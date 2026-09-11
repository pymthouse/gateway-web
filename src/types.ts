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

/** Awaited before the signer charge and after payment credentials are returned. */
export type PaymentPhase = "prepared" | "accepted";

/**
 * Per-request payment observer. Failures abort without paid orchestrator failover.
 * Receives only the challenge manifest id — never payment bytes or signer state.
 */
export type PaymentObserver = (payment: {
  manifestId: string;
  phase: PaymentPhase;
}) => void | Promise<void>;

/** Incoming HTTP header bag from undici (`string` or multi-value arrays). */
export type HttpHeaderBag = Record<string, string | string[] | undefined>;
