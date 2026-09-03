import { LivepeerGatewayError, LivepeerHTTPError } from "./errors.js";
import { getJson, parseHttpUrl } from "./http.js";
import { extractMediaUrl } from "./media-url.js";

const QUEUE_STATES = new Set(["IN_QUEUE", "IN_PROGRESS", "QUEUED"]);
const TERMINAL_FAIL_STATES = new Set(["FAILED", "ERROR", "CANCELLED", "CANCELED"]);

export const DEFAULT_QUEUE_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_QUEUE_POLL_REQUEST_TIMEOUT_MS = 30_000;

export interface QueueHandle {
  requestId: string | null;
  status: string | null;
  statusUrl: string | null;
  responseUrl: string | null;
  cancelUrl: string | null;
}

export interface QueueProgress {
  status: string;
  elapsedMs: number;
  requestId: string | null;
  statusUrl: string | null;
}

export interface AwaitQueueOptions {
  timeoutMs: number;
  insecureTls?: boolean;
  runnerUrl?: string;
  pollIntervalMs?: number;
  onProgress?: (info: QueueProgress) => void | Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringProp(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export { isQueueControlKey, isQueueControlUrl } from "./media-url.js";

function resolveMaybeUrl(value: string | null, baseUrl?: string): string | null {
  if (!value) return null;
  try {
    return baseUrl ? new URL(value, baseUrl).toString() : parseHttpUrl(value).toString();
  } catch {
    return null;
  }
}

function isFalQueueHost(host: string): boolean {
  const hostname = host.toLowerCase();
  return hostname === "queue.fal.run" || hostname.endsWith(".queue.fal.run");
}

function sameOrigin(url: URL, base?: string): boolean {
  if (!base) return false;
  try {
    return url.origin === parseHttpUrl(base).origin;
  } catch {
    return false;
  }
}

/** https fal queue hosts, or the same origin as the runner that issued the receipt. */
export function isAllowedQueuePollUrl(url: string, runnerUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = parseHttpUrl(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" && isFalQueueHost(parsed.hostname)) return true;
  return sameOrigin(parsed, runnerUrl);
}

function allowedPollUrl(url: string | null, runnerUrl?: string): string | null {
  if (!url) return null;
  return isAllowedQueuePollUrl(url, runnerUrl) ? url : null;
}

function handleFromRecord(rec: Record<string, unknown>, baseUrl?: string): QueueHandle {
  return {
    requestId: stringProp(rec, "request_id"),
    status: stringProp(rec, "status"),
    statusUrl: resolveMaybeUrl(stringProp(rec, "status_url"), baseUrl),
    responseUrl: resolveMaybeUrl(stringProp(rec, "response_url"), baseUrl),
    cancelUrl: resolveMaybeUrl(stringProp(rec, "cancel_url"), baseUrl),
  };
}

function mergeHandle(primary: QueueHandle, fallback: QueueHandle): QueueHandle {
  return {
    requestId: primary.requestId ?? fallback.requestId,
    status: primary.status ?? fallback.status,
    statusUrl: primary.statusUrl ?? fallback.statusUrl,
    responseUrl: primary.responseUrl ?? fallback.responseUrl,
    cancelUrl: primary.cancelUrl ?? fallback.cancelUrl,
  };
}

function handleHasPollTarget(handle: QueueHandle): boolean {
  return Boolean(handle.statusUrl || handle.responseUrl);
}

function handleLooksQueued(handle: QueueHandle): boolean {
  if (handle.status && QUEUE_STATES.has(handle.status)) return true;
  if (handle.status && TERMINAL_FAIL_STATES.has(handle.status)) return true;
  return handleHasPollTarget(handle);
}

/**
 * Pull a fal-style queue receipt out of a runner JSON body.
 * Looks at the top level and at a nested `output` envelope.
 */
export function extractQueueHandle(data: unknown, baseUrl?: string): QueueHandle | null {
  const rec = asRecord(data);
  if (!rec) return null;
  const top = handleFromRecord(rec, baseUrl);
  const nested = asRecord(rec.output);
  const fromOutput = nested ? handleFromRecord(nested, baseUrl) : emptyHandle();
  const merged = mergeHandle(top, fromOutput);
  if (!handleLooksQueued(merged) && !merged.requestId) return null;
  if (!handleLooksQueued(merged) && extractMediaUrl(data)) return null;
  return merged;
}

function emptyHandle(): QueueHandle {
  return {
    requestId: null,
    status: null,
    statusUrl: null,
    responseUrl: null,
    cancelUrl: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function deriveResponseUrl(handle: QueueHandle): string | null {
  if (handle.responseUrl) return handle.responseUrl;
  if (!handle.statusUrl) return null;
  try {
    const parsed = new URL(handle.statusUrl);
    parsed.pathname = parsed.pathname.replace(/\/status\/?$/i, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof LivepeerHTTPError && (error.status === 401 || error.status === 403);
}

function asJsonObject(value: unknown, stage: string): Record<string, unknown> {
  const rec = asRecord(value);
  if (!rec) {
    throw new LivepeerGatewayError(`fal ${stage} response must be a JSON object`);
  }
  return rec;
}

function attachResult(
  original: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if ("output" in original || "endpoint_id" in original || "schema_sha256" in original) {
    return { ...original, output: result };
  }
  return result;
}

async function fetchJsonObject(
  url: string,
  options: { timeoutMs: number; insecureTls: boolean },
): Promise<Record<string, unknown>> {
  const data = await getJson(url, {
    timeoutMs: options.timeoutMs,
    insecureTls: options.insecureTls,
  });
  return asJsonObject(data, url);
}

function requestIdLabel(requestId: string | null): string {
  return requestId ?? "unknown";
}

/** Throws on terminal failure; returns true when the job is COMPLETED. */
function queueStatusIsComplete(
  statusBody: Record<string, unknown>,
  status: string,
  requestId: string | null,
): boolean {
  if (status === "COMPLETED") {
    if (statusBody.error) {
      throw new LivepeerGatewayError(
        `queued job completed with an error (request_id=${requestIdLabel(requestId)})`,
      );
    }
    return true;
  }
  if (TERMINAL_FAIL_STATES.has(status)) {
    const detail = stringProp(statusBody, "error") ?? JSON.stringify(statusBody);
    throw new LivepeerGatewayError(
      `queued job ${status.toLowerCase()} (request_id=${requestIdLabel(requestId)}): ${detail}`,
    );
  }
  if (status && !QUEUE_STATES.has(status)) {
    throw new LivepeerGatewayError(
      `queued job returned unknown status ${JSON.stringify(status)} (request_id=${requestIdLabel(requestId)})`,
    );
  }
  return false;
}

type PollContext = {
  statusUrl: string;
  requestId: string | null;
  deadline: number;
  insecureTls: boolean;
  pollIntervalMs: number;
  report: (status: string) => Promise<void>;
};

async function pollUntilComplete(ctx: PollContext): Promise<boolean> {
  while (remainingMs(ctx.deadline) > 0) {
    const statusBody = await fetchJsonObject(ctx.statusUrl, {
      timeoutMs: Math.min(DEFAULT_QUEUE_POLL_REQUEST_TIMEOUT_MS, remainingMs(ctx.deadline) || 1),
      insecureTls: ctx.insecureTls,
    });
    const status = handleFromRecord(statusBody).status ?? "IN_QUEUE";
    await ctx.report(status);
    if (queueStatusIsComplete(statusBody, status, ctx.requestId)) return true;
    const wait = Math.min(ctx.pollIntervalMs, remainingMs(ctx.deadline));
    if (wait <= 0) break;
    await sleep(wait);
  }
  return false;
}

async function fetchSettledOutput(
  data: Record<string, unknown>,
  handle: QueueHandle,
  options: { deadline: number; insecureTls: boolean; runnerUrl?: string },
): Promise<Record<string, unknown>> {
  const resultUrl = allowedPollUrl(deriveResponseUrl(handle), options.runnerUrl);
  if (!resultUrl || remainingMs(options.deadline) <= 0) return data;
  const result = await fetchJsonObject(resultUrl, {
    timeoutMs: Math.min(DEFAULT_QUEUE_POLL_REQUEST_TIMEOUT_MS, remainingMs(options.deadline) || 1),
    insecureTls: options.insecureTls,
  });
  const settled = attachResult(data, result);
  if (!extractMediaUrl(settled) && extractQueueHandle(settled, options.runnerUrl)) {
    return data;
  }
  return settled;
}

function rethrowJobFailure(error: unknown): void {
  if (error instanceof LivepeerGatewayError && /queued job /.test(error.message)) {
    throw error;
  }
}

/**
 * If `data` is a fal queue submit receipt (IN_QUEUE / status_url, no media),
 * poll status_url then fetch response_url. Returns the original body when the
 * receipt is already complete, has no poll target, or the poll URL rejects
 * unauthenticated callers (401/403) — the handle stays on the body for the
 * caller to surface.
 */
export async function awaitQueuedResult(
  data: Record<string, unknown>,
  options: AwaitQueueOptions,
): Promise<Record<string, unknown>> {
  if (extractMediaUrl(data)) return data;

  const started = Date.now();
  const deadline = started + Math.max(0, options.timeoutMs);
  const insecureTls = options.insecureTls === true;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_QUEUE_POLL_INTERVAL_MS;
  const extracted = extractQueueHandle(data, options.runnerUrl);
  if (!extracted || !handleLooksQueued(extracted)) return data;
  const handle = {
    ...extracted,
    statusUrl: allowedPollUrl(extracted.statusUrl, options.runnerUrl),
    responseUrl: allowedPollUrl(extracted.responseUrl, options.runnerUrl),
  };
  if (!handle.statusUrl && !handle.responseUrl) return data;

  const report = async (status: string) => {
    if (!options.onProgress) return;
    await options.onProgress({
      status,
      elapsedMs: Date.now() - started,
      requestId: handle.requestId,
      statusUrl: handle.statusUrl,
    });
  };

  await report(handle.status ?? "IN_QUEUE");

  try {
    if (handle.statusUrl) {
      const completed = await pollUntilComplete({
        statusUrl: handle.statusUrl,
        requestId: handle.requestId,
        deadline,
        insecureTls,
        pollIntervalMs,
        report,
      });
      if (!completed) return data;
    }
    return await fetchSettledOutput(data, handle, {
      deadline,
      insecureTls,
      runnerUrl: options.runnerUrl,
    });
  } catch (error) {
    if (isAuthFailure(error)) return data;
    rethrowJobFailure(error);
    return data;
  }
}
