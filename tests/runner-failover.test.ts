import { describe, expect, it } from "vitest";
import { LivepeerGatewayError, LivepeerHTTPError, PaymentObserverError } from "../src/errors.js";
import { isRetryableRunnerFailure } from "../src/runner-failover.js";

describe("runner-failover", () => {
  it("retries on 5xx and gateway timeouts", () => {
    expect(isRetryableRunnerFailure(new LivepeerHTTPError(500, "http://x"))).toBe(true);
    expect(isRetryableRunnerFailure(new LivepeerHTTPError(502, "http://x"))).toBe(true);
    expect(isRetryableRunnerFailure(new LivepeerHTTPError(400, "http://x"))).toBe(false);
    expect(isRetryableRunnerFailure(new LivepeerHTTPError(401, "http://x"))).toBe(false);
    expect(
      isRetryableRunnerFailure(
        new LivepeerGatewayError("runner session response missing control_url"),
      ),
    ).toBe(true);
  });

  it("never retries payment observer failures", () => {
    expect(
      isRetryableRunnerFailure(new PaymentObserverError("payment_manifest_persistence_failed")),
    ).toBe(false);
    expect(
      isRetryableRunnerFailure(
        new PaymentObserverError("connection timeout", new LivepeerHTTPError(503, "http://x")),
      ),
    ).toBe(false);
  });
});
