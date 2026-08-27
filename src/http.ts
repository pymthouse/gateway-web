import { Agent, request } from "undici";
import {
  LivepeerGatewayError,
  LivepeerHTTPError,
  SignerRefreshRequired,
  SkipPaymentCycle,
} from "./errors.js";
import type { HeadersMap } from "./types.js";

const USER_AGENT = "pymthouse-gateway-web/0.1.0";
const REFRESH_SESSION_ORCHESTRATOR_URL_HEADER = "Livepeer-Orchestrator-URL";

let insecureAgent: Agent | undefined;

function dispatcherFor(insecureTls: boolean): Agent | undefined {
  if (!insecureTls) return undefined;
  if (!insecureAgent) {
    insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureAgent;
}

export interface HttpRequestOptions {
  method?: string;
  payload?: Record<string, unknown> | null;
  headers?: HeadersMap;
  timeoutMs?: number;
  insecureTls?: boolean;
  accept?: string;
}

export function parseHttpUrl(url: string, context = "URL"): URL {
  const trimmed = url.trim();
  const normalized = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new LivepeerGatewayError(`Invalid ${context}: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LivepeerGatewayError(
      `Only http:// or https:// ${context}s are supported (got ${parsed.protocol})`,
    );
  }
  if (!parsed.host) {
    throw new LivepeerGatewayError(`Invalid ${context}: ${url}`);
  }
  return parsed;
}

export function httpOrigin(url: string): string {
  const parsed = parseHttpUrl(url);
  return parsed.origin;
}

export function joinEndpoint(baseUrl: string, suffix: string): string {
  const parsed = parseHttpUrl(baseUrl);
  parsed.hash = "";
  const suffixPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}${suffixPath}`;
  return parsed.toString();
}

function truncate(s: string, maxLen = 2000): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...(+${s.length - maxLen} chars)`;
}

export function extractErrorMessageFromBody(body: string): string {
  const s = body.trim();
  if (!s) return "";
  try {
    const data: unknown = JSON.parse(s);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const err = (data as { error?: unknown }).error;
      if (err && typeof err === "object" && !Array.isArray(err)) {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === "string" && msg) return truncate(msg);
      }
    }
  } catch {
    // fall through
  }
  return truncate(body);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

export function raiseHttpJsonError(
  status: number,
  url: string,
  body = "",
  headers: Record<string, string | string[] | undefined> = {},
): never {
  const message = extractErrorMessageFromBody(body);
  const bodyPart = message ? `; body=${JSON.stringify(message)}` : "";
  if (status === 480) {
    throw new SignerRefreshRequired(
      `Signer returned HTTP 480 (refresh session required) (url=${url})${bodyPart}`,
      headerValue(headers, REFRESH_SESSION_ORCHESTRATOR_URL_HEADER),
    );
  }
  if (status === 482) {
    throw new SkipPaymentCycle(
      `Signer returned HTTP 482 (skip payment cycle) (url=${url})${bodyPart}`,
    );
  }
  throw new LivepeerHTTPError(
    status,
    url,
    body,
    `HTTP ${status} from endpoint (url=${url})${bodyPart}`,
  );
}

function jsonRequestParts(options: HttpRequestOptions): {
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
} {
  const headers: Record<string, string> = {
    Accept: options.accept ?? "application/json",
    "User-Agent": USER_AGENT,
  };
  let body: string | undefined;
  if (options.payload !== undefined && options.payload !== null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.payload);
  }
  if (options.headers) Object.assign(headers, options.headers);
  const method =
    options.method?.toUpperCase() ??
    (options.payload !== undefined && options.payload !== null ? "POST" : "GET");
  return { method, headers, body };
}

export async function requestBody(
  url: string,
  options: HttpRequestOptions = {},
): Promise<{
  body: Buffer;
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const { method, headers, body } = jsonRequestParts(options);
  const parsed = parseHttpUrl(url);
  try {
    const res = await request(parsed.toString(), {
      method,
      headers,
      body,
      dispatcher: dispatcherFor(options.insecureTls === true),
      signal: AbortSignal.timeout(timeoutMs),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    const contentType =
      typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : "";
    if (res.statusCode >= 400) {
      raiseHttpJsonError(
        res.statusCode,
        parsed.toString(),
        raw.toString("utf8"),
        res.headers as Record<string, string | string[] | undefined>,
      );
    }
    return {
      body: raw,
      contentType,
      headers: res.headers as Record<string, string | string[] | undefined>,
    };
  } catch (e) {
    if (
      e instanceof SignerRefreshRequired ||
      e instanceof SkipPaymentCycle ||
      e instanceof LivepeerGatewayError
    ) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : "Error";
    if (name === "AbortError" || name === "TimeoutError" || msg.includes("timeout")) {
      throw new LivepeerGatewayError(
        `HTTP JSON error: failed to reach endpoint: timeout (url=${parsed.toString()})`,
      );
    }
    if (msg.includes("ECONNREFUSED")) {
      throw new LivepeerGatewayError(
        `HTTP JSON error: connection refused (is the server running? is the host/port correct?) (url=${parsed.toString()})`,
      );
    }
    throw new LivepeerGatewayError(
      `HTTP JSON error: unexpected error: ${name}: ${msg} (url=${parsed.toString()})`,
    );
  }
}

export async function requestJson(url: string, options: HttpRequestOptions = {}): Promise<unknown> {
  const { body } = await requestBody(url, options);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch (e) {
    throw new LivepeerGatewayError(
      `HTTP JSON error: endpoint did not return valid JSON: ${e} (url=${url})`,
    );
  }
}

export async function postJson(
  url: string,
  payload: Record<string, unknown>,
  options: Omit<HttpRequestOptions, "payload" | "method"> = {},
): Promise<Record<string, unknown>> {
  const data = await requestJson(url, { ...options, method: "POST", payload });
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LivepeerGatewayError(
      `HTTP JSON error: expected JSON object, got ${Array.isArray(data) ? "array" : typeof data} (url=${url})`,
    );
  }
  return data as Record<string, unknown>;
}

export async function getJson(
  url: string,
  options: Omit<HttpRequestOptions, "payload" | "method"> = {},
): Promise<unknown> {
  return requestJson(url, { ...options, method: "GET" });
}

export async function postEmpty(
  url: string,
  options: Omit<HttpRequestOptions, "payload" | "method"> = {},
): Promise<void> {
  await requestBody(url, { ...options, method: "POST" });
}

export function isJsonContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime) return false;
  const slash = mime.lastIndexOf("/");
  const subtype = slash >= 0 ? mime.slice(slash + 1) : mime;
  return subtype === "json" || subtype.endsWith("+json");
}
