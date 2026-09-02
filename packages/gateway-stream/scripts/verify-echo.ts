/**
 * Live verify against a local echo runner:
 *
 *   DISCOVERY_URL=https://localhost:8935/discovery npm run verify:echo --workspace @pymthouse/gateway-stream
 *
 * Discovers `livepeer-example/echo`, opens `/echo`, publishes synthetic 64x64
 * yuv420p frames onto `in`, and asserts MediaOutput receives bytes on `out`.
 */
import { discoverRunners, openStreamSession, pickRunner } from "@pymthouse/gateway-web";
import { MediaOutput, MediaPublish } from "../src/index.js";
import { logStats, withDeadline } from "./verify-util.js";

const APP = "livepeer-example/echo";
const WIDTH = 64;
const HEIGHT = 64;

function yuv420p(width: number, height: number, y: number): Buffer {
  const size = (width * height * 3) / 2;
  const buf = Buffer.alloc(size, 128);
  buf.fill(y, 0, width * height);
  return buf;
}

async function main(): Promise<void> {
  const discoveryUrl = process.env.DISCOVERY_URL?.trim() || "https://localhost:8935/discovery";
  const signerUrl = process.env.SIGNER_URL?.trim() || "";
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? 30_000);
  const frameCount = Number(process.env.FRAME_COUNT ?? 30);

  console.log(`verify-echo: discovery=${discoveryUrl} app=${APP}`);

  const entries = await discoverRunners({
    discoveryUrl,
    app: APP,
    insecureTls: true,
    timeoutMs: 15_000,
    signerUrl: signerUrl || undefined,
  });
  const runner = pickRunner(entries, APP, { modes: ["persistent"] });
  if (!runner) {
    throw new Error(`No persistent runner for ${APP} in discovery`);
  }
  console.log(`verify-echo: runner ${runner.url}`);

  const stream = await openStreamSession({
    runner,
    endpoint: "/echo",
    streamPayload: { mode: "echo" },
    signerUrl,
    insecureTls: true,
    timeoutMs,
    startFunding: Boolean(signerUrl),
  });

  let bytes = 0;
  const output = new MediaOutput(stream.channelUrl("out"), {
    onBytes(chunk) {
      bytes += chunk.byteLength;
    },
    maxRetries: 8,
    insecureTls: true,
  });
  const started = output.start();

  const pub = new MediaPublish(stream.channelUrl("in"), {
    video: { fps: 10, keyframeIntervalS: 0.5 },
    minSegmentWallclockS: 0.2,
    trickle: { insecureTls: true },
  });

  try {
    for (let i = 0; i < frameCount; i += 1) {
      await pub.writeFrame({
        width: WIDTH,
        height: HEIGHT,
        data: yuv420p(WIDTH, HEIGHT, 40 + (i % 8) * 20),
      });
    }
    await pub.close();

    const deadline = Date.now() + timeoutMs;
    while (bytes === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (bytes === 0) {
      throw new Error(`verify-echo: no bytes received on out within ${timeoutMs}ms`);
    }
    console.log(`verify-echo OK  bytes=${bytes} frames=${frameCount}`);
  } finally {
    logStats("verify-echo:", pub, output);
    try {
      await withDeadline(
        "verify-echo teardown",
        20_000,
        (async () => {
          await output.close();
          await started.catch(() => undefined);
        })(),
      );
    } catch (e) {
      console.error("verify-echo:", e);
    }
    await stream.stop().catch(() => undefined);
  }
}

try {
  await main();
} catch (err: unknown) {
  console.error("verify-echo FAILED:", err);
  process.exit(1);
}
