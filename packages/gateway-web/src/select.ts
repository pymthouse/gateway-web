import { randomInt } from "node:crypto";
import { stripTrailingSlashes } from "./strings.js";
import type { DiscoveryEntry, LiveRunnerInstance, LiveRunnerPriceInfo } from "./types.js";

export type MeritRank = (capName: string, orchAddrs: string[]) => string[];

export type RunnerMode = "single-shot" | "persistent";

const DEFAULT_MODES: readonly RunnerMode[] = ["single-shot"];

export interface PickRunnerOptions {
  admitted?: readonly string[] | null;
  meritRank?: MeritRank | null;
  capName?: string;
  choose?: <T>(items: T[]) => T;
  /** Default `["single-shot"]` so existing callers do not reserve sessions. */
  modes?: readonly RunnerMode[];
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

/** Interpret the advertised runner mode. Empty / missing defaults to single-shot. */
export function advertisedMode(mode: string): RunnerMode {
  const n = mode.replaceAll("_", "-").trim();
  if (!n || n === "single-shot") return "single-shot";
  return "persistent";
}

function requestedModes(options: PickRunnerOptions): readonly RunnerMode[] {
  return options.modes && options.modes.length > 0 ? options.modes : DEFAULT_MODES;
}

function modeAllowed(mode: string, modes: readonly RunnerMode[]): boolean {
  return modes.includes(advertisedMode(mode));
}

function lastAppSegment(app: string): string {
  const trimmed = stripTrailingSlashes(app);
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
  if (override?.trim()) return override.trim();
  const cap = capability.trim();
  if (!cap) return null;
  for (const inst of instances) {
    if (appMatchesCapability(inst.app, cap)) return inst.app;
  }
  return null;
}

/**
 * HTTP path on `app_url` for a persistent session call.
 *
 * Trickle apps still start over this HTTP POST (`/echo`, `/stream`, …). The
 * response carries channel URLs; `TricklePublisher` / `TrickleSubscriber`
 * then speak the segment protocol. WebSocket apps remain out of scope.
 */
export function endpointFor(app: string, endpoint?: string): string {
  if (endpoint?.trim()) {
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

/** Suffix `/app` when the catalog published a bare runner base. Never rewrite `/session`. */
export function normalizeAppBase(base: string): string {
  const trimmed = stripTrailingSlashes(base);
  if (!trimmed.endsWith("/app")) {
    return `${trimmed}/app`;
  }
  return trimmed;
}

function defaultChoose<T>(items: T[]): T {
  if (items.length === 0) return items[0] as T;
  return items[randomInt(items.length)] as T;
}

function admitOrchestrator(addr: string, admitted: readonly string[] | null | undefined): boolean {
  if (!admitted || admitted.length === 0) return true;
  return admitted.some((a) => Boolean(a) && addr.includes(a));
}

function modeCandidates(
  entries: DiscoveryEntry[],
  appId: string,
  admitted: readonly string[] | null | undefined,
  modes: readonly RunnerMode[],
): LiveRunnerInstance[] {
  return instancesFromDiscovery(entries).filter(
    (inst) =>
      inst.app === appId &&
      modeAllowed(inst.mode, modes) &&
      inst.url &&
      admitOrchestrator(inst.orchestratorUrl, admitted),
  );
}

/** `image-generation/black-forest-labs/FLUX.1-dev` → `image-generation`. */
export function appFamilyPrefix(app: string): string {
  const slash = app.indexOf("/");
  return slash > 0 ? app.slice(0, slash) : "";
}

const MODALITY_FAMILIES = new Set(["image-generation", "video-generation", "audio-generation"]);

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

function uniqueByUrl(instances: LiveRunnerInstance[]): LiveRunnerInstance[] {
  const byUrl = new Map<string, LiveRunnerInstance>();
  for (const inst of instances) {
    if (!byUrl.has(inst.url)) byUrl.set(inst.url, inst);
  }
  return [...byUrl.values()];
}

function groupByOrchestrator(instances: LiveRunnerInstance[]): Map<string, LiveRunnerInstance[]> {
  const byOrch = new Map<string, LiveRunnerInstance[]>();
  for (const inst of instances) {
    const key = inst.orchestratorUrl || inst.url;
    const bucket = byOrch.get(key);
    if (bucket) bucket.push(inst);
    else byOrch.set(key, [inst]);
  }
  return byOrch;
}

function takeUntilLimit(
  source: Iterable<LiveRunnerInstance>,
  picked: LiveRunnerInstance[],
  usedUrls: Set<string>,
  limit: number,
): void {
  for (const inst of source) {
    if (picked.length >= limit) return;
    if (usedUrls.has(inst.url)) continue;
    picked.push(inst);
    usedUrls.add(inst.url);
  }
}

function pickOnePerOrchestrator(
  orchOrder: string[],
  byOrch: Map<string, LiveRunnerInstance[]>,
  choose: <T>(items: T[]) => T,
): LiveRunnerInstance[] {
  const picked: LiveRunnerInstance[] = [];
  for (const orch of orchOrder) {
    const bucket = byOrch.get(orch);
    if (!bucket?.length) continue;
    picked.push(bucket.length === 1 ? bucket[0]! : choose(bucket));
  }
  return picked;
}

function pickFromCandidates(
  pairs: LiveRunnerInstance[],
  options: PickRunnerOptions,
  max: number,
): LiveRunnerInstance[] {
  if (pairs.length === 0) return [];
  const choose = options.choose ?? defaultChoose;
  const limit = Math.max(1, max);
  const unique = uniqueByUrl(pairs);
  const byOrch = groupByOrchestrator(unique);
  const orchOrder = orderOrchestratorUrls([...byOrch.keys()], options.capName, options.meritRank);
  const picked: LiveRunnerInstance[] = [];
  const usedUrls = new Set<string>();
  takeUntilLimit(pickOnePerOrchestrator(orchOrder, byOrch, choose), picked, usedUrls, limit);
  takeUntilLimit(unique, picked, usedUrls, limit);
  return picked;
}

/**
 * Up to `max` runners for `appId` in the requested modes (default single-shot).
 *
 * Prefers distinct orchestrator addresses (merit rank, then discovery order),
 * then fills remaining slots with other runner URLs for the same app — including
 * extra GPUs that share an orchestrator host. When both modes are requested,
 * single-shot runners come first.
 */
export function pickRunners(
  entries: DiscoveryEntry[],
  appId: string,
  options: PickRunnerOptions = {},
  max = 5,
): LiveRunnerInstance[] {
  const modes = requestedModes(options);
  const limit = Math.max(1, max);
  if (modes.includes("single-shot") && modes.includes("persistent")) {
    const single = pickFromCandidates(
      modeCandidates(entries, appId, options.admitted, ["single-shot"]),
      options,
      limit,
    );
    if (single.length >= limit) return single;
    const persist = pickFromCandidates(
      modeCandidates(entries, appId, options.admitted, ["persistent"]),
      options,
      limit - single.length,
    );
    return [...single, ...persist];
  }
  return pickFromCandidates(
    modeCandidates(entries, appId, options.admitted, modes),
    options,
    limit,
  );
}

function isFamilyFailoverCandidate(
  inst: LiveRunnerInstance,
  appId: string,
  family: string,
  usedUrls: Set<string>,
  usedOrchs: Set<string>,
  admitted: readonly string[] | null | undefined,
  modes: readonly RunnerMode[],
): boolean {
  return (
    inst.app !== appId &&
    inst.app.startsWith(`${family}/`) &&
    modeAllowed(inst.mode, modes) &&
    Boolean(inst.url) &&
    admitOrchestrator(inst.orchestratorUrl, admitted) &&
    !usedUrls.has(inst.url) &&
    !(inst.orchestratorUrl && usedOrchs.has(inst.orchestratorUrl))
  );
}

function familyModeOrder(modes: readonly RunnerMode[]): readonly RunnerMode[] {
  if (modes.includes("single-shot") && modes.includes("persistent")) {
    return ["single-shot", "persistent"];
  }
  return modes;
}

/**
 * Exact-app pool first, then other apps in the same family
 * (`image-generation/…`) on orchestrators not already in the pool.
 */
export function pickInferencePool(
  entries: DiscoveryEntry[],
  appId: string,
  options: PickRunnerOptions = {},
  max = 5,
): LiveRunnerInstance[] {
  const limit = Math.max(1, max);
  const modes = requestedModes(options);
  const exact = pickRunners(entries, appId, options, limit);
  if (exact.length >= limit) return exact;

  const family = appFamilyPrefix(appId);
  if (!family || !MODALITY_FAMILIES.has(family)) return exact;

  const usedUrls = new Set(exact.map((r) => r.url));
  const usedOrchs = new Set(exact.map((r) => r.orchestratorUrl).filter(Boolean));
  const extras: LiveRunnerInstance[] = [];
  const familyInstances = instancesFromDiscovery(entries);
  for (const mode of familyModeOrder(modes)) {
    for (const inst of familyInstances) {
      if (extras.length + exact.length >= limit) break;
      if (
        !isFamilyFailoverCandidate(inst, appId, family, usedUrls, usedOrchs, options.admitted, [
          mode,
        ])
      ) {
        continue;
      }
      extras.push(inst);
      usedUrls.add(inst.url);
      if (inst.orchestratorUrl) usedOrchs.add(inst.orchestratorUrl);
    }
  }
  return [...exact, ...extras];
}

/**
 * Pick ONE runner for `appId` in the requested modes (default single-shot), or null.
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
