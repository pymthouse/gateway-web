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
