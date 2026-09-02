import { Writable } from "node:stream";
import {
  TricklePublisher,
  type SegmentWriter,
  type TricklePublisherOptions,
} from "@pymthouse/gateway-web";
import type { Encoder, Muxer } from "node-av/api";
import type { Packet } from "node-av";
import { loadNodeAv, type NodeAvModules } from "./load-av.js";

export interface VideoOutputConfig {
  fps?: number;
  keyframeIntervalS?: number;
  bitrate?: string;
  pixFmt?: "yuv420p";
}

export interface MediaPublishConfig {
  mimeType?: string;
  video?: VideoOutputConfig;
  minSegmentWallclockS?: number;
  trickle?: Omit<TricklePublisherOptions, "mimeType">;
}

export interface VideoFrameInput {
  width: number;
  height: number;
  data: Uint8Array;
  pts?: number;
  timeBaseNum?: number;
  timeBaseDen?: number;
}

class SegmentSink extends Writable {
  writer: SegmentWriter | null = null;

  constructor() {
    super();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const writer = this.writer;
    if (!writer) {
      callback(new Error("MediaPublish segment writer is not open"));
      return;
    }
    void writer.write(chunk).then(
      () => callback(),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }
}

/**
 * Encode video frames to H.264, mux MPEG-TS, and publish trickle segments.
 * Rotates the trickle segment on keyframes once `minSegmentWallclockS` has elapsed.
 */
export class MediaPublish {
  readonly url: string;
  private readonly mimeType: string;
  private readonly fps: number;
  private readonly keyframeIntervalS: number;
  private readonly bitrate: string;
  private readonly minSegmentWallclockS: number;
  private readonly trickleOpts: Omit<TricklePublisherOptions, "mimeType">;
  private publisher: TricklePublisher | null = null;
  private av: NodeAvModules | null = null;
  private encoder: Encoder | null = null;
  private muxer: Muxer | null = null;
  private streamIndex = 0;
  private sink: SegmentSink | null = null;
  private opened = false;
  private closed = false;
  private frameIndex = 0;
  private segmentStartedAt = 0;
  private width = 0;
  private height = 0;

  constructor(url: string, config: MediaPublishConfig = {}) {
    this.url = url;
    this.mimeType = config.mimeType ?? "video/mp2t";
    this.fps = Math.max(1, Math.round(config.video?.fps ?? 30));
    this.keyframeIntervalS = config.video?.keyframeIntervalS ?? 2;
    this.bitrate = config.video?.bitrate ?? "1M";
    this.minSegmentWallclockS = config.minSegmentWallclockS ?? 1;
    this.trickleOpts = config.trickle ?? {};
  }

  async writeFrame(frame: VideoFrameInput): Promise<void> {
    if (this.closed) throw new Error("MediaPublish is closed");
    await this.ensureOpen(frame);
    const av = this.av!;
    const videoFrame = av.lib.Frame.fromVideoBuffer(Buffer.from(frame.data), {
      width: frame.width,
      height: frame.height,
      format: av.constants.AV_PIX_FMT_YUV420P,
      timeBase: { num: frame.timeBaseNum ?? 1, den: frame.timeBaseDen ?? this.fps },
    });
    videoFrame.pts = BigInt(frame.pts ?? this.frameIndex);
    this.frameIndex += 1;
    try {
      const packets = await this.encoder!.encodeAll(videoFrame);
      for (const packet of packets) {
        await this.writePacket(packet);
      }
    } finally {
      videoFrame.free();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.encoder) {
        for await (const packet of this.encoder.flushPackets()) {
          await this.writePacket(packet);
        }
      }
    } catch {
      // flush is best-effort
    }
    try {
      await this.muxer?.close();
    } catch {
      // ignore
    }
    if (this.sink?.writer) {
      await this.sink.writer.close();
      this.sink.writer = null;
    }
    await this.publisher?.close();
    this.encoder?.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async ensureOpen(frame: VideoFrameInput): Promise<void> {
    if (this.opened) return;
    this.av = await loadNodeAv();
    this.width = frame.width;
    this.height = frame.height;
    const gopSize = Math.max(1, Math.round(this.fps * this.keyframeIntervalS));
    this.encoder = await this.av.api.Encoder.create(this.av.constants.FF_ENCODER_LIBX264, {
      bitrate: this.bitrate,
      gopSize,
      maxBFrames: 0,
      context: {
        width: frame.width,
        height: frame.height,
        pixelFormat: this.av.constants.AV_PIX_FMT_YUV420P,
        timeBase: new this.av.lib.Rational(1, this.fps),
        framerate: new this.av.lib.Rational(this.fps, 1),
      },
      options: {
        preset: "ultrafast",
        tune: "zerolatency",
        "forced-idr": true,
      },
    });
    this.sink = new SegmentSink();
    this.muxer = await this.av.api.Muxer.open(this.sink, { format: "mpegts" });
    this.streamIndex = this.muxer.addStream(this.encoder);
    this.publisher = new TricklePublisher(this.url, {
      mimeType: this.mimeType,
      ...this.trickleOpts,
    });
    this.sink.writer = await this.publisher.next();
    this.segmentStartedAt = Date.now();
    this.opened = true;
  }

  private async writePacket(packet: Packet): Promise<void> {
    const av = this.av!;
    const isKey = (packet.flags & av.constants.AV_PKT_FLAG_KEY) !== 0;
    const elapsed = (Date.now() - this.segmentStartedAt) / 1000;
    if (
      isKey &&
      this.opened &&
      elapsed >= this.minSegmentWallclockS &&
      this.publisher &&
      this.sink?.writer
    ) {
      await this.sink.writer.close();
      this.sink.writer = await this.publisher.next();
      this.segmentStartedAt = Date.now();
    }
    await this.muxer!.writePacket(packet, this.streamIndex);
    packet.free();
  }
}
