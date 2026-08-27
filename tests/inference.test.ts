import { describe, expect, it } from "vitest";
import { NoRunnerAvailableError } from "../src/errors.js";
import { createGateway } from "../src/inference.js";
import { clearSignerInfoCache } from "../src/signer.js";
import { json, startMockServer } from "./mock-server.js";

describe("runInference", () => {
  it("discovers, rewrites /session → /app, pays 402, extracts media URL", async () => {
    let generateHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: `${req.url.origin}`,
            runners: [
              {
                app: "storyboard/fal-flux-schnell",
                url: `${req.url.origin}/apps/flux/session`,
                mode: "single-shot",
                runner_id: "r1",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
        ]);
        return;
      }
      if (req.pathname === "/sign-orchestrator-info") {
        json(res, 200, { address: "0xabc", signature: "0xsig" });
        return;
      }
      if (req.pathname === "/generate-live-payment") {
        json(res, 200, { payment: "PAY", segCreds: "SEG", state: {} });
        return;
      }
      if (req.pathname === "/apps/flux/app/generate") {
        generateHits += 1;
        if (generateHits === 1) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        const body = req.json() as Record<string, unknown>;
        expect(body.prompt).toBe("a dragon");
        json(res, 200, { images: [{ url: "https://cdn.example/out.jpg" }] });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const gw = createGateway({
        signerUrl: server.origin,
        timeoutMs: 5_000,
      });
      const res = await gw.runInference({
        capability: "flux-schnell",
        params: { prompt: "a dragon" },
      });
      expect(res.url).toBe("https://cdn.example/out.jpg");
      expect(res.imageUrl).toBe("https://cdn.example/out.jpg");
      expect(res.videoUrl).toBeNull();
      expect(res.app).toBe("storyboard/fal-flux-schnell");
      expect(res.runnerUrl).toContain("/apps/flux/app/generate");
      expect(generateHits).toBe(2);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("throws NoRunnerAvailableError when discovery is empty", async () => {
    const server = await startMockServer((_req, res) => {
      json(res, 200, []);
    });
    try {
      const gw = createGateway({ signerUrl: server.origin });
      await expect(gw.runInference({ capability: "flux-dev" })).rejects.toBeInstanceOf(
        NoRunnerAvailableError,
      );
    } finally {
      await server.close();
    }
  });

  it("failovers to the next orchestrator when the first returns HTTP 500", async () => {
    let goodGenerateHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: `${req.url.origin}/orch-a`,
            runners: [
              {
                app: "storyboard/fal-flux-schnell",
                url: `${req.url.origin}/apps/flux-a/session`,
                mode: "single-shot",
                runner_id: "bad",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
          {
            address: `${req.url.origin}/orch-b`,
            runners: [
              {
                app: "storyboard/fal-flux-schnell",
                url: `${req.url.origin}/apps/flux-b/session`,
                mode: "single-shot",
                runner_id: "good",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
        ]);
        return;
      }
      if (req.pathname === "/sign-orchestrator-info") {
        json(res, 200, { address: "0xabc", signature: "0xsig" });
        return;
      }
      if (req.pathname === "/generate-live-payment") {
        json(res, 200, { payment: "PAY", segCreds: "SEG", state: {} });
        return;
      }
      if (req.pathname === "/apps/flux-a/app/generate") {
        json(res, 500, { error: "CUDA error" });
        return;
      }
      if (req.pathname === "/apps/flux-b/app/generate") {
        goodGenerateHits += 1;
        if (goodGenerateHits === 1) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        json(res, 200, { images: [{ url: "https://cdn.example/failover.jpg" }] });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const gw = createGateway({
        signerUrl: server.origin,
        timeoutMs: 5_000,
      });
      const res = await gw.runInference({
        capability: "flux-schnell",
        params: { prompt: "failover test" },
      });
      expect(res.url).toBe("https://cdn.example/failover.jpg");
      expect(res.orchestrator).toContain("/orch-b");
      expect(goodGenerateHits).toBe(2);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });
});
