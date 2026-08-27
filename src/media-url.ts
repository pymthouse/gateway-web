/**
 * Pull a media URL out of a runner / fal-style response envelope.
 *
 * Port of storyboard `packages/creative-kit/src/utils/url-extract.ts`.
 */
export function extractMediaUrl(resp: unknown): string | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;

  // OpenAI Images: { data: [{ url | b64_json }] }
  if (Array.isArray(r.data)) {
    const first = r.data[0];
    if (first && typeof first === "object") {
      const row = first as Record<string, unknown>;
      if (typeof row.url === "string" && row.url) return row.url;
      if (typeof row.b64_json === "string" && row.b64_json) {
        return `data:image/png;base64,${row.b64_json}`;
      }
    }
  }

  const data = (r.data ?? r) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    if (typeof r.url === "string") return r.url;
    return null;
  }

  if (typeof r.image_url === "string") return r.image_url;
  if (typeof r.video_url === "string") return r.video_url;
  if (typeof r.audio_url === "string") return r.audio_url;
  if (typeof r.url === "string") return r.url;
  if (typeof data.image_url === "string") return data.image_url;
  if (typeof data.video_url === "string") return data.video_url;
  if (typeof data.audio_url === "string") return data.audio_url;

  const images = data.images as Array<{ url?: string }> | undefined;
  if (images?.[0]?.url) return images[0].url;

  const meshes = data.model_meshes as Array<{ url?: string }> | undefined;
  if (meshes?.[0]?.url) return meshes[0].url;

  const nested = (key: string): string | undefined => {
    const v = data[key];
    if (v && typeof v === "object" && "url" in (v as object)) {
      const u = (v as { url?: unknown }).url;
      return typeof u === "string" ? u : undefined;
    }
    return undefined;
  };
  const fromNested =
    nested("image") ??
    nested("video") ??
    nested("audio") ??
    nested("audio_file") ??
    nested("model_mesh") ??
    nested("animation_glb") ??
    nested("rigged_character_glb") ??
    nested("model_glb") ??
    nested("output");
  if (fromNested) return fromNested;

  const modelUrls = data.model_urls;
  if (modelUrls && typeof modelUrls === "object") {
    const bundle = modelUrls as Record<string, unknown>;
    for (const fmt of ["glb", "fbx", "obj", "usdz", "stl"]) {
      const v = bundle[fmt];
      if (typeof v === "string" && v) return v;
      if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") {
        return (v as { url: string }).url;
      }
    }
  }

  if (typeof data.url === "string") return data.url;

  const inner = data.data;
  if (inner && typeof inner === "object") {
    const innerObj = inner as Record<string, unknown>;
    if (typeof innerObj.url === "string") return innerObj.url;
    if (typeof innerObj.image_url === "string") return innerObj.image_url;
    if (typeof innerObj.video_url === "string") return innerObj.video_url;
    if (typeof innerObj.audio_url === "string") return innerObj.audio_url;
  }

  for (const v of Object.values(data)) {
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return null;
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
