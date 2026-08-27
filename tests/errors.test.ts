import { describe, expect, it } from "vitest";
import { LivepeerHTTPError, NoRunnerAvailableError, SignerRefreshRequired } from "../src/errors.js";
import { extractErrorMessageFromBody, raiseHttpJsonError } from "../src/http.js";

describe("errors", () => {
  it("LivepeerHTTPError carries status, url, body", () => {
    const err = new LivepeerHTTPError(402, "http://x", '{"a":1}');
    expect(err.status).toBe(402);
    expect(err.url).toBe("http://x");
    expect(err.body).toBe('{"a":1}');
    expect(err).toBeInstanceOf(Error);
  });

  it("NoRunnerAvailableError formats rejections", () => {
    const err = new NoRunnerAvailableError("none", [
      { url: "http://a", reason: "down" },
      { url: "http://b", reason: "402" },
    ]);
    expect(err.toString()).toContain("http://a: down");
    expect(err.toString()).toContain("http://b: 402");
  });

  it("raiseHttpJsonError maps 480 and 482", () => {
    expect(() => raiseHttpJsonError(480, "http://s")).toThrow(SignerRefreshRequired);
    try {
      raiseHttpJsonError(480, "http://s", "", { "Livepeer-Orchestrator-URL": "https://orch" });
    } catch (e) {
      expect(e).toBeInstanceOf(SignerRefreshRequired);
      expect((e as SignerRefreshRequired).orchestratorUrl).toBe("https://orch");
    }
    expect(() => raiseHttpJsonError(482, "http://s")).toThrow(/skip payment cycle/);
  });

  it("extractErrorMessageFromBody prefers error.message", () => {
    expect(extractErrorMessageFromBody('{"error":{"message":"nope"}}')).toBe("nope");
    expect(extractErrorMessageFromBody("plain")).toBe("plain");
  });
});
