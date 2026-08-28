import type { LiveRunnerInstance } from "./types.js";

/** Max distinct orchestrators cached per capability (gateway failover pool). */
export const MAX_ORCHESTRATOR_CACHE = 5;

export const DEFAULT_ORCH_CACHE_TTL_MS = 60_000;

type CacheRow = {
  runners: LiveRunnerInstance[];
  fetchedAt: number;
};

/**
 * In-process cache of up to {@link MAX_ORCHESTRATOR_CACHE} runners for a
 * resolved app/capability (distinct orchestrators first, extra runner URLs
 * fill remaining slots). Refreshed from discovery when stale; dropped after
 * a full-pool failure so the next request re-selects.
 */
export class OrchestratorCache {
  private readonly rows = new Map<string, CacheRow>();

  get(key: string, ttlMs: number): LiveRunnerInstance[] | null {
    const row = this.rows.get(key);
    if (!row) return null;
    if (Date.now() - row.fetchedAt > ttlMs) {
      this.rows.delete(key);
      return null;
    }
    return row.runners;
  }

  set(key: string, runners: LiveRunnerInstance[]): void {
    this.rows.set(key, { runners, fetchedAt: Date.now() });
  }

  delete(key: string): void {
    this.rows.delete(key);
  }

  /** Test helper — drop all cached pools. */
  clear(): void {
    this.rows.clear();
  }
}

export function orchestratorCacheKey(capability: string, app: string): string {
  return `${capability.trim()}\0${app.trim()}`;
}
