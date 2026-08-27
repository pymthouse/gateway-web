import { LivepeerGatewayError, LivepeerHTTPError } from "./errors.js";

const RETRYABLE_HTTP_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);

/** Whether `runInference` should try the next cached orchestrator. */
export function isRetryableRunnerFailure(error: unknown): boolean {
  if (error instanceof LivepeerHTTPError) {
    return RETRYABLE_HTTP_STATUSES.has(error.status);
  }
  if (error instanceof LivepeerGatewayError) {
    const msg = error.message.toLowerCase();
    if (msg.includes("timeout")) return true;
    if (msg.includes("exhausted payment challenge retries")) return true;
    if (msg.includes("connection refused")) return true;
    if (msg.includes("failed to reach endpoint")) return true;
  }
  return false;
}

export function rejectionReason(error: unknown): string {
  if (error instanceof LivepeerHTTPError) {
    return `HTTP ${error.status}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
