import { consumeStreamBody, headerValue, requestStream } from "../http.js";
import type { HttpHeaderBag } from "../types.js";
import { Mutex } from "./queue.js";

export interface TrickleSubscriberOptions {
  startSeq?: number;
  maxRetries?: number;
  connectionClose?: boolean;
  maxBytes?: number | null;
  insecureTls?: boolean;
}

export interface TrickleSubscriberStats {
  elapsedS: number;
  getAttempts: number;
  getRetries: number;
  get404Eos: number;
  get470Reset: number;
  getFailures: number;
  segmentsDelivered: number;
  seqGapEvents: number;
  waitMsTotal: number;
  latestSeq: number;
}

export interface SegmentReaderStats {
  chunksRead: number;
  bytesRead: number;
  readErrors: number;
  maxBytesExceeded: number;
  segmentSeq: number;
}

/**
 * One trickle GET segment. Bytes are consumed once via `read()` / async iteration.
 * Mirrors livepeer-python-gateway `segment_reader.py` headers (`Lp-Trickle-Seq`,
 * `Lp-Trickle-Closed`) without the multi-cursor replay buffer.
 */
export class SegmentReader {
  readonly headers: HttpHeaderBag;
  private readonly body: AsyncIterable<Buffer>;
  private readonly maxBytes: number | null;
  private iterator: AsyncIterator<Buffer> | null = null;
  private leftover: Buffer = Buffer.alloc(0);
  private eof = false;
  private closed = false;
  private bytesRead = 0;
  private chunksRead = 0;
  private readErrors = 0;
  private maxBytesExceeded = 0;

  constructor(
    headers: HttpHeaderBag,
    body: AsyncIterable<Buffer>,
    options: { maxBytes?: number | null } = {},
  ) {
    this.headers = headers;
    this.body = body;
    this.maxBytes = options.maxBytes === undefined ? 10 * 1024 * 1024 : options.maxBytes;
  }

  seq(): number {
    const raw = headerValue(this.headers, "Lp-Trickle-Seq");
    if (raw === null) return -1;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : -1;
  }

  eos(): boolean {
    return headerValue(this.headers, "Lp-Trickle-Closed") !== null;
  }

  async read(chunkSize = 32 * 1024): Promise<Buffer | null> {
    if (this.closed || this.eof) return null;
    if (this.leftover.length > 0) {
      const out = this.leftover.subarray(0, chunkSize);
      this.leftover = this.leftover.subarray(out.length);
      return out;
    }
    this.iterator ??= this.body[Symbol.asyncIterator]();
    try {
      const next = await this.iterator.next();
      if (next.done) {
        this.eof = true;
        return null;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.chunksRead += 1;
      this.bytesRead += chunk.length;
      if (this.maxBytes !== null && this.bytesRead > this.maxBytes) {
        this.maxBytesExceeded += 1;
        this.eof = true;
        throw new Error(
          `Trickle segment exceeds max size (${this.bytesRead} > ${this.maxBytes})`,
        );
      }
      if (chunk.length <= chunkSize) return chunk;
      this.leftover = chunk.subarray(chunkSize);
      return chunk.subarray(0, chunkSize);
    } catch (e) {
      this.readErrors += 1;
      this.eof = true;
      throw e;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (;;) {
      const chunk = await this.read();
      if (chunk === null) return;
      yield chunk;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.eof = true;
    if (this.iterator && this.iterator.return) {
      try {
        await this.iterator.return();
      } catch {
        // ignore
      }
    }
  }

  getStats(): SegmentReaderStats {
    return {
      chunksRead: this.chunksRead,
      bytesRead: this.bytesRead,
      readErrors: this.readErrors,
      maxBytesExceeded: this.maxBytesExceeded,
      segmentSeq: this.seq(),
    };
  }
}

/**
 * Trickle subscriber: `GET {channel}/{seq}` (`-1`/`-2` for latest), honors
 * `Lp-Trickle-Seq`, `Lp-Trickle-Latest`, `Lp-Trickle-Closed`. 404 is EOS, 470
 * resets to the leading edge. Mirrors `trickle_subscriber.py`.
 */
export class TrickleSubscriber {
  readonly baseUrl: string;
  private seq: number;
  private readonly maxRetries: number;
  private readonly connectionClose: boolean;
  private readonly maxBytes: number | null;
  private readonly insecureTls: boolean;
  private readonly lock = new Mutex();
  private pending: SegmentReader | null = null;
  private errored = false;
  private closing = false;
  private closed = false;
  private prefetchTask: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  private readonly counts = {
    getAttempts: 0,
    getRetries: 0,
    get404Eos: 0,
    get470Reset: 0,
    getFailures: 0,
    segmentsDelivered: 0,
    seqGapEvents: 0,
    waitMsTotal: 0,
    latestSeq: 0,
  };

  constructor(url: string, options: TrickleSubscriberOptions = {}) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.seq = options.startSeq ?? -2;
    this.maxRetries = options.maxRetries ?? 5;
    this.connectionClose = options.connectionClose === true;
    this.maxBytes = options.maxBytes ?? null;
    this.insecureTls = options.insecureTls !== false;
    this.counts.latestSeq = this.seq;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private segmentUrl(seq: number): string {
    return `${this.baseUrl}/${seq}`;
  }

  private latestSeq(headers: HttpHeaderBag, current: number): number {
    const raw = headerValue(headers, "Lp-Trickle-Latest");
    if (raw === null) return current;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : current;
  }

  private async preconnect(): Promise<SegmentReader | null> {
    if (this.closing || this.closed || this.errored) return null;
    let seq = this.seq;
    let url = this.segmentUrl(seq);
    const headers: Record<string, string> = {};
    if (this.connectionClose) headers.Connection = "close";

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      if (this.closing || this.closed || this.errored) return null;
      const started = Date.now();
      this.counts.getAttempts += 1;
      try {
        const res = await requestStream(url, {
          method: "GET",
          headers,
          insecureTls: this.insecureTls,
        });
        this.counts.waitMsTotal += Date.now() - started;
        if (res.statusCode === 200) {
          return new SegmentReader(res.headers, res.body, { maxBytes: this.maxBytes });
        }
        if (res.statusCode === 404) {
          this.counts.get404Eos += 1;
          void consumeStreamBody(res.body);
          this.errored = true;
          return null;
        }
        if (res.statusCode === 470) {
          this.counts.get470Reset += 1;
          const latest = this.latestSeq(res.headers, seq);
          this.counts.latestSeq = latest;
          void consumeStreamBody(res.body);
          seq = latest;
          this.seq = seq;
          url = this.segmentUrl(seq);
          continue;
        }
        void consumeStreamBody(res.body);
        this.counts.getFailures += 1;
      } catch {
        this.counts.waitMsTotal += Date.now() - started;
        this.counts.getFailures += 1;
      }
      if (attempt < this.maxRetries - 1) {
        this.counts.getRetries += 1;
        await sleep(500);
      }
    }
    this.errored = true;
    return null;
  }

  async next(): Promise<SegmentReader | null> {
    if (this.closing || this.closed) return null;
    return this.lock.run(async () => {
      if (this.errored) return null;
      this.pending ??= await this.preconnect();
      const segment = this.pending;
      this.pending = null;
      if (segment === null) return null;
      if (segment.eos()) {
        await segment.close();
        return null;
      }
      const seq = segment.seq();
      const expected = this.seq;
      if (seq >= 0) {
        if (expected >= 0 && seq !== expected) this.counts.seqGapEvents += 1;
        this.seq = seq + 1;
      }
      const current = seq >= 0 ? seq : expected;
      this.counts.latestSeq = this.latestSeq(segment.headers, current);
      this.counts.segmentsDelivered += 1;
      this.prefetchTask = this.preconnectNext();
      return segment;
    });
  }

  private async preconnectNext(): Promise<void> {
    if (this.closing || this.closed || this.errored) return;
    await this.lock.run(async () => {
      if (this.closing || this.closed || this.errored) return;
      if (this.pending !== null) return;
      const next = await this.preconnect();
      if (next && (this.closing || this.closed || this.errored)) {
        await next.close();
        return;
      }
      if (next) this.pending = next;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.errored = true;
    await Promise.allSettled([this.prefetchTask]);
    if (this.pending) {
      await this.pending.close();
      this.pending = null;
    }
    this.closed = true;
  }

  getStats(): TrickleSubscriberStats {
    return {
      elapsedS: Math.max(0, (Date.now() - this.startedAt) / 1000),
      getAttempts: this.counts.getAttempts,
      getRetries: this.counts.getRetries,
      get404Eos: this.counts.get404Eos,
      get470Reset: this.counts.get470Reset,
      getFailures: this.counts.getFailures,
      segmentsDelivered: this.counts.segmentsDelivered,
      seqGapEvents: this.counts.seqGapEvents,
      waitMsTotal: this.counts.waitMsTotal,
      latestSeq: this.counts.latestSeq,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
