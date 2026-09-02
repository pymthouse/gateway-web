import type * as NodeAvApi from "node-av/api";
import type * as NodeAvConstants from "node-av/constants";
import type * as NodeAvLib from "node-av";

export class NodeAvLoadError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown = null) {
    super(message, cause !== null && cause !== undefined ? { cause } : undefined);
    this.name = "NodeAvLoadError";
    this.cause = cause;
  }
}

export interface NodeAvModules {
  api: typeof NodeAvApi;
  constants: typeof NodeAvConstants;
  lib: typeof NodeAvLib;
}

let cached: Promise<NodeAvModules> | null = null;

/**
 * Load `node-av` on first use. Throws `NodeAvLoadError` if the native module
 * is missing (typical when install ran with `--ignore-scripts`).
 */
export function loadNodeAv(): Promise<NodeAvModules> {
  cached ??= (async () => {
    try {
      const [api, constants, lib] = await Promise.all([
        import("node-av/api"),
        import("node-av/constants"),
        import("node-av"),
      ]);
      return { api, constants, lib };
    } catch (cause) {
      cached = null;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new NodeAvLoadError(
        `Failed to load node-av (${detail}). @pymthouse/gateway-stream needs its native FFmpeg bindings; reinstall without --ignore-scripts.`,
        cause,
      );
    }
  })();
  return cached;
}

/** Test helper. */
export function clearNodeAvCache(): void {
  cached = null;
}
