# Releasing gateway-web packages

This repo publishes two packages. Each has its own semver and tag prefix:

| Package | Directory | Tag | First publish |
|---|---|---|---|
| `@pymthouse/gateway-web` | `packages/gateway-web` | `v*.*.*` | required (already on npm) |
| `@pymthouse/gateway-stream` | `packages/gateway-stream` | `stream-v*.*.*` | one-time human publish, then OIDC |

The [release workflow](../.github/workflows/release.yml) derives the package
directory from the tag, runs that workspace's tests and build, publishes to npm
via **trusted publishing** (OIDC), and creates a GitHub Release.

## First publish (one-time, per package)

Trusted publishing attaches to an **existing** npm package. Publish once with a
human token before OIDC can take over.

### `@pymthouse/gateway-web` (already published)

```bash
npm login
npm publish --access public --workspace @pymthouse/gateway-web
```

### `@pymthouse/gateway-stream` (do this once)

`node-av` must install with scripts so FFmpeg binaries are present for the
prepublish build:

```bash
npm login
npm ci
npm publish --access public --workspace @pymthouse/gateway-stream
```

Then add the trusted publisher below for **each** package. Later versions go
out from CI — do not leave a long-lived `NPM_TOKEN` on the repo.

## npm trusted publishing (required for CI)

This repo publishes with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) — no `NPM_TOKEN` secret on the publish step.

### One-time setup on npmjs.com

Repeat for **@pymthouse/gateway-web** and **@pymthouse/gateway-stream**:

1. Open the package → **Settings** → **Trusted Publisher**.
2. Add a **GitHub Actions** publisher:
   - **Organization:** `pymthouse`
   - **Repository:** `gateway-web`
   - **Workflow filename:** `release.yml` (exact name, including `.yml`)
   - **Environment:** leave empty unless you use a GitHub Environment
   - **Allowed actions:** `npm publish` (required for configs created after 2026-05-20)
3. **Do not** set an `NPM_TOKEN` repository secret. A leftover token is passed as `NODE_AUTH_TOKEN` by some setups and overrides OIDC, which causes `npm error code EOTP`.

### Workflow requirements (already in `release.yml`)

- `permissions.id-token: write`
- `actions/setup-node` **without** `registry-url`
- **No** `NODE_AUTH_TOKEN` / `NPM_TOKEN` on the publish step
- `npm publish` from the package `working-directory` (npm CLI ≥ 11.5.1)
- Stream tags run `npm ci` **with** install scripts (`node-av` downloads FFmpeg)

`npm whoami` does not reflect OIDC auth; a failed publish usually means the trusted publisher fields do not match the workflow run (repo, workflow file name, or tag vs `workflow_dispatch`).

## Re-run a failed release

If the tag already exists (e.g. `v0.3.0` or `stream-v0.1.0`) but npm publish failed:

1. Confirm trusted publishing and delete `NPM_TOKEN` if present.
2. **Actions** → **release** → **Run workflow** → tag `v0.3.0` or `stream-v0.1.0` → **Run workflow**.

If you use `workflow_dispatch`, the trusted publisher must allow that trigger (same workflow file `release.yml`).

The publish step is idempotent: if `${name}@${version}` is already on the
registry, it skips `npm publish` and still creates the GitHub Release.

## Cutting a new version

Use the **Bump version** workflow (package + bump keyword) or locally:

```bash
# Core — tags vX.Y.Z
npm version patch --workspace @pymthouse/gateway-web --no-git-tag-version
VERSION=$(node -p "require('./packages/gateway-web/package.json').version")
git add packages/gateway-web/package.json package-lock.json
git commit -m "chore: release v${VERSION}"
git tag "v${VERSION}"
git push origin main --tags

# Stream — tags stream-vX.Y.Z
npm version patch --workspace @pymthouse/gateway-stream --no-git-tag-version
VERSION=$(node -p "require('./packages/gateway-stream/package.json').version")
git add packages/gateway-stream/package.json package-lock.json
git commit -m "chore: release stream-v${VERSION}"
git tag "stream-v${VERSION}"
git push origin main --tags
```

The tag push starts **release** automatically.
