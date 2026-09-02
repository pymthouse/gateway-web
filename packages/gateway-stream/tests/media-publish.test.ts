import { describe, expect, it } from "vitest";
import { TrickleSubscriber } from "@pymthouse/gateway-web";
import { startMockServer, trickleChannel, yuv420pGradient } from "@pymthouse/test-utils";
import { MediaPublish } from "../src/media-publish.js";
import { NodeAvLoadError, loadNodeAv } from "../src/load-av.js";

describe("MediaPublish", () => {
  it("publishes H.264 MPEG-TS segments over trickle", async () => {
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
        video: { fps: 10, keyframeIntervalS: 0.5 },
        minSegmentWallclockS: 0.2,
      });
      for (let i = 0; i < 8; i += 1) {
        await pub.writeFrame({
          width: 64,
          height: 64,
          data: yuv420pGradient(64, 64, i),
        });
      }
      await pub.close();
      expect(channel.segments.size).toBeGreaterThan(0);

      const sub = new TrickleSubscriber(`${server.origin}/chan`, { startSeq: 0, maxRetries: 2 });
      const first = await sub.next();
      expect(first).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const c of first!) chunks.push(c);
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
      await sub.close();
    } finally {
      await server.close();
    }
  });
});
