import { LivepeerGatewayError } from "../errors.js";

export interface TrickleChannel {
  name: string;
  url: string;
  mimeType?: string;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fromChannelList(value: unknown): Map<string, TrickleChannel> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<string, TrickleChannel>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const name = stringField(rec.name) || stringField(rec.channel_name);
    const url = stringField(rec.url);
    if (!name || !url) continue;
    const mimeType = stringField(rec.mime_type) || stringField(rec.mimeType);
    out.set(name, mimeType ? { name, url, mimeType } : { name, url });
  }
  return out.size > 0 ? out : null;
}

/**
 * Parse a runner stream-start JSON body into `{ name -> channel }`.
 * Accepts `{ in, out }`, `{ "in_url", "out_url" }`, or `{ channels: [...] }`.
 */
export function parseTrickleChannels(data: Record<string, unknown>): Map<string, TrickleChannel> {
  const fromList = fromChannelList(data.channels);
  if (fromList) return fromList;

  const out = new Map<string, TrickleChannel>();
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (key === "session" || key === "session_id" || key === "mode") continue;
    if (key.endsWith("_url")) {
      const name = key.slice(0, -4);
      if (name) out.set(name, { name, url: value.trim() });
      continue;
    }
    if (key === "in" || key === "out" || key === "control" || key === "events") {
      out.set(key, { name: key, url: value.trim() });
    }
  }
  if (out.size === 0) {
    throw new LivepeerGatewayError("stream response contained no trickle channel URLs");
  }
  return out;
}

export function channelUrl(channels: Map<string, TrickleChannel>, name: string): string {
  const found = channels.get(name);
  if (!found) {
    throw new LivepeerGatewayError(`stream response missing ${JSON.stringify(name)} url`);
  }
  return found.url;
}
