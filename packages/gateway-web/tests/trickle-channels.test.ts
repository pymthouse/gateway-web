import { describe, expect, it } from "vitest";
import { parseTrickleChannels, channelUrl } from "../src/trickle/channels.js";
import { LivepeerGatewayError } from "../src/errors.js";

describe("parseTrickleChannels", () => {
  it("reads in/out URL fields", () => {
    const channels = parseTrickleChannels({
      session: "s1",
      in: "http://orch/in",
      out: "http://orch/out",
      mode: "echo",
    });
    expect(channelUrl(channels, "in")).toBe("http://orch/in");
    expect(channelUrl(channels, "out")).toBe("http://orch/out");
  });

  it("reads *_url aliases", () => {
    const channels = parseTrickleChannels({
      in_url: "http://orch/in",
      out_url: "http://orch/out",
    });
    expect(channelUrl(channels, "in")).toBe("http://orch/in");
    expect(channelUrl(channels, "out")).toBe("http://orch/out");
  });

  it("reads a channels array", () => {
    const channels = parseTrickleChannels({
      channels: [
        { name: "in", url: "http://orch/in", mime_type: "video/mp2t" },
        { name: "out", url: "http://orch/out" },
      ],
    });
    expect(channels.get("in")?.mimeType).toBe("video/mp2t");
    expect(channelUrl(channels, "out")).toBe("http://orch/out");
  });

  it("throws when nothing looks like a channel", () => {
    expect(() => parseTrickleChannels({ session: "s1", mode: "echo" })).toThrow(
      LivepeerGatewayError,
    );
  });

  it("channelUrl throws for a missing name", () => {
    const channels = parseTrickleChannels({ in: "http://orch/in" });
    expect(() => channelUrl(channels, "out")).toThrow(/missing "out"/);
  });
});
