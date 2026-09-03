import { randomUUID } from "node:crypto";

import { callRunner } from "./call-runner.js";
import { discoverRunners } from "./discovery.js";
import { LivepeerGatewayError, NoRunnerAvailableError } from "./errors.js";
import { joinEndpoint } from "./http.js";
import { capabilityMediaKind, extractMediaUrl } from "./media-url.js";
import {
  DEFAULT_ORCH_CACHE_TTL_MS,
  MAX_ORCHESTRATOR_CACHE,
  OrchestratorCache,
  orchestratorCacheKey,
} from "./orch-cache.js";
import { isRetryableRunnerFailure, rejectionReason } from "./runner-failover.js";
import {
  advertisedMode,
  endpointFor,
  instancesFromDiscovery,
  normalizeAppBase,
  pickInferencePool,
  pickRunners,
  resolveApp,
  type MeritRank,
  type RunnerMode,
} from "./select.js";
import {
  callSession as callRunnerSession,
  reserveSession as reserveRunnerSession,
  stopSession as stopRunnerSession,
  type CallSessionResult,
  type RunnerSession,
} from "./session.js";
import type { HeadersMap, LiveRunnerInstance } from "./types.js";

export interface GatewayConfig {
  signerUrl: string;
  signerHeaders?: HeadersMap;
  discoveryUrl?: string;
  /**
   * Skip TLS verification for runner and discovery hosts (self-signed orch certs).
   * Default true. Signer requests always verify. Pass false to verify runner/discovery certs.
   */
  insecureTls?: boolean;
  timeoutMs?: number;
  admitted?: readonly string[] | null;
  meritRank?: MeritRank | null;
  /** Distinct orchestrators to cache per capability for failover (default 5). */
  maxOrchestrators?: number;
  /** TTL for the orchestrator pool cache (default 60s). */
  orchestratorCacheTtlMs?: number;
  /**
   * Names the integration on every ticket this gateway pays for, e.g. "mcp".
   * The signer records "direct_api" when it is absent.
   */
  attributionSource?: string;
}

export interface InferenceRequest {
  capability: string;
  params?: Record<string, unknown>;
  prompt?: string;
  imageData?: string;
  image_data?: string;
  timeout?: number;
  timeoutMs?: number;
  app?: string;
  endpoint?: string;
  modelId?: string;
  model_id?: string;
  /**
   * Job id to attribute this call's tickets to. Generated when omitted, and
   * always returned on the result so the caller can join it to metering.
   */
  gatewayRequestId?: string;
}

export interface InferenceResult {
  url: string | null;
  data: Record<string, unknown>;
  orchestrator: string;
  runnerUrl: string;
  app: string;
  mode: RunnerMode;
  elapsedMs: number;
  imageUrl: string | null;
  videoUrl: string | null;
  audioUrl: string | null;
  /** The id carried on this call's payment tickets. */
  gatewayRequestId: string;
}

function lastAppSegment(app: string): string {
  const slash = app.lastIndexOf("/");
  return slash >= 0 ? app.slice(slash + 1) : app;
}

function requirePersistentEndpoint(app: string, endpoint?: string): string {
  const ep = endpoint?.trim();
  if (!ep) {
    throw new LivepeerGatewayError(
      `runInference requires endpoint for persistent app ${JSON.stringify(app)}`,
    );
  }
  return ep;
}

function buildPayload(req: InferenceRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...req.params };
  const cap = req.capability.toLowerCase();
  const appHint = (req.app ?? req.capability).toLowerCase();
  const isTts = ["tts", "chatterbox", "lux-tts", "speech"].some((k) => cap.includes(k));
  if (req.prompt && !("text" in payload) && !("prompt" in payload)) {
    if (isTts) payload.text = req.prompt;
    else payload.prompt = req.prompt;
  }
  const imageData = req.imageData ?? req.image_data;
  if (imageData && !payload.image_url) {
    payload.image_url = imageData.startsWith("data:")
      ? imageData
      : `data:image/jpeg;base64,${imageData}`;
  }
  const modelId = req.modelId ?? req.model_id;
  if (modelId) payload.model_id = modelId;

  const isVllm = appHint.startsWith("vllm/") || lastAppSegment(appHint).startsWith("vllm");
  if (isVllm && typeof payload.prompt === "string" && payload.messages == null) {
    payload.messages = [{ role: "user", content: payload.prompt }];
  }
  const isImageGen =
    appHint.startsWith("image-generation/") || appHint.includes("/image-generation/");
  if (isImageGen && payload.size == null && (payload.width != null || payload.height != null)) {
    payload.size = `${payload.width ?? 1024}x${payload.height ?? 1024}`;
  }
  return payload;
}

function buildInferenceResult(options: {
  req: InferenceRequest;
  runner: LiveRunnerInstance;
  runnerUrl: string;
  data: Record<string, unknown>;
  t0: number;
  gatewayRequestId: string;
}): InferenceResult {
  const url = extractMediaUrl(options.data) ?? extractMediaUrl({ data: options.data });
  const kind = capabilityMediaKind(options.req.capability);
  return {
    url,
    data: options.data,
    orchestrator: options.runner.orchestratorUrl || "live-runner",
    runnerUrl: options.runnerUrl,
    app: options.runner.app,
    mode: advertisedMode(options.runner.mode),
    elapsedMs: Date.now() - options.t0,
    imageUrl: kind === "image" ? url : null,
    videoUrl: kind === "video" ? url : null,
    audioUrl: kind === "audio" ? url : null,
    gatewayRequestId: options.gatewayRequestId,
  };
}

export interface ReserveSessionRequest {
  capability: string;
  params?: Record<string, unknown>;
  app?: string;
  /** Default true. Pass false to hand payment state to another process. */
  startFunding?: boolean;
  /** Job id to attribute this session's tickets to. Generated when omitted. */
  gatewayRequestId?: string;
}

export interface CallSessionRequest {
  endpoint: string;
  payload?: Record<string, unknown>;
  method?: string;
}

export interface Gateway {
  runInference(req: InferenceRequest): Promise<InferenceResult>;
  reserveSession(req: ReserveSessionRequest): Promise<RunnerSession>;
  callSession(handle: RunnerSession, req: CallSessionRequest): Promise<CallSessionResult>;
  stopSession(handle: RunnerSession): Promise<void>;
}

export function createGateway(config: GatewayConfig): Gateway {
  if (!config.signerUrl?.trim()) {
    throw new LivepeerGatewayError("createGateway requires signerUrl");
  }
  const insecureTls = config.insecureTls !== false;
  const defaultTimeoutMs = config.timeoutMs ?? 600_000;
  const maxOrchestrators = Math.min(
    MAX_ORCHESTRATOR_CACHE,
    Math.max(1, config.maxOrchestrators ?? MAX_ORCHESTRATOR_CACHE),
  );
  const orchestratorCacheTtlMs = config.orchestratorCacheTtlMs ?? DEFAULT_ORCH_CACHE_TTL_MS;
  const orchCache = new OrchestratorCache();

  async function loadEntries(timeoutMs: number) {
    return discoverRunners({
      signerUrl: config.signerUrl,
      signerHeaders: config.signerHeaders,
      discoveryUrl: config.discoveryUrl,
      timeoutMs: Math.min(timeoutMs, 15_000),
      insecureTls,
    });
  }

  function cachedInferencePool(
    entries: Awaited<ReturnType<typeof loadEntries>>,
    app: string,
    capability: string,
  ): { cacheKey: string; runners: LiveRunnerInstance[] } {
    const cacheKey = orchestratorCacheKey(capability, app);
    let runners = orchCache.get(cacheKey, orchestratorCacheTtlMs);
    if (!runners) {
      runners = pickInferencePool(
        entries,
        app,
        {
          admitted: config.admitted,
          meritRank: config.meritRank,
          capName: capability,
          modes: ["single-shot", "persistent"],
        },
        maxOrchestrators,
      );
      if (runners.length === 0) {
        throw new NoRunnerAvailableError(
          `no LR runner for app ${app} in discovery (modes: single-shot, persistent)`,
        );
      }
      orchCache.set(cacheKey, runners);
    }
    return { cacheKey, runners };
  }

  async function runSingleShot(
    runner: LiveRunnerInstance,
    req: InferenceRequest,
    payload: Record<string, unknown>,
    timeoutMs: number,
    gatewayRequestId: string,
  ) {
    const endpoint = endpointFor(runner.app, req.endpoint);
    const runnerUrl = joinEndpoint(normalizeAppBase(runner.url), endpoint);
    const result = await callRunner({
      runnerUrl,
      runner,
      payload,
      signerUrl: config.signerUrl,
      signerHeaders: config.signerHeaders,
      timeoutMs,
      insecureTls,
      gatewayRequestId,
      attributionSource: config.attributionSource ?? null,
    });
    return { runnerUrl, data: result.data };
  }

  async function runPersistent(
    runner: LiveRunnerInstance,
    req: InferenceRequest,
    payload: Record<string, unknown>,
    timeoutMs: number,
    gatewayRequestId: string,
  ) {
    const endpoint = requirePersistentEndpoint(runner.app, req.endpoint);
    const session = await reserveRunnerSession({
      runner,
      payload,
      signerUrl: config.signerUrl,
      signerHeaders: config.signerHeaders,
      timeoutMs,
      insecureTls,
      gatewayRequestId,
      attributionSource: config.attributionSource ?? null,
    });
    try {
      const result = await callRunnerSession(session, {
        endpoint,
        payload,
        timeoutMs,
        insecureTls,
      });
      return { runnerUrl: result.runnerUrl, data: result.data };
    } finally {
      try {
        await stopRunnerSession(session, { timeoutMs: 5_000, insecureTls });
      } catch {
        // Release is best-effort; do not hide the app call outcome.
      }
    }
  }

  return {
    async runInference(req: InferenceRequest): Promise<InferenceResult> {
      const t0 = Date.now();
      if (!req.capability?.trim()) {
        throw new LivepeerGatewayError("runInference requires capability");
      }
      const timeoutMs =
        req.timeoutMs ?? (typeof req.timeout === "number" ? req.timeout * 1000 : defaultTimeoutMs);
      const gatewayRequestId = req.gatewayRequestId?.trim() || randomUUID();

      const entries = await loadEntries(timeoutMs);
      const instances = instancesFromDiscovery(entries);
      const app = resolveApp(instances, req.capability, req.app);
      if (!app) {
        throw new NoRunnerAvailableError(
          `No live-runner app matching capability ${JSON.stringify(req.capability)}`,
        );
      }

      const { cacheKey, runners } = cachedInferencePool(entries, app, req.capability);
      if (runners.every((r) => advertisedMode(r.mode) === "persistent")) {
        requirePersistentEndpoint(app, req.endpoint);
      }

      const payload = buildPayload(req);
      const rejections: Array<{ url: string; reason: string }> = [];
      let lastError: unknown;

      for (const runner of runners) {
        const mode = advertisedMode(runner.mode);
        try {
          const result =
            mode === "persistent"
              ? await runPersistent(runner, req, payload, timeoutMs, gatewayRequestId)
              : await runSingleShot(runner, req, payload, timeoutMs, gatewayRequestId);
          return buildInferenceResult({
            req,
            runner,
            runnerUrl: result.runnerUrl,
            data: result.data,
            t0,
            gatewayRequestId,
          });
        } catch (e) {
          lastError = e;
          rejections.push({
            url: runner.orchestratorUrl || runner.url,
            reason: rejectionReason(e),
          });
          if (!isRetryableRunnerFailure(e)) throw e;
        }
      }

      orchCache.delete(cacheKey);
      throw new NoRunnerAvailableError(
        `all ${runners.length} orchestrator(s) failed for capability ${JSON.stringify(req.capability)}` +
          (lastError instanceof Error ? `: ${lastError.message}` : ""),
        rejections,
      );
    },

    async reserveSession(req: ReserveSessionRequest): Promise<RunnerSession> {
      if (!req.capability?.trim()) {
        throw new LivepeerGatewayError("reserveSession requires capability");
      }
      const entries = await loadEntries(defaultTimeoutMs);
      const instances = instancesFromDiscovery(entries);
      const app = resolveApp(instances, req.capability, req.app);
      if (!app) {
        throw new NoRunnerAvailableError(
          `No live-runner app matching capability ${JSON.stringify(req.capability)}`,
        );
      }
      const runners = pickRunners(
        entries,
        app,
        {
          admitted: config.admitted,
          meritRank: config.meritRank,
          capName: req.capability,
          modes: ["persistent"],
        },
        maxOrchestrators,
      );
      if (runners.length === 0) {
        throw new NoRunnerAvailableError(
          `no LR runner for app ${app} in discovery (modes: persistent)`,
        );
      }
      const gatewayRequestId = req.gatewayRequestId?.trim() || randomUUID();
      const rejections: Array<{ url: string; reason: string }> = [];
      let lastError: unknown;
      for (const runner of runners) {
        try {
          return await reserveRunnerSession({
            runner,
            payload: req.params ?? {},
            signerUrl: config.signerUrl,
            signerHeaders: config.signerHeaders,
            timeoutMs: defaultTimeoutMs,
            insecureTls,
            startFunding: req.startFunding,
            gatewayRequestId,
            attributionSource: config.attributionSource ?? null,
          });
        } catch (e) {
          lastError = e;
          rejections.push({
            url: runner.orchestratorUrl || runner.url,
            reason: rejectionReason(e),
          });
          if (!isRetryableRunnerFailure(e)) throw e;
        }
      }
      throw new NoRunnerAvailableError(
        `all ${runners.length} orchestrator(s) failed to reserve ${JSON.stringify(req.capability)}` +
          (lastError instanceof Error ? `: ${lastError.message}` : ""),
        rejections,
      );
    },

    callSession(handle: RunnerSession, req: CallSessionRequest): Promise<CallSessionResult> {
      return callRunnerSession(handle, {
        endpoint: req.endpoint,
        payload: req.payload,
        method: req.method,
        timeoutMs: defaultTimeoutMs,
        insecureTls,
      });
    },

    stopSession(handle: RunnerSession): Promise<void> {
      return stopRunnerSession(handle, { timeoutMs: 5_000, insecureTls });
    },
  };
}
