# Release Checklist

Run through this before every version release. No exceptions.

The release workflow (`.github/workflows/release.yml`) does the publishing and, since 0.5.1, verifies its own external effects: it reads npm, GHCR, the GitHub release and the Official MCP Registry back from outside and fails unless all four say the tag. The human items below are the ones no workflow can reach — sign-ins, third-party dashboards, judgement calls. Two releases in a row (0.4.6, 0.5.0) shipped to npm and never reached the registry because "run `mcp-publisher publish`" was a checkbox here and nothing checked the checkbox; that step is now a job, and this list says what the jobs prove so nobody re-verifies by hand what the run already asserted.

## Pre-release (on a branch, through the PR cycle)

- [ ] Bump version in `package.json`
- [ ] `npm run version:sync` — writes the version into `server.json` (top level + every `packages[]` entry), `website/public/.well-known/mcp.json`, **both** Claude Code plugin manifests (`.claude-plugin/plugin.json` and the one the marketplace actually serves, `claude-plugin/.claude-plugin/plugin.json`), and `package-lock.json`. It prints a `REVIEW` line if `packages/langchain/package.json`'s dependency range on `@iris-eval/mcp-server` no longer admits the new version — that edit is by hand (it is dependency policy, not a mirror).
- [ ] `npm run version:check` — must pass. Same files as the syncer, plus the langchain range and `SECURITY.md`'s supported-versions table. If it fails, fix the file; never widen the check.
- [ ] `CHANGELOG.md`: add the `## [X.Y.Z] - YYYY-MM-DD` section. **The GitHub release body is built from this section** (the workflow refuses a production tag that has none). If behaviour changes, the section needs a **"Check before upgrading"** paragraph up top and each breaking entry marked **BREAKING** in its bullet — there is no second place to write it, and 0.5.0's release page went out without its two breaking changes because there used to be.
- [ ] `SECURITY.md`: the supported-versions table names the new minor (the version check enforces this).
- [ ] `npm run proof` then `npm run proof -- --composite` — regenerate `proof/results.json`, `proof/RESULTS.md`, `src/eval/published-accuracy.ts`, `proof/composite-results.json` and `proof/COMPOSITE.md` so every number carries the release version (`--check` and `--check --composite` are what CI runs). Then `npm run claims:capture-tests` (assert zero failures in `.claims-cache/tests.json`), `npm run claims:generate`, `npm run llms:render` — the truthbase, `docs/capabilities.md`, `docs/evaluators.md`, `llms.txt` and both skill files regenerate from the same files.
- [ ] `bash scripts/check-product-claims.sh` and `npm run claims:check` — the website stats and `.claims.json` match source.
- [ ] `npm test` · `npm run lint` · `npm run typecheck` — green.
- [ ] Merge the release PR (squash). Tag `main`, never the branch.

## Release (tag main)

- [ ] `git tag vX.Y.Z` on the squash commit · `git push origin vX.Y.Z`
- [ ] Watch the run (`gh run watch`, or the Actions tab). What each job proves:

| Job | Green means |
|---|---|
| `validate` | typecheck, tests, build; tag = `package.json`; every version-carrying file agrees; `CHANGELOG.md` has this version's section |
| `publish-npm` | published under `latest` (`next` for `-rc` tags) with provenance via Trusted Publishing; anything but an already-published conflict fails loudly |
| `publish-docker` | multi-arch image pushed as `:vX.Y.Z` (+ `:latest` for production), cosign-signed, SBOM attested |
| `github-release` | release created with the CHANGELOG section as the body, the supply-chain block, the PR list, and the SBOMs + cosign bundles attached |
| `publish-registry` | production only: `server.json` validated, published to the Official MCP Registry with the workflow's GitHub OIDC identity, and the registry's `latest` read back and compared with the tag |
| `verify-release` | npm's dist-tag, GHCR's tag digests, the release page and the registry all say this tag — read from outside, after everything else |

- [ ] **`verify-release` green.** A red job anywhere means the release did not happen, whatever the earlier jobs said. Fix the cause and re-run the same tag: `gh workflow run release.yml --ref vX.Y.Z` (every job is idempotent — already-published versions are recognised, not re-pushed).

## Post-release — the workflow asserted these; eyeball them once

- [ ] npm: `npm view @iris-eval/mcp-server dist-tags` → `latest` is the new version.
- [ ] Registry: `curl -s https://registry.modelcontextprotocol.io/v0.1/servers/io.github.iris-eval%2Fmcp-server/versions/latest` → `"version":"X.Y.Z"` and `"isLatest":true`.
- [ ] Docker actually **runs**: `docker run --rm ghcr.io/iris-eval/mcp-server:vX.Y.Z node dist/index.js --self-test` passes. The workflow checks that `:latest` is the digest it pushed, not that the image starts; 0.5.0's image exited on its default command and the checklist never asked.
- [ ] GitHub release page: the CHANGELOG section is at the top, "Check before upgrading" included if there is one.

## Post-release — human (no workflow can do these)

- [ ] **Glama** — sign in at glama.ai/mcp/servers/iris-eval/mcp-server and trigger **Build & Release**, then **Sync**. Glama's AI summary and its `<meta name="description">` are regenerated only on Glama's side: after 0.5.0 they carried a stale rule count for three weeks while the README rendered further down the same page was current.
- [ ] **npm `next` dist-tag** — `npm view @iris-eval/mcp-server dist-tags`. If `next` points at anything older than `latest`, remove it: `npm dist-tag rm @iris-eval/mcp-server next`. A stale `next` installs exactly the version band the security advisories name.
- [ ] **iris-eval.com** — the release banner and the version pill read from the truthbase and switch on deploy; confirm on the live site, and confirm `/.well-known/mcp.json` shows the new version.
- [ ] Shields.io badges on the README show the new version (cached — allow an hour).
- [ ] **48 hours later — the directories that ingest from the Official MCP Registry.** Re-check PulseMCP and mcp.so (mcp.so/server/iris/iris-eval): version and description should now match the registry. A listing that has never synced is a manual re-submission — an external send, maintainer-approved, using `docs/launch/directory-listing-template.md`.
- [ ] **Visual assets** — if the release touched the brand, tagline or dashboard chrome, walk `docs/assets/ASSET-VERSIONS.md`: the in-repo table *and* the externally hosted list (GitHub social preview, org avatar, X, dev.to). The site share image needs `OG_CACHE_BUST` bumped in `website/src/lib/og.ts` or scrapers keep the old card.
- [ ] **Milestone** — close `vX.Y.Z` the same day, move what did not ship to the next milestone, and create the next one with a one-paragraph description in the roadmap's language (rules: `.github/LABELS.md`).
- [ ] Release announcement on X (@iris_eval) — content-reviewed, maintainer-approved per post.

## Quarterly reviews (add to calendar)

- [ ] Every comparison page under `website/src/app/compare/` — competitors ship; `lastVerified` must be a date someone actually verified
- [ ] Porkbun domain auto-renew is enabled for iris-eval.com
- [ ] npm Trusted Publisher config on npmjs.com still names this repo + `release.yml`. There is no npm token anywhere — publishing is OIDC — so if a token has appeared in Secrets, that is the drift, not the fix
- [ ] The `mcp-publisher` pin in `release.yml` (`MCP_PUBLISHER_VERSION` + sha256) is still accepted by the registry. A login failure with "invalid audience" means the pin fell behind the registry deployment; bump version and checksum together
- [ ] Dependabot queue: nothing older than a month. One required check red on every Dependabot PR at once is a self-deadlocking gate (see CONTRIBUTING → Dependabot PRs): fix `main`, then `@dependabot rebase`
- [ ] Verify Upstash Redis credentials still work (check /api/waitlist-count) — the waitlist is a demand signal for hosted features, not a product commitment
- [ ] Verify no surface has acquired a price, a usage cap, or a compliance claim. There is no pricing, the open-source server is unlimited, and no certification is held — if any file says otherwise, that is the bug
- [ ] Search for new MCP directories and awesome lists to submit to
