export interface LiveRunnerUpstreamPrice {
  provider?: string;
  endpointId?: string;
  unit?: string;
  unitPrice?: number | string;
  currency?: string;
  fetchedAt?: string;
}

export interface LiveRunnerSellPrice {
  unit?: string;
  price: number | string;
  currency?: string;
  upchargeBps?: number;
}

export interface LiveRunnerPriceInfo {
  price: number | string;
  currency: string;
  unit: string;
  upstream?: LiveRunnerUpstreamPrice | null;
  sell?: LiveRunnerSellPrice | null;
}

export interface LiveRunnerQuote {
  quote_id: string;
  app?: string;
  manifest_id?: string;
  sell_price: number | string;
  sell_unit?: string;
  upcharge_bps?: number;
  wei_price_per_unit?: number;
  wei_pixels_per_unit?: number;
  max_units?: number | string;
  expires_at?: number;
  orch_sig?: string;
  upstream?: LiveRunnerUpstreamPrice | null;
}

export interface LiveRunnerUsageAttestation {
  quote_id: string;
  billable_units: number | string;
  sell_price: number | string;
  cost_wei: string;
  orch_sig?: string;
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
  quote?: LiveRunnerQuote | null;
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
