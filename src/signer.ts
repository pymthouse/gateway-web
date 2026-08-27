import {
  LivepeerGatewayError,
  LivepeerHTTPError,
  PaymentError,
  RemoteSignerError,
  SignerRefreshRequired,
  SkipPaymentCycle,
} from "./errors.js";
import { httpOrigin, postEmpty, postJson } from "./http.js";
import type {
  GetPaymentResponse,
  HeadersMap,
  LivePaymentChallenge,
  LiveRunnerPriceInfo,
  SignerMaterial,
} from "./types.js";

export const PAYMENT_INTERVAL_MS = 3_000;

function freezeHeaders(headers: HeadersMap | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

const signerInfoCache = new Map<string, Promise<SignerMaterial>>();

function signerMaterialFromJson(data: Record<string, unknown>, signerUrl: string): SignerMaterial {
  if (!("address" in data) || !("signature" in data)) {
    throw new RemoteSignerError(
      signerUrl,
      `Remote signer JSON must contain 'address' and 'signature': ${JSON.stringify(data)}`,
    );
  }
  const address = data.address;
  const sig = data.signature;
  if (typeof address !== "string" || !address) {
    throw new RemoteSignerError(
      signerUrl,
      `Remote signer 'address' must be a non-empty string: ${JSON.stringify(address)}`,
    );
  }
  if (typeof sig !== "string" || !sig) {
    throw new RemoteSignerError(
      signerUrl,
      `Remote signer 'signature' must be a non-empty string: ${JSON.stringify(sig)}`,
    );
  }
  return { address, sig };
}

export async function getSignerInfo(
  signerUrl: string,
  signerHeaders?: HeadersMap,
): Promise<SignerMaterial> {
  if (!signerUrl) return { address: null, sig: null };
  const key = `${httpOrigin(signerUrl)}\0${freezeHeaders(signerHeaders)}`;
  const cached = signerInfoCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const url = `${httpOrigin(signerUrl)}/sign-orchestrator-info`;
    try {
      const data = await postJson(
        url,
        {},
        {
          headers: signerHeaders,
          timeoutMs: 5_000,
          insecureTls: false,
        },
      );
      return signerMaterialFromJson(data, url);
    } catch (e) {
      if (e instanceof RemoteSignerError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new RemoteSignerError(url, msg, e);
    }
  })();

  signerInfoCache.set(key, pending);
  try {
    return await pending;
  } catch (e) {
    signerInfoCache.delete(key);
    throw e;
  }
}

/** Test helper — the Python `@async_lru_cache` lives for process lifetime. */
export function clearSignerInfoCache(): void {
  signerInfoCache.clear();
}

export interface LivePaymentSessionOptions {
  signerUrl: string | null;
  signerHeaders?: HeadersMap;
  type: string;
  challenge: LivePaymentChallenge;
  app?: string | null;
  maxPrice?: LiveRunnerPriceInfo | null;
  maxRefreshRetries?: number;
}

export class LivePaymentSession {
  private readonly signerUrl: string | null;
  private readonly signerHeaders: HeadersMap | undefined;
  private readonly type: string;
  private challenge: LivePaymentChallenge;
  private readonly app: string | null;
  private readonly maxPrice: Record<string, unknown> | null;
  private readonly maxRefreshRetries: number;
  private state: Record<string, unknown> | null = null;

  constructor(options: LivePaymentSessionOptions) {
    this.signerUrl = options.signerUrl;
    this.signerHeaders = options.signerHeaders;
    this.type = options.type;
    this.challenge = options.challenge;
    this.app = options.app ?? null;
    this.maxPrice =
      options.maxPrice !== undefined && options.maxPrice !== null
        ? {
            price: options.maxPrice.price,
            currency: String(options.maxPrice.currency || "usd")
              .trim()
              .toLowerCase(),
            unit: String(options.maxPrice.unit || "hour")
              .trim()
              .toLowerCase(),
          }
        : null;
    this.maxRefreshRetries = Math.max(0, options.maxRefreshRetries ?? 3);
  }

  async getPayment(): Promise<GetPaymentResponse> {
    if (!this.signerUrl) return { payment: "", segCreds: null };
    let attempts = 0;
    for (;;) {
      try {
        return await this.paymentRequest();
      } catch (e) {
        if (!(e instanceof SignerRefreshRequired)) throw e;
        if (attempts >= this.maxRefreshRetries) {
          throw new PaymentError(`Signer refresh required after ${attempts} retries: ${e.message}`);
        }
        if (this.state === null) throw e;
        await this.refreshPaymentParams();
        attempts += 1;
      }
    }
  }

  async sendPayment(): Promise<void> {
    if (!this.signerUrl) return;
    const payment = await this.getPayment();
    if (!payment.segCreds) {
      throw new PaymentError("Signer returned a payment with no segCreds");
    }
    await postEmpty(this.challenge.paymentUrl, {
      headers: {
        "Livepeer-Payment": payment.payment,
        "Livepeer-Segment": payment.segCreds,
      },
      timeoutMs: 5_000,
      insecureTls: true,
    });
  }

  /**
   * Keep a metered session funded until `signal` aborts.
   * First payment waits one interval — the caller already paid upfront.
   */
  async runPayments(signal?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;
      await abortableSleep(PAYMENT_INTERVAL_MS, signal);
      if (signal?.aborted) return false;
      try {
        await this.sendPayment();
      } catch (e) {
        if (e instanceof SkipPaymentCycle) continue;
        if (e instanceof LivepeerHTTPError) {
          if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
            return e.status === 404;
          }
        }
      }
    }
  }

  private async paymentRequest(): Promise<GetPaymentResponse> {
    if (!this.signerUrl) {
      throw new LivepeerGatewayError("paymentRequest requires signerUrl");
    }
    const url = `${httpOrigin(this.signerUrl)}/generate-live-payment`;
    const payload: Record<string, unknown> = {
      orchestrator: this.challenge.paymentParams,
      type: this.type,
      ManifestID: this.challenge.manifestId,
    };
    if (this.app) payload.app = this.app;
    if (this.maxPrice !== null) payload.maxPrice = { ...this.maxPrice };
    if (this.state !== null) payload.state = this.state;

    const data = await postJson(url, payload, {
      headers: this.signerHeaders,
      timeoutMs: 15_000,
      insecureTls: false,
    });

    const payment = data.payment;
    if (typeof payment !== "string" || !payment) {
      throw new PaymentError(
        `GetPayment error: missing/invalid 'payment' in response (url=${url})`,
      );
    }
    const segCreds = data.segCreds;
    if (segCreds !== undefined && segCreds !== null && typeof segCreds !== "string") {
      throw new PaymentError(`GetPayment error: invalid 'segCreds' in response (url=${url})`);
    }
    const state = data.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new PaymentError(`Remote signer response missing 'state' object (url=${url})`);
    }
    this.state = state as Record<string, unknown>;
    return {
      payment,
      segCreds: typeof segCreds === "string" ? segCreds : null,
    };
  }

  private async refreshPaymentParams(): Promise<void> {
    const signer = await getSignerInfo(this.signerUrl ?? "", this.signerHeaders);
    if (!signer.address) {
      throw new PaymentError("Cannot refresh payment without signer address");
    }
    const url = `${this.challenge.paymentUrl.replace(/\/+$/, "")}/refresh-payment`;
    const data = await postJson(
      url,
      {
        sender: signer.address,
        manifest_id: this.challenge.manifestId,
      },
      {
        timeoutMs: 5_000,
        insecureTls: true,
      },
    );
    const paymentParams = data.payment_params;
    if (typeof paymentParams !== "string" || !paymentParams) {
      throw new PaymentError(
        `RefreshPayment error: missing/invalid 'payment_params' in response (url=${url})`,
      );
    }
    this.challenge = {
      ...this.challenge,
      paymentParams,
    };
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
