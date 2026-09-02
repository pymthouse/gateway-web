import { describe, expect, it } from "vitest";
import { json, startMockServer } from "@pymthouse/test-utils";
import { MediaOutput } from "../src/media-output.js";
import { MediaPublish } from "../src/media-publish.js";
import { NodeAvLoadError, loadNodeAv } from "../src/load-av.js";

function yuv420p(width: number, height: number, tick: number): Buffer {
  const buf = Buffer.alloc((width * height * 3) / 2, 128);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      buf[y * width + x] = (x * 2 + y + tick * 9) & 0xff;
    }
  }
  return buf;
}

describe("MediaOutput", () => {
  it("decodes frames a short stream leaves buffered in the decoder", async () => {
    try {
      await loadNodeAv();
    } catch (e) {
      if (e instanceof NodeAvLoadError) return;
      throw e;
    }

    const segments = new Map<string, Buffer>();
    const server = await startMockServer((req, res) => {
      if (req.method === "POST" && req.pathname.startsWith("/chan/")) {
        segments.set(req.pathname, req.bodyBuf);
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "GET" && req.pathname.startsWith("/chan/")) {
        const body = segments.get(req.pathname);
        if (!body) {
          res.writeHead(470);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Lp-Trickle-Seq": req.pathname.split("/").pop() ?? "0",
        });
        res.end(body);
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }
      json(res, 404, {});
    });

    try {
      const pub = new MediaPublish(`${server.origin}/chan`, {
        video: { fps: 10, keyframeIntervalS: 0.2 },
        minSegmentWallclockS: 0.05,
      });
      for (let i = 0; i < 12; i += 1) {
        await pub.writeFrame({ width: 96, height: 64, data: yuv420p(96, 64, i) });
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
