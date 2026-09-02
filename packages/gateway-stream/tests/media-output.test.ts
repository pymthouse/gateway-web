import { describe, expect, it } from "vitest";
import { startMockServer, trickleChannel, yuv420pGradient } from "@pymthouse/test-utils";
import { MediaOutput } from "../src/media-output.js";
import { MediaPublish } from "../src/media-publish.js";
import { NodeAvLoadError, loadNodeAv } from "../src/load-av.js";

describe("MediaOutput", () => {
  it("decodes frames a short stream leaves buffered in the decoder", async () => {
    try {
      await loadNodeAv();
    } catch (e) {
      if (e instanceof NodeAvLoadError) return;
      throw e;
    }

    const channel = trickleChannel();
    const server = await startMockServer(channel.handler);

    try {
      const pub = new MediaPublish(`${server.origin}/chan`, {
        video: { fps: 10, keyframeIntervalS: 0.2 },
        minSegmentWallclockS: 0.05,
      });
      for (let i = 0; i < 12; i += 1) {
        await pub.writeFrame({ width: 96, height: 64, data: yuv420pGradient(96, 64, i) });
        await new Promise((r) => setTimeout(r, 30));
      }
      await pub.close();

      let bytes = 0;
      const frames: { width: number; height: number }[] = [];
      const output = new MediaOutput(`${server.origin}/chan`, {
        startSeq: 0,
        maxRetries: 1,
        onBytes: (c) => {
          bytes += c.byteLength;
        },
        onFrame: (f) => {
          frames.push({ width: f.width, height: f.height });
        },
      });
      await output.start();
      await output.close();

      expect(bytes).toBeGreaterThan(0);
      // Every frame of a clip this short stays inside the decoder until it is
      // flushed, so without the end-of-stream drain this is 0.
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toEqual({ width: 96, height: 64 });
    } finally {
      await server.close();
    }
  });
});
