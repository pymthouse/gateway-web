import { LivepeerGatewayError, RemoteSignerError } from "./errors.js";
import { getJson, httpOrigin, parseHttpUrl } from "./http.js";
import type { DiscoveryEntry, FilterValue, HeadersMap } from "./types.js";

function normalizeFilterValues(value: FilterValue | undefined): string[] {
  if (value === undefined) return [];
  const values = typeof value === "string" ? [value] : [...value];
  return values.map((item) => item.trim()).filter((item) => item.length > 0);
}

function appendQueryValues(url: string, values: Array<[string, string]>): string {
  if (values.length === 0) return url;
  const parsed = parseHttpUrl(url);
  for (const [key, val] of values) {
    parsed.searchParams.append(key, val);
  }
  return parsed.toString();
}

function appendRunnerFilters(
  url: string,
  app: FilterValue | undefined,
  gpu: FilterValue | undefined,
): string {
  const values: Array<[string, string]> = [];
  for (const item of normalizeFilterValues(app)) values.push(["app", item]);
  for (const item of normalizeFilterValues(gpu)) values.push(["gpu", item]);
  return appendQueryValues(url, values);
}

function runnerGpuName(runner: Record<string, unknown>): string {
  const gpu = runner.gpu;
  if (gpu && typeof gpu === "object" && !Array.isArray(gpu)) {
    const name = (gpu as { name?: unknown }).name;
    if (typeof name === "string") return name.trim();
  }
  return "";
}

function validRunner(runner: Record<string, unknown>): boolean {
  const url = runner.url;
  const app = runner.app;
  return (
    typeof url === "string" && Boolean(url.trim()) && typeof app === "string" && Boolean(app.trim())
  );
}

function runnerMatchesFilters(
  runner: Record<string, unknown>,
  appFilters: string[],
  gpuFilters: string[],
): boolean {
  const app = typeof runner.app === "string" ? runner.app.trim() : "";
  if (appFilters.length > 0 && !appFilters.includes(app)) return false;
  if (gpuFilters.length > 0 && !gpuFilters.includes(runnerGpuName(runner))) return false;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collectMatchingRunners(
  runners: unknown[],
  appFilters: string[],
  gpuFilters: string[],
): Array<Record<string, unknown>> {
  const matched: Array<Record<string, unknown>> = [];
  for (const runner of runners) {
    const rec = asRecord(runner);
    if (!rec || !validRunner(rec) || !runnerMatchesFilters(rec, appFilters, gpuFilters)) continue;
    matched.push(rec);
  }
  return matched;
}

function filterRunnerDiscoveryEntries(
  data: unknown[],
  appFilters: string[],
  gpuFilters: string[],
): DiscoveryEntry[] {
  const entries: DiscoveryEntry[] = [];
  for (const item of data) {
    const rec = asRecord(item);
    if (!rec || !Array.isArray(rec.runners)) continue;
    const matched = collectMatchingRunners(rec.runners, appFilters, gpuFilters);
    if (matched.length === 0) continue;
    const address = typeof rec.address === "string" ? rec.address : "";
    entries.push({ ...rec, address, runners: matched });
  }
  return entries;
}

export interface DiscoverRunnersOptions {
  signerUrl?: string;
  signerHeaders?: HeadersMap;
  discoveryUrl?: string;
  discoveryHeaders?: HeadersMap;
  app?: FilterValue;
  gpu?: FilterValue;
  timeoutMs?: number;
  /** Skip TLS verification. Default false. */
  insecureTls?: boolean;
}

export function defaultDiscoveryUrl(signerUrl: string): string {
  return `${httpOrigin(signerUrl)}/discover-orchestrators`;
}

export async function discoverRunners(options: DiscoverRunnersOptions): Promise<DiscoveryEntry[]> {
  let discoveryEndpoint: string;
  let requestHeaders: HeadersMap | undefined;
  if (options.discoveryUrl) {
    discoveryEndpoint = parseHttpUrl(options.discoveryUrl).toString();
    requestHeaders = options.discoveryHeaders;
  } else if (options.signerUrl) {
    discoveryEndpoint = defaultDiscoveryUrl(options.signerUrl);
    requestHeaders = options.signerHeaders;
  } else {
    throw new LivepeerGatewayError("discoverRunners requires discoveryUrl or signerUrl");
  }

  const appFilters = normalizeFilterValues(options.app);
  const gpuFilters = normalizeFilterValues(options.gpu);
  discoveryEndpoint = appendRunnerFilters(discoveryEndpoint, options.app, options.gpu);

  let data: unknown;
  try {
    data = await getJson(discoveryEndpoint, {
      headers: requestHeaders,
      timeoutMs: options.timeoutMs ?? 15_000,
      insecureTls: options.insecureTls === true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new RemoteSignerError(discoveryEndpoint, msg, e);
  }

  if (!Array.isArray(data)) {
    throw new RemoteSignerError(
      discoveryEndpoint,
      `Discovery response must be a JSON list, got ${data === null ? "null" : typeof data}`,
    );
  }

  return filterRunnerDiscoveryEntries(data, appFilters, gpuFilters);
}
