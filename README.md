# @pymthouse/gateway-web

Minimal Node.js client for Livepeer **live-runner** single-shot inference.

Ports the dispatch path that the Python SDK service uses for `POST /inference` → `call_runner`: discover runners, pick single-shot apps, pay a 402 challenge via a remote signer, and return the runner's JSON (with a media URL extracted).

**Orchestrator failover:** for each capability the gateway caches up to **5 distinct orchestrators** (one runner per orch, merit-ranked). On retryable runner failures (5xx, timeouts, exhausted payment retries on that orch) it automatically tries the next cached orchestrator before giving up.

This package does **not** implement BYOC `/process/request/{cap}`, gRPC `GetOrchestrator`, protobuf, LV2V/trickle, or training.

Published to the **`@pymthouse`** npm org (not `@livepeer` — no npm org access there).

## Install

```bash
npm install @pymthouse/gateway-web
```

Node 20+. Runtime dependency: `undici` (needed so TLS verification can be disabled **per request** for self-signed orchestrator/runner certs — never set `NODE_TLS_REJECT_UNAUTHORIZED=0`).

## Usage

```ts
import { createGateway } from "@pymthouse/gateway-web";

const gw = createGateway({
  signerUrl: "https://signer.pymthouse.com",
  signerHeaders: { Authorization: `Bearer ${process.env.PYMTHOUSE_API_KEY}` },
  // discoveryUrl defaults to `${signerUrl}/discover-orchestrators`
  insecureTls: true, // runner + discovery only; signer stays verified
  timeoutMs: 600_000,
});

const res = await gw.runInference({
  capability: "image-generation/black-forest-labs/FLUX.1-dev",
  params: { prompt: "a dragon" },
});

console.log(res.url);
```

Mint the bearer the same way Console does (`mintUserSignerToken` via
`@pymthouse/builder-sdk` + app signer routing). Do **not** point this package
at `signer.daydream.live`.

`callRunner` and `discoverRunners` are also exported for callers who want to drive the pieces directly.

## Smoke

```bash
CONSOLE_ENV=/path/to/console/.env npm run smoke
```

Uses Console's `PYMTHOUSE_*` M2M vars to mint a signer JWT, then runs
`createGateway().runInference()` against pymthouse discovery. Default capability
is `vllm/qwen3-coder-30b` (chat completion). Override with `CAPABILITY`,
`MODEL`, and `PROMPT`.

## TLS

Runner and discovery hosts often use self-signed certs. Pass `insecureTls: true` on the gateway (or per-call). Signer calls always verify TLS.

## Storyboard

Storyboard depends on this package from npm (`@pymthouse/gateway-web`). It routes
`sdkPost("/inference", …)` through the gateway when `STORYBOARD_GATEWAY_WEB=1`
(pymthouse signer URL required). All other SDK endpoints stay on the SDK service.

## Releasing

CI runs lint, typecheck, tests, and a pack dry-run on every PR and push to `main`.
Pushing a `v*.*.*` tag publishes to npm via trusted publishing and creates a GitHub Release. See [docs/RELEASING.md](docs/RELEASING.md).
