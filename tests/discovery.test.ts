import { describe, expect, it } from "vitest";
import { defaultDiscoveryUrl, discoverRunners } from "../src/discovery.js";
import { RemoteSignerError } from "../src/errors.js";
import { json, startMockServer } from "./mock-server.js";
import { rotatingBearerCredential } from "./signer-test-helpers.js";

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

  it("401 on discover-orchestrators rotates and retries", async () => {
    const { credential, callCount } = rotatingBearerCredential();
    const authorizations: string[] = [];
    let hits = 0;
    const server = await startMockServer((req, res) => {
      authorizations.push(String(req.headers.authorization ?? ""));
      hits += 1;
      if (hits === 1) {
        json(res, 401, { error: { message: "expired" } });
        return;
      }
      json(res, 200, RUNNERS);
    });
    try {
      const entries = await discoverRunners({
        signerUrl: server.origin,
        signerHeaders: credential,
      });
      expect(entries[0]?.runners.length).toBeGreaterThan(0);
      expect(hits).toBe(2);
      expect(callCount()).toBe(2);
      expect(authorizations).toEqual(["Bearer t1", "Bearer t2"]);
    } finally {
      await server.close();
    }
  });

  it("sends rotating signer headers to an explicit discoveryUrl", async () => {
    const { credential } = rotatingBearerCredential();
    const authorizations: string[] = [];
    const server = await startMockServer((req, res) => {
      expect(req.pathname).toBe("/custom-discovery");
      authorizations.push(String(req.headers.authorization ?? ""));
      json(res, 200, RUNNERS);
    });
    try {
      const entries = await discoverRunners({
        signerUrl: "https://unused.example",
        discoveryUrl: `${server.origin}/custom-discovery`,
        signerHeaders: credential,
      });
      expect(entries[0]?.runners.length).toBeGreaterThan(0);
      expect(authorizations).toEqual(["Bearer t1"]);
    } finally {
      await server.close();
    }
  });
});
