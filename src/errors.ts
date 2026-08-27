export class LivepeerGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LivepeerGatewayError";
  }
}

export class LivepeerHTTPError extends LivepeerGatewayError {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body = "", message?: string) {
    super(message ?? `HTTP ${status} from endpoint (url=${url})`);
    this.name = "LivepeerHTTPError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface RunnerRejection {
  url: string;
  reason: string;
}

export class NoRunnerAvailableError extends LivepeerGatewayError {
  readonly rejections: RunnerRejection[];

  constructor(message: string, rejections: RunnerRejection[] = []) {
    super(message);
    this.name = "NoRunnerAvailableError";
    this.rejections = rejections;
  }

  override toString(): string {
    if (this.rejections.length === 0) return `${this.name}: ${this.message}`;
    const reasons = this.rejections.map((r) => `${r.url}: ${r.reason}`).join("; ");
    return `${this.name}: ${this.message}: ${reasons}`;
  }
}

export class SignerRefreshRequired extends LivepeerGatewayError {
  readonly orchestratorUrl: string | null;

  constructor(message: string, orchestratorUrl: string | null = null) {
    super(message);
    this.name = "SignerRefreshRequired";
    this.orchestratorUrl = orchestratorUrl;
  }
}

export class SkipPaymentCycle extends LivepeerGatewayError {
  constructor(message: string) {
    super(message);
    this.name = "SkipPaymentCycle";
  }
}

export class PaymentError extends LivepeerGatewayError {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

export class RemoteSignerError extends LivepeerGatewayError {
  readonly signerUrl: string;
  override readonly cause: unknown;

  constructor(signerUrl: string, message: string, cause: unknown = null) {
    super(`Remote signer error: ${message} (url=${signerUrl})`);
    this.name = "RemoteSignerError";
    this.signerUrl = signerUrl;
    this.cause = cause;
  }
}
