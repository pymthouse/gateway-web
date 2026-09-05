import { describe, expect, it } from "vitest";
import { callRunner, padRunnerPrice, runnerPaymentType } from "../src/call-runner.js";
import { LivepeerGatewayError, LivepeerHTTPError } from "../src/errors.js";
import { clearSignerInfoCache } from "../src/signer.js";
import type { LiveRunnerInstance } from "../src/types.js";
import { json, startMockServer } from "./mock-server.js";
import { replySignOrchestratorInfo } from "./signer-test-helpers.js";

function runner(overrides: Partial<LiveRunnerInstance> = {}): LiveRunnerInstance {
  return {
    url: "http://unused",
    app: "livepeer-example/fal-flux-schnell",
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
    expect(
      runnerPaymentType(
        runner({
          priceInfo: {
            price: 1,
            currency: "wei",
            unit: "usage",
            sell: { price: "0.02625", unit: "image", upchargeBps: 500 },
          },
        }),
      ),
    ).toBe("usage");
    expect(runnerPaymentType(null)).toBe("live");
    expect(() =>
      runnerPaymentType(runner({ priceInfo: { price: 1, currency: "usd", unit: "widgets" } })),
    ).toThrow(/Unsupported live runner payment unit/);
  });

  it("pads max price by 1.2% and forces usage unit when sell is present", () => {
    expect(padRunnerPrice({ price: 100, currency: "usd", unit: "fixed" }).price).toBeCloseTo(101.2);
    expect(
      padRunnerPrice({
        price: 10,
        currency: "wei",
        unit: "fixed",
        sell: { price: "0.02625", unit: "image", upchargeBps: 500 },
      }).unit,
    ).toBe("usage");
  });

  it("402 → pay → retry → 200", async () => {
    let generateHits = 0;
    const server = await startMockServer((req, res) => {
      if (replySignOrchestratorInfo(req, res)) return;
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
      if (req.pathname === "/app") {
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
        runnerUrl: `${server.origin}/app`,
        runner: runner({ url: `${server.origin}/app` }),
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

  it("402 quote is forwarded and settleUsage uses attestation bytes", async () => {
    const quote = {
      quote_id: "q_1",
      sell_price: "0.02625",
      sell_unit: "image",
      upcharge_bps: 500,
      wei_price_per_unit: 10,
      wei_pixels_per_unit: 1,
    };
    const attestation = {
      quote_id: "q_1",
      billable_units: 2,
      sell_price: "0.02625",
      cost_wei: "20",
      orch_sig: "0xsig",
    };
    const attB64 = Buffer.from(JSON.stringify(attestation)).toString("base64");
    const payments: Array<Record<string, unknown>> = [];
    let generateHits = 0;
    const server = await startMockServer((req, res) => {
      if (replySignOrchestratorInfo(req, res)) return;
      if (req.pathname === "/generate-live-payment") {
        const body = req.json() as Record<string, unknown>;
        payments.push(body);
        json(res, 200, {
          payment: "PAY",
          segCreds: "SEG",
          state: { n: payments.length },
        });
        return;
      }
      if (req.pathname === "/app") {
        generateHits += 1;
        if (generateHits === 1) {
          json(res, 402, {
            payment_params: "opaque-params",
            manifest_id: "man-9",
            payment_url: `${req.url.origin}/pay`,
            quote,
          });
          return;
        }
        json(
          res,
          200,
          { url: "https://cdn.example/out.jpg" },
          { "X-Livepeer-Usage-Attestation": attB64 },
        );
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const result = await callRunner({
        runnerUrl: `${server.origin}/app`,
        runner: runner({
          url: `${server.origin}/app`,
          priceInfo: {
            price: 10,
            currency: "wei",
            unit: "usage",
            sell: { price: "0.02625", unit: "image", upchargeBps: 500 },
          },
        }),
        payload: { prompt: "a dragon" },
        signerUrl: server.origin,
        timeoutMs: 5_000,
      });
      expect(result.quote?.quote_id).toBe("q_1");
      expect(result.billableUnits).toBe(2);
      expect(result.settledCostWei).toBe("20");
      expect(payments).toHaveLength(2);
      expect(payments[0]?.type).toBe("usage");
      expect(payments[0]?.quote).toEqual(quote);
      expect(payments[0]?.attestation).toBeUndefined();
      expect(payments[1]?.type).toBe("usage");
      expect(payments[1]?.attestation).toEqual(attestation);
      expect(typeof payments[1]?.attestation).toBe("object");
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("exhausts payment challenge retries", async () => {
    const server = await startMockServer((req, res) => {
      if (replySignOrchestratorInfo(req, res)) return;
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
          runnerUrl: `${server.origin}/app`,
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
      if (replySignOrchestratorInfo(req, res)) return;
      json(res, 500, { error: { message: "boom" } });
    });
    try {
      clearSignerInfoCache();
      await expect(
        callRunner({
          runnerUrl: `${server.origin}/app`,
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
          runnerUrl: `${server.origin}/app`,
        }),
      ).rejects.toBeInstanceOf(LivepeerGatewayError);
    } finally {
      await server.close();
    }
  });
});
