import { describe, expect, it } from "vitest";
import { PaymentError, SignerRefreshRequired } from "../src/errors.js";
import { clearSignerInfoCache, getSignerInfo, LivePaymentSession } from "../src/signer.js";
import { json, startMockServer } from "./mock-server.js";
import {
  fixedChallenge,
  replySignOrchestratorInfo,
  shortChallenge,
  withCapturedMints,
  withLivePaymentSession,
} from "./signer-test-helpers.js";

describe("signer", () => {
  it("getSignerInfo posts /sign-orchestrator-info and caches", async () => {
    let hits = 0;
    const server = await startMockServer((req, res) => {
      expect(req.pathname).toBe("/sign-orchestrator-info");
      hits += 1;
      json(res, 200, { address: "0xabc", signature: "0xsig" });
    });
    try {
      clearSignerInfoCache();
      const a = await getSignerInfo(server.origin, { Authorization: "Bearer k" });
      const b = await getSignerInfo(server.origin, { Authorization: "Bearer k" });
      expect(a).toEqual({ address: "0xabc", sig: "0xsig" });
      expect(b).toEqual(a);
      expect(hits).toBe(1);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("LivePaymentSession mints, round-trips state, and refreshes on 480", async () => {
    let payHits = 0;
    let refreshHits = 0;
    const server = await startMockServer((req, res) => {
      if (replySignOrchestratorInfo(req, res)) return;
      if (req.pathname === "/generate-live-payment") {
        payHits += 1;
        const body = req.json() as Record<string, unknown>;
        if (payHits === 1) {
          expect(body.orchestrator).toBe("params-1");
          expect(body.type).toBe("fixed");
          expect(body.ManifestID).toBe("man-1");
          expect(body.state).toBeUndefined();
          json(res, 200, {
            payment: "pay-1",
            segCreds: "seg-1",
            state: { n: 1 },
          });
          return;
        }
        if (payHits === 2) {
          expect(body.state).toEqual({ n: 1 });
          json(res, 480, { error: { message: "refresh" } });
          return;
        }
        expect(body.orchestrator).toBe("params-2");
        expect(body.state).toEqual({ n: 1 });
        json(res, 200, {
          payment: "pay-2",
          segCreds: "seg-2",
          state: { n: 2 },
        });
        return;
      }
      if (req.pathname === "/pay/refresh-payment") {
        refreshHits += 1;
        json(res, 200, { payment_params: "params-2" });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const session = new LivePaymentSession({
        signerUrl: server.origin,
        type: "fixed",
        challenge: fixedChallenge(server.origin),
      });
      const first = await session.getPayment();
      expect(first).toEqual({ payment: "pay-1", segCreds: "seg-1" });
      const second = await session.getPayment();
      expect(second).toEqual({ payment: "pay-2", segCreds: "seg-2" });
      expect(refreshHits).toBe(1);
      expect(payHits).toBe(3);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("sends gatewayRequestId and attributionSource so tickets stay joinable", async () => {
    await withCapturedMints(
      { gatewayRequestId: "job_abc123", attributionSource: "mcp" },
      async (session, bodies, origin) => {
        await session.getPayment();
        expect(bodies[0]?.gatewayRequestId).toBe("job_abc123");
        expect(bodies[0]?.attributionSource).toBe("mcp");

        // The pair must survive a handoff, or a resumed loop bills unattributed.
        const resumed = LivePaymentSession.fromSnapshot({
          signerUrl: origin,
          snapshot: session.snapshot(),
        });
        await resumed.getPayment();
        expect(bodies[1]?.gatewayRequestId).toBe("job_abc123");
        expect(bodies[1]?.attributionSource).toBe("mcp");
      },
    );
  });

  it("omits attribution fields when the caller supplies none", async () => {
    await withCapturedMints({}, async (session, bodies) => {
      await session.getPayment();
      expect(bodies[0]).not.toHaveProperty("gatewayRequestId");
      expect(bodies[0]).not.toHaveProperty("attributionSource");
    });
  });

  it("snapshot round-trips state so fromSnapshot continues the payment sequence", async () => {
    let payHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/generate-live-payment") {
        payHits += 1;
        const body = req.json() as Record<string, unknown>;
        if (payHits === 1) {
          expect(body.state).toBeUndefined();
          json(res, 200, { payment: "pay-1", segCreds: "seg-1", state: { n: 1 } });
          return;
        }
        expect(body.state).toEqual({ n: 1 });
        expect(body.orchestrator).toBe("params-1");
        expect(body.app).toBe("livepeer-example/realtime-transcription");
        json(res, 200, { payment: "pay-2", segCreds: "seg-2", state: { n: 2 } });
        return;
      }
      json(res, 404, {});
    });
    try {
      const first = new LivePaymentSession({
        signerUrl: server.origin,
        type: "live",
        app: "livepeer-example/realtime-transcription",
        maxPrice: { price: 0.01, currency: "usd", unit: "hour" },
        challenge: fixedChallenge(server.origin),
      });
      await first.getPayment();
      const snap = first.snapshot();
      expect(snap.state).toEqual({ n: 1 });
      expect(snap.maxPrice).toEqual({ price: 0.01, currency: "usd", unit: "hour" });
      const resumed = LivePaymentSession.fromSnapshot({
        signerUrl: server.origin,
        snapshot: JSON.parse(JSON.stringify(snap)) as typeof snap,
      });
      const second = await resumed.getPayment();
      expect(second).toEqual({ payment: "pay-2", segCreds: "seg-2" });
      expect(payHits).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("480 with no prior state is not retried", async () => {
    await withLivePaymentSession(
      (req, res) => {
        if (req.pathname === "/generate-live-payment") {
          json(res, 480, {});
          return;
        }
        json(res, 404, {});
      },
      (origin) => ({ type: "live", challenge: shortChallenge(origin) }),
      async (session) => {
        await expect(session.getPayment()).rejects.toBeInstanceOf(SignerRefreshRequired);
      },
    );
  });

  it("missing payment field is PaymentError", async () => {
    await withLivePaymentSession(
      (req, res) => {
        if (req.pathname === "/generate-live-payment") {
          json(res, 200, { state: {} });
          return;
        }
        json(res, 404, {});
      },
      (origin) => ({ type: "live", challenge: shortChallenge(origin) }),
      async (session) => {
        await expect(session.getPayment()).rejects.toBeInstanceOf(PaymentError);
      },
    );
  });
});
