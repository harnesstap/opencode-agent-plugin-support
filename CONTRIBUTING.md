# Contributing

```bash
npm install
npm test
npm run build
```

- `npm test` — Vitest (`test/all.test.ts`, `test/plugin-root.test.ts`, `test/v2-entry.test.ts`): manifest/path containment, enablement merge, `installed_plugins` v1/v2/v3, foreign-project ranking, relative install paths, plugin-root fallback chain (swept cache + directory marketplace, git clones, relative/object marketplace sources, `strict`), skill dedupe, frontmatter, env expansion, v1/v2 tool-name mapping (including MCP), hook JSON / exit code 2, PreToolUse timeout fail-closed, SessionStart source matchers, fixture component load, v1 config injection, v2 `{ id, setup, server }` entry and mocked `setup(ctx)`, per-plugin load isolation.
- Live TUI smoke: [test/smoke.md](test/smoke.md). That needs a logged-in `opencode` binary; this environment may not have one.

See [ARCHITECTURE.md](ARCHITECTURE.md) for v2 transforms vs v1 config injection, component mapping, hook stdin/exit codes, and registry versions.

## Release (maintainers)

npm publish runs only in CI (`release.yml`), matching [harnesstap/harnesstap](https://github.com/harnesstap/harnesstap): GitHub-hosted runner, `permissions: id-token: write`, `actions/setup-node` with `registry-url: https://registry.npmjs.org`, then `npm publish --access public` **in this workflow file** (not `workflow_call`). Provenance is automatic with trusted publishing; the repo must be **public**.

### Cut a release

1. Bump `version` in `package.json` (keep it in lockstep with the git tag).
2. Add a matching heading in `CHANGELOG.md`.
3. Merge to `main`, then tag and push:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

   Tag `v*` must equal `package.json` `version` (with or without the `v` prefix). The workflow fails if they differ, and skips publish if that version is already on npm.

4. Optional: **Actions → Release → Run workflow** (`workflow_dispatch`) and pass the tag.

Do not publish from a laptop except the one-time first publish below.

### One-time npm setup

The `@harnesstap` npm scope already exists (org/user `harnesstap`, maintainer `kayrnt`). Provenance requires this GitHub repository to be public.

**Trusted publisher (after the package exists on npm):** on [npmjs.com](https://www.npmjs.com/) → package `@harnesstap/opencode-agent-plugin-support` → **Settings → Trusted publishing** → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `harnesstap` |
| Repository | `opencode-agent-plugin-support` |
| Workflow filename | `release.yml` (filename only, not a path) |
| Environment name | leave empty (this workflow does not use a GitHub Environment) |
| Allowed actions | allow **`npm publish`** |

Complete the first successful OIDC publish within **2 days** of creating that configuration, or npm expires it.

npm’s Trusted Publisher UI is on the **package** settings page. Current npm docs do not provide a PyPI-style pending publisher for a name that is not on the registry yet, so **the first publish cannot use OIDC until the package exists**.

**First publish of `0.1.0` (once):** as npm user `kayrnt`, from a clean `main` checkout at the tagged commit:

```bash
npm login   # kayrnt, with publish rights on @harnesstap
npm ci
npm publish --access public
```

Then add the trusted publisher table above. Later `v*` tags publish via OIDC with **no `NPM_TOKEN`**.

If you prefer the first publish to also run in GitHub Actions, temporarily uncomment the `NODE_AUTH_TOKEN` block in `.github/workflows/release.yml`, add repo secret `NPM_TOKEN` (granular automation token with write to `@harnesstap/opencode-agent-plugin-support`), push `v0.1.0`, then remove the secret and restore OIDC-only.

Enable [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository) on this repo (Settings → Code security).
