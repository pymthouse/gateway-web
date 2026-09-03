import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { NoRunnerAvailableError, LivepeerGatewayError } from "../src/errors.js";
import { createGateway, type Gateway } from "../src/inference.js";
import { clearSignerInfoCache } from "../src/signer.js";
import { json, startMockServer, type MockHandler, type MockRequest } from "./mock-server.js";
import { replySignerPayment } from "./signer-test-helpers.js";

const PRICE = { price: 1, currency: "usd", unit: "fixed" } as const;

function runner(origin: string, app: string, path: string, runnerId: string) {
  return {
    app,
    url: `${origin}${path}`,
    mode: "single-shot",
    runner_id: runnerId,
    price_info: PRICE,
  };
}

/** First hit: 402 challenge. Later hits: 200 with `success`. */
function replyPaidApp(
  hits: { n: number },
  req: MockRequest,
  res: ServerResponse,
  success: unknown,
  onPaid?: (body: Record<string, unknown>) => void,
): void {
  hits.n += 1;
  if (hits.n === 1) {
    json(res, 402, {
      payment_params: "p",
      manifest_id: "m",
      payment_url: `${req.url.origin}/pay`,
    });
    return;
  }
  onPaid?.(req.json() as Record<string, unknown>);
  json(res, 200, success);
}

function liveRunnerHandler(opts: {
  catalog: (origin: string) => unknown[];
  onDiscover?: (req: MockRequest) => void;
  failPaths?: Record<string, unknown>;
  paidPaths: Record<
    string,
    { hits: { n: number }; success: unknown; onPaid?: (body: Record<string, unknown>) => void }
  >;
}): MockHandler {
  return (req, res) => {
    if (req.pathname === "/discover-orchestrators") {
      opts.onDiscover?.(req);
      json(res, 200, opts.catalog(req.url.origin));
      return;
    }
    if (replySignerPayment(req, res, {})) return;
    const failBody = opts.failPaths?.[req.pathname];
    if (failBody !== undefined) {
      json(res, 500, failBody);
      return;
    }
    const paid = opts.paidPaths[req.pathname];
    if (paid) {
      replyPaidApp(paid.hits, req, res, paid.success, paid.onPaid);
      return;
    }
    json(res, 404, { error: { message: req.pathname } });
  };
}

async function withGateway(
  handler: MockHandler,
  run: (gw: Gateway) => Promise<void>,
): Promise<void> {
  const server = await startMockServer(handler);
  try {
    clearSignerInfoCache();
    await run(
      createGateway({
        signerUrl: server.origin,
        timeoutMs: 5_000,
      }),
    );
  } finally {
    clearSignerInfoCache();
    await server.close();
  }
}

describe("runInference", () => {
  it("discovers, POSTs discovery /app, pays 402, extracts media URL", async () => {
    const hits = { n: 0 };
    const app = "livepeer-example/fal-flux-schnell";
    await withGateway(
      liveRunnerHandler({
        catalog: (origin) => [
          { address: origin, runners: [runner(origin, app, "/apps/flux/app", "r1")] },
        ],
        paidPaths: {
          "/apps/flux/app": {
            hits,
            success: { images: [{ url: "https://cdn.example/out.jpg" }] },
            onPaid: (body) => expect(body.prompt).toBe("a dragon"),
          },
        },
      }),
      async (gw) => {
        const res = await gw.runInference({
          capability: app,
          params: { prompt: "a dragon" },
        });
        expect(res.url).toBe("https://cdn.example/out.jpg");
        expect(res.imageUrl).toBe("https://cdn.example/out.jpg");
        expect(res.videoUrl).toBeNull();
        expect(res.app).toBe(app);
        expect(res.mode).toBe("single-shot");
        expect(res.runnerUrl).toContain("/apps/flux/app");
        expect(hits.n).toBe(2);
      },
    );
  });

  it("throws NoRunnerAvailableError when discovery is empty", async () => {
    await withGateway(
      (_req, res) => {
        json(res, 200, []);
      },
      async (gw) => {
        await expect(gw.runInference({ capability: "flux-dev" })).rejects.toBeInstanceOf(
          NoRunnerAvailableError,
        );
      },
    );
  });

  it("failovers to the next orchestrator when the first returns HTTP 500", async () => {
    const hits = { n: 0 };
    const app = "livepeer-example/fal-flux-schnell";
    await withGateway(
      liveRunnerHandler({
        onDiscover: (req) => expect(req.url.searchParams.getAll("app")).toEqual([]),
        catalog: (origin) => [
          {
            address: `${origin}/orch-a`,
            runners: [runner(origin, app, "/apps/flux-a/app", "bad")],
          },
          {
            address: `${origin}/orch-b`,
            runners: [runner(origin, app, "/apps/flux-b/app", "good")],
          },
        ],
        failPaths: { "/apps/flux-a/app": { error: "CUDA error" } },
        paidPaths: {
          "/apps/flux-b/app": {
            hits,
            success: { images: [{ url: "https://cdn.example/failover.jpg" }] },
          },
        },
      }),
      async (gw) => {
        const res = await gw.runInference({
          capability: app,
          params: { prompt: "failover test" },
        });
        expect(res.url).toBe("https://cdn.example/failover.jpg");
        expect(res.orchestrator).toContain("/orch-b");
        expect(hits.n).toBe(2);
      },
    );
  });

  it("failovers to a second runner on the same orchestrator host", async () => {
    const hits = { n: 0 };
    const app = "image-generation/black-forest-labs/FLUX.1-dev";
    await withGateway(
      liveRunnerHandler({
        catalog: (origin) => [
          {
            address: origin,
            runners: [
              runner(origin, app, "/apps/flux-a", "bad"),
              runner(origin, app, "/apps/flux-b", "good"),
            ],
          },
        ],
        failPaths: { "/apps/flux-a/app": { error: "CUDA error" } },
        paidPaths: {
          "/apps/flux-b/app": {
            hits,
            success: { images: [{ url: "https://cdn.example/same-host.jpg" }] },
          },
        },
      }),
      async (gw) => {
        const res = await gw.runInference({
          capability: app,
          params: { prompt: "a dragon" },
        });
        expect(res.url).toBe("https://cdn.example/same-host.jpg");
        expect(hits.n).toBe(2);
      },
    );
  });

  it("failovers to a sibling image-generation app on another orchestrator", async () => {
    const hits = { n: 0 };
    await withGateway(
      liveRunnerHandler({
        catalog: (origin) => [
          {
            address: `${origin}/orch-flux`,
            runners: [
              runner(origin, "image-generation/black-forest-labs/FLUX.1-dev", "/apps/flux", "flux"),
            ],
          },
          {
            address: `${origin}/orch-sdxl`,
            runners: [runner(origin, "image-generation/stability/sdxl", "/apps/sdxl", "sdxl")],
          },
        ],
        failPaths: { "/apps/flux/app": { error: "CUDA error" } },
        paidPaths: {
          "/apps/sdxl/app": {
            hits,
            success: { images: [{ url: "https://cdn.example/sibling.jpg" }] },
          },
        },
      }),
      async (gw) => {
        const res = await gw.runInference({
          capability: "image-generation/black-forest-labs/FLUX.1-dev",
          params: { prompt: "a dragon" },
        });
        expect(res.url).toBe("https://cdn.example/sibling.jpg");
        expect(res.app).toBe("image-generation/stability/sdxl");
        expect(hits.n).toBe(2);
      },
    );
  });

  it("rejects endpoint on single-shot capabilities", async () => {
    const app = "livepeer-example/fal-flux-schnell";
    await withGateway(
      liveRunnerHandler({
        catalog: (origin) => [
          { address: origin, runners: [runner(origin, app, "/apps/flux/app", "r1")] },
        ],
        paidPaths: {},
      }),
      async (gw) => {
        await expect(
          gw.runInference({
            capability: app,
            params: { prompt: "a dragon" },
            endpoint: "/hello",
          }),
        ).rejects.toBeInstanceOf(LivepeerGatewayError);
        await expect(
          gw.runInference({
            capability: app,
            params: { prompt: "a dragon" },
            endpoint: "/hello",
          }),
        ).rejects.toThrow(/does not accept endpoint for single-shot/);
      },
    );
  });

  it("grok capability POSTs discovery /app and reads receipt output.images", async () => {
    const hits = { n: 0 };
    const app = "livepeer-example/fal-grok-image-2";
    await withGateway(
      liveRunnerHandler({
        catalog: (origin) => [
          {
            address: origin,
            runners: [runner(origin, app, "/apps/fal-grok-image-2/app", "grok")],
          },
        ],
        paidPaths: {
          "/apps/fal-grok-image-2/app": {
            hits,
            success: {
              request_id: "req-grok",
              endpoint_id: "xai/grok-imagine-image/v2.0/text-to-image",
              schema_sha256: "a".repeat(64),
              output: { images: [{ url: "https://cdn.example/grok.png" }] },
            },
          },
        },
      }),
      async (gw) => {
        const res = await gw.runInference({
          capability: app,
          params: { prompt: "a dragon" },
        });
        expect(res.runnerUrl).toMatch(/\/apps\/fal-grok-image-2\/app$/);
        expect(res.runnerUrl).not.toContain("/generate");
        expect(res.imageUrl).toBe("https://cdn.example/grok.png");
        expect(hits.n).toBe(2);
      },
    );
  });

  it("polls a fal queue receipt until the media URL lands", async () => {
    const hits = { n: 0 };
    let statusHits = 0;
    const app = "livepeer-example/fal-ray-32-t2v";
    const server = await startMockServer((req, res) => {
      if (req.pathname === "/discover-orchestrators") {
        json(res, 200, [
          {
            address: req.url.origin,
            runners: [runner(req.url.origin, app, "/apps/ray/app", "r1")],
          },
        ]);
        return;
      }
      if (replySignerPayment(req, res, {})) return;
      if (req.pathname === "/apps/ray/app") {
        hits.n += 1;
        if (hits.n === 1) {
          json(res, 402, {
            payment_params: "p",
            manifest_id: "m",
            payment_url: `${req.url.origin}/pay`,
          });
          return;
        }
        json(res, 200, {
          endpoint_id: "luma/agent/ray/v3.2/text-to-video",
          request_id: "req-ray",
          schema_sha256: "a".repeat(64),
          output: {
            request_id: "req-ray",
            status: "IN_QUEUE",
            status_url: `${req.url.origin}/queue/req-ray/status`,
            response_url: `${req.url.origin}/queue/req-ray`,
          },
        });
        return;
      }
      if (req.pathname === "/queue/req-ray/status") {
        statusHits += 1;
        json(res, 200, {
          status: statusHits < 2 ? "IN_PROGRESS" : "COMPLETED",
          request_id: "req-ray",
        });
        return;
      }
      if (req.pathname === "/queue/req-ray") {
        json(res, 200, { video: { url: "https://cdn.example/out.mp4" } });
        return;
      }
      json(res, 404, { error: { message: req.pathname } });
    });
    try {
      clearSignerInfoCache();
      const gw = createGateway({ signerUrl: server.origin, timeoutMs: 5_000 });
      const res = await gw.runInference({
        capability: app,
        params: { prompt: "a dragon" },
      });
      expect(res.url).toBe("https://cdn.example/out.mp4");
      expect(res.videoUrl).toBe("https://cdn.example/out.mp4");
      expect(res.status).toBe("completed");
      expect(statusHits).toBeGreaterThanOrEqual(2);
    } finally {
      clearSignerInfoCache();
      await server.close();
    }
  });
});
