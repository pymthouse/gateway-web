import { describe, expect, it } from "vitest";
import { LivepeerGatewayError, LivepeerHTTPError } from "../src/errors.js";
import { getJson, httpOrigin, joinEndpoint, postJson } from "../src/http.js";
import { stripTrailingSlashes } from "../src/strings.js";
import { json, startMockServer } from "./mock-server.js";

describe("http", () => {
  it("httpOrigin strips path", () => {
    expect(httpOrigin("https://signer.example.com/foo?x=1")).toBe("https://signer.example.com");
    expect(httpOrigin("host:8935")).toBe("https://host:8935");
  });

  it("joinEndpoint appends a suffix", () => {
    expect(joinEndpoint("http://x/app", "/generate")).toBe("http://x/app/generate");
    expect(joinEndpoint("http://x/app/", "generate")).toBe("http://x/app/generate");
  });

  it("stripTrailingSlashes removes only trailing slashes", () => {
    expect(stripTrailingSlashes("https://x/app///")).toBe("https://x/app");
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("noslash")).toBe("noslash");
  });

  it("getJson / postJson round-trip", async () => {
    const server = await startMockServer((req, res) => {
      if (req.method === "GET") {
        json(res, 200, { ok: true });
        return;
      }
      json(res, 200, { echo: req.json() });
    });
    try {
      await expect(getJson(server.origin)).resolves.toEqual({ ok: true });
      await expect(postJson(`${server.origin}/p`, { a: 1 })).resolves.toEqual({
        echo: { a: 1 },
      });
    } finally {
      await server.close();
    }
  });

  it("non-2xx becomes LivepeerHTTPError", async () => {
    const server = await startMockServer((_req, res) => {
      json(res, 403, { error: { message: "nope" } });
    });
    try {
      await getJson(server.origin);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LivepeerHTTPError);
      expect((e as LivepeerHTTPError).status).toBe(403);
      expect((e as Error).message).toContain("nope");
    } finally {
      await server.close();
    }
  });

  it("invalid JSON body is LivepeerGatewayError", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not-json");
    });
    try {
      await getJson(server.origin);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LivepeerGatewayError);
      expect((e as Error).message).toMatch(/did not return valid JSON/);
    } finally {
      await server.close();
    }
  });

  it("requestStream returns the body without a timeout", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "X-Seq": "7" });
      res.end("stream-body");
    });
    try {
      const { requestStream, consumeStreamBody, headerValue } = await import("../src/http.js");
      const res = await requestStream(server.origin, { method: "GET" });
      expect(res.statusCode).toBe(200);
      expect(headerValue(res.headers, "X-Seq")).toBe("7");
      const body = await consumeStreamBody(res.body);
      expect(body.toString()).toBe("stream-body");
    } finally {
      await server.close();
    }
  });
});
