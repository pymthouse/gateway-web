import { describe, expect, it } from "vitest";
import {
  advertisedMode,
  instancesFromDiscovery,
  normalizeAppBase,
  pickInferencePool,
  pickRunner,
  pickRunners,
  priceInfoFromJson,
  resolveApp,
} from "../src/select.js";
import type { DiscoveryEntry } from "../src/types.js";

function entry(address: string, runners: Array<Record<string, unknown>>): DiscoveryEntry {
  return { address, runners };
}

const ENTRIES: DiscoveryEntry[] = [
  entry("https://orch-a:8936", [
    {
      app: "livepeer-example/fal-flux-schnell",
      url: "https://orch-a:8936/apps/flux/session",
      mode: "single-shot",
      runner_id: "r1",
      price_info: { price: 3, currency: "USD", unit: "fixed" },
    },
    {
      app: "livepeer-example/fal-flux-schnell",
      url: "https://orch-a:8936/apps/flux-persist",
      mode: "persistent",
      runner_id: "r-persist",
    },
  ]),
  entry("https://orch-b:8936", [
    {
      app: "livepeer-example/fal-flux-schnell",
      url: "https://orch-b:8936/apps/flux",
      mode: "single_shot",
      runner_id: "r2",
    },
  ]),
  entry("https://orch-c:8936", [
    {
      app: "other/app",
      url: "https://orch-c:8936/apps/other",
      mode: "single-shot",
    },
  ]),
];

describe("select", () => {
  it("advertisedMode treats empty and single_shot as single-shot", () => {
    expect(advertisedMode("")).toBe("single-shot");
    expect(advertisedMode("single_shot")).toBe("single-shot");
    expect(advertisedMode("single-shot")).toBe("single-shot");
    expect(advertisedMode("persistent")).toBe("persistent");
    expect(advertisedMode("PERSISTENT")).toBe("persistent");
  });

  it("priceInfoFromJson parses upstream and sell", () => {
    const info = priceInfoFromJson({
      price: "10",
      currency: "wei",
      unit: "usage",
      upstream: {
        provider: "fal",
        endpoint_id: "fal-ai/flux/dev",
        unit: "image",
        unit_price: "0.025",
        currency: "USD",
      },
      sell: { unit: "image", price: "0.02625", currency: "USD", upcharge_bps: 500 },
    });
    expect(info?.unit).toBe("usage");
    expect(info?.upstream?.endpointId).toBe("fal-ai/flux/dev");
    expect(info?.sell?.price).toBe("0.02625");
    expect(info?.sell?.upchargeBps).toBe(500);
  });

  it("normalizeAppBase suffixes /app/ so Go mux does not 301 the POST", () => {
    expect(normalizeAppBase("https://x/apps/flux/session")).toBe(
      "https://x/apps/flux/session/app/",
    );
    expect(normalizeAppBase("https://x/apps/flux")).toBe("https://x/apps/flux/app/");
    expect(normalizeAppBase("https://x/apps/flux/app")).toBe("https://x/apps/flux/app/");
    expect(normalizeAppBase("https://x/apps/flux/app/")).toBe("https://x/apps/flux/app/");
  });

  it("resolveApp: override, then exact capability === runner.app", () => {
    const instances = instancesFromDiscovery(ENTRIES);
    expect(resolveApp(instances, "flux-schnell", "explicit/app")).toBe("explicit/app");
    expect(resolveApp(instances, "livepeer-example/fal-flux-schnell")).toBe(
      "livepeer-example/fal-flux-schnell",
    );
    expect(resolveApp(instances, "fal-flux-schnell")).toBeNull();
    expect(resolveApp(instances, "flux-schnell")).toBeNull();
    expect(resolveApp(instances, "missing")).toBeNull();
  });

  it("resolveApp does not fuzzy-match image-generation catalog names", () => {
    const instances = instancesFromDiscovery([
      entry("https://orch-d:8936", [
        {
          app: "image-generation/black-forest-labs/FLUX.1-dev",
          url: "https://orch-d:8936/apps/flux",
          mode: "single-shot",
        },
        {
          app: "image-generation/black-forest-labs/FLUX.1-schnell",
          url: "https://orch-d:8936/apps/schnell",
          mode: "single-shot",
        },
      ]),
    ]);
    expect(resolveApp(instances, "flux-schnell")).toBeNull();
    expect(resolveApp(instances, "flux-dev")).toBeNull();
    expect(resolveApp(instances, "image-generation/black-forest-labs/FLUX.1-dev")).toBe(
      "image-generation/black-forest-labs/FLUX.1-dev",
    );
  });

  it("pickRunner keeps single-shot (including single_shot) and matching app", () => {
    const picked = pickRunner(ENTRIES, "livepeer-example/fal-flux-schnell", {
      choose: (items) => items[0]!,
    });
    expect(picked?.runnerId).toBe("r1");
    expect(picked?.mode).toBe("single-shot");
    expect(picked?.priceInfo?.unit).toBe("fixed");
  });

  it("pickRunner applies admission allow-list", () => {
    const picked = pickRunner(ENTRIES, "livepeer-example/fal-flux-schnell", {
      admitted: ["orch-b"],
    });
    expect(picked?.orchestratorUrl).toBe("https://orch-b:8936");
  });

  it("pickRunner uses meritRank when multiple orchs remain", () => {
    const picked = pickRunner(ENTRIES, "livepeer-example/fal-flux-schnell", {
      capName: "flux-schnell",
      meritRank: (_cap, addrs) => [...addrs].reverse(),
    });
    expect(picked?.orchestratorUrl).toBe("https://orch-b:8936");
  });

  it("pickRunner returns null when nothing matches", () => {
    expect(pickRunner(ENTRIES, "nope")).toBeNull();
  });

  it("pickRunners returns one runner per orchestrator up to max", () => {
    const many: DiscoveryEntry[] = [
      entry("https://orch-1:8936", [
        {
          app: "livepeer-example/fal-flux-schnell",
          url: "https://orch-1:8936/a",
          mode: "single-shot",
        },
      ]),
      entry("https://orch-2:8936", [
        {
          app: "livepeer-example/fal-flux-schnell",
          url: "https://orch-2:8936/b",
          mode: "single-shot",
        },
      ]),
      entry("https://orch-3:8936", [
        {
          app: "livepeer-example/fal-flux-schnell",
          url: "https://orch-3:8936/c",
          mode: "single-shot",
        },
      ]),
    ];
    const picked = pickRunners(many, "livepeer-example/fal-flux-schnell", {}, 5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((r) => r.orchestratorUrl)).size).toBe(3);
  });

  it("pickRunners fills extra runner URLs on the same orchestrator", () => {
    const sameHost: DiscoveryEntry[] = [
      entry("http://154.61.61.108:8787/", [
        {
          app: "image-generation/black-forest-labs/FLUX.1-dev",
          url: "http://154.61.61.108:8787/apps/flux-a",
          mode: "single-shot",
          runner_id: "gpu-a",
        },
        {
          app: "image-generation/black-forest-labs/FLUX.1-dev",
          url: "http://154.61.61.108:8787/apps/flux-b",
          mode: "single-shot",
          runner_id: "gpu-b",
        },
      ]),
    ];
    const picked = pickRunners(
      sameHost,
      "image-generation/black-forest-labs/FLUX.1-dev",
      { choose: (items) => items[0]! },
      5,
    );
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((r) => r.url)).size).toBe(2);
  });

  it("pickInferencePool tries sibling family apps on other orchestrators", () => {
    const mixed: DiscoveryEntry[] = [
      entry("https://orch-a:8936", [
        {
          app: "image-generation/black-forest-labs/FLUX.1-dev",
          url: "https://orch-a:8936/apps/flux",
          mode: "single-shot",
        },
      ]),
      entry("https://orch-b:8936", [
        {
          app: "image-generation/stability/sdxl",
          url: "https://orch-b:8936/apps/sdxl",
          mode: "single-shot",
        },
      ]),
    ];
    const picked = pickInferencePool(
      mixed,
      "image-generation/black-forest-labs/FLUX.1-dev",
      { choose: (items) => items[0]! },
      5,
    );
    expect(picked.map((r) => r.app)).toEqual([
      "image-generation/black-forest-labs/FLUX.1-dev",
      "image-generation/stability/sdxl",
    ]);
  });

  it("pickRunners default modes skip persistent runners", () => {
    const picked = pickRunners(ENTRIES, "livepeer-example/fal-flux-schnell", {
      choose: (items) => items[0]!,
    });
    expect(picked.every((r) => r.mode !== "persistent")).toBe(true);
    expect(picked.map((r) => r.runnerId)).not.toContain("r-persist");
  });

  it("pickRunners includes persistent when both modes are requested", () => {
    const picked = pickRunners(
      ENTRIES,
      "livepeer-example/fal-flux-schnell",
      { choose: (items) => items[0]!, modes: ["single-shot", "persistent"] },
      5,
    );
    expect(picked.map((r) => r.runnerId)).toContain("r-persist");
    expect(picked.filter((r) => r.mode !== "persistent").length).toBeGreaterThan(0);
    const persistIdx = picked.findIndex((r) => r.mode === "persistent");
    const singleIdx = picked.findIndex((r) => r.mode !== "persistent");
    expect(singleIdx).toBeGreaterThanOrEqual(0);
    expect(persistIdx).toBeGreaterThan(singleIdx);
  });

  it("mixed-mode app yields single-shot first", () => {
    const mixed: DiscoveryEntry[] = [
      entry("https://orch-persist:8936", [
        {
          app: "livepeer-example/hello-world",
          url: "https://orch-persist:8936/apps/hello/session",
          mode: "persistent",
          runner_id: "persist",
        },
      ]),
      entry("https://orch-shot:8936", [
        {
          app: "livepeer-example/hello-world",
          url: "https://orch-shot:8936/apps/hello/app",
          mode: "single-shot",
          runner_id: "shot",
        },
      ]),
    ];
    const picked = pickRunners(
      mixed,
      "livepeer-example/hello-world",
      { choose: (items) => items[0]!, modes: ["single-shot", "persistent"] },
      5,
    );
    expect(picked.map((r) => r.runnerId)).toEqual(["shot", "persist"]);
  });

  it("pickInferencePool does not mix livepeer-example apps across capabilities", () => {
    const mixed: DiscoveryEntry[] = [
      entry("https://orch-a:8936", [
        {
          app: "livepeer-example/fal-flux-schnell",
          url: "https://orch-a:8936/apps/flux",
          mode: "single-shot",
        },
      ]),
      entry("https://orch-b:8936", [
        {
          app: "livepeer-example/fal-ltx-i2v",
          url: "https://orch-b:8936/apps/ltx",
          mode: "single-shot",
        },
      ]),
    ];
    const picked = pickInferencePool(mixed, "livepeer-example/fal-flux-schnell", {
      choose: (items) => items[0]!,
    });
    expect(picked).toHaveLength(1);
    expect(picked[0]?.app).toBe("livepeer-example/fal-flux-schnell");
  });
});
