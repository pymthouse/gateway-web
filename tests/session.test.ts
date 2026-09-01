import { describe, expect, it } from "vitest";
import { LivepeerGatewayError } from "../src/errors.js";
import { createGateway } from "../src/inference.js";
import { callSession, reserveSession, stopSession } from "../src/session.js";
import { clearSignerInfoCache, PAYMENT_INTERVAL_MS } from "../src/signer.js";
import type { LiveRunnerInstance } from "../src/types.js";
import { json, startMockServer } from "./mock-server.js";

function persistentRunner(
  origin: string,
  overrides: Partial<LiveRunnerInstance> = {},
): LiveRunnerInstance {
  return {
    url: `${origin}/apps/hello/session`,
    app: "livepeer-example/hello-world",
    runnerId: "hello",
    mode: "persistent",
    orchestratorUrl: origin,
    raw: {},
    priceInfo: { price: 1, currency: "usd", unit: "seconds" },
    ...overrides,
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

describe("session", () => {
  it("reserve POSTs the discovery URL unmodified and parses all three fields", async () => {
    const reserved: string[] = [];
    const server = await startMockServer((req, res) => {
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello/session") {
        reserved.push(req.pathname);
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const handle = await reserveSession({
        runner: persistentRunner(server.origin, {
          priceInfo: { price: 1, currency: "usd", unit: "fixed" },
        }),
        signerUrl: server.origin,
        payload: { name: "livepeer" },
      });
      expect(reserved).toEqual(["/apps/hello/session"]);
      expect(handle.sessionId).toBe("sess-1");
      expect(handle.appUrl).toBe(`${server.origin}/apps/hello/app`);
      expect(handle.controlUrl).toBe(`${server.origin}/control/sess-1`);
      expect(handle.runnerUrl).toBe(`${server.origin}/apps/hello/session`);
      await handle.stopPayments();
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("reserve throws when control_url is missing", async () => {
    const server = await startMockServer((req, res) => {
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello/session") {
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
        });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      await expect(
        reserveSession({
          runner: persistentRunner(server.origin, {
            priceInfo: { price: 1, currency: "usd", unit: "fixed" },
          }),
          signerUrl: server.origin,
        }),
      ).rejects.toThrow(/missing control_url/);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("402 on reserve pays and retries", async () => {
    let sessionHits = 0;
    const server = await startMockServer((req, res) => {
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello/session") {
        sessionHits += 1;
        if (sessionHits === 1) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        expect(req.headers["livepeer-payment"]).toBe("PAY");
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const handle = await reserveSession({
        runner: persistentRunner(server.origin, {
          priceInfo: { price: 1, currency: "usd", unit: "fixed" },
        }),
        signerUrl: server.origin,
      });
      expect(sessionHits).toBe(2);
      expect(handle.sessionId).toBe("sess-1");
      await handle.stopPayments();
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("stop POSTs control_url/stop and is idempotent", async () => {
    const stops: string[] = [];
    const server = await startMockServer((req, res) => {
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello/session") {
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      if (req.pathname === "/control/sess-1/stop") {
        expect(req.method).toBe("POST");
        stops.push(req.pathname);
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const handle = await reserveSession({
        runner: persistentRunner(server.origin, {
          priceInfo: { price: 1, currency: "usd", unit: "fixed" },
        }),
        signerUrl: server.origin,
      });
      await stopSession(handle);
      expect(stops).toEqual(["/control/sess-1/stop"]);
      expect(handle.released).toBe(true);
      await stopSession(handle);
      expect(stops).toEqual(["/control/sess-1/stop"]);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("callSession requires endpoint and POSTs app_url + path", async () => {
    const server = await startMockServer((req, res) => {
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello/session") {
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      if (req.pathname === "/apps/hello/app/hello") {
        const body = req.json() as Record<string, unknown>;
        expect(body.name).toBe("livepeer");
        json(res, 200, { message: "Hello, livepeer!" });
        return;
      }
      if (req.pathname === "/control/sess-1/stop") {
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const handle = await reserveSession({
        runner: persistentRunner(server.origin, {
          priceInfo: { price: 1, currency: "usd", unit: "fixed" },
        }),
        signerUrl: server.origin,
      });
      await expect(callSession(handle, { endpoint: "" })).rejects.toBeInstanceOf(
        LivepeerGatewayError,
      );
      const result = await callSession(handle, {
        endpoint: "/hello",
        payload: { name: "livepeer" },
      });
      expect(result.data.message).toBe("Hello, livepeer!");
      expect(result.runnerUrl).toBe(`${server.origin}/apps/hello/app/hello`);
      await stopSession(handle);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("metered funding continues after reserve and is cancelled before stop", async () => {
    let payments = 0;
    let payPosts = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/sign-orchestrator-info") {
        json(res, 200, { address: "0xabc", signature: "0xsig" });
        return;
      }
      if (req.pathname === "/generate-live-payment") {
        payments += 1;
        json(res, 200, { payment: "PAY", segCreds: "SEG", state: { n: payments } });
        return;
      }
      if (req.pathname === "/pay") {
        payPosts += 1;
        json(res, 200, {});
        return;
      }
      if (req.pathname === "/apps/hello/session") {
        if (!req.headers["livepeer-payment"]) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      if (req.pathname === "/control/sess-1/stop") {
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const handle = await reserveSession({
        runner: persistentRunner(server.origin),
        signerUrl: server.origin,
      });
      const paymentsAfterReserve = payments;
      expect(paymentsAfterReserve).toBeGreaterThanOrEqual(1);
      await new Promise((resolve) => setTimeout(resolve, PAYMENT_INTERVAL_MS + 500));
      expect(payments).toBeGreaterThan(paymentsAfterReserve);
      expect(payPosts).toBeGreaterThan(0);
      await stopSession(handle);
      const afterStop = payments;
      await new Promise((resolve) => setTimeout(resolve, PAYMENT_INTERVAL_MS + 500));
      expect(payments).toBe(afterStop);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  }, 15_000);

  it("runInference on a persistent-only app reserves, calls, and stops", async () => {
    const hits: string[] = [];
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: req.url.origin,
            runners: [
              {
                app: "livepeer-example/hello-world",
                url: `${req.url.origin}/apps/hello/session`,
                mode: "persistent",
                runner_id: "hello",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
        ]);
        return;
      }
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello/session") {
        hits.push("reserve");
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      if (req.pathname === "/apps/hello/app/hello") {
        hits.push("call");
        json(res, 200, { message: "Hello, livepeer!" });
        return;
      }
      if (req.pathname === "/control/sess-1/stop") {
        hits.push("stop");
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const gw = createGateway({ signerUrl: server.origin, timeoutMs: 5_000 });
      const res = await gw.runInference({
        capability: "livepeer-example/hello-world",
        endpoint: "/hello",
        params: { name: "livepeer" },
      });
      expect(res.mode).toBe("persistent");
      expect(res.data.message).toBe("Hello, livepeer!");
      expect(hits).toEqual(["reserve", "call", "stop"]);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("runInference stops the session even when the app call throws", async () => {
    const hits: string[] = [];
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: req.url.origin,
            runners: [
              {
                app: "livepeer-example/hello-world",
                url: `${req.url.origin}/apps/hello/session`,
                mode: "persistent",
                runner_id: "hello",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
        ]);
        return;
      }
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello/session") {
        hits.push("reserve");
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      if (req.pathname === "/apps/hello/app/hello") {
        hits.push("call");
        json(res, 500, { error: "boom" });
        return;
      }
      if (req.pathname === "/control/sess-1/stop") {
        hits.push("stop");
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const gw = createGateway({ signerUrl: server.origin, timeoutMs: 5_000 });
      await expect(
        gw.runInference({
          capability: "livepeer-example/hello-world",
          endpoint: "/hello",
        }),
      ).rejects.toThrow(/all 1 orchestrator/);
      expect(hits).toEqual(["reserve", "call", "stop"]);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("mixed-mode pool uses each runner's own path", async () => {
    const hits: string[] = [];
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: `${req.url.origin}/orch-shot`,
            runners: [
              {
                app: "livepeer-example/hello-world",
                url: `${req.url.origin}/apps/hello-shot/app`,
                mode: "single-shot",
                runner_id: "shot",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
          {
            address: `${req.url.origin}/orch-persist`,
            runners: [
              {
                app: "livepeer-example/hello-world",
                url: `${req.url.origin}/apps/hello/session`,
                mode: "persistent",
                runner_id: "persist",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
        ]);
        return;
      }
      if (signerHandlers(req, res)) return;
      if (req.pathname === "/apps/hello-shot/app/hello") {
        hits.push("single-shot");
        json(res, 500, { error: "CUDA error" });
        return;
      }
      if (req.pathname === "/apps/hello/session") {
        hits.push("reserve");
        json(res, 200, {
          session_id: "sess-1",
          app_url: `${req.url.origin}/apps/hello/app`,
          control_url: `${req.url.origin}/control/sess-1`,
        });
        return;
      }
      if (req.pathname === "/apps/hello/app/hello") {
        hits.push("persistent-call");
        json(res, 200, { message: "Hello from persist" });
        return;
      }
      if (req.pathname === "/control/sess-1/stop") {
        hits.push("stop");
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const gw = createGateway({ signerUrl: server.origin, timeoutMs: 5_000 });
      const res = await gw.runInference({
        capability: "livepeer-example/hello-world",
        endpoint: "/hello",
      });
      expect(res.mode).toBe("persistent");
      expect(res.data.message).toBe("Hello from persist");
      expect(hits).toEqual(["single-shot", "reserve", "persistent-call", "stop"]);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });
});
