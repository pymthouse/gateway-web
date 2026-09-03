import {
  LivepeerGatewayError,
  LivepeerHTTPError,
  PaymentError,
  RemoteSignerError,
  SignerRefreshRequired,
  SkipPaymentCycle,
} from "./errors.js";
import { httpOrigin, postEmpty, postJson } from "./http.js";
import { stripTrailingSlashes } from "./strings.js";
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
  /** Restored ticket state from a previous isolate or process. */
  state?: Record<string, unknown> | null;
  /**
   * Caller-owned job id echoed to the signer so the ticket it mints can be
   * joined back to the request that paid for it. Without it the metering
   * pipeline records the ticket with a null gateway_request_id.
   */
  gatewayRequestId?: string | null;
  /** Which integration issued the call. The signer defaults to "direct_api". */
  attributionSource?: string | null;
}

/** Serializable payment loop — enough to resume `runPayments` elsewhere. */
export interface PaymentSessionSnapshot {
  type: string;
  challenge: LivePaymentChallenge;
  app: string | null;
  maxPrice: LiveRunnerPriceInfo | null;
  state: Record<string, unknown> | null;
  gatewayRequestId: string | null;
  attributionSource: string | null;
}

export class LivePaymentSession {
  private readonly signerUrl: string | null;
  private readonly signerHeaders: HeadersMap | undefined;
  private readonly type: string;
  private challenge: LivePaymentChallenge;
  private readonly app: string | null;
  private readonly maxPrice: LiveRunnerPriceInfo | null;
  private readonly maxRefreshRetries: number;
  private readonly gatewayRequestId: string | null;
  private readonly attributionSource: string | null;
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
    this.gatewayRequestId = options.gatewayRequestId?.trim() || null;
    this.attributionSource = options.attributionSource?.trim() || null;
    this.state = options.state ?? null;
  }

  snapshot(): PaymentSessionSnapshot {
    return {
      type: this.type,
      challenge: { ...this.challenge },
      app: this.app,
      maxPrice: this.maxPrice === null ? null : { ...this.maxPrice },
      state: this.state === null ? null : { ...this.state },
      gatewayRequestId: this.gatewayRequestId,
      attributionSource: this.attributionSource,
    };
  }

  static fromSnapshot(options: {
    signerUrl: string | null;
    signerHeaders?: HeadersMap;
    snapshot: PaymentSessionSnapshot;
    maxRefreshRetries?: number;
  }): LivePaymentSession {
    return new LivePaymentSession({
      signerUrl: options.signerUrl,
      signerHeaders: options.signerHeaders,
      type: options.snapshot.type,
      challenge: options.snapshot.challenge,
      app: options.snapshot.app,
      maxPrice: options.snapshot.maxPrice,
      maxRefreshRetries: options.maxRefreshRetries,
      state: options.snapshot.state,
      gatewayRequestId: options.snapshot.gatewayRequestId,
      attributionSource: options.snapshot.attributionSource,
    });
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

  startFunding(): { cancel: () => Promise<void> } {
    const ac = new AbortController();
    const task = this.runPayments(ac.signal);
    return {
      cancel: async () => {
        ac.abort();
        try {
          await task;
        } catch {
          // funding is best-effort; a cancel must not fail the caller
        }
      },
    };
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
        if (e instanceof LivepeerHTTPError && isFatalMeteredHttpStatus(e.status)) {
          return e.status === 404;
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
    if (this.gatewayRequestId) payload.gatewayRequestId = this.gatewayRequestId;
    if (this.attributionSource) payload.attributionSource = this.attributionSource;

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
    const url = `${stripTrailingSlashes(this.challenge.paymentUrl)}/refresh-payment`;
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

function isFatalMeteredHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
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
