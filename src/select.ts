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
  return mode.replaceAll("_", "-") === "single-shot";
}

function lastAppSegment(app: string): string {
  const trimmed = app.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function appMatchesCapability(app: string, capability: string): boolean {
  if (app === capability) return true;
  const seg = lastAppSegment(app);
  if (seg === capability) return true;
  // storyboard/fal-flux-schnell ↔ flux-schnell
  if (seg.endsWith(`-${capability}`) || seg.endsWith(capability)) return true;
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

function singleShotCandidates(
  entries: DiscoveryEntry[],
  appId: string,
  admitted: readonly string[] | null | undefined,
): LiveRunnerInstance[] {
  function admit(addr: string): boolean {
    if (!admitted || admitted.length === 0) return true;
    return admitted.some((a) => Boolean(a) && addr.includes(a));
  }

  return instancesFromDiscovery(entries).filter(
    (inst) =>
      inst.app === appId && isSingleShot(inst.mode) && inst.url && admit(inst.orchestratorUrl),
  );
}

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
 * Up to `maxOrchestrators` single-shot runners — at most one runner per distinct
 * orchestrator address, ordered by merit rank then discovery order.
 */
export function pickRunners(
  entries: DiscoveryEntry[],
  appId: string,
  options: PickRunnerOptions = {},
  maxOrchestrators = 5,
): LiveRunnerInstance[] {
  const choose = options.choose ?? defaultChoose;
  const pairs = singleShotCandidates(entries, appId, options.admitted);
  if (pairs.length === 0) return [];

  const byOrch = new Map<string, LiveRunnerInstance[]>();
  for (const inst of pairs) {
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

  const limit = Math.max(1, Math.min(maxOrchestrators, orchOrder.length));
  const picked: LiveRunnerInstance[] = [];
  for (const orch of orchOrder) {
    if (picked.length >= limit) break;
    const bucket = byOrch.get(orch);
    if (!bucket?.length) continue;
    picked.push(bucket.length === 1 ? bucket[0]! : choose(bucket));
  }
  return picked;
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
