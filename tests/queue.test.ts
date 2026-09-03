import { describe, expect, it } from "vitest";
import { LivepeerGatewayError } from "../src/errors.js";
import { awaitQueuedResult, extractQueueHandle, isAllowedQueuePollUrl } from "../src/queue.js";
import { json, startMockServer } from "./mock-server.js";

describe("extractQueueHandle", () => {
  it("reads a fal submit receipt", () => {
    const handle = extractQueueHandle({
      request_id: "req-123",
      status: "IN_QUEUE",
      status_url: "https://queue.fal.run/fal-ai/flux/requests/req-123/status",
      response_url: "https://queue.fal.run/fal-ai/flux/requests/req-123",
    });
    expect(handle?.requestId).toBe("req-123");
    expect(handle?.status).toBe("IN_QUEUE");
    expect(handle?.statusUrl).toContain("/status");
  });

  it("reads a nested adapter envelope", () => {
    const handle = extractQueueHandle({
      endpoint_id: "fal-ai/flux/schnell",
      request_id: "req-123",
      output: {
        status: "IN_QUEUE",
        status_url: "https://queue.fal.run/fal-ai/flux/requests/req-123/status",
      },
      schema_sha256: "a".repeat(64),
    });
    expect(handle?.requestId).toBe("req-123");
    expect(handle?.status).toBe("IN_QUEUE");
  });

  it("returns null for a completed media receipt", () => {
    expect(
      extractQueueHandle({
        output: { images: [{ url: "https://cdn.example/out.png" }] },
      }),
    ).toBeNull();
  });
});

describe("awaitQueuedResult", () => {
  it("polls status_url then fetches the result", async () => {
    let statusHits = 0;
    const server = await startMockServer((req, res) => {
      if (req.pathname.endsWith("/status")) {
        statusHits += 1;
        json(res, 200, {
          status: statusHits < 2 ? "IN_QUEUE" : "COMPLETED",
          request_id: "req-123",
        });
        return;
      }
      if (req.pathname.endsWith("/req-123")) {
        json(res, 200, { images: [{ url: "https://cdn.example/out.png" }] });
        return;
      }
      json(res, 404, { error: req.pathname });
    });
    try {
      const settled = await awaitQueuedResult(
        {
          endpoint_id: "fal-ai/flux/schnell",
          request_id: "req-123",
          schema_sha256: "a".repeat(64),
          output: {
            request_id: "req-123",
            status: "IN_QUEUE",
            status_url: `${server.origin}/fal-ai/flux/requests/req-123/status`,
            response_url: `${server.origin}/fal-ai/flux/requests/req-123`,
          },
        },
        { timeoutMs: 5_000, pollIntervalMs: 10, runnerUrl: server.origin },
      );
      expect(statusHits).toBeGreaterThanOrEqual(2);
      expect(settled.output).toEqual({ images: [{ url: "https://cdn.example/out.png" }] });
    } finally {
      await server.close();
    }
  });

  it("returns the receipt when status_url is unauthorized", async () => {
    const server = await startMockServer((req, res) => {
      json(res, 401, { error: "unauthorized" });
    });
    const receipt = {
      request_id: "req-123",
      status: "IN_QUEUE",
      status_url: `${server.origin}/status`,
      response_url: `${server.origin}/result`,
    };
    try {
      const settled = await awaitQueuedResult(receipt, {
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        runnerUrl: server.origin,
      });
      expect(settled).toEqual(receipt);
    } finally {
      await server.close();
    }
  });

  it("throws when the queue reports FAILED", async () => {
    const server = await startMockServer((req, res) => {
      json(res, 200, { status: "FAILED", error: "nsfw" });
    });
    try {
      await expect(
        awaitQueuedResult(
          {
            request_id: "req-123",
            status: "IN_QUEUE",
            status_url: `${server.origin}/status`,
            response_url: `${server.origin}/result`,
          },
          { timeoutMs: 2_000, pollIntervalMs: 10, runnerUrl: server.origin },
        ),
      ).rejects.toBeInstanceOf(LivepeerGatewayError);
    } finally {
      await server.close();
    }
  });

  it("leaves a completed media body alone", async () => {
    const body = { images: [{ url: "https://cdn.example/out.png" }] };
    expect(await awaitQueuedResult(body, { timeoutMs: 100 })).toBe(body);
  });

  it("does not poll a status_url off the fal/runner allowlist", async () => {
    const receipt = {
      request_id: "req-123",
      status: "IN_QUEUE",
      status_url: "https://evil.example/status",
      response_url: "https://evil.example/result",
    };
    const settled = await awaitQueuedResult(receipt, {
      timeoutMs: 2_000,
      runnerUrl: "https://runner.example/app/",
    });
    expect(settled).toBe(receipt);
  });
});

describe("isAllowedQueuePollUrl", () => {
  it("allows https fal queue hosts", () => {
    expect(isAllowedQueuePollUrl("https://queue.fal.run/fal-ai/flux/requests/x/status")).toBe(true);
    expect(
      isAllowedQueuePollUrl("https://us.queue.fal.run/fal-ai/flux/requests/x/status"),
    ).toBe(true);
  });

  it("allows the runner origin", () => {
    expect(
      isAllowedQueuePollUrl(
        "http://127.0.0.1:9999/queue/req/status",
        "http://127.0.0.1:9999/apps/flux/app/",
      ),
    ).toBe(true);
  });

  it("rejects other hosts and http fal lookalikes", () => {
    expect(isAllowedQueuePollUrl("https://evil.example/status")).toBe(false);
    expect(isAllowedQueuePollUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedQueuePollUrl("http://queue.fal.run/fal-ai/flux/requests/x/status")).toBe(false);
    expect(
      isAllowedQueuePollUrl(
        "https://evil.example/status",
        "https://runner.example/app/",
      ),
    ).toBe(false);
  });
});
