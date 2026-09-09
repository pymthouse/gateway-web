import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SIGNER_REFRESH_SKEW_MS, SignerCredential } from "../src/signer-credential.js";
import type { HeadersMap, SignerCredentialProviderResult } from "../src/types.js";

const CLOCK_START = new Date("2026-01-01T00:00:00Z");

async function withFrozenClock(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(CLOCK_START);
    await run();
  } finally {
    vi.useRealTimers();
  }
}

function countingTtlCredential(
  material: (n: number) => SignerCredentialProviderResult,
): { cred: SignerCredential; calls: () => number } {
  let n = 0;
  const cred = SignerCredential.from(
    () => {
      n += 1;
      return material(n);
    },
    { skewMs: 30_000 },
  );
  return { cred, calls: () => n };
}

describe("SignerCredential", () => {
  it("static bag never invokes a provider and returns identical headers", async () => {
    const bag: HeadersMap = { Authorization: "Bearer k" };
    const cred = SignerCredential.from(bag);
    expect(await cred.headers()).toEqual({ Authorization: "Bearer k" });
    expect(await cred.headers()).toEqual({ Authorization: "Bearer k" });
    cred.invalidate();
    expect(await cred.headers()).toEqual({ Authorization: "Bearer k" });
    expect(cred.key).toBe("Authorization=Bearer k");
  });

  it("from() is idempotent for an existing credential", () => {
    const cred = SignerCredential.from({ Authorization: "Bearer k" });
    expect(SignerCredential.from(cred)).toBe(cred);
  });

  it("from() reuses the credential for the same provider function and skew", () => {
    const provider = () => ({ Authorization: "Bearer k" });
    const defaultSkew = SignerCredential.from(provider);
    expect(SignerCredential.from(provider)).toBe(defaultSkew);
    expect(SignerCredential.from(provider, { skewMs: DEFAULT_SIGNER_REFRESH_SKEW_MS })).toBe(
      defaultSkew,
    );
    const tighter = SignerCredential.from(provider, { skewMs: 5_000 });
    expect(tighter).not.toBe(defaultSkew);
    expect(SignerCredential.from(provider, { skewMs: 5_000 })).toBe(tighter);
  });

  it("provider returning a bare HeadersMap is called once and never proactively refreshed", async () => {
    let calls = 0;
    const cred = SignerCredential.from(() => {
      calls += 1;
      return { Authorization: `Bearer t${calls}` };
    });
    expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
    expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
    expect(calls).toBe(1);
  });

  it("concurrent headers() calls collapse to one provider invocation", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cred = SignerCredential.from(async () => {
      calls += 1;
      await gate;
      return { Authorization: "Bearer shared" };
    });
    const pending = Promise.all([cred.headers(), cred.headers(), cred.headers()]);
    release();
    const results = await pending;
    expect(calls).toBe(1);
    expect(results).toEqual([
      { Authorization: "Bearer shared" },
      { Authorization: "Bearer shared" },
      { Authorization: "Bearer shared" },
    ]);
  });

  it("invalidate() forces the next headers() call to refresh", async () => {
    let calls = 0;
    const cred = SignerCredential.from(() => {
      calls += 1;
      return { Authorization: `Bearer t${calls}` };
    });
    expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
    cred.invalidate();
    expect(await cred.headers()).toEqual({ Authorization: "Bearer t2" });
    expect(calls).toBe(2);
  });

  it("re-invokes the provider once the skew window opens", async () => {
    const { cred, calls } = countingTtlCredential((n) => ({
      headers: { Authorization: `Bearer t${n}` },
      expiresInSeconds: 90,
    }));
    await withFrozenClock(async () => {
      expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
      vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
      expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
      expect(calls()).toBe(1);
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      expect(await cred.headers()).toEqual({ Authorization: "Bearer t2" });
      expect(calls()).toBe(2);
    });
  });

  it("flat Authorization + expiresInSeconds is TTL, not an HTTP header", async () => {
    const { cred, calls } = countingTtlCredential((n) => ({
      Authorization: `Bearer t${n}`,
      expiresInSeconds: 90,
    }));
    await withFrozenClock(async () => {
      expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      expect(await cred.headers()).toEqual({ Authorization: "Bearer t2" });
      expect(calls()).toBe(2);
    });
  });

  it("expiresInSeconds at or below the skew window refreshes on the next headers() call", async () => {
    const { cred, calls } = countingTtlCredential((n) => ({
      headers: { Authorization: `Bearer t${n}` },
      expiresInSeconds: 30,
    }));
    await withFrozenClock(async () => {
      expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
      expect(await cred.headers()).toEqual({ Authorization: "Bearer t2" });
      expect(calls()).toBe(2);
    });
  });

  it("invalidate during an in-flight refresh leaves the credential stale", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cred = SignerCredential.from(async () => {
      calls += 1;
      started();
      await gate;
      return { Authorization: `Bearer t${calls}` };
    });
    const pending = cred.headers();
    await began;
    cred.invalidate();
    release();
    expect(await pending).toEqual({ Authorization: "Bearer t1" });
    expect(await cred.headers()).toEqual({ Authorization: "Bearer t2" });
    expect(calls).toBe(2);
  });

  it("provider throw on refresh after invalidate surfaces the error", async () => {
    let calls = 0;
    const cred = SignerCredential.from(() => {
      calls += 1;
      if (calls === 2) throw new Error("mint failed");
      return { Authorization: "Bearer t1" };
    });
    expect(await cred.headers()).toEqual({ Authorization: "Bearer t1" });
    cred.invalidate();
    await expect(cred.headers()).rejects.toThrow("mint failed");
    expect(calls).toBe(2);
  });

  it("invalidate() is a no-op on a static bag", () => {
    const cred = SignerCredential.from({ Authorization: "Bearer k" });
    expect(cred.invalidate()).toBe(false);
  });
});
