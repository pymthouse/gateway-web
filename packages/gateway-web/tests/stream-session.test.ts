import { describe, expect, it } from "vitest";
import { openStreamSession, resumeStreamSession } from "../src/stream-session.js";
import { clearSignerInfoCache } from "../src/signer.js";
import type { LiveRunnerInstance } from "../src/types.js";
import { json, startMockServer, type MockRequest } from "./mock-server.js";

function runner(origin: string): LiveRunnerInstance {
  return {
    url: `${origin}/apps/echo/session`,
    app: "livepeer-example/echo",
    runnerId: "echo",
    mode: "persistent",
    orchestratorUrl: origin,
    raw: {},
    priceInfo: { price: 0, currency: "usd", unit: "hour" },
  };
}

function signerHandlers(req: { pathname: string }, res: Parameters<typeof json>[0]): boolean {
  if (req.pathname === "/sign-orchestrator-info") {
    json(res, 200, { address: "0xabc", signature: "0xsig" });
    return true;
  }
  if (req.pathname === "/generate-live-payment") {
    json(res, 200, { payment: "PAY", segCreds: "SEG", state: { n: 1 } });
    return true;
  }
  return false;
}

describe("openStreamSession", () => {
  it("reserves, POSTs the stream endpoint, and parses in/out", async () => {
    const server = await startMockServer((req: MockRequest, res) => {
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/echo/session") {
        json(res, 200, {
          session_id: "sess-echo",
          app_url: `${req.url.origin}/apps/echo/app`,
          control_url: `${req.url.origin}/control/sess-echo`,
        });
        return;
      }
      if (req.pathname === "/apps/echo/app/echo") {
        json(res, 200, {
          session: "sess-echo",
          in: `${req.url.origin}/trickle/in`,
          out: `${req.url.origin}/trickle/out`,
          mode: "echo",
        });
        return;
      }
      if (req.pathname === "/control/sess-echo/stop") {
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const stream = await openStreamSession({
        runner: runner(server.origin),
        signerUrl: server.origin,
        endpoint: "/echo",
        streamPayload: { mode: "echo" },
      });
      expect(stream.session.sessionId).toBe("sess-echo");
      expect(stream.channelUrl("in")).toBe(`${server.origin}/trickle/in`);
      expect(stream.channelUrl("out")).toBe(`${server.origin}/trickle/out`);
      const snap = stream.snapshot();
      expect(snap.endpoint).toBe("/echo");
      expect(snap.channels.in?.url).toBe(`${server.origin}/trickle/in`);

      const resumed = resumeStreamSession({
        snapshot: snap,
        signerUrl: server.origin,
        startFunding: false,
      });
      expect(resumed.session.sessionId).toBe("sess-echo");
      expect(resumed.channelUrl("out")).toBe(`${server.origin}/trickle/out`);
      await stream.stop();
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });
});
