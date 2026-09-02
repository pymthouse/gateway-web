# gateway-web

npm workspaces for the Livepeer live-runner Node clients.

| Package | What it is |
|---|---|
| [`@pymthouse/gateway-web`](packages/gateway-web) | Discovery, 402 payment handshake, single-shot inference, HTTP persistent sessions, and trickle publish/subscribe (undici only). |
| [`@pymthouse/gateway-stream`](packages/gateway-stream) | Optional MPEG-TS media layer (`node-av`) for trickle jobs that encode or decode frames. |

Install only `@pymthouse/gateway-web` unless you need frame-level media.

## Scripts

```bash
npm test
npm run build
npm run lint
npm run typecheck
```

Releases: `v*.*.*` publishes `@pymthouse/gateway-web`; `stream-v*.*.*` publishes `@pymthouse/gateway-stream`. See [docs/RELEASING.md](docs/RELEASING.md).
