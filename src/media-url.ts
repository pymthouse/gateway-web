/**
 * Pull a media URL out of a runner / fal-style response envelope.
 *
 * Port of storyboard `packages/creative-kit/src/utils/url-extract.ts`.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringProp(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  return typeof value === "string" ? value : undefined;
}

function openaiImagesUrl(r: Record<string, unknown>): string | null {
  if (!Array.isArray(r.data)) return null;
  const row = asRecord(r.data[0]);
  if (!row) return null;
  const url = stringProp(row, "url");
  if (url) return url;
  const b64 = stringProp(row, "b64_json");
  return b64 ? `data:image/png;base64,${b64}` : null;
}

function mediaFieldUrls(rec: Record<string, unknown>): string | undefined {
  return (
    stringProp(rec, "image_url") ?? stringProp(rec, "video_url") ?? stringProp(rec, "audio_url")
  );
}

function firstArrayItemUrl(data: Record<string, unknown>, key: string): string | undefined {
  const arr = data[key];
  if (!Array.isArray(arr)) return undefined;
  const row = asRecord(arr[0]);
  return row ? stringProp(row, "url") : undefined;
}

function nestedObjectUrl(data: Record<string, unknown>, key: string): string | undefined {
  const rec = asRecord(data[key]);
  return rec ? stringProp(rec, "url") : undefined;
}

const NESTED_MEDIA_KEYS = [
  "image",
  "video",
  "audio",
  "audio_file",
  "model_mesh",
  "animation_glb",
  "rigged_character_glb",
  "model_glb",
  "output",
] as const;

function nestedMediaUrl(data: Record<string, unknown>): string | undefined {
  for (const key of NESTED_MEDIA_KEYS) {
    const url = nestedObjectUrl(data, key);
    if (url) return url;
  }
  return undefined;
}

const MODEL_URL_FORMATS = ["glb", "fbx", "obj", "usdz", "stl"] as const;

function modelBundleUrl(data: Record<string, unknown>): string | undefined {
  const bundle = asRecord(data.model_urls);
  if (!bundle) return undefined;
  for (const fmt of MODEL_URL_FORMATS) {
    const value = bundle[fmt];
    if (typeof value === "string" && value) return value;
    const rec = asRecord(value);
    const url = rec ? stringProp(rec, "url") : undefined;
    if (url) return url;
  }
  return undefined;
}

function firstHttpString(data: Record<string, unknown>): string | null {
  for (const value of Object.values(data)) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  }
  return null;
}

export function extractMediaUrl(resp: unknown): string | null {
  const r = asRecord(resp);
  if (!r) return null;

  const openai = openaiImagesUrl(r);
  if (openai) return openai;

  const data = asRecord(r.data ?? r);
  if (!data) {
    return typeof r.url === "string" ? r.url : null;
  }

  const inner = asRecord(data.data);
  return (
    mediaFieldUrls(r) ??
    stringProp(r, "url") ??
    mediaFieldUrls(data) ??
    firstArrayItemUrl(data, "images") ??
    firstArrayItemUrl(data, "model_meshes") ??
    nestedMediaUrl(data) ??
    modelBundleUrl(data) ??
    stringProp(data, "url") ??
    (inner ? (stringProp(inner, "url") ?? mediaFieldUrls(inner)) : undefined) ??
    firstHttpString(data)
  );
}

export function mediaKind(url: string): "image" | "video" | "audio" {
  const lower = url.toLowerCase();
  if (/\.(mp4|webm|mov|m3u8)(\?|$)/.test(lower) || lower.includes("/video/")) {
    return "video";
  }
  if (/\.(mp3|wav|ogg|flac|m4a)(\?|$)/.test(lower) || lower.includes("/audio/")) {
    return "audio";
  }
  return "image";
}

/** Capability-name bucketing used by the SDK service `/inference` response. */
export function capabilityMediaKind(capability: string): "image" | "video" | "audio" {
  const cap = capability.toLowerCase();
  const vidKeys = [
    "i2v",
    "t2v",
    "video",
    "veo",
    "seedance",
    "pixverse",
    "ltx",
    "kling",
    "ray",
    "cosmos",
  ];
  const audKeys = ["tts", "chatterbox", "speech", "music", "sfx", "audio"];
  if (vidKeys.some((k) => cap.includes(k))) return "video";
  if (audKeys.some((k) => cap.includes(k))) return "audio";
  return "image";
}
