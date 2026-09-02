import { LivepeerGatewayError } from "../errors.js";
import { consumeStreamBody, headerValue, requestBody, requestStream } from "../http.js";
import { ByteQueue, Mutex, QueueTimeoutError } from "./queue.js";

const PUT_TIMEOUT_MS = 5_000;

export class TricklePublishError extends LivepeerGatewayError {
  constructor(message: string) {
    super(message);
    this.name = "TricklePublishError";
  }
}

export class TrickleSegmentWriteError extends TricklePublishError {
  readonly seq: number;
  readonly url: string | null;
  readonly status: number | null;

  constructor(
    message: string,
    options: { seq: number; url?: string | null; status?: number | null } = { seq: -1 },
  ) {
    super(message);
    this.name = "TrickleSegmentWriteError";
    this.seq = options.seq;
    this.url = options.url ?? null;
    this.status = options.status ?? null;
  }
}

export class TricklePublisherTerminalError extends TricklePublishError {
  readonly consecutiveFailures: number;
  readonly url: string | null;

  constructor(message: string, consecutiveFailures: number, url: string | null = null) {
    super(message);
    this.name = "TricklePublisherTerminalError";
    this.consecutiveFailures = consecutiveFailures;
    this.url = url;
  }
}

export interface TricklePublisherOptions {
  mimeType: string;
  startSeq?: number;
  connectionClose?: boolean;
  maxConsecutiveFailures?: number;
  insecureTls?: boolean;
}

export interface TricklePublisherStats {
  elapsedS: number;
  segmentsStarted: number;
  segmentsCompleted: number;
  emptySegmentsCompleted: number;
  segmentsFailed: number;
  postAttempts: number;
  postRetriesNoBodyConsumed: number;
  postSuccess: number;
  postHttpFailures: number;
  postExceptions: number;
  post404: number;
  segmentWriterPutTimeouts: number;
  bytesSubmittedToTransport: number;
  terminalFailures: number;
  seq: number;
  consecutiveFailures: number;
  terminalError: boolean;
}

interface SegmentPostState {
  seq: number;
  queue: ByteQueue;
  error: TrickleSegmentWriteError | null;
  sendReset: boolean;
  abort: AbortController;
  done: Promise<void>;
}

/**
 * Trickle publisher: sequential `POST {channel}/{seq}` with a streaming body,
 * `Lp-Trickle-Reset` on the first segment after seq was unresolved, `DELETE {channel}`
 * on close. Mirrors livepeer-python-gateway `trickle_publisher.py`.
 */
export class TricklePublisher {
  readonly url: string;
  readonly mimeType: string;
  seq: number;
  private readonly connectionClose: boolean;
  private readonly maxConsecutiveFailures: number;
  private readonly insecureTls: boolean;
  private readonly lock = new Mutex();
  private closing = false;
  private closed = false;
  private terminalError: TricklePublisherTerminalError | null = null;
  private consecutiveFailures = 0;
  private nextState: SegmentPostState | null = null;
  private preconnectTask: Promise<void> | null = null;
  private readonly posts = new Set<Promise<void>>();
  private readonly startedAt = Date.now();
  private readonly counts = {
    segmentsStarted: 0,
    segmentsCompleted: 0,
    emptySegmentsCompleted: 0,
    segmentsFailed: 0,
    postAttempts: 0,
    postRetriesNoBodyConsumed: 0,
    postSuccess: 0,
    postHttpFailures: 0,
    postExceptions: 0,
    post404: 0,
    segmentWriterPutTimeouts: 0,
    bytesSubmittedToTransport: 0,
    terminalFailures: 0,
  };

  constructor(url: string, options: TricklePublisherOptions | string) {
    this.url = url.replace(/\/+$/, "");
    if (typeof options === "string") {
      this.mimeType = options;
      this.seq = -1;
      this.connectionClose = false;
      this.maxConsecutiveFailures = 3;
      this.insecureTls = true;
    } else {
      this.mimeType = options.mimeType;
      this.seq = options.startSeq ?? -1;
      this.connectionClose = options.connectionClose === true;
      this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? 3);
      this.insecureTls = options.insecureTls !== false;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private streamUrl(seq: number): string {
    return `${this.url}/${seq}`;
  }

  private assertOpen(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closed) {
      throw new TricklePublisherTerminalError(
        "Trickle publisher is closed",
        this.consecutiveFailures,
        this.url,
      );
    }
    if (this.closing) {
      throw new TricklePublisherTerminalError(
        "Trickle publisher is closing",
        this.consecutiveFailures,
        this.url,
      );
    }
  }

  private preconnect(seq: number, sendReset = false): SegmentPostState {
    const state: SegmentPostState = {
      seq,
      queue: new ByteQueue(),
      error: null,
      sendReset,
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    const task = this.runPost(this.streamUrl(seq), state);
    this.posts.add(task);
    void task.finally(() => this.posts.delete(task));
    state.done = task;
    return state;
  }

  private async runPost(url: string, state: SegmentPostState): Promise<void> {
    if (this.closing || this.closed) return;
    let finalError: TrickleSegmentWriteError | null = null;
    let finalStatus: number | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.closing || this.closed) return;
      this.counts.postAttempts += 1;
      state.queue.consumed = false;
      const headers: Record<string, string> = { "Content-Type": this.mimeType };
      if (state.sendReset) headers["Lp-Trickle-Reset"] = "1";
      if (this.connectionClose) headers.Connection = "close";
      try {
        const res = await requestStream(url, {
          method: "POST",
          headers,
          body: state.queue.iterate(),
          insecureTls: this.insecureTls,
          signal: state.abort.signal,
        });
        finalStatus = res.statusCode;
        const body = await consumeStreamBody(res.body);
        if (res.statusCode === 200) {
          this.consecutiveFailures = 0;
          this.counts.postSuccess += 1;
          this.counts.segmentsCompleted += 1;
          if (!state.queue.consumed) this.counts.emptySegmentsCompleted += 1;
          return;
        }
        this.counts.postHttpFailures += 1;
        finalError = new TrickleSegmentWriteError(
          `Trickle POST failed url=${url} status=${res.statusCode} body=${body.toString("utf8")}`,
          { seq: state.seq, url, status: res.statusCode },
        );
      } catch (e) {
        if (this.closing || this.closed) return;
        this.counts.postExceptions += 1;
        const err = new TrickleSegmentWriteError(`Trickle POST exception url=${url}`, {
          seq: state.seq,
          url,
        });
        err.cause = e;
        finalError = err;
        finalStatus = null;
      }

      if (finalStatus === 404) {
        this.counts.post404 += 1;
        break;
      }
      if (!state.queue.consumed && attempt === 0) {
        this.counts.postRetriesNoBodyConsumed += 1;
        continue;
      }
      break;
    }

    if (!finalError) return;
    this.recordSegmentFailure(finalError, state);
    if (finalStatus === 404 && this.terminalError === null) {
      this.markTerminal("Trickle publisher channel does not exist", finalError);
    }
  }

  private recordSegmentFailure(exc: TrickleSegmentWriteError, state: SegmentPostState): void {
    state.error = exc;
    this.counts.segmentsFailed += 1;
    this.consecutiveFailures += 1;
    if (
      this.terminalError === null &&
      this.consecutiveFailures >= this.maxConsecutiveFailures
    ) {
      this.markTerminal("Trickle publisher reached terminal failure state", exc);
    }
  }

  private markTerminal(message: string, cause: Error): void {
    const terminal = new TricklePublisherTerminalError(
      message,
      this.consecutiveFailures,
      this.url,
    );
    terminal.cause = cause;
    this.terminalError = terminal;
    this.counts.terminalFailures += 1;
  }

  async create(): Promise<void> {
    this.assertOpen();
    await requestBody(this.url, {
      method: "POST",
      headers: { "Expect-Content": this.mimeType },
      payload: {},
      insecureTls: this.insecureTls,
      timeoutMs: 5_000,
    });
  }

  private async resolveNextSeq(): Promise<number> {
    try {
      const res = await requestStream(`${this.url}/next`, {
        method: "GET",
        insecureTls: this.insecureTls,
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      void consumeStreamBody(res.body);
      const latest = headerValue(res.headers, "Lp-Trickle-Latest");
      if (latest !== null) return Number.parseInt(latest, 10);
    } catch {
      // fall through to -1
    }
    return -1;
  }

  async next(): Promise<SegmentWriter> {
    this.assertOpen();
    return this.lock.run(async () => {
      this.assertOpen();
      let sendReset = false;
      if (this.seq < 0) {
        sendReset = true;
        this.seq = await this.resolveNextSeq();
      }
      if (this.nextState === null || this.nextState.seq !== this.seq) {
        this.nextState = this.preconnect(this.seq, sendReset);
      }
      const state = this.nextState;
      this.nextState = null;
      this.counts.segmentsStarted += 1;
      this.seq += 1;
      this.preconnectTask = this.preconnectNext(this.seq);
      return new SegmentWriter(state, {
        errorGetter: () => this.terminalError,
        onWriteBytes: (n) => {
          this.counts.bytesSubmittedToTransport += Math.max(0, n);
        },
        onWriteTimeout: () => {
          this.counts.segmentWriterPutTimeouts += 1;
        },
      });
    });
  }

  private async preconnectNext(seq: number): Promise<void> {
    if (this.closing || this.closed || this.terminalError) return;
    await this.lock.run(async () => {
      if (this.closing || this.closed || this.terminalError) return;
      if (this.nextState !== null) return;
      if (this.seq !== seq) return;
      this.nextState = this.preconnect(seq);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (this.nextState !== null) {
      await new SegmentWriter(this.nextState).close();
      this.nextState = null;
    }
    await Promise.allSettled([this.preconnectTask, ...this.posts]);
    try {
      const res = await requestStream(this.url, {
        method: "DELETE",
        insecureTls: this.insecureTls,
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      void consumeStreamBody(res.body);
    } catch {
      // best-effort shutdown
    }
    this.closed = true;
  }

  getStats(): TricklePublisherStats {
    return {
      elapsedS: Math.max(0, (Date.now() - this.startedAt) / 1000),
      segmentsStarted: this.counts.segmentsStarted,
      segmentsCompleted: this.counts.segmentsCompleted,
      emptySegmentsCompleted: this.counts.emptySegmentsCompleted,
      segmentsFailed: this.counts.segmentsFailed,
      postAttempts: this.counts.postAttempts,
      postRetriesNoBodyConsumed: this.counts.postRetriesNoBodyConsumed,
      postSuccess: this.counts.postSuccess,
      postHttpFailures: this.counts.postHttpFailures,
      postExceptions: this.counts.postExceptions,
      post404: this.counts.post404,
      segmentWriterPutTimeouts: this.counts.segmentWriterPutTimeouts,
      bytesSubmittedToTransport: this.counts.bytesSubmittedToTransport,
      terminalFailures: this.counts.terminalFailures,
      seq: this.seq,
      consecutiveFailures: this.consecutiveFailures,
      terminalError: this.terminalError !== null,
    };
  }
}

export class SegmentWriter {
  private readonly state: SegmentPostState;
  private readonly errorGetter?: () => TricklePublisherTerminalError | null;
  private readonly onWriteBytes?: (n: number) => void;
  private readonly onWriteTimeout?: () => void;

  constructor(
    state: SegmentPostState,
    hooks: {
      errorGetter?: () => TricklePublisherTerminalError | null;
      onWriteBytes?: (n: number) => void;
      onWriteTimeout?: () => void;
    } = {},
  ) {
    this.state = state;
    this.errorGetter = hooks.errorGetter;
    this.onWriteBytes = hooks.onWriteBytes;
    this.onWriteTimeout = hooks.onWriteTimeout;
  }

  seq(): number {
    return this.state.seq;
  }

  async write(data: Uint8Array | Buffer | string): Promise<void> {
    const terminal = this.errorGetter?.();
    if (terminal) throw terminal;
    if (this.state.error) throw this.state.error;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    try {
      await this.state.queue.push(bytes, PUT_TIMEOUT_MS);
      this.onWriteBytes?.(bytes.byteLength);
    } catch (e) {
      if (e instanceof QueueTimeoutError) {
        this.onWriteTimeout?.();
        const again = this.errorGetter?.();
        if (again) throw again;
        throw new TrickleSegmentWriteError(
          `Trickle segment writer timed out after ${PUT_TIMEOUT_MS / 1000}s`,
          { seq: this.state.seq },
        );
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.state.error) return;
    await this.state.queue.close(PUT_TIMEOUT_MS);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
