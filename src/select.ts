import type { DiscoveryEntry, LiveRunnerInstance, LiveRunnerPriceInfo } from "./types.js";

export type MeritRank = (capName: string, orchAddrs: string[]) => string[];

export interface PickRunnerOptions {
  admitted?: readonly string[] | null;
  meritRank?: MeritRank | null;
  capName?: string;
  choose?: <T>(items: T[]) => T;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function priceInfoFromJson(value: unknown): LiveRunnerPriceInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const price = rec.price;
  if (typeof price === "boolean") return null;
  if (typeof price !== "number" && typeof price !== "string") return null;
  const currency = rec.currency;
  const unit = rec.unit;
  return {
    price,
    currency: typeof currency === "string" ? currency.trim().toLowerCase() : "",
    unit: typeof unit === "string" ? unit.trim().toLowerCase() : "",
  };
}

export function instancesFromDiscovery(entries: DiscoveryEntry[]): LiveRunnerInstance[] {
  const candidates: LiveRunnerInstance[] = [];
  for (const entry of entries) {
    const orchestratorUrl = stringValue(entry.address);
    for (const runner of entry.runners) {
      const url = stringValue(runner.url);
      const app = stringValue(runner.app);
      if (!url || !app) continue;
      candidates.push({
        url,
        app,
        runnerId: stringValue(runner.runner_id),
        mode: stringValue(runner.mode),
        orchestratorUrl,
        raw: { ...runner },
        priceInfo: priceInfoFromJson(runner.price_info),
      });
    }
  }
  return candidates;
}

function isSingleShot(mode: string): boolean {
  const n = mode.replaceAll("_", "-").trim();
  if (!n) return true;
  return n === "single-shot";
}

function lastAppSegment(app: string): string {
  const trimmed = app.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function compactToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function appMatchesCapability(app: string, capability: string): boolean {
  if (app === capability) return true;
  const seg = lastAppSegment(app);
  if (seg === capability) return true;
  // storyboard/fal-flux-schnell ↔ flux-schnell
  if (seg.endsWith(`-${capability}`) || seg.endsWith(capability)) return true;
  const n = app.toLowerCase();
  const s = capability.toLowerCase();
  const cn = compactToken(seg);
  const cs = compactToken(s);
  if (cs.length >= 4 && (cn === cs || cn.includes(cs) || cs.includes(cn))) return true;
  if (s === "flux-dev" && /flux\.?1[-.]?dev/.test(n)) return true;
  if (s === "flux-schnell" && n.includes("schnell")) return true;
  return false;
}

/** Resolve a capability name to a discovery `app` id. Explicit override wins. */
export function resolveApp(
  instances: LiveRunnerInstance[],
  capability: string,
  override?: string,
): string | null {
  if (override && override.trim()) return override.trim();
  const cap = capability.trim();
  if (!cap) return null;
  for (const inst of instances) {
    if (appMatchesCapability(inst.app, cap)) return inst.app;
  }
  return null;
}

export function endpointFor(app: string, endpoint?: string): string {
  if (endpoint && endpoint.trim()) {
    const ep = endpoint.trim();
    return ep.startsWith("/") ? ep : `/${ep}`;
  }
  const seg = lastAppSegment(app);
  // Production fal live-runner apps advertise storyboard/fal-<cap> and
  // serve POST /generate (see lr_offerings.default_offerings). Community
  // image-generation apps on pymthouse serve the OpenAI Images API.
  if (app.startsWith("image-generation/") || app.includes("/image-generation/")) {
    return "/v1/images/generations";
  }
  if (app.startsWith("vllm/") || seg.startsWith("vllm")) {
    return "/v1/chat/completions";
  }
  if (seg.startsWith("fal-")) return "/generate";
  if (seg) return `/${seg}`;
  return "/generate";
}

export function normalizeAppBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/session")) {
    return `${trimmed.slice(0, -"/session".length)}/app`;
  }
  if (!trimmed.endsWith("/app")) {
    return `${trimmed}/app`;
  }
  return trimmed;
}

function defaultChoose<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function admitOrchestrator(
  addr: string,
  admitted: readonly string[] | null | undefined,
): boolean {
  if (!admitted || admitted.length === 0) return true;
  return admitted.some((a) => Boolean(a) && addr.includes(a));
}

function singleShotCandidates(
  entries: DiscoveryEntry[],
  appId: string,
  admitted: readonly string[] | null | undefined,
): LiveRunnerInstance[] {
  return instancesFromDiscovery(entries).filter(
    (inst) =>
      inst.app === appId &&
      isSingleShot(inst.mode) &&
      inst.url &&
      admitOrchestrator(inst.orchestratorUrl, admitted),
  );
}

/** `image-generation/black-forest-labs/FLUX.1-dev` → `image-generation`. */
export function appFamilyPrefix(app: string): string {
  const slash = app.indexOf("/");
  return slash > 0 ? app.slice(0, slash) : "";
}

const MODALITY_FAMILIES = new Set([
  "image-generation",
  "video-generation",
  "audio-generation",
]);

function orderOrchestratorUrls(
  orchUrls: string[],
  capName: string | undefined,
  meritRank: MeritRank | null | undefined,
): string[] {
  if (!capName || !meritRank || orchUrls.length <= 1) return orchUrls;
  try {
    const ranked = meritRank(capName, orchUrls);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const addr of ranked) {
      if (!orchUrls.includes(addr) || seen.has(addr)) continue;
      seen.add(addr);
      ordered.push(addr);
    }
    for (const addr of orchUrls) {
      if (!seen.has(addr)) ordered.push(addr);
    }
    return ordered;
  } catch {
    return orchUrls;
  }
}

/**
 * Up to `max` single-shot runners for `appId`.
 *
 * Prefers distinct orchestrator addresses (merit rank, then discovery order),
 * then fills remaining slots with other runner URLs for the same app — including
 * extra GPUs that share an orchestrator host.
 */
export function pickRunners(
  entries: DiscoveryEntry[],
  appId: string,
  options: PickRunnerOptions = {},
  max = 5,
): LiveRunnerInstance[] {
  const choose = options.choose ?? defaultChoose;
  const limit = Math.max(1, max);
  const pairs = singleShotCandidates(entries, appId, options.admitted);
  if (pairs.length === 0) return [];

  const byUrl = new Map<string, LiveRunnerInstance>();
  for (const inst of pairs) {
    if (!byUrl.has(inst.url)) byUrl.set(inst.url, inst);
  }
  const unique = [...byUrl.values()];

  const byOrch = new Map<string, LiveRunnerInstance[]>();
  for (const inst of unique) {
    const key = inst.orchestratorUrl || inst.url;
    const bucket = byOrch.get(key);
    if (bucket) bucket.push(inst);
    else byOrch.set(key, [inst]);
  }

  const orchOrder = orderOrchestratorUrls(
    [...byOrch.keys()],
    options.capName,
    options.meritRank,
  );

  const picked: LiveRunnerInstance[] = [];
  const usedUrls = new Set<string>();
  for (const orch of orchOrder) {
    if (picked.length >= limit) break;
    const bucket = byOrch.get(orch);
    if (!bucket?.length) continue;
    const inst = bucket.length === 1 ? bucket[0]! : choose(bucket);
    picked.push(inst);
    usedUrls.add(inst.url);
  }

  for (const inst of unique) {
    if (picked.length >= limit) break;
    if (usedUrls.has(inst.url)) continue;
    picked.push(inst);
    usedUrls.add(inst.url);
  }

  return picked;
}

/**
 * Exact-app pool first, then other single-shot apps in the same family
 * (`image-generation/…`) on orchestrators not already in the pool.
 */
export function pickInferencePool(
  entries: DiscoveryEntry[],
  appId: string,
  options: PickRunnerOptions = {},
  max = 5,
): LiveRunnerInstance[] {
  const limit = Math.max(1, max);
  const exact = pickRunners(entries, appId, options, limit);
  if (exact.length >= limit) return exact;

  const family = appFamilyPrefix(appId);
  if (!family || !MODALITY_FAMILIES.has(family)) return exact;

  const usedUrls = new Set(exact.map((r) => r.url));
  const usedOrchs = new Set(exact.map((r) => r.orchestratorUrl).filter(Boolean));
  const extras: LiveRunnerInstance[] = [];

  for (const inst of instancesFromDiscovery(entries)) {
    if (extras.length + exact.length >= limit) break;
    if (inst.app === appId) continue;
    if (!inst.app.startsWith(`${family}/`)) continue;
    if (!isSingleShot(inst.mode) || !inst.url) continue;
    if (!admitOrchestrator(inst.orchestratorUrl, options.admitted)) continue;
    if (usedUrls.has(inst.url)) continue;
    if (inst.orchestratorUrl && usedOrchs.has(inst.orchestratorUrl)) continue;
    extras.push(inst);
    usedUrls.add(inst.url);
    if (inst.orchestratorUrl) usedOrchs.add(inst.orchestratorUrl);
  }

  return [...exact, ...extras];
}

/**
 * Pick ONE single-shot runner for `appId`, or null.
 *
 * Port of simple-infra `lr_select.pick_base`: admit by orchestrator-address
 * substring, then optional merit ranking, then random among remaining.
 */
export function pickRunner(
  entries: DiscoveryEntry[],
  appId: string,
  options: PickRunnerOptions = {},
): LiveRunnerInstance | null {
  const runners = pickRunners(entries, appId, options, 1);
  return runners[0] ?? null;
}
