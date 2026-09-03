import { describe, expect, it } from "vitest";
import { NoRunnerAvailableError } from "../src/errors.js";
import { createGateway } from "../src/inference.js";
import { clearSignerInfoCache } from "../src/signer.js";
import { json, startMockServer } from "./mock-server.js";

describe("runInference", () => {
  it("discovers, POSTs discovery /app, pays 402, extracts media URL", async () => {
    let generateHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: `${req.url.origin}`,
            runners: [
              {
                app: "livepeer-example/fal-flux-schnell",
                url: `${req.url.origin}/apps/flux/app`,
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
      if (req.pathname === "/apps/flux/app") {
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
        capability: "livepeer-example/fal-flux-schnell",
        params: { prompt: "a dragon" },
      });
      expect(res.url).toBe("https://cdn.example/out.jpg");
      expect(res.imageUrl).toBe("https://cdn.example/out.jpg");
      expect(res.videoUrl).toBeNull();
      expect(res.app).toBe("livepeer-example/fal-flux-schnell");
      expect(res.mode).toBe("single-shot");
      expect(res.runnerUrl).toContain("/apps/flux/app");
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
        expect(req.url.searchParams.getAll("app")).toEqual([]);
        json(res, 200, [
          {
            address: `${req.url.origin}/orch-a`,
            runners: [
              {
                app: "livepeer-example/fal-flux-schnell",
                url: `${req.url.origin}/apps/flux-a/app`,
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
                app: "livepeer-example/fal-flux-schnell",
                url: `${req.url.origin}/apps/flux-b/app`,
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
      if (req.pathname === "/apps/flux-a/app") {
        json(res, 500, { error: "CUDA error" });
        return;
      }
      if (req.pathname === "/apps/flux-b/app") {
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
        capability: "livepeer-example/fal-flux-schnell",
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

  it("failovers to a second runner on the same orchestrator host", async () => {
    let goodHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: `${req.url.origin}`,
            runners: [
              {
                app: "image-generation/black-forest-labs/FLUX.1-dev",
                url: `${req.url.origin}/apps/flux-a`,
                mode: "single-shot",
                runner_id: "bad",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
              {
                app: "image-generation/black-forest-labs/FLUX.1-dev",
                url: `${req.url.origin}/apps/flux-b`,
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
      if (req.pathname === "/apps/flux-a/app") {
        json(res, 500, { error: "CUDA error" });
        return;
      }
      if (req.pathname === "/apps/flux-b/app") {
        goodHits += 1;
        if (goodHits === 1) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        json(res, 200, { images: [{ url: "https://cdn.example/same-host.jpg" }] });
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
        capability: "image-generation/black-forest-labs/FLUX.1-dev",
        params: { prompt: "a dragon" },
      });
      expect(res.url).toBe("https://cdn.example/same-host.jpg");
      expect(goodHits).toBe(2);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("failovers to a sibling image-generation app on another orchestrator", async () => {
    let sdxlHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: `${req.url.origin}/orch-flux`,
            runners: [
              {
                app: "image-generation/black-forest-labs/FLUX.1-dev",
                url: `${req.url.origin}/apps/flux`,
                mode: "single-shot",
                runner_id: "flux",
                price_info: { price: 1, currency: "usd", unit: "fixed" },
              },
            ],
          },
          {
            address: `${req.url.origin}/orch-sdxl`,
            runners: [
              {
                app: "image-generation/stability/sdxl",
                url: `${req.url.origin}/apps/sdxl`,
                mode: "single-shot",
                runner_id: "sdxl",
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
      if (req.pathname === "/apps/flux/app") {
        json(res, 500, { error: "CUDA error" });
        return;
      }
      if (req.pathname === "/apps/sdxl/app") {
        sdxlHits += 1;
        if (sdxlHits === 1) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        json(res, 200, { images: [{ url: "https://cdn.example/sibling.jpg" }] });
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
        capability: "image-generation/black-forest-labs/FLUX.1-dev",
        params: { prompt: "a dragon" },
      });
      expect(res.url).toBe("https://cdn.example/sibling.jpg");
      expect(res.app).toBe("image-generation/stability/sdxl");
      expect(sdxlHits).toBe(2);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });

  it("grok capability POSTs discovery /app and reads receipt output.images", async () => {
    let appHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: `${req.url.origin}`,
            runners: [
              {
                app: "livepeer-example/fal-grok-image-2",
                url: `${req.url.origin}/apps/fal-grok-image-2/app`,
                mode: "single-shot",
                runner_id: "grok",
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
      if (req.pathname === "/apps/fal-grok-image-2/app") {
        appHits += 1;
        if (appHits === 1) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        json(res, 200, {
          request_id: "req-grok",
          endpoint_id: "xai/grok-imagine-image/v2.0/text-to-image",
          schema_sha256: "a".repeat(64),
          output: { images: [{ url: "https://cdn.example/grok.png" }] },
        });
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
        capability: "livepeer-example/fal-grok-image-2",
        params: { prompt: "a dragon" },
      });
      expect(res.runnerUrl).toMatch(/\/apps\/fal-grok-image-2\/app$/);
      expect(res.runnerUrl).not.toContain("/generate");
      expect(res.imageUrl).toBe("https://cdn.example/grok.png");
      expect(appHits).toBe(2);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });
});
