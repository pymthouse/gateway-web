import { callRunner } from "./call-runner.js";
import { LivepeerGatewayError } from "./errors.js";
import { isJsonContentType, joinEndpoint, postEmpty, requestBody } from "./http.js";
import type { HeadersMap, LiveRunnerInstance } from "./types.js";
import type { LivePaymentSession } from "./signer.js";

export interface RunnerSession {
  sessionId: string;
  appUrl: string;
  runnerUrl: string;
  controlUrl: string;
  runner: LiveRunnerInstance;
  released: boolean;
  stopPayments(): Promise<void>;
}

export interface ReserveSessionOptions {
  runner: LiveRunnerInstance;
  payload?: Record<string, unknown>;
  signerUrl: string;
  signerHeaders?: HeadersMap;
  timeoutMs?: number;
  insecureTls?: boolean;
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

function startFunding(paymentSession: LivePaymentSession): { cancel: () => Promise<void> } {
  const ac = new AbortController();
  const task = paymentSession.runPayments(ac.signal);
  return {
    cancel: async () => {
      ac.abort();
      try {
        await task;
      } catch {
        // funding is best-effort; a cancel must not fail session cleanup
      }
    },
  };
}

function parseRunnerJsonBody(
  body: Buffer,
  runnerUrl: string,
  contentType: string,
): Record<string, unknown> {
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
  return parsed as Record<string, unknown>;
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

  const funding = result.paymentSession ? startFunding(result.paymentSession) : null;

  return {
    sessionId,
    appUrl,
    runnerUrl,
    controlUrl,
    runner: options.runner,
    released: false,
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
