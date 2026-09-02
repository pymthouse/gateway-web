import { PassThrough } from "node:stream";
import {
  TrickleSubscriber,
  type TrickleSubscriberOptions,
  type TrickleSubscriberStats,
} from "@pymthouse/gateway-web";
import { loadNodeAv } from "./load-av.js";

export interface DecodedVideoFrame {
  width: number;
  height: number;
  pts: number | null;
  data: Buffer;
}

/** The subset of node-av's `Frame` this module touches, kept structural so the
 * node-av import stays lazy. */
interface DecodedFrameHandle {
  width: number;
  height: number;
  pts: bigint | number | null;
  toBuffer: () => Buffer;
  free: () => void;
}

export interface MediaOutputOptions extends TrickleSubscriberOptions {
  onBytes?: (chunk: Uint8Array) => void | Promise<void>;
  onFrame?: (frame: DecodedVideoFrame) => void | Promise<void>;
}

/**
 * Subscribe to a trickle MPEG-TS channel. `onBytes` sees raw TS chunks;
 * `onFrame` decodes video frames via node-av.
 */
export class MediaOutput {
  readonly url: string;
  private readonly options: MediaOutputOptions;
  private subscriber: TrickleSubscriber | null = null;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(url: string, options: MediaOutputOptions = {}) {
    this.url = url;
    this.options = options;
  }

  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.subscriber?.close();
    try {
      await this.running;
    } catch {
      // ignore
    }
  }

  /** Transport counters, or null before `start()`. */
  getStats(): TrickleSubscriberStats | null {
    return this.subscriber?.getStats() ?? null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async run(): Promise<void> {
    this.subscriber = new TrickleSubscriber(this.url, this.options);
    const decode = this.options.onFrame !== undefined;
    let ts: PassThrough | null = null;
    let decodeTask: Promise<void> | null = null;
    if (decode) {
      ts = new PassThrough();
      decodeTask = this.decodeLoop(ts);
    }
    try {
      for (;;) {
        if (this.closed) break;
        const segment = await this.subscriber.next();
        if (segment === null) break;
        for await (const chunk of segment) {
          if (this.options.onBytes) await this.options.onBytes(chunk);
          if (ts && !ts.destroyed) ts.write(chunk);
        }
        await segment.close();
      }
    } finally {
      ts?.end();
      await decodeTask;
      await this.subscriber.close();
    }
  }

  private async decodeLoop(ts: PassThrough): Promise<void> {
    const av = await loadNodeAv();
    await using demuxer = await av.api.Demuxer.open(ts, { format: "mpegts" });
    const video = demuxer.video();
    if (!video) return;
    using decoder = await av.api.Decoder.create(video);
    for await (const packet of demuxer.packets()) {
      if (this.closed) break;
      if (!packet) continue;
      if (packet.streamIndex !== video.index) {
        packet.free();
        continue;
      }
      const frames = await decoder.decodeAll(packet);
      packet.free();
      for (const frame of frames) await this.emitFrame(frame);
    }
    // The decoder buffers frames and never drains on its own, so the tail is
    // only reachable by flushing; a stream shorter than that buffer decodes to
    // nothing at all without this.
    for await (const frame of decoder.flushFrames()) {
      await this.emitFrame(frame);
    }
  }

  private async emitFrame(frame: DecodedFrameHandle): Promise<void> {
    try {
      const data = frame.toBuffer();
      await this.options.onFrame?.({
        width: frame.width,
        height: frame.height,
        pts: Number(frame.pts),
        data,
      });
    } finally {
      frame.free();
    }
  }
}
