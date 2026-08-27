import { describe, expect, it } from "vitest";
import {
  endpointFor,
  instancesFromDiscovery,
  normalizeAppBase,
  pickRunner,
  pickRunners,
  resolveApp,
} from "../src/select.js";
import type { DiscoveryEntry } from "../src/types.js";

function entry(address: string, runners: Array<Record<string, unknown>>): DiscoveryEntry {
  return { address, runners };
}

const ENTRIES: DiscoveryEntry[] = [
  entry("https://orch-a:8936", [
    {
      app: "storyboard/fal-flux-schnell",
      url: "https://orch-a:8936/apps/flux/session",
      mode: "single-shot",
      runner_id: "r1",
      price_info: { price: 3, currency: "USD", unit: "fixed" },
    },
    {
      app: "storyboard/fal-flux-schnell",
      url: "https://orch-a:8936/apps/flux-persist",
      mode: "persistent",
      runner_id: "r-persist",
    },
  ]),
  entry("https://orch-b:8936", [
    {
      app: "storyboard/fal-flux-schnell",
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
  it("normalizeAppBase rewrites /session → /app", () => {
    expect(normalizeAppBase("https://x/apps/flux/session")).toBe("https://x/apps/flux/app");
    expect(normalizeAppBase("https://x/apps/flux/session/")).toBe("https://x/apps/flux/app");
    expect(normalizeAppBase("https://x/apps/flux")).toBe("https://x/apps/flux/app");
    expect(normalizeAppBase("https://x/apps/flux/app")).toBe("https://x/apps/flux/app");
  });

  it("endpointFor prefers explicit, fal-* → /generate, image-generation → OpenAI images", () => {
    expect(endpointFor("storyboard/fal-flux-schnell")).toBe("/generate");
    expect(endpointFor("storyboard/fal-flux-schnell", "/generate")).toBe("/generate");
    expect(endpointFor("storyboard/fal-flux-schnell", "generate")).toBe("/generate");
    expect(endpointFor("image-generation/black-forest-labs/FLUX.1-dev")).toBe(
      "/v1/images/generations",
    );
    expect(endpointFor("vllm/qwen3-coder-30b")).toBe("/v1/chat/completions");
    expect(endpointFor("emran/screen-agent")).toBe("/screen-agent");
    expect(endpointFor("")).toBe("/generate");
  });

  it("resolveApp: override, exact, then last-segment / fal- prefix", () => {
    const instances = instancesFromDiscovery(ENTRIES);
    expect(resolveApp(instances, "flux-schnell", "explicit/app")).toBe("explicit/app");
    expect(resolveApp(instances, "storyboard/fal-flux-schnell")).toBe(
      "storyboard/fal-flux-schnell",
    );
    expect(resolveApp(instances, "fal-flux-schnell")).toBe("storyboard/fal-flux-schnell");
    expect(resolveApp(instances, "flux-schnell")).toBe("storyboard/fal-flux-schnell");
    expect(resolveApp(instances, "missing")).toBeNull();
  });

  it("pickRunner keeps single-shot (including single_shot) and matching app", () => {
    const picked = pickRunner(ENTRIES, "storyboard/fal-flux-schnell", {
      choose: (items) => items[0]!,
    });
    expect(picked?.runnerId).toBe("r1");
    expect(picked?.mode).toBe("single-shot");
    expect(picked?.priceInfo?.unit).toBe("fixed");
  });

  it("pickRunner applies admission allow-list", () => {
    const picked = pickRunner(ENTRIES, "storyboard/fal-flux-schnell", {
      admitted: ["orch-b"],
    });
    expect(picked?.orchestratorUrl).toBe("https://orch-b:8936");
  });

  it("pickRunner uses meritRank when multiple orchs remain", () => {
    const picked = pickRunner(ENTRIES, "storyboard/fal-flux-schnell", {
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
        { app: "storyboard/fal-flux-schnell", url: "https://orch-1:8936/a", mode: "single-shot" },
      ]),
      entry("https://orch-2:8936", [
        { app: "storyboard/fal-flux-schnell", url: "https://orch-2:8936/b", mode: "single-shot" },
      ]),
      entry("https://orch-3:8936", [
        { app: "storyboard/fal-flux-schnell", url: "https://orch-3:8936/c", mode: "single-shot" },
      ]),
    ];
    const picked = pickRunners(many, "storyboard/fal-flux-schnell", {}, 5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((r) => r.orchestratorUrl)).size).toBe(3);
  });
});
