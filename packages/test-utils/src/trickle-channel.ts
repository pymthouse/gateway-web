import { json, type MockHandler } from "./mock-server.js";

export interface TrickleChannel {
  /** Segments written so far, keyed by request path. */
  segments: Map<string, Buffer>;
  handler: MockHandler;
}

/**
 * An in-memory trickle channel for tests: POST stores a segment, GET replays it
 * with its `Lp-Trickle-Seq`, and a GET for a segment nobody has written yet gets
 * 470 the way a real channel signals "not produced".
 */
export function trickleChannel(prefix = "/chan"): TrickleChannel {
  const segments = new Map<string, Buffer>();
  const handler: MockHandler = (req, res) => {
    if (req.method === "GET" && req.pathname.endsWith("/next")) {
      res.writeHead(200, { "Lp-Trickle-Latest": "0" });
      res.end();
      return;
    }
    if (req.method === "POST" && req.pathname.startsWith(`${prefix}/`)) {
      segments.set(req.pathname, req.bodyBuf);
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "GET" && req.pathname.startsWith(`${prefix}/`)) {
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
  };
  return { segments, handler };
}

/** A yuv420p frame with a diagonal gradient that shifts with `tick`, so encoded
 * output actually varies between frames. */
export function yuv420pGradient(width: number, height: number, tick: number): Buffer {
  const buf = Buffer.alloc((width * height * 3) / 2, 128);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      buf[y * width + x] = (x * 2 + y + tick * 9) & 0xff;
    }
  }
  return buf;
}
