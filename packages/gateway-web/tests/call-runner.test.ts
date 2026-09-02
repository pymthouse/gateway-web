import { describe, expect, it } from "vitest";
import { callRunner, padRunnerPrice, runnerPaymentType } from "../src/call-runner.js";
import { LivepeerGatewayError, LivepeerHTTPError } from "../src/errors.js";
import { clearSignerInfoCache } from "../src/signer.js";
import type { LiveRunnerInstance } from "../src/types.js";
import { json, startMockServer } from "./mock-server.js";

function runner(overrides: Partial<LiveRunnerInstance> = {}): LiveRunnerInstance {
  return {
    url: "http://unused",
    app: "storyboard/fal-flux-schnell",
    runnerId: "r1",
    mode: "single-shot",
    orchestratorUrl: "http://orch",
    raw: {},
    priceInfo: { price: 1, currency: "usd", unit: "fixed" },
    ...overrides,
  };
}

describe("callRunner", () => {
  it("maps price_info.unit to payment type", () => {
    expect(
      runnerPaymentType(runner({ priceInfo: { price: 1, currency: "usd", unit: "fixed" } })),
    ).toBe("fixed");
    expect(
      runnerPaymentType(runner({ priceInfo: { price: 1, currency: "usd", unit: "hour" } })),
    ).toBe("live");
    expect(
      runnerPaymentType(runner({ priceInfo: { price: 1, currency: "usd", unit: "720p" } })),
    ).toBe("lv2v");
    expect(runnerPaymentType(null)).toBe("live");
    expect(() =>
      runnerPaymentType(runner({ priceInfo: { price: 1, currency: "usd", unit: "widgets" } })),
    ).toThrow(/Unsupported live runner payment unit/);
  });

  it("pads max price by 1.2%", () => {
    expect(padRunnerPrice({ price: 100, currency: "usd", unit: "fixed" }).price).toBeCloseTo(101.2);
  });

  it("402 → pay → retry → 200", async () => {
    let generateHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/sign-orchestrator-info") {
        json(res, 200, { address: "0xabc", signature: "0xsig" });
        return;
      }
      if (req.pathname === "/generate-live-payment") {
        const body = req.json() as Record<string, unknown>;
        expect(body.orchestrator).toBe("opaque-params");
        expect(body.ManifestID).toBe("man-9");
        expect(body.type).toBe("fixed");
        json(res, 200, {
          payment: "PAY",
          segCreds: "SEG",
          state: { n: 1 },
        });
        return;
      }
      if (req.pathname === "/app/generate") {
        generateHits += 1;
        if (generateHits === 1) {
          expect(req.headers["livepeer-payer-address"]).toBe("0xabc");
          expect(req.headers["livepeer-payment"]).toBeUndefined();
          json(res, 402, {
            payment_params: "opaque-params",
            manifest_id: "man-9",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        expect(req.headers["livepeer-payment"]).toBe("PAY");
        expect(req.headers["livepeer-segment"]).toBe("SEG");
        json(res, 200, { url: "https://cdn.example/out.jpg" });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const result = await callRunner({
        runnerUrl: `${server.origin}/app/generate`,
        runner: runner({ url: `${server.origin}/app/generate` }),
        payload: { prompt: "a dragon" },
        signerUrl: server.origin,
        timeoutMs: 5_000,
      });
      expect(result.data.url).toBe("https://cdn.example/out.jpg");
      expect(result.sessionId).toBe("man-9");
      expect(generateHits).toBe(2);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("exhausts payment challenge retries", async () => {
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/sign-orchestrator-info") {
        json(res, 200, { address: "0xabc", signature: "0xsig" });
        return;
      }
      if (req.pathname === "/generate-live-payment") {
        json(res, 200, { payment: "PAY", segCreds: "SEG", state: {} });
        return;
      }
      json(res, 402, {
        payment_params: "p",
        manifest_id: "m",
        payment_url: `${req.url.origin}/pay`,
      });
    });
    try {
      clearSignerInfoCache();
      await expect(
        callRunner({
          runnerUrl: `${server.origin}/app/generate`,
          runner: runner(),
          signerUrl: server.origin,
          maxPaymentChallengeRetries: 0,
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow(/exhausted payment challenge retries/);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("non-402 errors propagate", async () => {
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/sign-orchestrator-info") {
        json(res, 200, { address: "0xabc", signature: "0xsig" });
        return;
      }
      json(res, 500, { error: { message: "boom" } });
    });
    try {
      clearSignerInfoCache();
      await expect(
        callRunner({
          runnerUrl: `${server.origin}/app/generate`,
          runner: runner(),
          signerUrl: server.origin,
        }),
      ).rejects.toBeInstanceOf(LivepeerHTTPError);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("402 without signerUrl is a gateway error", async () => {
    const server = await startMockServer((_req, res) => {
      json(res, 402, {
        payment_params: "p",
        manifest_id: "m",
        payment_url: "http://x/pay",
      });
    });
    try {
      await expect(
        callRunner({
          runnerUrl: `${server.origin}/app/generate`,
        }),
      ).rejects.toBeInstanceOf(LivepeerGatewayError);
    } finally {
      await server.close();
    }
  });
});
