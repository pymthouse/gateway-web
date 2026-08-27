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
  endpointFor,
  instancesFromDiscovery,
  normalizeAppBase,
  pickRunners,
  resolveApp,
  type MeritRank,
} from "./select.js";
import type { HeadersMap, LiveRunnerInstance } from "./types.js";

export interface GatewayConfig {
  signerUrl: string;
  signerHeaders?: HeadersMap;
  discoveryUrl?: string;
  insecureTls?: boolean;
  timeoutMs?: number;
  admitted?: readonly string[] | null;
  meritRank?: MeritRank | null;
  /** Distinct orchestrators to cache per capability for failover (default 5). */
  maxOrchestrators?: number;
  /** TTL for the orchestrator pool cache (default 60s). */
  orchestratorCacheTtlMs?: number;
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
}

export interface InferenceResult {
  url: string | null;
  data: Record<string, unknown>;
  orchestrator: string;
  runnerUrl: string;
  app: string;
  elapsedMs: number;
  imageUrl: string | null;
  videoUrl: string | null;
  audioUrl: string | null;
}

function buildPayload(req: InferenceRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...(req.params ?? {}) };
  const cap = req.capability.toLowerCase();
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
  return payload;
}

function buildInferenceResult(options: {
  req: InferenceRequest;
  runner: LiveRunnerInstance;
  runnerUrl: string;
  data: Record<string, unknown>;
  t0: number;
}): InferenceResult {
  const url =
    extractMediaUrl(options.data) ?? extractMediaUrl({ data: options.data });
  const kind = capabilityMediaKind(options.req.capability);
  return {
    url,
    data: options.data,
    orchestrator: options.runner.orchestratorUrl || "live-runner",
    runnerUrl: options.runnerUrl,
    app: options.runner.app,
    elapsedMs: Date.now() - options.t0,
    imageUrl: kind === "image" ? url : null,
    videoUrl: kind === "video" ? url : null,
    audioUrl: kind === "audio" ? url : null,
  };
}

export interface Gateway {
  runInference(req: InferenceRequest): Promise<InferenceResult>;
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

  return {
    async runInference(req: InferenceRequest): Promise<InferenceResult> {
      const t0 = Date.now();
      if (!req.capability?.trim()) {
        throw new LivepeerGatewayError("runInference requires capability");
      }
      const timeoutMs =
        req.timeoutMs ?? (typeof req.timeout === "number" ? req.timeout * 1000 : defaultTimeoutMs);

      const entries = await discoverRunners({
        signerUrl: config.signerUrl,
        signerHeaders: config.signerHeaders,
        discoveryUrl: config.discoveryUrl,
        app: req.app,
        timeoutMs: Math.min(timeoutMs, 15_000),
        insecureTls,
      });

      const instances = instancesFromDiscovery(entries);
      const app = resolveApp(instances, req.capability, req.app);
      if (!app) {
        throw new NoRunnerAvailableError(
          `No live-runner app matching capability ${JSON.stringify(req.capability)}`,
        );
      }

      const cacheKey = orchestratorCacheKey(req.capability, app);
      let runners = orchCache.get(cacheKey, orchestratorCacheTtlMs);
      if (!runners) {
        runners = pickRunners(
          entries,
          app,
          {
            admitted: config.admitted,
            meritRank: config.meritRank,
            capName: req.capability,
          },
          maxOrchestrators,
        );
        if (runners.length === 0) {
          throw new NoRunnerAvailableError(`no LR single-shot runner for app ${app} in discovery`);
        }
        orchCache.set(cacheKey, runners);
      }

      const endpoint = endpointFor(app, req.endpoint);
      const payload = buildPayload(req);
      const rejections: Array<{ url: string; reason: string }> = [];
      let lastError: unknown;

      for (const runner of runners) {
        const runnerUrl = joinEndpoint(normalizeAppBase(runner.url), endpoint);
        try {
          const result = await callRunner({
            runnerUrl,
            runner,
            payload,
            signerUrl: config.signerUrl,
            signerHeaders: config.signerHeaders,
            timeoutMs,
            insecureTls,
          });
          return buildInferenceResult({
            req,
            runner,
            runnerUrl,
            data: result.data,
            t0,
          });
        } catch (e) {
          lastError = e;
          rejections.push({
            url: runner.orchestratorUrl || runnerUrl,
            reason: rejectionReason(e),
          });
          if (!isRetryableRunnerFailure(e)) throw e;
        }
      }

      throw new NoRunnerAvailableError(
        `all ${runners.length} orchestrator(s) failed for capability ${JSON.stringify(req.capability)}` +
          (lastError instanceof Error ? `: ${lastError.message}` : ""),
        rejections,
      );
    },
  };
}
