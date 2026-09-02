import { describe, expect, it } from "vitest";
import { TricklePublisher, TricklePublisherTerminalError } from "../src/trickle/publisher.js";
import { json, startMockServer } from "@pymthouse/test-utils";

describe("TricklePublisher", () => {
  it("POSTs seq 0 with reset, streams the body, DELETEs on close", async () => {
    const posts: { path: string; reset: string | undefined; body: string }[] = [];
    const deletes: string[] = [];
    const server = await startMockServer((req, res) => {
      if (req.method === "GET" && req.pathname.endsWith("/next")) {
        res.writeHead(200, { "Lp-Trickle-Latest": "0" });
        res.end();
        return;
      }
      if (req.method === "POST") {
        posts.push({
          path: req.pathname,
          reset: req.headers["lp-trickle-reset"] as string | undefined,
          body: req.body,
        });
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        deletes.push(req.pathname);
        res.writeHead(200);
        res.end();
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    const pub = new TricklePublisher(`${server.origin}/chan`, {
      mimeType: "video/mp2t",
    });
    try {
      const seg = await pub.next();
      expect(seg.seq()).toBe(0);
      await seg.write(Buffer.from("hello"));
      await seg.close();
      await pub.close();
      expect(posts.some((p) => p.path === "/chan/0" && p.reset === "1" && p.body === "hello")).toBe(
        true,
      );
      expect(deletes).toEqual(["/chan"]);
    } finally {
      await server.close();
    }
  });

  it("404 on POST is terminal", async () => {
    const server = await startMockServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Lp-Trickle-Latest": "0" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("gone");
    });
    const pub = new TricklePublisher(`${server.origin}/chan`, {
      mimeType: "video/mp2t",
      startSeq: 0,
    });
    try {
      const seg = await pub.next();
      await seg.write(Buffer.from("x"));
      await seg.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(pub.getStats().post404).toBeGreaterThanOrEqual(1);
      expect(pub.getStats().terminalError).toBe(true);
      await expect(pub.next()).rejects.toBeInstanceOf(TricklePublisherTerminalError);
    } finally {
      await pub.close();
      await server.close();
    }
  });
});
