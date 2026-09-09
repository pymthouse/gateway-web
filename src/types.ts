export interface LiveRunnerPriceInfo {
  price: number | string;
  currency: string;
  unit: string;
}

export interface LiveRunnerInstance {
  url: string;
  app: string;
  runnerId: string;
  mode: string;
  orchestratorUrl: string;
  raw: Record<string, unknown>;
  priceInfo: LiveRunnerPriceInfo | null;
}

export interface DiscoveryEntry {
  address: string;
  runners: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export type FilterValue = string | readonly string[];

export interface LivePaymentChallenge {
  paymentParams: string;
  manifestId: string;
  paymentUrl: string;
}

export interface GetPaymentResponse {
  payment: string;
  segCreds: string | null;
}

export interface SignerMaterial {
  address: string | null;
  sig: string | null;
}

export type HeadersMap = Record<string, string>;

/** Incoming HTTP header bag from undici (`string` or multi-value arrays). */
export type HttpHeaderBag = Record<string, string | string[] | undefined>;

export interface SignerCredentialMaterial {
  headers: HeadersMap;
  /**
   * Seconds until expiry. Enables refresh before use; omit to refresh only on
   * signer 401/403 or HTTP 480. A numeric `expiresInSeconds` on a bare header
   * bag is treated as TTL, not as an HTTP header.
   */
  expiresInSeconds?: number;
}

/** Header bag, optionally with a numeric TTL that is not sent as a header. */
export interface SignerCredentialBag {
  expiresInSeconds?: number;
  [header: string]: string | number | undefined;
}

export type SignerCredentialProviderResult =
  | SignerCredentialMaterial
  | HeadersMap
  | SignerCredentialBag;

export type SignerCredentialProvider = () =>
  Promise<SignerCredentialProviderResult> | SignerCredentialProviderResult;

/** Static signer headers, or a fal-style token provider that can rotate them. */
export type SignerCredentialInput = HeadersMap | SignerCredentialProvider;
