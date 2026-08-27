/**
 * Live smoke via createGateway (orchestrator cache + failover).
 *
 *   CONSOLE_ENV=/home/elite/repos/console/.env npm run smoke
 *
 * Optional:
 *   CAPABILITY   default vllm/qwen3-coder-30b
 *   MODEL        default qwen3-coder-30b (vLLM model id on the runner)
 *   PROMPT       default "Reply with exactly one word: hello"
 *   EXTERNAL_USER_ID  default gateway-web-smoke
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createGateway } from "../src/index.js";

const require = createRequire(import.meta.url);

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
    resolve(process.cwd(), "../console/node_modules/@pymthouse/builder-sdk/dist/signer/server.js"),
    "@pymthouse/builder-sdk/signer/server",
    resolve(process.cwd(), "../builder-sdk/dist/signer/server.js"),
  ]);
  const root = tryRequire<{ PmtHouseClient: ClientCtor }>([
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
      "Need PYMTHOUSE_ISSUER_URL, PYMTHOUSE_PUBLIC_CLIENT_ID, PYMTHOUSE_M2M_CLIENT_ID, PYMTHOUSE_M2M_CLIENT_SECRET",
    );
  }

  const externalUserId = (process.env.EXTERNAL_USER_ID ?? "gateway-web-smoke").trim();
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

  const [token, routing] = await Promise.all([
    mintUserSignerToken({
      issuerUrl,
      m2mClientId,
      m2mClientSecret,
      externalUserId,
    }),
    client.getSignerRouting(),
  ]);

  const fromRouting =
    routing.routing?.signerApiUrl?.trim() ||
    routing.patterns?.directDmz?.signerApiUrl?.trim() ||
    "";
  const signerUrl =
    process.env.SIGNER_URL?.trim() ||
    process.env.PYMTHOUSE_SIGNER_URL?.trim() ||
    fromRouting;
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

function chatContent(data: Record<string, unknown>): string | null {
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content : null;
}

async function main(): Promise<void> {
  loadEnvFile(process.env.CONSOLE_ENV?.trim() || resolve(process.cwd(), "../console/.env"));
  loadEnvFile(resolve(process.cwd(), ".env"));

  const session = await mintPymthouseSession();
  const capability = process.env.CAPABILITY?.trim() || "vllm/qwen3-coder-30b";
  const model = process.env.MODEL?.trim() || "qwen3-coder-30b";
  const prompt = process.env.PROMPT ?? "Reply with exactly one word: hello";

  const signerHeaders = { Authorization: `Bearer ${session.jwt}` };
  const gw = createGateway({
    signerUrl: session.signerUrl,
    signerHeaders,
    insecureTls: true,
    timeoutMs: 300_000,
  });

  console.log(
    `smoke: capability=${capability} model=${model} signer=${session.signerUrl} ` +
      `balanceUsdMicros=${session.balanceUsdMicros}`,
  );

  const t0 = Date.now();
  const result = await gw.runInference({
    capability,
    params: {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 32,
    },
  });

  const content = chatContent(result.data);
  console.log(`smoke OK  ${Date.now() - t0}ms  ${result.app}`);
  console.log(`  orchestrator ${result.orchestrator}`);
  console.log(`  runner       ${result.runnerUrl}`);
  if (content) console.log(`  reply        ${content.slice(0, 200)}`);
  else console.log(`  data         ${JSON.stringify(result.data).slice(0, 400)}`);
}

main().catch((err: unknown) => {
  console.error("smoke FAILED:", err);
  process.exit(1);
});
