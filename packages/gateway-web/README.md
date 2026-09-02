# @pymthouse/gateway-web

Minimal Node.js client for Livepeer **live-runner** inference: single-shot HTTP calls, HTTP persistent sessions (`reserve` → `call` → `stop`), and **trickle** publish/subscribe.

Ports the dispatch path that the Python SDK service uses: discover runners, pick by the **advertised** runner mode, pay a 402 challenge via a remote signer, and return the runner's JSON (with a media URL extracted). Persistent runners keep the discovery `/session` URL, reserve a session, POST `{app_url}{endpoint}`, then `POST {control_url}/stop`.

Trickle jobs use `openStreamSession` (reserve with `startFunding: false`, POST the app stream path, parse channel URLs) plus `TricklePublisher` / `TrickleSubscriber`. MPEG-TS frame encode/decode lives in `@pymthouse/gateway-stream`.

`runInference` considers both modes and dispatches per runner. Persistent apps **must** pass `endpoint` — it is not advertised and cannot be guessed from the app id. Missing `endpoint` fails **before** reserve so you are not billed for a session that then 404s.

`runInference` against a persistent runner is `reserve → one call → stop`. Each invocation pays a full reserve; the isolate cannot reuse the session across calls. Hold a session yourself with `reserveSession` / `callSession` / `stopSession` when you need more than one HTTP round-trip.

**Orchestrator failover:** for each capability the gateway caches up to **5 distinct orchestrators** (one runner per orch, merit-ranked). On retryable runner failures (5xx, timeouts, exhausted payment retries on that orch) it automatically tries the next cached orchestrator before giving up. Single-shot runners are tried first when an app is advertised under both modes.

This package does **not** implement BYOC `/process/request/{cap}`, gRPC `GetOrchestrator`, protobuf, WebSocket, LV2V, or training. See [docs/stream-session-handoff.md](../../docs/stream-session-handoff.md) for the streaming-handoff spike.

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

console.log(res.url, res.mode);

// Persistent HTTP apps: pass the app path.
const hello = await gw.runInference({
  capability: "livepeer-example/hello-world",
  endpoint: "/hello",
  params: { name: "livepeer" },
});
```

`reserveSession` / `callSession` / `stopSession` are also on the gateway (and exported) for callers who want to hold a session across multiple HTTP calls. Pass `startFunding: false` to reserve without starting the 3s payment loop; `paymentSession.snapshot()` / `LivePaymentSession.fromSnapshot()` move that loop to another process.

Mint the bearer the same way Console does (`mintUserSignerToken` via
`@pymthouse/builder-sdk` + app signer routing). Do **not** point this package
at `signer.daydream.live`.

`callRunner`, `discoverRunners`, `reserveSession`, `callSession`, `stopSession`, `openStreamSession`, `TricklePublisher`, and `TrickleSubscriber` are also exported for callers who want to drive the pieces directly.

Frame encode/decode (H.264 / MPEG-TS) is `@pymthouse/gateway-stream`.

## Smoke

```bash
CONSOLE_ENV=/path/to/console/.env npm run smoke
```

Uses Console's `PYMTHOUSE_*` M2M vars to mint a signer JWT, then runs
`createGateway().runInference()` against pymthouse discovery. Default capability
is `vllm/qwen3-coder-30b` (chat completion). Override with `CAPABILITY`,
`MODEL`, and `PROMPT`.

## TLS

Runner and discovery hosts often use self-signed certs. TLS verification is **skipped by default** for those hosts (`insecureTls` defaults to `true`). Pass `insecureTls: false` to verify. Signer calls always verify TLS.

## Storyboard

Storyboard depends on this package from npm (`@pymthouse/gateway-web`). It routes
`sdkPost("/inference", …)` through the gateway when `STORYBOARD_GATEWAY_WEB=1`
(pymthouse signer URL required). All other SDK endpoints stay on the SDK service.

## Releasing

CI runs lint, typecheck, tests, and a pack dry-run on every PR and push to `main`.
Pushing a `v*.*.*` tag publishes to npm via trusted publishing and creates a GitHub Release. See [docs/RELEASING.md](../../docs/RELEASING.md).
