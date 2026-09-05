import { LivepeerGatewayError, LivepeerHTTPError, SignerRefreshRequired } from "./errors.js";
import { isJsonContentType, parseRunnerJsonBody, requestBody } from "./http.js";
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
  providerRequestId: string | null;
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
  /** Skip TLS verification. Default true; pass false to verify runner certs. */
  insecureTls?: boolean;
  /** Job id sent to the signer so its ticket carries a joinable request id. */
  gatewayRequestId?: string | null;
  /** Which integration issued the call. The signer defaults to "direct_api". */
  attributionSource?: string | null;
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
      const supported = Object.keys(RUNNER_PAYMENT_TYPES_BY_UNIT)
        .sort((a, b) => a.localeCompare(b))
        .join(", ");
      throw new LivepeerGatewayError(
        `Unsupported live runner payment unit ${JSON.stringify(unit)}; expected one of ${supported}`,
      );
    }
    return paymentType;
  }
  if (runner?.app === "live-video-to-video/scope") return "lv2v";
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
  gatewayRequestId: string | null;
  attributionSource: string | null;
}): Promise<{ session: LivePaymentSession; payment: GetPaymentResponse }> {
  const session = new LivePaymentSession({
    signerUrl: options.signerUrl,
    signerHeaders: options.signerHeaders,
    type: options.paymentType,
    challenge: options.challenge,
    app: options.app,
    maxPrice: options.maxPrice,
    gatewayRequestId: options.gatewayRequestId,
    attributionSource: options.attributionSource,
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

async function resolveChallengePayment(options: {
  challenge: LivePaymentChallenge;
  paymentType: string;
  signerUrl: string;
  signerHeaders: HeadersMap | undefined;
  maxPrice: LiveRunnerPriceInfo | null;
  app: string | null;
  requestHeaders: HeadersMap;
  gatewayRequestId: string | null;
  attributionSource: string | null;
}): Promise<{ session: LivePaymentSession; sessionId: string; needsOngoingFunding: boolean }> {
  const paid = await getRunnerPayment({
    challenge: options.challenge,
    paymentType: options.paymentType,
    signerUrl: options.signerUrl,
    signerHeaders: options.signerHeaders,
    maxPrice: options.maxPrice,
    app: options.app,
    gatewayRequestId: options.gatewayRequestId,
    attributionSource: options.attributionSource,
  });
  options.requestHeaders["Livepeer-Payment"] = paid.payment.payment;
  options.requestHeaders["Livepeer-Segment"] = paid.payment.segCreds ?? "";
  return {
    session: paid.session,
    sessionId: options.challenge.manifestId,
    needsOngoingFunding: METERED_PAYMENT_TYPES.has(options.paymentType),
  };
}

function asPaymentChallenge(error: unknown, signerUrl: string | null): LivePaymentChallenge {
  if (!(error instanceof LivepeerHTTPError) || error.status !== 402) throw error;
  if (!signerUrl) {
    throw new LivepeerGatewayError("Live runner paid call requires signerUrl");
  }
  return parseRunnerPaymentChallenge(error);
}

interface PaidAttemptInput {
  runnerUrl: string;
  requestPayload: Record<string, unknown>;
  signerUrl: string | null;
  signerHeaders: HeadersMap | undefined;
  paymentType: string;
  maxPrice: LiveRunnerPriceInfo | null;
  payerAddress: string;
  runner: LiveRunnerInstance | null | undefined;
  challenge: LivePaymentChallenge | null;
  lastAttempt: boolean;
  timeoutMs: number;
  insecureTls: boolean;
  method: string;
  gatewayRequestId: string | null;
  attributionSource: string | null;
}

type PaidAttemptResult =
  | { kind: "success"; result: LiveRunnerCallResult }
  | { kind: "retry"; challenge: LivePaymentChallenge | null };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toPaidCallResult(
  input: PaidAttemptInput,
  sessionId: string,
  paymentSession: LivePaymentSession | null,
  response: { body: Buffer; contentType: string; providerRequestId: string | null },
): LiveRunnerCallResult {
  const isJson = isJsonContentType(response.contentType);
  const data = isJson
    ? parseRunnerJsonBody(response.body, input.runnerUrl, response.contentType)
    : {};
  return {
    data,
    runnerUrl: input.runnerUrl,
    runner: input.runner ?? null,
    sessionId: sessionId || nonEmptyString(data.session_id) || "",
    paymentSession: input.paymentType === "fixed" ? null : paymentSession,
    content: isJson ? null : response.body,
    contentType: response.contentType,
    providerRequestId: response.providerRequestId ?? nonEmptyString(data.request_id),
  };
}

async function attemptPaidCall(input: PaidAttemptInput): Promise<PaidAttemptResult> {
  let paymentSession: LivePaymentSession | null = null;
  let sessionId = "";
  let needsOngoingFunding = false;
  const requestHeaders: HeadersMap = { Accept: "*/*" };
  if (input.signerUrl) {
    requestHeaders[LIVE_RUNNER_PAYER_ADDRESS_HEADER] = input.payerAddress;
  }

  if (input.challenge !== null) {
    try {
      const paid = await resolveChallengePayment({
        challenge: input.challenge,
        paymentType: input.paymentType,
        signerUrl: input.signerUrl ?? "",
        signerHeaders: input.signerHeaders,
        maxPrice: input.maxPrice,
        app: input.runner?.app ?? null,
        requestHeaders,
        gatewayRequestId: input.gatewayRequestId,
        attributionSource: input.attributionSource,
      });
      paymentSession = paid.session;
      sessionId = paid.sessionId;
      needsOngoingFunding = paid.needsOngoingFunding;
    } catch (e) {
      if (!(e instanceof SignerRefreshRequired) || input.lastAttempt) throw e;
      return { kind: "retry", challenge: null };
    }
  }

  const funding = needsOngoingFunding && paymentSession ? paymentSession.startFunding() : null;
  try {
    const response = await requestBody(input.runnerUrl, {
      method: input.method,
      payload: input.requestPayload,
      headers: requestHeaders,
      timeoutMs: input.timeoutMs,
      insecureTls: input.insecureTls,
      accept: "*/*",
    });
    return {
      kind: "success",
      result: toPaidCallResult(input, sessionId, paymentSession, response),
    };
  } catch (e) {
    return { kind: "retry", challenge: asPaymentChallenge(e, input.signerUrl) };
  } finally {
    if (funding) await funding.cancel();
  }
}

export async function callRunner(options: CallRunnerOptions): Promise<LiveRunnerCallResult> {
  const runnerUrl = (options.runnerUrl ?? options.runner?.url ?? "").trim();
  if (!runnerUrl) {
    throw new LivepeerGatewayError("Live runner call requires runnerUrl");
  }
  const signerUrl = options.signerUrl ?? null;
  let payerAddress = "";
  if (signerUrl) {
    const signer = await getSignerInfo(signerUrl, options.signerHeaders);
    payerAddress = signer.address ?? "";
  }

  let challenge: LivePaymentChallenge | null = null;
  const maxRetries = Math.max(0, options.maxPaymentChallengeRetries ?? 3);
  const attempts = (maxRetries + 1) * 2;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const outcome = await attemptPaidCall({
      runnerUrl,
      requestPayload: options.payload ?? {},
      signerUrl,
      signerHeaders: options.signerHeaders,
      paymentType: signerUrl ? runnerPaymentType(options.runner, options.paymentUnit) : "",
      maxPrice:
        signerUrl && options.runner?.priceInfo ? padRunnerPrice(options.runner.priceInfo) : null,
      payerAddress,
      runner: options.runner,
      challenge,
      lastAttempt: attempt + 1 >= attempts,
      timeoutMs: options.timeoutMs ?? 5_000,
      insecureTls: options.insecureTls !== false,
      method: options.method ?? "POST",
      gatewayRequestId: options.gatewayRequestId ?? null,
      attributionSource: options.attributionSource ?? null,
    });
    if (outcome.kind === "success") return outcome.result;
    challenge = outcome.challenge;
  }

  throw new LivepeerGatewayError("Live runner call exhausted payment challenge retries");
}
