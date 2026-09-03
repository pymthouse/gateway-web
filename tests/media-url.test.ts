import { describe, expect, it } from "vitest";
import { capabilityMediaKind, extractMediaUrl, mediaKind } from "../src/media-url.js";

describe("extractMediaUrl", () => {
  it("reads flat keys", () => {
    expect(extractMediaUrl({ image_url: "https://a/i.png" })).toBe("https://a/i.png");
    expect(extractMediaUrl({ url: "https://a/i.png" })).toBe("https://a/i.png");
  });

  it("reads OpenAI Images { data: [{ url }] }", () => {
    expect(extractMediaUrl({ data: [{ url: "https://a/i.png" }] })).toBe("https://a/i.png");
  });

  it("reads nested fal shapes", () => {
    expect(extractMediaUrl({ video: { url: "https://a/v.mp4" } })).toBe("https://a/v.mp4");
    expect(extractMediaUrl({ images: [{ url: "https://a/i.png" }] })).toBe("https://a/i.png");
    expect(extractMediaUrl({ data: { data: { url: "https://a/i.png" } } })).toBe("https://a/i.png");
  });

  it("reads runner receipt output.images[0].url", () => {
    expect(
      extractMediaUrl({
        request_id: "req-123",
        endpoint_id: "xai/grok-imagine-image/v2.0/text-to-image",
        schema_sha256: "a".repeat(64),
        output: { images: [{ url: "https://cdn.example/grok.png" }] },
      }),
    ).toBe("https://cdn.example/grok.png");
  });

  it("reads meshy model_urls", () => {
    expect(extractMediaUrl({ model_urls: { glb: "https://a/m.glb" } })).toBe("https://a/m.glb");
  });

  it("falls back to any http(s) string", () => {
    expect(extractMediaUrl({ weird: "https://a/x.bin" })).toBe("https://a/x.bin");
  });

  it("does not treat fal queue control URLs as media", () => {
    expect(
      extractMediaUrl({
        request_id: "req-123",
        status: "IN_QUEUE",
        status_url: "https://queue.fal.run/fal-ai/flux/requests/req-123/status",
        response_url: "https://queue.fal.run/fal-ai/flux/requests/req-123",
        cancel_url: "https://queue.fal.run/fal-ai/flux/requests/req-123/cancel",
      }),
    ).toBeNull();
    expect(
      extractMediaUrl({
        endpoint_id: "fal-ai/flux/schnell",
        output: {
          request_id: "req-123",
          status_url: "https://queue.fal.run/fal-ai/flux/requests/req-123/status",
        },
        request_id: "req-123",
      }),
    ).toBeNull();
  });

  it("returns null for empty", () => {
    expect(extractMediaUrl(null)).toBeNull();
    expect(extractMediaUrl({})).toBeNull();
  });
});

describe("mediaKind / capabilityMediaKind", () => {
  it("classifies URLs by extension", () => {
    expect(mediaKind("https://a/x.mp4")).toBe("video");
    expect(mediaKind("https://a/x.wav")).toBe("audio");
    expect(mediaKind("https://a/x.png")).toBe("image");
  });

  it("buckets capabilities like the SDK service", () => {
    expect(capabilityMediaKind("flux-schnell")).toBe("image");
    expect(capabilityMediaKind("pixverse-i2v")).toBe("video");
    expect(capabilityMediaKind("chatterbox-tts")).toBe("audio");
  });
});
