import { describe, expect, it } from "vitest";
import { TrickleSubscriber } from "@pymthouse/gateway-web";
import { MediaPublish } from "../src/media-publish.js";
import { NodeAvLoadError, loadNodeAv } from "../src/load-av.js";
import { json, startMockServer } from "./mock-server.js";

function yuv420p(width: number, height: number, y: number): Buffer {
  const size = (width * height * 3) / 2;
  const buf = Buffer.alloc(size, 128);
  buf.fill(y, 0, width * height);
  return buf;
}

describe("MediaPublish", () => {
  it("publishes H.264 MPEG-TS segments over trickle", async () => {
    try {
      await loadNodeAv();
    } catch (e) {
      if (e instanceof NodeAvLoadError) return;
      throw e;
    }

    const segments = new Map<string, Buffer>();
    const server = await startMockServer((req, res) => {
      if (req.method === "GET" && req.pathname.endsWith("/next")) {
        res.writeHead(200, { "Lp-Trickle-Latest": "0" });
        res.end();
        return;
      }
      if (req.method === "POST" && req.pathname.startsWith("/chan/")) {
        segments.set(req.pathname, req.bodyBuf);
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "GET" && req.pathname.startsWith("/chan/")) {
        const body = segments.get(req.pathname);
        if (!body) {
          res.writeHead(404);
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
        video: { fps: 10, keyframeIntervalS: 0.5 },
        minSegmentWallclockS: 0.2,
      });
      for (let i = 0; i < 8; i += 1) {
        await pub.writeFrame({
          width: 64,
          height: 64,
          data: yuv420p(64, 64, 40 + i * 20),
        });
      }
      await pub.close();
      expect(segments.size).toBeGreaterThan(0);

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
