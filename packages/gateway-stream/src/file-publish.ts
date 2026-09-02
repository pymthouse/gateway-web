import { loadNodeAv } from "./load-av.js";
import { MediaPublish, type MediaPublishConfig } from "./media-publish.js";

export interface PublishFileOptions {
  path: string;
  url: string;
  fps?: number;
  maxFrames?: number;
  realtime?: boolean;
  publish?: MediaPublishConfig;
}

/**
 * Decode a local media file and publish video frames onto a trickle channel
 * at `fps` (default: the file's frame rate, else 30).
 */
export async function publishFile(options: PublishFileOptions): Promise<number> {
  const av = await loadNodeAv();
  await using input = await av.api.Demuxer.open(options.path);
  const video = input.video();
  if (!video) {
    throw new Error(`No video stream in ${options.path}`);
  }
  using decoder = await av.api.Decoder.create(video);
  const rate = video.avgFrameRate;
  const fps = options.fps ?? (rate.den !== 0 ? rate.num / rate.den : 30);
  const publisher = new MediaPublish(options.url, {
    ...options.publish,
    video: { fps, ...options.publish?.video },
  });
  const maxFrames = options.maxFrames ?? 0;
  const realtime = options.realtime !== false;
  const frameIntervalMs = 1000 / Math.max(1, fps);
  let count = 0;
  let lastWall = Date.now();
  try {
    for await (const packet of input.packets()) {
      if (!packet) continue;
      if (packet.streamIndex !== video.index) {
        packet.free();
        continue;
      }
      const frames = await decoder.decodeAll(packet);
      packet.free();
      let stop = false;
      for (const frame of frames) {
        try {
          count += 1;
          if (maxFrames > 0 && count > maxFrames) {
            stop = true;
            break;
          }
          await publisher.writeFrame({
            width: frame.width,
            height: frame.height,
            data: frame.toBuffer(),
            pts: Number(frame.pts),
          });
          if (realtime) {
            const elapsed = Date.now() - lastWall;
            const sleepMs = frameIntervalMs - elapsed;
            if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
            lastWall = Date.now();
          }
        } finally {
          frame.free();
        }
      }
      if (stop) break;
    }
  } finally {
    await publisher.close();
  }
  return count;
}
