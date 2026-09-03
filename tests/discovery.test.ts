import { describe, expect, it } from "vitest";
import { defaultDiscoveryUrl, discoverRunners } from "../src/discovery.js";
import { RemoteSignerError } from "../src/errors.js";
import { json, startMockServer } from "./mock-server.js";

const RUNNERS = [
  {
    address: "https://orch.example:8936",
    runners: [
      {
        app: "livepeer-example/fal-flux-schnell",
        url: "https://orch.example:8936/apps/flux/session",
        mode: "single-shot",
        price_info: { price: 1, currency: "usd", unit: "fixed" },
      },
      {
        app: "other/app",
        url: "https://orch.example:8936/apps/other",
        mode: "persistent",
      },
      { app: "no-url" },
    ],
  },
  { address: "https://empty:8936", runners: [] },
  "not-an-object",
];

describe("discovery", () => {
  it("defaultDiscoveryUrl is signer origin + /discover-orchestrators", () => {
    expect(defaultDiscoveryUrl("https://signer.example.com/path")).toBe(
      "https://signer.example.com/discover-orchestrators",
    );
  });

  it("filters to runners with url+app and optional app/gpu filters", async () => {
    const server = await startMockServer((req, res) => {
      expect(req.pathname).toBe("/discover-orchestrators");
      expect(req.url.searchParams.getAll("app")).toEqual(["livepeer-example/fal-flux-schnell"]);
      json(res, 200, RUNNERS);
    });
    try {
      const entries = await discoverRunners({
        signerUrl: server.origin,
        app: "livepeer-example/fal-flux-schnell",
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.runners).toHaveLength(1);
      expect(entries[0]?.runners[0]?.app).toBe("livepeer-example/fal-flux-schnell");
    } finally {
      await server.close();
    }
  });

  it("uses explicit discoveryUrl over signer default", async () => {
    const server = await startMockServer((req, res) => {
      expect(req.pathname).toBe("/custom-discovery");
      json(res, 200, RUNNERS);
    });
    try {
      const entries = await discoverRunners({
        signerUrl: "https://unused.example",
        discoveryUrl: `${server.origin}/custom-discovery`,
      });
      expect(entries[0]?.runners.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-list discovery response", async () => {
    const server = await startMockServer((_req, res) => {
      json(res, 200, { runners: [] });
    });
    try {
      await discoverRunners({ signerUrl: server.origin });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteSignerError);
      expect((e as Error).message).toMatch(/JSON list/);
    } finally {
      await server.close();
    }
  });
});
