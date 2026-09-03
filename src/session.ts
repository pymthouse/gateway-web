import { callRunner } from "./call-runner.js";
import { LivepeerGatewayError } from "./errors.js";
import {
  isJsonContentType,
  joinEndpoint,
  parseRunnerJsonBody,
  postEmpty,
  requestBody,
} from "./http.js";
import type { LivePaymentSession } from "./signer.js";
import type { HeadersMap, LiveRunnerInstance } from "./types.js";

export interface RunnerSession {
  sessionId: string;
  appUrl: string;
  runnerUrl: string;
  controlUrl: string;
  runner: LiveRunnerInstance;
  released: boolean;
  paymentSession: LivePaymentSession | null;
  stopPayments(): Promise<void>;
}

export interface ReserveSessionOptions {
  runner: LiveRunnerInstance;
  payload?: Record<string, unknown>;
  signerUrl: string;
  signerHeaders?: HeadersMap;
  timeoutMs?: number;
  insecureTls?: boolean;
  /**
   * Start the 3s metered funding loop in this process (default true).
   * Pass false to hand the payment session to another holder.
   */
  startFunding?: boolean;
  /** Job id sent to the signer so its ticket carries a joinable request id. */
  gatewayRequestId?: string | null;
  /** Which integration issued the call. The signer defaults to "direct_api". */
  attributionSource?: string | null;
}

export interface CallSessionOptions {
  endpoint: string;
  payload?: Record<string, unknown>;
  method?: string;
  timeoutMs?: number;
  insecureTls?: boolean;
}

export interface CallSessionResult {
  data: Record<string, unknown>;
  runnerUrl: string;
  content: Buffer | null;
  contentType: string;
}

export interface StopSessionOptions {
  timeoutMs?: number;
  insecureTls?: boolean;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * POST the advertised runner URL unmodified (typically `…/session`) and keep
 * metered funding alive until `stopSession`.
 */
export async function reserveSession(options: ReserveSessionOptions): Promise<RunnerSession> {
  const runnerUrl = options.runner.url.trim();
  if (!runnerUrl) {
    throw new LivepeerGatewayError("reserveSession requires runner.url");
  }
  const result = await callRunner({
    runnerUrl,
    runner: options.runner,
    payload: options.payload ?? {},
    signerUrl: options.signerUrl,
    signerHeaders: options.signerHeaders,
    timeoutMs: options.timeoutMs,
    insecureTls: options.insecureTls,
    gatewayRequestId: options.gatewayRequestId,
    attributionSource: options.attributionSource,
  });

  const sessionId = stringField(result.data, "session_id");
  const appUrl = stringField(result.data, "app_url");
  const controlUrl = stringField(result.data, "control_url");
  if (!sessionId) {
    throw new LivepeerGatewayError("runner session response missing session_id");
  }
  if (!appUrl) {
    throw new LivepeerGatewayError("runner session response missing app_url");
  }
  if (!controlUrl) {
    throw new LivepeerGatewayError("runner session response missing control_url");
  }

  const funding =
    options.startFunding === false || !result.paymentSession
      ? null
      : result.paymentSession.startFunding();

  return {
    sessionId,
    appUrl,
    runnerUrl,
    controlUrl,
    runner: options.runner,
    released: false,
    paymentSession: result.paymentSession,
    async stopPayments() {
      if (funding) await funding.cancel();
    },
  };
}

export async function callSession(
  handle: RunnerSession,
  options: CallSessionOptions,
): Promise<CallSessionResult> {
  const endpoint = options.endpoint.trim();
  if (!endpoint) {
    throw new LivepeerGatewayError("callSession requires endpoint");
  }
  const runnerUrl = joinEndpoint(
    handle.appUrl,
    endpoint.startsWith("/") ? endpoint : `/${endpoint}`,
  );
  const { body, contentType } = await requestBody(runnerUrl, {
    method: options.method ?? "POST",
    payload: options.payload ?? {},
    timeoutMs: options.timeoutMs ?? 5_000,
    insecureTls: options.insecureTls !== false,
    accept: "*/*",
  });
  const isJson = isJsonContentType(contentType);
  return {
    data: isJson ? parseRunnerJsonBody(body, runnerUrl, contentType) : {},
    runnerUrl,
    content: isJson ? null : body,
    contentType,
  };
}

export async function stopSession(
  handle: RunnerSession,
  options: StopSessionOptions = {},
): Promise<void> {
  await handle.stopPayments();
  if (handle.released) return;
  await postEmpty(joinEndpoint(handle.controlUrl, "stop"), {
    timeoutMs: options.timeoutMs ?? 5_000,
    insecureTls: options.insecureTls !== false,
  });
  handle.released = true;
}
