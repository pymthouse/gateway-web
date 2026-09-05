import { isUnauthorizedHttpError } from "./errors.js";
import type {
  HeadersMap,
  SignerCredentialInput,
  SignerCredentialMaterial,
  SignerCredentialProvider,
  SignerCredentialProviderResult,
} from "./types.js";

export const DEFAULT_SIGNER_REFRESH_SKEW_MS = 30_000;

export interface SignerCredentialOptions {
  skewMs?: number;
}

let nextProviderId = 1;

const providerCredentials = new WeakMap<SignerCredentialProvider, SignerCredential>();

export function freezeHeaders(headers: HeadersMap | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function copyHeaders(headers: HeadersMap): HeadersMap {
  return { ...headers };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expiresInSecondsOf(value: Record<string, unknown>): number | undefined {
  const ttl = value.expiresInSeconds;
  if (typeof ttl === "number" && Number.isFinite(ttl)) return ttl;
  return undefined;
}

function normalizeMaterial(value: SignerCredentialProviderResult): SignerCredentialMaterial {
  if (!isPlainObject(value)) {
    return { headers: {} };
  }
  const nested = value.headers;
  if (isPlainObject(nested)) {
    return {
      headers: copyHeaders(nested as HeadersMap),
      expiresInSeconds: expiresInSecondsOf(value),
    };
  }
  const expiresInSeconds = expiresInSecondsOf(value);
  const headers = copyHeaders(value as HeadersMap);
  if (expiresInSeconds !== undefined) delete headers.expiresInSeconds;
  return { headers, expiresInSeconds };
}

/**
 * Resolves signer request headers, optionally rotating them before expiry or
 * after HTTP 401/403/480. A static header bag never refreshes.
 */
export class SignerCredential {
  readonly key: string;
  private readonly provider: SignerCredentialProvider | undefined;
  private readonly skewMs: number;
  private cached: HeadersMap | undefined;
  private expiresAtMs: number | undefined;
  private stale = false;
  private generation = 0;
  private inflight: Promise<HeadersMap | undefined> | undefined;

  private constructor(options: {
    key: string;
    provider?: SignerCredentialProvider;
    cached?: HeadersMap;
    skewMs: number;
  }) {
    this.key = options.key;
    this.provider = options.provider;
    this.cached = options.cached;
    this.skewMs = options.skewMs;
  }

  static from(
    input?: SignerCredentialInput | SignerCredential,
    options?: SignerCredentialOptions,
  ): SignerCredential {
    if (input instanceof SignerCredential) return input;
    const skewMs = Math.max(0, options?.skewMs ?? DEFAULT_SIGNER_REFRESH_SKEW_MS);
    if (typeof input === "function") {
      const existing = providerCredentials.get(input);
      if (existing) return existing;
      const created = new SignerCredential({
        key: `provider:${nextProviderId++}`,
        provider: input,
        skewMs,
      });
      providerCredentials.set(input, created);
      return created;
    }
    const headers = input ? copyHeaders(input) : undefined;
    return new SignerCredential({
      key: freezeHeaders(headers),
      cached: headers,
      skewMs,
    });
  }

  /** Marks a provider credential stale. No-op for a static bag; returns whether a refresh will run. */
  invalidate(): boolean {
    if (!this.provider) return false;
    this.stale = true;
    this.generation += 1;
    return true;
  }

  async headers(): Promise<HeadersMap | undefined> {
    if (!this.provider) return this.cached;
    if (this.inflight !== undefined) return this.inflight;
    if (this.cached && !this.stale && !this.needsRefresh()) {
      return this.cached;
    }
    this.inflight = this.refresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  private needsRefresh(): boolean {
    if (this.expiresAtMs === undefined) return false;
    return Date.now() >= this.expiresAtMs - this.skewMs;
  }

  private async refresh(): Promise<HeadersMap | undefined> {
    const provider = this.provider;
    if (!provider) return this.cached;
    const generation = this.generation;
    const value = await provider();
    const material = normalizeMaterial(value);
    this.cached = material.headers;
    const ttl = material.expiresInSeconds;
    this.expiresAtMs = ttl !== undefined ? Date.now() + ttl * 1000 : undefined;
    this.stale = generation !== this.generation;
    return this.cached;
  }
}

/** Send once; on signer 401/403 invalidate and retry with a fresh provider token. */
export async function sendWithSignerHeaders<T>(
  credential: SignerCredential,
  send: (headers: HeadersMap | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await send(await credential.headers());
  } catch (e) {
    if (!isUnauthorizedHttpError(e) || !credential.invalidate()) throw e;
    return await send(await credential.headers());
  }
}
