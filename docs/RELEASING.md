# Releasing `@pymthouse/gateway-web`

Releases are triggered by pushing a semver tag (`v*.*.*`). The [release workflow](../.github/workflows/release.yml) runs tests, builds, publishes to npm via **trusted publishing** (OIDC), and creates a GitHub Release.

## First publish (one-time)

Trusted publishing attaches to an **existing** npm package. The name
`@pymthouse/gateway-web` must be published once with a human token before OIDC
can take over:

```bash
npm login
npm publish --access public
```

Then add the trusted publisher below. Later versions go out from CI — do not
leave a long-lived `NPM_TOKEN` on the repo.

## npm trusted publishing (required for CI)

This repo publishes with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) — no `NPM_TOKEN` secret on the publish step.

### One-time setup on npmjs.com

1. Open **@pymthouse/gateway-web** → **Settings** → **Trusted Publisher**.
2. Add a **GitHub Actions** publisher:
   - **Organization:** `pymthouse`
   - **Repository:** `gateway-web`
   - **Workflow filename:** `release.yml` (exact name, including `.yml`)
   - **Environment:** leave empty unless you use a GitHub Environment
   - **Allowed actions:** `npm publish` (required for configs created after 2026-05-20)
3. **Do not** set an `NPM_TOKEN` repository secret. A leftover token is passed as `NODE_AUTH_TOKEN` by some setups and overrides OIDC, which causes `npm error code EOTP`.

### Workflow requirements (already in `release.yml`)

- `permissions.id-token: write`
- `actions/setup-node` with `registry-url: https://registry.npmjs.org`
- **No** `NODE_AUTH_TOKEN` / `NPM_TOKEN` on the publish step
- `npm publish` (npm CLI ≥ 11.5.1)

`npm whoami` does not reflect OIDC auth; a failed publish usually means the trusted publisher fields do not match the workflow run (repo, workflow file name, or tag vs `workflow_dispatch`).

## Re-run a failed release

If the tag already exists (e.g. `v0.1.0`) but npm publish failed:

1. Confirm trusted publishing and delete `NPM_TOKEN` if present.
2. **Actions** → **release** → **Run workflow** → tag `v0.1.0` → **Run workflow**.

If you use `workflow_dispatch`, the trusted publisher must allow that trigger (same workflow file `release.yml`).

The publish step is idempotent: if `${name}@${version}` is already on the
registry, it skips `npm publish` and still creates the GitHub Release.

## Cutting a new version

Use the **Bump version** workflow or locally:

```bash
npm version patch   # or minor / major / prerelease
git push origin main --tags
```

The tag push starts **release** automatically.
