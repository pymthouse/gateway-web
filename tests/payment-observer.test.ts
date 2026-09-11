import { describe, expect, it } from "vitest";
import { PaymentObserverError } from "../src/errors.js";
import { createGateway } from "../src/inference.js";
import { clearSignerInfoCache } from "../src/signer.js";
import { json, startMockServer, type MockRequest } from "./mock-server.js";

type RunnerMode = "single-shot" | "persistent";

function handlePaidRunner(
  req: MockRequest,
  res: Parameters<typeof json>[0],
  path: string,
  failFirst: boolean,
  order: string[],
): boolean {
  const match = /^\/apps\/(first|second)\/(app|session)$/.exec(path);
  if (!match) return false;
  const [, id, kind] = match;
  if (!req.headers["livepeer-payment"]) {
    json(res, 402, {
      payment_params: "p",
      manifest_id: "manifest-" + id,
      payment_url: `${req.url.origin}/pay`,
    });
    return true;
  }
  order.push("provider:" + id);
  if (failFirst && id === "first") {
    json(res, 503, { error: "provider_failed" });
    return true;
  }
  if (kind === "session") {
    json(res, 200, {
      session_id: "provider-session",
      app_url: `${req.url.origin}/session-app`,
      control_url: `${req.url.origin}/control`,
    });
    return true;
  }
  json(res, 200, { text: "ok", request_id: "provider" });
  return true;
}

async function withPaidRunners(
  mode: RunnerMode,
  failFirst: boolean,
  run: (input: { origin: string; order: string[]; payments: () => number }) => Promise<void>,
): Promise<void> {
  const order: string[] = [];
  let payments = 0;
  const ids = failFirst ? ["first", "second"] : ["first"];
  const server = await startMockServer((req, res) => {
    const path = req.pathname.endsWith("/") ? req.pathname.slice(0, -1) : req.pathname;
    if (req.pathname === "/discover-orchestrators") {
      json(
        res,
        200,
        ids.map((id) => ({
          address: `${req.url.origin}/orch-${id}`,
          runners: [
            {
              app: "test-app",
              url:
                mode === "persistent"
                  ? `${req.url.origin}/apps/${id}/session`
                  : `${req.url.origin}/apps/${id}/app`,
              mode,
              runner_id: id,
              price_info: { price: 1, currency: "wei", unit: "fixed" },
            },
          ],
        })),
      );
      return;
    }
    if (req.pathname === "/sign-orchestrator-info") {
      json(res, 200, { address: "0xabc", signature: "0xsig" });
      return;
    }
    if (req.pathname === "/generate-live-payment") {
      const body = req.json() as Record<string, unknown>;
      payments += 1;
      order.push("paid:" + String(body.ManifestID));
      json(res, 200, { payment: "PAY", segCreds: "SEG", state: {} });
      return;
    }
    if (handlePaidRunner(req, res, path, failFirst, order)) return;
    if (path === "/session-app/hello") {
      json(res, 200, { text: "ok" });
      return;
    }
    if (path === "/control/stop") {
      json(res, 200, {});
      return;
    }
    json(res, 404, { error: { message: req.pathname } });
  });
  try {
    clearSignerInfoCache();
    await run({
      origin: server.origin,
      order,
      payments: () => payments,
    });
  } finally {
    clearSignerInfoCache();
    await server.close();
  }
}

describe("onPayment observer", () => {
  it.each(["single-shot", "persistent"] as const)(
    "records the manifest before charging and before provider completion (%s)",
    async (mode) => {
      await withPaidRunners(mode, false, async ({ origin, order }) => {
        await createGateway({ signerUrl: origin, timeoutMs: 5_000 }).runInference({
          capability: "test-app",
          ...(mode === "persistent" ? { endpoint: "/hello" } : {}),
          onPayment: async ({ manifestId, phase }) => {
            order.push(phase + ":" + manifestId);
          },
        });
        expect(order).toEqual([
          "prepared:manifest-first",
          "paid:manifest-first",
          "accepted:manifest-first",
          "provider:first",
        ]);
      });
    },
  );

  it.each(["single-shot", "persistent"] as const)(
    "preserves manifests from paid failed attempts and failover (%s)",
    async (mode) => {
      await withPaidRunners(mode, true, async ({ origin, order, payments }) => {
        await createGateway({ signerUrl: origin, timeoutMs: 5_000 }).runInference({
          capability: "test-app",
          ...(mode === "persistent" ? { endpoint: "/hello" } : {}),
          onPayment: async ({ manifestId, phase }) => {
            order.push(phase + ":" + manifestId);
          },
        });
        expect(order.filter((s) => s.startsWith("accepted:"))).toEqual([
          "accepted:manifest-first",
          "accepted:manifest-second",
        ]);
        expect(payments()).toBe(2);
      });
    },
  );

  it.each(["prepared", "accepted"] as const)(
    "stops without paid failover if persistence fails at %s",
    async (phase) => {
      await withPaidRunners("single-shot", true, async ({ origin, order, payments }) => {
        await expect(
          createGateway({ signerUrl: origin, timeoutMs: 5_000 }).runInference({
            capability: "test-app",
            onPayment: async (payment) => {
              if (payment.phase === phase) throw new Error("db unavailable");
            },
          }),
        ).rejects.toMatchObject({
          name: "PaymentObserverError",
          message: "payment_manifest_persistence_failed",
        });
        expect(payments()).toBe(phase === "prepared" ? 0 : 1);
        expect(order.some((s) => s.startsWith("provider:"))).toBe(false);
      });
    },
  );

  it("does not failover when the callback message looks retryable", async () => {
    await withPaidRunners("single-shot", true, async ({ origin, payments }) => {
      await expect(
        createGateway({ signerUrl: origin, timeoutMs: 5_000 }).runInference({
          capability: "test-app",
          onPayment: async () => {
            throw new Error("connection timeout");
          },
        }),
      ).rejects.toBeInstanceOf(PaymentObserverError);
      expect(payments()).toBe(0);
    });
  });

  it("threads onPayment through reserveSession", async () => {
    await withPaidRunners("persistent", false, async ({ origin, order }) => {
      await createGateway({ signerUrl: origin, timeoutMs: 5_000 }).reserveSession({
        capability: "test-app",
        startFunding: false,
        onPayment: async ({ manifestId, phase }) => {
          order.push(phase + ":" + manifestId);
        },
      });
      expect(order).toEqual([
        "prepared:manifest-first",
        "paid:manifest-first",
        "accepted:manifest-first",
        "provider:first",
      ]);
    });
  });
});
