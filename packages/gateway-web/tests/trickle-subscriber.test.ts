import { describe, expect, it } from "vitest";
import { TrickleSubscriber } from "../src/trickle/subscriber.js";
import { json, startMockServer } from "./mock-server.js";

describe("TrickleSubscriber", () => {
  it("GETs the segment and yields bytes", async () => {
    const server = await startMockServer((req, res) => {
      if (req.method === "GET" && req.pathname === "/chan/0") {
        res.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Lp-Trickle-Seq": "0",
          "Lp-Trickle-Latest": "0",
        });
        res.end(Buffer.from("seg0"));
        return;
      }
      if (req.method === "GET") {
        res.writeHead(404);
        res.end();
        return;
      }
      json(res, 405, {});
    });
    const sub = new TrickleSubscriber(`${server.origin}/chan`, { startSeq: 0 });
    try {
      const seg = await sub.next();
      expect(seg).not.toBeNull();
      expect(seg!.seq()).toBe(0);
      const chunks: Buffer[] = [];
      for await (const chunk of seg!) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("seg0");
      const eos = await sub.next();
      expect(eos).toBeNull();
    } finally {
      await sub.close();
      await server.close();
    }
  });

  it("treats Lp-Trickle-Closed as EOS", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Lp-Trickle-Closed": "1", "Lp-Trickle-Seq": "3" });
      res.end();
    });
    const sub = new TrickleSubscriber(`${server.origin}/chan`, { startSeq: 3 });
    try {
      await expect(sub.next()).resolves.toBeNull();
    } finally {
      await sub.close();
      await server.close();
    }
  });

  it("470 resets to Lp-Trickle-Latest", async () => {
    const hits: string[] = [];
    const server = await startMockServer((req, res) => {
      hits.push(req.pathname);
      if (req.pathname === "/chan/5") {
        res.writeHead(470, { "Lp-Trickle-Latest": "2" });
        res.end();
        return;
      }
      if (req.pathname === "/chan/2") {
        res.writeHead(200, { "Lp-Trickle-Seq": "2" });
        res.end(Buffer.from("ok"));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const sub = new TrickleSubscriber(`${server.origin}/chan`, { startSeq: 5, maxRetries: 3 });
    try {
      const seg = await sub.next();
      expect(seg?.seq()).toBe(2);
      expect(hits).toContain("/chan/5");
      expect(hits).toContain("/chan/2");
    } finally {
      await sub.close();
      await server.close();
    }
  });
});
