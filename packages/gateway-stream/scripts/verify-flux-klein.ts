/**
 * Live verify against `livepeer-example/flux-klein`:
 *
 *   CONSOLE_ENV=/path/to/console/.env npm run verify:flux-klein --workspace @pymthouse/gateway-stream
 *
 * Discovers the runner, POSTs `/stream`, publishes synthetic frames onto `in`,
 * POSTs `/update` mid-stream, and asserts MediaOutput receives bytes on `out`.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  discoverRunners,
  openStreamSession,
  pickRunner,
} from "@pymthouse/gateway-web";
import { MediaOutput, MediaPublish } from "../src/index.js";

const require = createRequire(import.meta.url);
const APP = "livepeer-example/flux-klein";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    const key = trimmed.slice(0, i);
    let value = trimmed.slice(i + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

type MintFn = (opts: {
  issuerUrl: string;
  m2mClientId: string;
  m2mClientSecret: string;
  externalUserId: string;
}) => Promise<{ jwt: string; balanceUsdMicros: string }>;

type ClientCtor = new (opts: {
  issuerUrl: string;
  publicClientId: string;
  m2mClientId: string;
  m2mClientSecret: string;
}) => {
  upsertAppUser: (opts: { externalUserId: string; email?: string }) => Promise<unknown>;
  getSignerRouting: () => Promise<{
    routing?: { signerApiUrl?: string };
    patterns?: { directDmz?: { signerApiUrl?: string } };
  }>;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = resolve(SCRIPT_DIR, "../../../..");

function tryRequire<T>(ids: string[]): T {
  let lastErr: unknown;
  for (const id of ids) {
    try {
      return require(id) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Cannot load module from ${ids.join(" | ")}. Last error: ${lastErr}`);
}

function loadBuilderSdk(): { mintUserSignerToken: MintFn; PmtHouseClient: ClientCtor } {
  const server = tryRequire<{ mintUserSignerToken: MintFn }>([
    resolve(REPOS_DIR, "console/node_modules/@pymthouse/builder-sdk/dist/signer/server.js"),
    resolve(process.cwd(), "../console/node_modules/@pymthouse/builder-sdk/dist/signer/server.js"),
    "@pymthouse/builder-sdk/signer/server",
    resolve(process.cwd(), "../builder-sdk/dist/signer/server.js"),
  ]);
  const root = tryRequire<{ PmtHouseClient: ClientCtor }>([
    resolve(REPOS_DIR, "console/node_modules/@pymthouse/builder-sdk/dist/index.js"),
    resolve(process.cwd(), "../console/node_modules/@pymthouse/builder-sdk/dist/index.js"),
    "@pymthouse/builder-sdk",
    resolve(process.cwd(), "../builder-sdk/dist/index.js"),
  ]);
  return {
    mintUserSignerToken: server.mintUserSignerToken,
    PmtHouseClient: root.PmtHouseClient,
  };
}

async function mintPymthouseSession(): Promise<{
  jwt: string;
  signerUrl: string;
  balanceUsdMicros: string;
}> {
  const issuerUrl = process.env.PYMTHOUSE_ISSUER_URL?.trim();
  const publicClientId = process.env.PYMTHOUSE_PUBLIC_CLIENT_ID?.trim();
  const m2mClientId = process.env.PYMTHOUSE_M2M_CLIENT_ID?.trim();
  const m2mClientSecret = process.env.PYMTHOUSE_M2M_CLIENT_SECRET?.trim();
  if (!issuerUrl || !publicClientId || !m2mClientId || !m2mClientSecret) {
    throw new Error(
      "Need PYMTHOUSE_ISSUER_URL, PYMTHOUSE_PUBLIC_CLIENT_ID, PYMTHOUSE_M2M_CLIENT_ID, PYMTHOUSE_M2M_CLIENT_SECRET (or CONSOLE_ENV)",
    );
  }

  const externalUserId = (process.env.EXTERNAL_USER_ID ?? "gateway-stream-flux-klein").trim();
  const { mintUserSignerToken, PmtHouseClient } = loadBuilderSdk();
  const client = new PmtHouseClient({
    issuerUrl,
    publicClientId,
    m2mClientId,
    m2mClientSecret,
  });

  try {
    await client.upsertAppUser({
      externalUserId,
      email: `${externalUserId}@livepeer.local`,
    });
  } catch {
    // user may already exist
  }

  const token = await mintUserSignerToken({
    issuerUrl,
    m2mClientId,
    m2mClientSecret,
    externalUserId,
  });

  let fromRouting = "";
  try {
    const routing = await client.getSignerRouting();
    fromRouting =
      routing.routing?.signerApiUrl?.trim() ||
      routing.patterns?.directDmz?.signerApiUrl?.trim() ||
      "";
  } catch {
    // routing endpoint is optional when SIGNER_URL / PYMTHOUSE_SIGNER_URL is set
  }
  const signerUrl =
    process.env.SIGNER_URL?.trim() || process.env.PYMTHOUSE_SIGNER_URL?.trim() || fromRouting;
  if (!signerUrl) {
    throw new Error("No signer URL from routing / PYMTHOUSE_SIGNER_URL / SIGNER_URL");
  }
  if (new URL(signerUrl).hostname.toLowerCase() === "signer.daydream.live") {
    throw new Error("Refusing Daydream signer — use pymthouse (Console path)");
  }

  return {
    jwt: token.jwt,
    signerUrl: signerUrl.replace(/\/+$/, ""),
    balanceUsdMicros: token.balanceUsdMicros,
  };
}

function yuv420p(width: number, height: number, y: number): Buffer {
  const size = (width * height * 3) / 2;
  const buf = Buffer.alloc(size, 128);
  buf.fill(y, 0, width * height);
  return buf;
}

async function main(): Promise<void> {
  loadEnvFile(process.env.CONSOLE_ENV?.trim() || resolve(REPOS_DIR, "console/.env"));
  loadEnvFile(resolve(process.cwd(), ".env"));

  const timeoutMs = Number(process.env.TIMEOUT_MS ?? 60_000);
  const frameCount = Number(process.env.FRAME_COUNT ?? 24);
  const width = Number(process.env.FRAME_WIDTH ?? 64);
  const height = Number(process.env.FRAME_HEIGHT ?? 64);
  const prompt = process.env.PROMPT ?? "a red cube on a studio table, cinematic lighting";
  const updatePrompt = process.env.UPDATE_PROMPT ?? "a blue sphere on a studio table, cinematic lighting";

  const paid = Boolean(
    process.env.PYMTHOUSE_ISSUER_URL?.trim() && process.env.PYMTHOUSE_M2M_CLIENT_SECRET?.trim(),
  );
  const session = paid ? await mintPymthouseSession() : null;
  const signerUrl = session?.signerUrl ?? process.env.SIGNER_URL?.trim() ?? "";
  const signerHeaders = session ? { Authorization: `Bearer ${session.jwt}` } : undefined;
  const discoveryUrl = process.env.DISCOVERY_URL?.trim() || undefined;

  console.log(
    `verify-flux-klein: app=${APP} discovery=${discoveryUrl ?? "(signer)"} ` +
      `signer=${signerUrl || "(none)"}` +
      (session ? ` balanceUsdMicros=${session.balanceUsdMicros}` : ""),
  );

  const entries = await discoverRunners({
    discoveryUrl,
    signerUrl: signerUrl || undefined,
    signerHeaders,
    app: APP,
    insecureTls: true,
    timeoutMs: 15_000,
  });
  const runner = pickRunner(entries, APP, { modes: ["persistent"] });
  if (!runner) {
    throw new Error(`No persistent runner for ${APP} in discovery`);
  }
  console.log(`verify-flux-klein: runner ${runner.url}`);

  const stream = await openStreamSession({
    runner,
    endpoint: "/stream",
    streamPayload: { prompt },
    signerUrl,
    signerHeaders,
    insecureTls: true,
    timeoutMs,
    callTimeoutMs: timeoutMs,
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
    video: { fps: 8, keyframeIntervalS: 1 },
    minSegmentWallclockS: 0.5,
    trickle: { insecureTls: true },
  });

  try {
    const mid = Math.max(1, Math.floor(frameCount / 2));
    for (let i = 0; i < frameCount; i += 1) {
      if (i === mid) {
        console.log(`verify-flux-klein: POST /update prompt=${JSON.stringify(updatePrompt)}`);
        await stream.call({
          endpoint: "/update",
          payload: { prompt: updatePrompt },
          timeoutMs,
          insecureTls: true,
        });
      }
      await pub.writeFrame({
        width,
        height,
        data: yuv420p(width, height, 40 + (i % 8) * 20),
      });
    }
    await pub.close();

    const deadline = Date.now() + timeoutMs;
    while (bytes === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (bytes === 0) {
      throw new Error(`verify-flux-klein: no bytes received on out within ${timeoutMs}ms`);
    }
    console.log(`verify-flux-klein OK  bytes=${bytes} frames=${frameCount}`);
  } finally {
    await output.close();
    await started.catch(() => undefined);
    await stream.stop().catch(() => undefined);
  }
}

try {
  await main();
} catch (err: unknown) {
  console.error("verify-flux-klein FAILED:", err);
  process.exit(1);
}
