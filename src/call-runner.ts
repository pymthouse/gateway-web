import { LivepeerGatewayError, LivepeerHTTPError, SignerRefreshRequired } from "./errors.js";
import { isJsonContentType, requestBody } from "./http.js";
import { getSignerInfo, LivePaymentSession } from "./signer.js";
import type {
  GetPaymentResponse,
  HeadersMap,
  LivePaymentChallenge,
  LiveRunnerInstance,
  LiveRunnerPriceInfo,
} from "./types.js";

const LIVE_RUNNER_PAYER_ADDRESS_HEADER = "Livepeer-Payer-Address";

const RUNNER_PAYMENT_TYPES_BY_UNIT: Record<string, string> = {
  hour: "live",
  seconds: "live",
  "720p": "lv2v",
  "720p-pixel-seconds": "lv2v",
  fixed: "fixed",
};

const METERED_PAYMENT_TYPES = new Set(["live", "lv2v"]);

export interface LiveRunnerCallResult {
  data: Record<string, unknown>;
  runnerUrl: string;
  runner: LiveRunnerInstance | null;
  sessionId: string;
  paymentSession: LivePaymentSession | null;
  content: Buffer | null;
  contentType: string;
}

export interface CallRunnerOptions {
  runnerUrl?: string;
  runner?: LiveRunnerInstance | null;
  payload?: Record<string, unknown>;
  method?: string;
  signerUrl?: string | null;
  signerHeaders?: HeadersMap;
  paymentUnit?: string | null;
  timeoutMs?: number;
  maxPaymentChallengeRetries?: number;
  insecureTls?: boolean;
}

export function runnerPaymentType(
  runner: LiveRunnerInstance | null | undefined,
  paymentUnit?: string | null,
): string {
  const explicitUnit = String(paymentUnit ?? "")
    .trim()
    .toLowerCase();
  const discoveredUnit =
    runner?.priceInfo != null
      ? String(runner.priceInfo.unit ?? "")
          .trim()
          .toLowerCase()
      : "";
  if (explicitUnit && discoveredUnit && explicitUnit !== discoveredUnit) {
    throw new LivepeerGatewayError("payment_unit conflicts with runner price metadata");
  }
  const unit = discoveredUnit || explicitUnit;
  if (unit) {
    const paymentType = RUNNER_PAYMENT_TYPES_BY_UNIT[unit];
    if (paymentType === undefined) {
      const supported = Object.keys(RUNNER_PAYMENT_TYPES_BY_UNIT).sort().join(", ");
      throw new LivepeerGatewayError(
        `Unsupported live runner payment unit ${JSON.stringify(unit)}; expected one of ${supported}`,
      );
    }
    return paymentType;
  }
  if (runner != null && runner.app === "live-video-to-video/scope") return "lv2v";
  return "live";
}

export function padRunnerPrice(priceInfo: LiveRunnerPriceInfo): LiveRunnerPriceInfo {
  const price = Number(String(priceInfo.price).trim());
  if (!Number.isFinite(price)) return priceInfo;
  return { ...priceInfo, price: price * 1.012 };
}

function parseRunnerPaymentChallenge(error: LivepeerHTTPError): LivePaymentChallenge {
  let data: unknown;
  try {
    data = JSON.parse(error.body) as unknown;
  } catch {
    throw new LivepeerGatewayError("Live runner payment challenge response was not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LivepeerGatewayError("Live runner payment challenge response must be a JSON object");
  }
  const rec = data as Record<string, unknown>;
  const paymentParams = rec.payment_params;
  const manifestId = rec.manifest_id;
  const paymentUrl = rec.payment_url;
  if (typeof paymentParams !== "string" || !paymentParams) {
    throw new LivepeerGatewayError("Live runner payment challenge missing payment_params");
  }
  if (typeof manifestId !== "string" || !manifestId) {
    throw new LivepeerGatewayError("Live runner payment challenge missing manifest_id");
  }
  if (typeof paymentUrl !== "string" || !paymentUrl) {
    throw new LivepeerGatewayError("Live runner payment challenge missing payment_url");
  }
  return {
    paymentParams,
    manifestId,
    paymentUrl,
  };
}

async function getRunnerPayment(options: {
  challenge: LivePaymentChallenge;
  paymentType: string;
  signerUrl: string;
  signerHeaders: HeadersMap | undefined;
  maxPrice: LiveRunnerPriceInfo | null;
  app: string | null;
}): Promise<{ session: LivePaymentSession; payment: GetPaymentResponse }> {
  const session = new LivePaymentSession({
    signerUrl: options.signerUrl,
    signerHeaders: options.signerHeaders,
    type: options.paymentType,
    challenge: options.challenge,
    app: options.app,
    maxPrice: options.maxPrice,
  });
  const payment = await session.getPayment();
  if (!payment.payment) {
    throw new LivepeerGatewayError("Live runner payment response missing payment");
  }
  if (!payment.segCreds) {
    throw new LivepeerGatewayError("Live runner payment response missing segCreds");
  }
  return { session, payment };
}

function startFunding(paymentSession: LivePaymentSession): { cancel: () => Promise<void> } {
  const ac = new AbortController();
  const task = paymentSession.runPayments(ac.signal);
  return {
    cancel: async () => {
      ac.abort();
      try {
        await task;
      } catch {
        // funding is best-effort; a cancel must not fail the runner call
      }
    },
  };
}

export async function callRunner(options: CallRunnerOptions): Promise<LiveRunnerCallResult> {
  const runnerUrl = (options.runnerUrl ?? options.runner?.url ?? "").trim();
  if (!runnerUrl) {
    throw new LivepeerGatewayError("Live runner call requires runnerUrl");
  }
  const requestPayload = options.payload ?? {};
  const signerUrl = options.signerUrl ?? null;
  const paymentType = signerUrl ? runnerPaymentType(options.runner, options.paymentUnit) : "";
  let maxPrice: LiveRunnerPriceInfo | null = null;
  if (signerUrl && options.runner?.priceInfo) {
    maxPrice = padRunnerPrice(options.runner.priceInfo);
  }

  let payerAddress = "";
  if (signerUrl) {
    const signer = await getSignerInfo(signerUrl, options.signerHeaders);
    payerAddress = signer.address ?? "";
  }

  let challenge: LivePaymentChallenge | null = null;
  const maxRetries = Math.max(0, options.maxPaymentChallengeRetries ?? 3);
  const attempts = (maxRetries + 1) * 2;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const insecureTls = options.insecureTls !== false;
  const method = options.method ?? "POST";

  for (let attempt = 0; attempt < attempts; attempt++) {
    let paymentSession: LivePaymentSession | null = null;
    let sessionId = "";
    let needsOngoingFunding = false;
    const requestHeaders: HeadersMap = { Accept: "*/*" };
    if (signerUrl) {
      requestHeaders[LIVE_RUNNER_PAYER_ADDRESS_HEADER] = payerAddress;
    }

    if (challenge !== null) {
      try {
        const paid = await getRunnerPayment({
          challenge,
          paymentType,
          signerUrl: signerUrl ?? "",
          signerHeaders: options.signerHeaders,
          maxPrice,
          app: options.runner?.app ?? null,
        });
        paymentSession = paid.session;
        requestHeaders["Livepeer-Payment"] = paid.payment.payment;
        requestHeaders["Livepeer-Segment"] = paid.payment.segCreds ?? "";
        sessionId = challenge.manifestId;
        needsOngoingFunding = METERED_PAYMENT_TYPES.has(paymentType);
      } catch (e) {
        if (e instanceof SignerRefreshRequired) {
          if (attempt + 1 >= attempts) throw e;
          challenge = null;
          continue;
        }
        throw e;
      }
    }

    const funding = needsOngoingFunding && paymentSession ? startFunding(paymentSession) : null;
    try {
      const { body, contentType } = await requestBody(runnerUrl, {
        method,
        payload: requestPayload,
        headers: requestHeaders,
        timeoutMs,
        insecureTls,
        accept: "*/*",
      });
      const isJson = isJsonContentType(contentType);
      let data: Record<string, unknown> = {};
      if (isJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8")) as unknown;
        } catch (e) {
          throw new LivepeerGatewayError(
            `HTTP JSON error: endpoint did not return valid JSON: ${e} (url=${runnerUrl}, content_type=${contentType})`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new LivepeerGatewayError(
            `Live runner call expected JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
          );
        }
        data = parsed as Record<string, unknown>;
      }
      const dataSessionId = data.session_id;
      return {
        data,
        runnerUrl,
        runner: options.runner ?? null,
        sessionId: sessionId || (typeof dataSessionId === "string" ? dataSessionId.trim() : ""),
        paymentSession: paymentType === "fixed" ? null : paymentSession,
        content: isJson ? null : body,
        contentType,
      };
    } catch (e) {
      if (!(e instanceof LivepeerHTTPError) || e.status !== 402) throw e;
      if (!signerUrl) {
        throw new LivepeerGatewayError("Live runner paid call requires signerUrl");
      }
      challenge = parseRunnerPaymentChallenge(e);
    } finally {
      if (funding) await funding.cancel();
    }
  }

  throw new LivepeerGatewayError("Live runner call exhausted payment challenge retries");
}
