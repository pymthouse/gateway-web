import type { MediaOutput, MediaPublish } from "../src/index.js";

/**
 * Reject if `p` has not settled within `ms`. Teardown runs on the failure path,
 * so a stuck close must not stop the caller from releasing a paid session.
 */
export async function withDeadline<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Print both transport counters. Without these a "no bytes on out" failure
 * cannot distinguish a rejected publish from an app that produced nothing.
 */
export function logStats(label: string, pub: MediaPublish, output: MediaOutput): void {
  console.log(`${label} publish=${JSON.stringify(pub.getStats())}`);
  console.log(`${label} subscribe=${JSON.stringify(output.getStats())}`);
}

/**
 * Hold frame `index` until its wallclock presentation time. MediaPublish rotates
 * segments on `minSegmentWallclockS`, so an unpaced loop encodes the whole clip
 * into segment 0 and a live app never sees a second segment.
 */
export async function paceToFps(startedAt: number, index: number, fps: number): Promise<void> {
  const delay = startedAt + ((index + 1) * 1000) / fps - Date.now();
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
}
