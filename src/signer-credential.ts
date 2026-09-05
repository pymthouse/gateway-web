import type {
  HeadersMap,
  SignerCredentialInput,
  SignerCredentialMaterial,
  SignerCredentialProvider,
} from "./types.js";

export const DEFAULT_SIGNER_REFRESH_SKEW_MS = 30_000;

export interface SignerCredentialOptions {
  skewMs?: number;
}

let nextProviderId = 1;

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

function isMaterial(
  value: SignerCredentialMaterial | HeadersMap,
): value is SignerCredentialMaterial {
  const headers = (value as SignerCredentialMaterial).headers;
  return Boolean(headers) && typeof headers === "object" && !Array.isArray(headers);
}

function normalizeMaterial(value: SignerCredentialMaterial | HeadersMap): SignerCredentialMaterial {
  if (isMaterial(value)) {
    return {
      headers: copyHeaders(value.headers),
      expiresInSeconds: value.expiresInSeconds,
    };
  }
  return { headers: copyHeaders(value) };
}

/**
 * Resolves signer request headers, optionally rotating them before expiry or
 * after HTTP 480. A static header bag never refreshes.
 */
export class SignerCredential {
  readonly key: string;
  private readonly provider: SignerCredentialProvider | undefined;
  private readonly skewMs: number;
  private cached: HeadersMap | undefined;
  private expiresAtMs: number | undefined;
  private stale = false;
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
      return new SignerCredential({
        key: `provider:${nextProviderId++}`,
        provider: input,
        skewMs,
      });
    }
    const headers = input ? copyHeaders(input) : undefined;
    return new SignerCredential({
      key: freezeHeaders(headers),
      cached: headers,
      skewMs,
    });
  }

  invalidate(): void {
    this.stale = true;
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
    const value = await provider();
    const material = normalizeMaterial(value);
    this.cached = material.headers;
    this.stale = false;
    const ttl = material.expiresInSeconds;
    this.expiresAtMs =
      ttl !== undefined && Number.isFinite(ttl) ? Date.now() + ttl * 1000 : undefined;
    return this.cached;
  }
}
