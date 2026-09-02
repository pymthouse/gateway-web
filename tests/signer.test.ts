import { describe, expect, it } from "vitest";
import { PaymentError, SignerRefreshRequired } from "../src/errors.js";
import { clearSignerInfoCache, getSignerInfo, LivePaymentSession } from "../src/signer.js";
import { json, startMockServer } from "./mock-server.js";

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
      if (req.pathname === "/sign-orchestrator-info") {
        json(res, 200, { address: "0xabc", signature: "0xsig" });
        return;
      }
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
        challenge: {
          paymentParams: "params-1",
          manifestId: "man-1",
          paymentUrl: `${server.origin}/pay`,
        },
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
        challenge: {
          paymentParams: "params-1",
          manifestId: "man-1",
          paymentUrl: `${server.origin}/pay`,
        },
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
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/generate-live-payment") {
        json(res, 480, {});
        return;
      }
      json(res, 404, {});
    });
    try {
      const session = new LivePaymentSession({
        signerUrl: server.origin,
        type: "live",
        challenge: {
          paymentParams: "p",
          manifestId: "m",
          paymentUrl: `${server.origin}/pay`,
        },
      });
      await expect(session.getPayment()).rejects.toBeInstanceOf(SignerRefreshRequired);
    } finally {
      await server.close();
    }
  });

  it("missing payment field is PaymentError", async () => {
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/generate-live-payment") {
        json(res, 200, { state: {} });
        return;
      }
      json(res, 404, {});
    });
    try {
      const session = new LivePaymentSession({
        signerUrl: server.origin,
        type: "live",
        challenge: {
          paymentParams: "p",
          manifestId: "m",
          paymentUrl: `${server.origin}/pay`,
        },
      });
      await expect(session.getPayment()).rejects.toBeInstanceOf(PaymentError);
    } finally {
      await server.close();
    }
  });
});
