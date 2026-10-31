# Security Exposure — Per-Alert Threat-Model Record

This document records iris's per-surface threat-model assessment for every open Dependabot security advisory on `iris-eval/mcp-server`. The dashboard alert count is a count of *advisories that name a package iris depends on*; this file records, for each, **whether the vulnerable code is reachable in iris's actual runtime** and **what we decided to do about it**.

The substance/signal gap matters: a HIGH-severity advisory in a transitive package whose code never loads into iris's process is, materially, no risk to iris's users — but the GitHub Security tab will display it identically to a HIGH that *is* reachable. This file closes the gap by recording the analysis that justifies each decision.

## How each alert is assessed

1. **Load-graph reachability.** Does Node load the vulnerable package's code into iris's process at runtime? (Verified via `grep -rln "from ['\"]<package>" node_modules/<dep-chain>/dist/`.) If not, the advisory is on dead code.
2. **Code-path reachability.** If loaded, does any code iris calls reach the vulnerable function or method? (Verified via the package's source.)
3. **Untrusted-input reachability.** If reached, can attacker-controlled input flow into the vulnerable parameter? (Verified via iris's input-handling boundaries: MCP tool args, HTTP request bodies, citation URLs, etc.)
4. **Downstream guards.** If reachable, what additional controls limit exploitation? (Listed explicitly so they can be re-verified.)

## How decisions map to actions

- **Override** — pin a fixed version via `package.json` `overrides`. Defense in depth even when reachability analysis says safe. Used for HIGH severity by default.
- **Dismiss as `not_used`** — code path is not loaded into iris's process. Closes the alert with rationale linking to this file.
- **Dismiss as `tolerable_risk`** — code path is loaded but the vulnerable function is not called by iris's usage. Closes with rationale.
- **Track** — waiting on upstream fix; document the wait.
- **Patch** — requires an iris-side code change; ship in a release.

CI runs `scripts/security/check-exposure-coverage.mjs` on every PR. If a new ≥medium Dependabot alert appears without a row in this file, the PR fails — preventing silent drift.

---

## Currently open advisories

### [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) — braces stack-exhaustion denial of service through deeply nested patterns

- **Severity:** high
- **Package:** `braces`
- **Vulnerable:** `≤ 3.0.3` — **first patched:** none published at assessment. The installed version is 3.0.3.
- **Load path:** the website's lint tooling only: `eslint-config-next@16.3.6` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`, marked `dev: true` in `website/package-lock.json`. Neither the server's lockfile nor the dashboard's contains `braces`. `npm audit`'s only offered fix is a semver-major move of `eslint-config-next` to 14.2.35, a downgrade of the website's lint configuration.
- **Load-graph reachable:** Not from iris's server process or the dashboard. In the website, only when ESLint resolves its file globs (`npm run lint`, and the lint step `next build` runs).
- **Code-path reachable:** `braces` expands the glob patterns ESLint and `fast-glob` are given: the checked-in `eslint.config.*` file patterns. No website route, page or API handler calls it; the playground's evaluation library does not import it.
- **Untrusted input reachable:** **No.** A deeply nested pattern would have to be written into a checked-in lint configuration or a CI workflow, which takes commit access through the CODEOWNERS-protected pull-request gate. Visitors to iris-eval.com send text to the playground's evaluation, which never reaches a glob.
- **Downstream guards:** the PR review gate on `main`; CI job timeouts, so a pathological expansion would show as a failed lint job rather than as anything a user sees.
- **Decision:** **Track**, with the code path assessed as `tolerable_risk` until then: dev tooling behind commit access. Take the patched `braces` (or an `eslint-config-next` that no longer reaches it) by a Linux-regenerated lockfile bump when one is published, and retire this row.
- **Assessed:** 2026-10-02 against iris commit `8488a9fe` (PR #792), the day the advisory appeared and began failing this gate on every branch.

### [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) — node-forge RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements

- **Severity:** high
- **Package:** `node-forge` (every release through 1.4.0; no fixed version is published)
- **Load path:** `node-forge@1.4.0` ← `@anthropic-ai/mcpb@2.1.2`, an exact devDependency: the reference MCPB tooling CI and the release use to unpack, validate and launch `iris-eval.mcpb`. It is not in the published npm package (`files` lists `dist`, `LICENSE`, `README.md` and `server.json`), not in the Docker image (`npm ci --omit=dev`), and not in the bundle, which is built from the published tarball.
- **Load-graph reachable:** In CI only. `mcpb unpack` (`.github/workflows/ci.yml`) imports the tooling's `dist/node/sign.js`, which imports `node-forge`. Nothing iris ships loads it.
- **Code-path reachable:** No. The advisory is in signature VERIFICATION. In the tooling that is `verifyMcpbFile`, reached by `mcpb verify` and `mcpb info`; iris runs neither. `mcpb unpack` takes one function from that module, `extractSignatureBlock`, which searches the file's bytes for a signature block and calls nothing in `node-forge`. The two test hosts import the library for `getMcpConfigForManifest` only.
- **Untrusted input reachable:** No. The only bundle handed to the tooling is the one the same job built from this repository, and it carries no MCPB signature: a release is verified by its GitHub artifact attestation and by `scripts/mcpb/verify.mjs`, which compares the bundle with the npm tarball byte for byte.
- **Downstream guards:** A forged MCPB signature could at most make `mcpb verify` report a bundle as signed. No step in CI or the release reads that answer.
- **Decision:** **Track** — waiting on an upstream fix — and dismiss as `tolerable_risk` meanwhile. When `node-forge` publishes a fixed version, pin it with an `overrides` entry, as was done for `tmp` when this tooling was locked.
- **Assessed:** 2026-10-01 against iris commit `78a0781`.
- **Closed 2026-10-31:** `node-forge` 1.4.1 and 1.4.2 were published on 2026-10-30 alongside eleven advisories for versions through 1.4.0; the lockfile was regenerated on Linux to 1.4.2 (`@anthropic-ai/mcpb`'s own range `^1.3.2` reaches it, so no `overrides` entry was needed). GitHub's advisory database lists no advisory covering 1.4.2 (read 2026-10-31, every page of the `securityVulnerabilities` query). This row is history.

### [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) — Zod can exhaust memory while validating oversized constrained collections (the copy inside the MCPB tooling)

- **Severity:** high
- **Package:** `zod` 3.25.76, the copy nested under `@anthropic-ai/mcpb@2.1.2`. Every release before 4.6.6 is affected and the 3.x line has no fixed release. The `zod` iris itself loads is 4.6.7 from 2026-10-25 (the dated section below).
- **Load path:** `node_modules/@anthropic-ai/mcpb/node_modules/zod` ← `@anthropic-ai/mcpb@2.1.2`, the exact devDependency recorded under GHSA-86w9-cpqp-85rv above, which declares `zod` `^3.25.67`. Not in the published npm package, the Docker image or the bundle.
- **Load-graph reachable:** In CI and the release only, where the tooling checks `iris-eval.mcpb`'s `manifest.json` against the MCPB schema (`dist/schemas/*.js`).
- **Code-path reachable:** Yes, in that check: the advisory is in how an array schema with no length limit collects one issue per failing element.
- **Untrusted input reachable:** No. The only manifest the tooling reads is the one the same job built from this repository, and its arrays hold a few dozen entries at most.
- **Downstream guards:** CI job timeouts: a pathological manifest would show as a failed job, never as anything a user runs.
- **Decision:** **Track**, and dismiss as `tolerable_risk` meanwhile: dev tooling reading our own file. An `overrides` entry cannot move the tooling to zod 4, because its own range is `^3.25.67`; this row retires with an `@anthropic-ai/mcpb` release on zod 4 or a patched 3.x.
- **Assessed:** 2026-10-25 against iris commit `e42e7548`.

### [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) — fast-uri host confusion via percent-encoded authority delimiters

- **Severity:** HIGH
- **Package:** `fast-uri`
- **Vulnerable:** ≤ 3.1.1 — **first patched:** 3.1.2
- **Load path:** `fast-uri` ← `ajv@8.18.0`, which is now BOTH a direct dependency of iris (declared at the SDK’s own `^8.17.1` so npm dedupes to one copy) and a transitive of `@modelcontextprotocol/sdk`.
- **Load-graph reachable:** Yes — ajv is imported by the SDK for protocol-message validation.
- **Code-path reachable:** ajv invokes fast-uri only for `format: "uri"` JSON-Schema validation. The MCP protocol uses URI fields; iris's tool argument schemas may include URI-formatted fields.
- **Untrusted input reachable:** Indirect — MCP tool args reach ajv, which reaches fast-uri.
- **Downstream guards:** iris’s own ajv instance (`src/eval/schema-validator.ts`, v0.11.0+) sets `validateFormats: false` and does not depend on `ajv-formats`, so `format: "uri"` in a caller-supplied tool schema is an annotation and never reaches fast-uri from the tool-argument path. Separately, iris's only outbound URL handling is the citation-verify resolver (`src/eval/citation-verify/resolve.ts`, v0.4.0+), which does its own scheme allowlist (http/https only), private-IP block, cloud-metadata host block, and DNS pre-resolve check before fetching. fast-uri's correctness is **not** on iris's security-critical URL acceptance path — a successfully-bypassed fast-uri parse cannot smuggle a request past the resolver's independent checks.
- **Decision:** **Override** — `package.json` `overrides.fast-uri = "^3.1.2"` forces the patched version. Defense in depth even though reachability analysis indicates the vulnerability is not iris-exploitable.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6) — fast-uri path traversal via percent-encoded dot segments

- **Severity:** HIGH
- **Package:** `fast-uri`
- **Vulnerable:** ≤ 3.1.0 — **first patched:** 3.1.1 (covered by the same override at ≥ 3.1.2)
- **Load path / reachability / guards:** Identical to GHSA-v39h-62p7-jpjc above.
- **Decision:** **Override** — same fast-uri pin covers both alerts.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-9vqf-7f2p-gf9v](https://github.com/advisories/GHSA-9vqf-7f2p-gf9v) — Hono bodyLimit() bypass for chunked / unknown-length requests

- **Severity:** medium
- **Package:** `hono`
- **Load path:** `hono` ← `@modelcontextprotocol/sdk@1.29.0` (declared as a runtime dep)
- **Load-graph reachable:** **No.** `grep -rln "from ['\"]hono" node_modules/@modelcontextprotocol/sdk/dist/esm/` returns exactly one match: `dist/esm/examples/server/honoWebStandardStreamableHttp.js`. That is an EXAMPLE file shipped with the SDK to demonstrate using Hono as an alternative server framework. iris imports `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/streamableHttp.js`; neither imports anything from `examples/`. Hono is in `node_modules/` because npm installs the declared dep tree, but Node's ESM resolver never loads any `hono` module into iris's process.
- **Code-path reachable:** N/A — package not loaded.
- **iris's actual HTTP transport:** Express (see `src/transport/http.ts`), with helmet for security headers, the SDK's `StreamableHTTPServerTransport.handleRequest()` invoked from Express handlers.
- **Decision:** **Dismiss as `not_used`** with rationale linking to this file.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-69xw-7hcm-h432](https://github.com/advisories/GHSA-69xw-7hcm-h432) — hono/jsx unvalidated JSX tag names allow HTML injection

- **Severity:** medium
- **Package:** `hono`
- **Load-graph reachable:** No (same evidence as GHSA-9vqf-7f2p-gf9v).
- **Decision:** **Dismiss as `not_used`** — hono is not loaded; hono/jsx specifically is for SSR via Hono, which iris doesn't use.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-p77w-8qqv-26rm](https://github.com/advisories/GHSA-p77w-8qqv-26rm) — Hono Cache Middleware ignores Vary: Authorization / Vary: Cookie

- **Severity:** medium
- **Package:** `hono`
- **Load-graph reachable:** No (same evidence).
- **Decision:** **Dismiss as `not_used`** — iris's caching is in `runtime-cache` / SQLite, not Hono middleware. The Hono Cache Middleware code is in dead-code paths.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-qp7p-654g-cw7p](https://github.com/advisories/GHSA-qp7p-654g-cw7p) — Hono CSS Declaration Injection via Style Object Values in JSX SSR

- **Severity:** medium
- **Package:** `hono`
- **Load-graph reachable:** No (same evidence). iris's website + dashboard use React/Next.js, not Hono JSX.
- **Decision:** **Dismiss as `not_used`**.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-hm8q-7f3q-5f36](https://github.com/advisories/GHSA-hm8q-7f3q-5f36) — Hono improper validation of NumericDate claims (exp / nbf / iat) in JWT verify()

- **Severity:** low
- **Package:** `hono`
- **Load-graph reachable:** No (same evidence). iris's auth middleware is in `src/middleware/auth.ts`, independent of Hono's JWT helper.
- **Decision:** **Dismiss as `not_used`**.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) — ip-address XSS in Address6 HTML-emitting methods

- **Severity:** medium
- **Package:** `ip-address`
- **Load path:** `ip-address` ← `express-rate-limit@8.5.0`
- **Load-graph reachable:** Yes — express-rate-limit imports ip-address for its IPv6 parsing.
- **Code-path reachable:** express-rate-limit's call surface into ip-address is parse + `isInSubnet` / `isCorrect`. The vulnerability is in `Address6`'s HTML-emitting methods (`toRFC5952String`, `toV4InV6`'s HTML form, etc.) — these are not on express-rate-limit's call graph.
- **Untrusted input reachable:** N/A — vulnerable methods not invoked.
- **Downstream guards:** The rate-limiter only stores the parsed address as a key; it never renders it as HTML.
- **Decision:** **Dismiss as `tolerable_risk`** with rationale linking here.
- **Assessed:** 2026-05-08 against iris commit `47a3de2`.

### [GHSA-jxxr-4gwj-5jf2](https://github.com/advisories/GHSA-jxxr-4gwj-5jf2) — brace-expansion DoS via large numeric range defeats documented `max` protection

- **Severity:** moderate (CVSS 6.5, CWE-400)
- **Package:** `brace-expansion`
- **Vulnerable:** `5.0.0 ≤ x < 5.0.6` — **first patched:** 5.0.6
- **Load path:** Transitive through `minimatch` / `glob`, pulled in by dev tooling (vitest file resolution, eslint glob handling, npm internal patterns). No runtime production code-path includes `brace-expansion`.
- **Load-graph reachable:** Yes — installed in `node_modules/` to support dev tooling.
- **Code-path reachable:** Vulnerable function (`expand`'s numeric-range branch with attacker-controlled patterns like `{1..1000000}`) is **not** invoked by iris's runtime. iris does not accept user-supplied glob or brace patterns through any MCP tool, HTTP handler, or rule input. The only callers are: vitest's test-file resolution (patterns are checked-in test paths from `vitest.config.ts`), eslint's `lintFilePatterns` (checked-in source globs), and npm's own internal package matching (config-controlled).
- **Untrusted input reachable:** **No.** The attacker model that could trigger the resource-exhaustion path requires write access to either `package.json`, `vitest.config.ts`, or a CI workflow file — all of which require commit access through the PR review gate. An attacker at that privilege level has more direct attack vectors than triggering a DoS via brace expansion.
- **Downstream guards:** PR review gate on CODEOWNERS-protected `main`. CI workflows time out at 10–20 minutes per job; a pathological brace expansion would manifest as a hung-job timeout, not a service degradation visible to iris users.
- **Decision:** **Dismiss as `tolerable_risk`** — the vulnerable code path is dev-tooling-only and gated behind commit-level access. GitHub Dependabot already auto-dismissed the surfaced alerts (Dependabot alerts #58, #59, #60 on 2026-05-18) on the same reasoning. This row makes the analysis explicit so the CI gate can re-verify the documented decision.
- **Assessed:** 2026-05-21 against iris commit `77f30cd` (PR #173).

### [GHSA-xrhx-7g5j-rcj5](https://github.com/advisories/GHSA-xrhx-7g5j-rcj5) — Hono IP Restriction bypasses static deny rules for non-canonical IPv6

- **Severity:** medium
- **Package:** `hono`
- **Vulnerable:** 4.12.18 installed — fixed in the 4.12.x line picked up by Dependabot #188 (→ 4.12.23)
- **Load path:** `hono` ← `@modelcontextprotocol/sdk@1.29.0` (declared runtime dep)
- **Load-graph reachable:** **No.** Same evidence as GHSA-9vqf-7f2p-gf9v above, re-verified 2026-06-09: `grep -rln "from ['\"]hono" node_modules/@modelcontextprotocol/sdk/dist/esm/` matches only `examples/server/honoWebStandardStreamableHttp.js` — an SDK example never imported by iris's entry points. iris's HTTP transport is Express.
- **Code-path reachable:** N/A — package not loaded. Additionally, iris's source contains zero uses of Hono's `ipRestriction` middleware (grep of `src/`); iris's network restriction is host binding (`127.0.0.1` default) + bearer-token auth, not Hono IP rules.
- **Decision:** **Patch** — Dependabot #188 (hono 4.12.23) queued in the 2026-06-09 drain. Reachability analysis shows not-loaded regardless; the alert would qualify for `not_used` dismissal if the patch lagged.
- **Assessed:** 2026-06-09 against iris commit `1d14cfc`.

### [GHSA-3hrh-pfw6-9m5x](https://github.com/advisories/GHSA-3hrh-pfw6-9m5x) — Hono cookie helper does not sanitize sameSite / priority, allowing Set-Cookie injection

- **Severity:** medium
- **Package:** `hono`
- **Vulnerable:** 4.12.18 installed — fixed via Dependabot #188 (→ 4.12.23)
- **Load-graph reachable:** **No** (same evidence as GHSA-xrhx-7g5j-rcj5). iris's source has zero uses of Hono's cookie helpers (`setCookie`/`getCookie`/`deleteCookie`); dashboard API auth is a bearer token in the `Authorization` header, and the one cookie iris sets — the `iris_session` HttpOnly, SameSite=Lax browser session cookie in `src/dashboard/session-auth.ts` — is written as a raw `Set-Cookie` header by Express, never through Hono. *(Corrected 2026-09-07: this line said no cookies are set anywhere; that stopped being true when the dashboard sign-in shipped in v0.6.0.)*
- **Decision:** **Patch** — Dependabot #188; `not_used` analysis on record as above.
- **Assessed:** 2026-06-09 against iris commit `1d14cfc`.

### [GHSA-f577-qrjj-4474](https://github.com/advisories/GHSA-f577-qrjj-4474) — Hono JWT middleware accepts any Authorization scheme, not only Bearer

- **Severity:** medium
- **Package:** `hono`
- **Vulnerable:** 4.12.18 installed — fixed via Dependabot #188 (→ 4.12.23)
- **Load-graph reachable:** **No** (same evidence). iris does not use Hono's JWT middleware anywhere; authentication is iris's own `src/middleware/auth.ts` (padded `timingSafeEqual` compare), which validates the scheme explicitly.
- **Decision:** **Patch** — Dependabot #188; `not_used` analysis on record as above.
- **Assessed:** 2026-06-09 against iris commit `1d14cfc`.

### [GHSA-2gcr-mfcq-wcc3](https://github.com/advisories/GHSA-2gcr-mfcq-wcc3) — Hono app.mount() strips mount prefix using undecoded path

- **Severity:** medium
- **Package:** `hono`
- **Vulnerable:** 4.12.18 installed — fixed via Dependabot #188 (→ 4.12.23)
- **Load-graph reachable:** **No** (same evidence). iris's source contains zero `.mount(` call sites; routing is Express routers.
- **Decision:** **Patch** — Dependabot #188; `not_used` analysis on record as above.
- **Assessed:** 2026-06-09 against iris commit `1d14cfc`.

### [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) — qs.stringify remotely triggerable DoS (TypeError on null/undefined entries in comma-format arrays with encodeValuesOnly)

- **Severity:** moderate
- **Package:** `qs`
- **Vulnerable:** `qs@6.15.0` installed — **first patched:** 6.15.2 (Dependabot #177)
- **Load path:** `qs` ← `body-parser@2.2.2` ← `express@5.2.1` (iris's actual HTTP transport)
- **Load-graph reachable:** **Yes** — `express/lib/utils.js` and `body-parser/lib/types/urlencoded.js` both require `qs`.
- **Code-path reachable:** **No.** The vulnerable function is `qs.stringify` with the non-default option combination `arrayFormat: 'comma'` + `encodeValuesOnly: true`. Express and body-parser call only `qs.parse` (query-string and urlencoded-body parsing); verified 2026-06-09 — zero `.stringify(` call sites in either package's lib. iris's own code never imports qs directly.
- **Untrusted input reachable:** N/A — vulnerable function not invoked. Attacker-controlled query strings and bodies flow into `qs.parse`, which this advisory does not cover.
- **Downstream guards:** Express body-size limits + iris rate limiting bound parse-side resource use independently.
- **Decision:** **Patch** — Dependabot #177 (qs 6.15.2) queued in the 2026-06-09 drain; `tolerable_risk` analysis on record had the patch lagged.
- **Assessed:** 2026-06-09 against iris commit `1d14cfc`.

### 2026-08-06 — four HIGH advisories remediated by override; remaining hono-family advisories triaged

**Why this batch exists.** `npm audit --audit-level=high` is a step in the `lint-and-typecheck` CI job. Four HIGH advisories had accumulated at root (`brace-expansion`, `fast-uri`, `ip-address`, `postcss`), so that step exited non-zero on **every** pull request — including every Dependabot PR proposing the individual fixes. No single-package PR could turn the job green, because three other HIGHs would still be present. CI was deadlocked by the very advisories it was blocking the fixes for. This batch resolves all four at once via `overrides`, restoring a green gate.

**Remediated (no longer reported by `npm audit`):**

| Advisory(ies) | Package | Was → Now | Decision |
|---|---|---|---|
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895), [GHSA-jxxr-4gwj-5jf2](https://github.com/advisories/GHSA-jxxr-4gwj-5jf2) | `brace-expansion` | 5.0.5 → 5.0.9 | **Override** `^5.0.7` |
| [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6), [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) | `fast-uri` | 3.1.2 → 3.1.5 | **Override** `^3.1.5` (raised from `^3.1.2`) |
| [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh), [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) | `ip-address` | 10.2.0 → 10.4.0 | **Override** `^10.4.0` |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | `postcss` | 8.5.15 → 8.5.26 | **Override** `^8.5.25` |

All four are transitive-only (`brace-expansion` via dev-tooling globs, `fast-uri` ← ajv ← MCP SDK, `ip-address` ← express-rate-limit, `postcss` ← vite ← vitest), so `overrides` is the correct lever — there is no direct dependency to bump. The prior per-advisory reachability analyses above remain accurate; these are now moot in practice because the fixed versions are installed.

**Lockfile provenance:** `package-lock.json` was regenerated under **Linux (WSL)** with `npm install --package-lock-only`, not on Windows. A Windows regeneration prunes the Linux-only `@emnapi/core` / `@emnapi/runtime` top-level entries that rolldown needs, producing a lockfile that fails `npm ci` on CI — the Session-28 incident recorded in `reference_rolldown_lockfile_trap`. Verified after regen: all three `@emnapi` entries present, zero package entries removed, integrity hashes balanced.

**Load-graph correction (supersedes the "hono is never loaded" claim in the rows above).** `@modelcontextprotocol/sdk@1.29.0` rearchitected `StreamableHTTPServerTransport` into a thin wrapper over a Web-Standard transport. `dist/esm/server/streamableHttp.js:9` now **statically imports** `getRequestListener` from `@hono/node-server`, and iris's HTTP transport (`src/transport/http.ts:4`) imports that module — so on the **HTTP transport**, `@hono/node-server` IS loaded into iris's process. (On the default **stdio** transport it is not.) What iris uses from it is exactly one function, `getRequestListener`, a Node↔Web request/response bridge. Verified 2026-08-06: that code path pulls no `hono` core module, and `serveStatic` has zero call sites in `src/`.

#### [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) — @hono/node-server serveStatic path traversal on Windows via encoded backslash (`%5C`)

- **Severity:** moderate — **Package:** `@hono/node-server` (2.1.5 installed — the MCP SDK's 1.30.0 bump carried it to 2.1.0, past the advisory's 2.0.5 fix, and the root `overrides` entry raised it to 2.1.5 on 2026-10-30 for GHSA-rmxm-3fg6-px4f below; `npm audit` no longer reports this advisory for this tree. The row stays as the record of the assessment made while it was open; the installed version above is checked against `package-lock.json` by `scripts/security/check-exposure-coverage.mjs`)
- **Load-graph reachable:** **Yes on HTTP transport** (see correction above); no on stdio.
- **Code-path reachable:** **No.** The vulnerability is in `serveStatic`; iris calls only `getRequestListener`. iris serves no static files through this package — dashboard assets go through Express `express.static`.
- **Decision:** **Resolved 2026-09-05 by the SDK upgrade** (while open: dismiss as `tolerable_risk`) — loaded, but the vulnerable static-file handler is off iris's call graph. Cannot be overridden locally without forcing a major version on the SDK's bridge; tracks the SDK upgrade.
- **Assessed:** 2026-08-06; re-verified against the lockfile 2026-09-05 (the record had said 1.19.13 for a month after the upgrade).

#### [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) — @hono/node-server `serveStatic` decodes the request path a second time (middleware bypass on static paths)

- **Severity:** moderate — **Package:** `@hono/node-server` (2.1.5 installed — vulnerable range >= 1.19.10, < 2.1.3; fixed in 2.1.3; published 2026-10-28). The tree had 2.1.0 through `@modelcontextprotocol/sdk@1.32.1` (`^1.19.9 || ^2.0.5`); the root `overrides` entry is now `^2.1.5` and the lockfile resolves 2.1.5 (regenerated on Linux, node 24; the one lockfile change).
- **Load-graph reachable:** **Yes on HTTP transport**, no on stdio — the same path as GHSA-frvp-7c67-39w9 above (`getRequestListener` only).
- **Code-path reachable:** **No.** The defect is in `serveStatic`, which has zero call sites in `src/` (re-verified 2026-10-30). iris serves no static files through this package.
- **Decision:** **Patched 2026-10-30** (override to 2.1.5; while open it was `tolerable_risk` for the reason above). The Advisory inventory failed on main on 2026-10-29 and 2026-10-30 because this row did not yet exist; this row and the bump are the fix.
- **Assessed:** 2026-10-30.

#### [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239), [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj), [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59), [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) — hono core (CORS-middleware ReDoS, hono/jsx cross-request context leak, `cx()` JSX XSS, API-Gateway v1 adapter header de-dup)

- **Severity:** moderate (all four) — **Package:** `hono` (transitive, under `@hono/node-server`)
- **Load-graph reachable:** hono **core** is imported only by `@hono/node-server`'s `serve-static` and `vercel` adapters, neither of which iris loads; `getRequestListener` does not pull hono core.
- **Code-path reachable:** **No.** Every affected surface is a submodule iris never invokes: CORS middleware (iris uses its own `src/middleware/cors.ts` on Express), `hono/jsx` SSR, the `cx()` utility, and the AWS API-Gateway adapter.
- **Decision:** **Dismiss as `not_used`** — vulnerable submodules unreachable.
- **Assessed:** 2026-08-06.

### [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) — React Router RSC-mode CSRF bypass (action executes before the 400)

- **Severity:** high (GitHub label) — **CVSS: 0** — **Package:** `react-router` — **Manifest:** `dashboard/package-lock.json`
- **Installed:** 7.18.2 (via `react-router-dom@^7.18.2`) — **first patched:** `react-router` **8.3.0**
- **Load-graph reachable:** Yes — the dashboard UI is built on React Router.
- **Code-path reachable:** **No.** The advisory states its scope explicitly: *"This only affects your application if you are using the unstable RSC APIs."* It is a follow-up to CVE-2026-22030 covering React Server Component request flows. The dashboard is a purely client-side SPA: `dashboard/src/App.tsx` mounts `BrowserRouter` and the app uses only `Routes`, `Route`, `Link`, `NavLink`, `useNavigate`, `useParams`, `useSearchParams`, `useLocation`. Verified 2026-08-07 — grep across `dashboard/src`, `dashboard/package.json` and the Vite config for `unstable_`, `RSC`, `routeRSCServerRequest`, `createCallServer`, `matchRSCServerRequest`, `@vitejs/plugin-rsc` and `react-server` returns **zero** matches. There is no server-rendered route, and therefore no RSC action to execute early.
- **Untrusted-input reachable:** N/A — the vulnerable code path does not exist in this build.
- **Why not simply patched:** **`react-router-dom` has no 8.x release** (latest is 7.18.2). React Router merged its packages in v7+, so reaching `react-router@8.3.0` means dropping `react-router-dom` and rewriting every import across ~20 dashboard files onto `react-router` v8 — a breaking framework migration. Taking that risk to close a CVSS-0 advisory whose own text says it does not apply would be a bad trade: the migration could break dashboard routing, while the advisory cannot affect it.
- **Decision:** **Dismiss as `not_used`.** Re-open if the dashboard ever adopts RSC routing, or fold the upgrade into a deliberate React Router v8 migration on its own schedule (with its own testing), not into a security drain.
- **Assessed:** 2026-08-07 against iris commit `514297b`.

---

### 2026-09-03 — ten advisories patched by lockfile bump (Linux-regenerated)

**Why this batch exists.** Main had not moved since 2026-08-13. In the three weeks between, the advisory database gained ten entries at ≥moderate against packages already in our lockfiles, and `check-exposure-coverage.mjs` fired on the first pull request to run CI afterwards (#391, a website fix that touched no dependency). That is the gate working as designed: it is deadlock-free, both exits live inside a pull request, and every one of the ten had an upstream fix, so the dependency PR took the bump exit for all of them rather than documenting them as open.

**Remediated (no longer reported by `npm audit`):**

| Advisory(ies) | Package | Was → Now | Load path | Decision |
|---|---|---|---|---|
| [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8), [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) (HIGH — host confusion via skipped IDN canonicalization / percent-encoded scheme normalization; SSRF via malformed IPv6 normalization / repeated hostname percent-decoding) | `fast-uri` | 3.1.5 → 3.1.7 | root ← `ajv@8.18.0` ← `@modelcontextprotocol/sdk@1.30.0` — runtime; same reachability as the 2026-05-08 fast-uri rows above (ajv `format: "uri"` validation only; iris's own outbound URL handling has its own scheme allowlist and SSRF guard) | **Patch** — lockfile bump; the existing `overrides.fast-uri = "^3.1.2"` pin admits 3.1.7 |
| [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) (HIGH — custom generators can loop indefinitely when size is zero) | `nanoid` | 3.3.17 → 3.3.18 | root ← `postcss` ← `vite` ← `vitest`; website / dashboard / the since-retired installer package ← `postcss` — dev tooling only, never in the shipped package's runtime graph | **Patch** — lockfile bump |
| [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx), [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) (HIGH — unbounded cache growth via distinct query results; crash / prototype write via untrusted `browserslist-stats.json`) | `browserslist` | 4.28.4 → 4.28.8 | website, dashboard ← `@babel/helper-compilation-targets` — build-time only; no untrusted stats file exists in either tree | **Patch** — lockfile bump |
| [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx), [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) (moderate — array-limit bypass via bracket-key comma parsing; DoS via attacker-controlled `isBuffer`) | `qs` | 6.15.2 → 6.16.0 | root ← `express@5.2.1` (+ `body-parser`) — runtime on the dashboard HTTP server; query strings are untrusted input | **Patch** — lockfile bump |
| [GHSA-p498-v437-472g](https://github.com/advisories/GHSA-p498-v437-472g) (moderate — recursive copy follows symlinked files outside the source tree) | `@humanfs/node` | 0.16.7 → 0.16.8 (pulls in new dep `@humanfs/types@0.15.0`) | root, website ← `eslint` — dev tooling only | **Patch** — lockfile bump |

**Lockfile provenance, again the platform trap.** The first attempt ran `npm update` on Windows: the root and website lockfiles came out clean, but the dashboard and since-retired installer lockfiles lost their `@emnapi/core` and `@emnapi/runtime` top-level entries — the rolldown trap this file's 2026-08-06 provenance note records. Reverted and regenerated under **WSL Linux** with `npm update <pkg> --package-lock-only --no-audit --no-fund --ignore-scripts` in each workspace. Verified per lockfile after the Linux run: zero package entries removed (`git diff main -- <lockfile> | grep -cE '^-\s+"node_modules/'` = 0 ×4), `@emnapi` line counts unchanged (root 0, website 24, dashboard 20, init 11), integrity-hash counts intact (+1 at root and website for the one genuinely new dep), and only the packages named above plus their own subdependencies moved.

**Gate after:** `npm audit reports 0 advisory(ies) at >=moderate severity`. The Dependabot PR for the fast-uri bump (#390) is superseded by this batch.

### 2026-09-26 — `tmp` overridden when the MCPB tooling became a locked devDependency

**Why.** `@anthropic-ai/mcpb` (the reference MCPB CLI and library that CI and the release use to unpack, validate and launch `iris-eval.mcpb`) became an exact devDependency, so its whole tree is locked. Its interactive prompts pull in `tmp@0.0.33` through `@inquirer/prompts` → `@inquirer/editor` → `external-editor@3.1.0`, and `npm audit` reported it.

| Advisory(ies) | Package | Was → Now | Load path | Decision |
|---|---|---|---|---|
| [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) (HIGH — path traversal via unsanitized prefix/postfix), [GHSA-52f5-9888-hmc6](https://github.com/advisories/GHSA-52f5-9888-hmc6) (low — symlinked `dir` parameter) | `tmp` | 0.0.33 → 0.2.7 | root ← `external-editor` ← `@inquirer/editor` ← `@inquirer/prompts` ← `@anthropic-ai/mcpb` — dev tooling only, loaded by `mcpb init`'s editor prompt, which nothing here runs; never in the shipped package or the bundle | **Override** — `overrides.tmp = "^0.2.6"`; `external-editor` calls only `tmp.tmpNameSync`, which 0.2.x keeps |

**Lockfile provenance.** Regenerated on Linux (`node:22-bookworm`, npm 11.20.0) with `npm install --package-lock-only --ignore-scripts --save-dev --save-exact @anthropic-ai/mcpb@2.1.2`: 49 packages added, none removed (`git diff main -- package-lock.json | grep -cE '^-\s+"node_modules/'` = 0), `libc` fields intact. Electron, the host runtime the MCPB CI job starts the bundle in, is deliberately not locked: see the `mcpb-electron` job in `.github/workflows/ci.yml`.

**Gate after:** `npm audit` reports 0 vulnerabilities.


### 2026-09-28 — `ip-address` and `undici` patched by lockfile bump (Linux-regenerated); NAT64 added to iris's own SSRF guard

| Advisory(ies) | Package | Was → Now | Load path | Decision |
|---|---|---|---|---|
| [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q) (moderate — `Address6.isLinkLocal()` recognizes `fe80::/64`, not `fe80::/10`), [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc) (moderate — no classifier recognizes the NAT64 local-use range `64:ff9b:1::/48`) | `ip-address` | 10.4.0 → 10.7.2 | root ← `express-rate-limit@8.7.0` — runtime: shipped in the npm package, the image and the MCPB bundle. **Not reachable:** `express-rate-limit` imports `Address6` only in `ipKeyGenerator` and calls `isMapped4()`, `is4()`, `isInSubnet(::/96)`, `to4()`, `correctForm()` and `networkForm()` to build a rate-limit key; it never calls `isLinkLocal()`, `isPrivate()` or any other classifier (`grep -n "isLinkLocal\|isPrivate\|getType" node_modules/express-rate-limit/dist/index.mjs`: no hits). iris's source does not import `ip-address` at all. The keys for `::ffff:127.0.0.1`, `2001:db8:1234:5678::1`, `2001:db8:1234:56ff:ffff::9`, `::1`, `10.0.0.1` and `::127.0.0.1` are identical under 10.4.0 and 10.7.2 (checked with `express-rate-limit@8.7.0` on Linux). | **Patch** — lockfile bump; `overrides.ip-address` raised from `^10.4.0` to `^10.5.1` so the floor excludes both advisories |
| [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) (moderate — WebSocket client crashes the process on a malformed permessage-deflate message past the size limit) | `undici` | 7.29.0 → 7.30.0 | dashboard ← `jsdom@29.1.1` (a devDependency: the dashboard's vitest environment). **Not reachable:** jsdom's `WebSocket` is undici's, but no dashboard source or test opens a WebSocket (`grep -rn WebSocket dashboard/src`: no hits), and jsdom never ships: the built dashboard is static files. iris's server does not use WebSocket; Node's own bundled undici (`globalThis.WebSocket`) is patched with Node, not by this lockfile. | **Patch** — lockfile bump; `jsdom`'s range `^7.25.0` admits 7.30.0, so no override |

**iris's own guard had the same gap as GHSA-2vr4-cq9g-pvrc.** The citation fetcher's SSRF check (`isBlockedIpv6` in `src/eval/citation-verify/resolve.ts`) classifies IPv4 re-encoded through 6to4, Teredo, IPv4-mapped and IPv4-compatible addresses, but not NAT64. On a network with a NAT64 gateway, `64:ff9b::7f00:1` reaches 127.0.0.1 and `64:ff9b::a9fe:a9fe` reaches the cloud metadata endpoint. The well-known prefix `64:ff9b::/96` now applies the IPv4 blocklist to the address it embeds, and the local-use `64:ff9b:1::/48` is refused whole, because where it embeds the address depends on the prefix length an operator chose. Tests: `tests/unit/eval/citation-verify/resolve.test.ts` (the NAT64 case fails on the previous guard). The guard's link-local check was already `fe80::/10` (`/^fe[89ab]/`); a regression test now holds it, including `fe81::1`, the address GHSA-rpw4-54j3-4h4q uses. Citation fetching is opt-in, and the DNS-rebinding window recorded in the 0.20.0 security review still applies.

**Lockfile provenance.** Regenerated on Linux (`node:22-bookworm`, npm 11.20.0) from copies of the manifests and lockfiles, with `npm update ip-address --package-lock-only --ignore-scripts` at the root and `npm update undici --package-lock-only --ignore-scripts` in `dashboard/`. Each lockfile changed in exactly one entry (version, `resolved` and `integrity` of the package named); no entry added or removed, `libc` fields intact. (npm 10.9.9, the image's default, dropped every `libc` field, so it was not used.)

**Gate after:** `npm audit` reports 0 vulnerabilities in the root, `dashboard/` and `website/`.

### 2026-10-22 — `ip-address` patched by override and lockfile bump (Linux-regenerated); the MCP SDK floor raised to 1.32.0 and its tool-input element limit turned on

| Advisory(ies) | Package | Was → Now | Load path | Decision |
|---|---|---|---|---|
| [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) (moderate — `Address6` strips a zone identifier in quadratic time before its length limit; 100,000 `%` characters and a newline take 3.9 s) | `ip-address` | 10.7.2 → 10.7.4 | root ← `express-rate-limit@8.7.0` — runtime: shipped in the npm package, the image and the MCPB bundle. **Not reachable from a client:** `express-rate-limit` constructs `Address6` only in `ipKeyGenerator`, from `req.ip`, after `net.isIPv6()` accepts it. iris leaves Express's `trust proxy` off (`grep -rn "trust proxy" src`: no hits), so `req.ip` is the socket's remote address as the operating system reports it, never a string a client sends. iris's source does not import `ip-address`. | **Patch** — `overrides.ip-address` raised from `^10.5.1` to `^10.7.4` so the floor excludes the advisory, and the lockfile moved with it |
| [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) (high — one HTTP request within the default size limit could exhaust server memory during validation), and for the floor [GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw), [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq), [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw), [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h), [GHSA-f897-62hf-6gxq](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-f897-62hf-6gxq) | `@modelcontextprotocol/sdk` | range `^1.30.0` → `^1.32.0` (the lockfile already installed 1.32.0) | root, a direct runtime dependency. iris imports `server/mcp.js`, `server/stdio.js`, `server/streamableHttp.js` and `types.js` only, so of the six only GHSA-46jr-4wx8-v453 (tool-input validation in `McpServer`) and GHSA-f897-62hf-6gxq (HTTP body and batch size; iris's own `express.json` 1 MB limit runs before the SDK sees a body) touch code iris runs; the bearer-auth, tasks and client advisories are in modules iris never loads. | **Patch** — the floor, because a published package does not carry iris's lockfile and an install that already held 1.30.x or 1.31.x kept it; and an iris-side change, because GHSA-46jr-4wx8-v453's fix is an `McpServer` option that is off by default: `security.maxInputElements` (default 100,000, `IRIS_MAX_INPUT_ELEMENTS`; named `maxToolInputElements` until it also bounded the dashboard's request bodies, a name still read) is now set on every MCP server iris builds, stdio and HTTP. The measurements behind the number are in `src/config/defaults.ts`; tests: `tests/integration/tool-input-elements.test.ts` (five of its six fail without the option) |

**Lockfile provenance.** Regenerated on Linux (`node:24`, npm 11.19.0) with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` after the two `package.json` edits. The root lockfile changed in two places: the root package's declared SDK range, and the version, `resolved` and `integrity` of `ip-address`. No entry added or removed (`git diff origin/main -- package-lock.json | grep -cE '^-\s+"node_modules/'` = 0), `libc` fields (10) and integrity hashes (392) unchanged in number, `@emnapi` entries unchanged (0, as before).

**Gate after:** `npm audit` at the root reports only GHSA-86w9-cpqp-85rv (`node-forge`, recorded above).


### 2026-10-25 — `zod`, `body-parser`, `fast-uri` and `undici` patched (Linux-regenerated); floors for `zod` and `body-parser`; the image's Node.js moved to 24.22.1

**Why this batch exists.** The scheduled advisory inventory passed on 2026-10-23 and failed on 2026-10-24 and 2026-10-25: the advisory database had gained seven advisories at ≥moderate against packages in our lockfiles, six of them published on 2026-10-23. Every one has an upstream fix except the copy of `zod` inside the MCPB tooling, recorded above.

| Advisory(ies) | Package | Was → Now | Load path | Decision |
|---|---|---|---|---|
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high — memory exhaustion while collecting one issue per failing element of an array with no length limit) | `zod` | root, `packages/sdk`, `packages/langchain`: 4.6.5 → 4.6.7; `dashboard/`, `website/`: 4.3.6 → 4.6.7 | root: a direct runtime dependency, shipped in the npm package, the image and the bundle. iris validates every MCP tool call's arguments and every JSON body its HTTP servers accept with zod, so a client reaches the code path. **Guards:** the 1 MB request size limit on stdio and HTTP; and, from the release after 0.20.0, the element limit (`security.maxInputElements`, 100,000) counted before any schema runs, which bounds how many issues one request can make. 0.20.0 has the size limit only. `dashboard/` and `website/`: ← `eslint-plugin-react-hooks`, lint tooling. `packages/`: devDependencies of the side packages' tests. | **Patch** — lockfile bumps, and the root's range raised from `^4.4.3` to `^4.6.7`, because a published package does not carry iris's lockfile and an install that already holds 4.6.5 or earlier keeps it |
| [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) (high — a compressed request body followed by trailing bytes can end the process with an uncaught decoder error) | `body-parser` | 2.3.0 → 2.4.0, with its own `content-type` 2.0.0 → 2.1.0, `iconv-lite` 0.7.2 → 0.7.3 and `qs` 6.16.0 → 6.16.1 | root ← `express@5.2.1`: `express.json` on both HTTP servers, `express.raw` for OTLP protobuf and `express.urlencoded` for the sign-in form. Runtime, shipped. All three run before the API-key check and decompress bodies (OpenTelemetry exporters send gzip, so iris keeps decompression on), so any client that can reach a port reaches the code; the Docker image listens on every interface inside the container. We could not make 2.3.0 end the process with the request shapes the advisory describes (gzip, deflate and brotli bodies with trailing bytes in the same packet and in a later one; an unsupported `utf-*` charset on a compressed body), with Express's default error handler and with one that only replies, as iris's does, on Windows with Node.js 24.11.0 and on Linux with 24.22.1. We patch on the maintainers' report. | **Patch** — lockfile bump, and `body-parser` declared as a direct dependency at `^2.4.0`, as `ajv` is: express's own range (`^2.2.1`) admits 2.3.0, so without it a project that already holds 2.3.0 keeps it when it upgrades iris. npm dedupes to one copy |
| [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr) (moderate — scheme spoofing via percent-encoded scheme decoding; host confusion via unchecked WHATWG host canonicalization), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) (low) | `fast-uri` | 3.1.8 → 3.1.9 | root ← `ajv@8.20.0`, runtime. Same reachability as the 2026-05-08 fast-uri rows above: ajv calls fast-uri only for `format: "uri"`, iris's own ajv validates no formats, and the citation fetcher's URL checks do not depend on it | **Override** — `overrides.fast-uri` raised from `^3.1.8` to `^3.1.9` |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) (high — unhandled error on excessive content-encodings), [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) (moderate — unbounded memory in the EventSource parser), [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) (moderate — Subresource Integrity bypass via non-lowercase algorithm tokens) | `undici` | `dashboard/`: 8.11.2 → 8.12.3; `packages/sdk`: 7.30.0 → 7.30.1 | `dashboard/` ← `jsdom`, the dashboard tests' environment (the built dashboard is static files); `packages/sdk` ← `openai` and `@ai-sdk/provider-utils`, devDependencies its provider tests use. Neither ships. The copy that matters to iris is the one inside Node.js: the citation fetcher calls Node's own `fetch` (`src/eval/citation-verify/resolve.ts`), and the 2026-10-20 security releases carry the fixed undici: 7.30.1 in Node.js 24.22.1, 6.29.1 in 22.23.4 | **Patch** — lockfile bumps, and the image's Node.js (below) |

**The image's Node.js.** `Dockerfile` moves `node:24-alpine` from the digest it pinned since September (Node.js 24.21.0, Alpine 3.24.2) to `sha256:06d7adf3…` (Node.js 24.22.1, the 2026-10-20 security release, with seven Node.js CVEs and undici 7.30.1; Alpine 3.24.3), read with `node -v` and `/etc/alpine-release` in each image. An npm install runs on the user's own Node.js, which this repository does not choose; the engines floor stays `>=22.13.0`.

**Lockfile provenance.** Regenerated on Linux (`node:24`, npm 11.19.0): `npm install --package-lock-only --ignore-scripts` at the root and in `packages/langchain` after their `package.json` edits; `npm update undici zod --package-lock-only --ignore-scripts` in `dashboard/` and `packages/sdk`; `npm update zod --package-lock-only --ignore-scripts` in `website/`. Per lockfile (root, dashboard, website, sdk, langchain): no entry added or removed (`git diff origin/main -- <lockfile> | grep -cE '^[-+]\s+"node_modules/'` = 0 both ways), and `libc` fields (10, 14, 28, 0, 0), integrity hashes (392, 478, 557, 22, 25) and `@emnapi` lines (0, 20, 22, 0, 0) unchanged in number. Only the packages named above moved. The `packages/langchain` lockfile also re-records the SDK's `@types/node` range, which `packages/sdk/package.json` already declared.

**Gate after:** `npm audit` reports 0 vulnerabilities in `dashboard/`, `website/`, `packages/sdk` and `packages/langchain`. At the root it reports only GHSA-86w9-cpqp-85rv (`node-forge`) and GHSA-mrhx-c7xc-m3w5 (the MCPB tooling's own `zod`), both recorded above.

### Untrusted JSON Schema — the tool-argument path (v0.11.0+)

Not an advisory. A standing assessment, recorded here because it is the one place in iris where a
caller supplies something that is COMPILED rather than merely parsed.

A tools catalogue arrives over `log_trace` (unauthenticated in stdio mode), over `POST /api/v1/traces`,
and inline on `evaluate_output`. Its `inputSchema` is JSON Schema, and ajv does not interpret a schema —
it generates JavaScript from it, compiles that with `new Function`, and runs it on the main thread.

The guard ladder is in `src/eval/schema-validator.ts` and every rung has a test that fires it
(`tests/unit/eval/schema-validator.test.ts`). A reviewer changing that module checks this list:

1. Static caps first, before ajv is imported: 32 KiB serialised, depth 12, 2,000 nodes, 24 patterns.
   This is the real boundary against compile blowup — total, cheap, and it bounds every rung after it.
2. `$ref` must start with `#`. A remote reference is refused by the walk, and `loadSchema` is never
   configured, so nothing can be fetched even if the walk were bypassed. `$id`, `$dynamicRef`,
   `$dynamicAnchor`, `$recursiveRef` and `$vocabulary` are refused: their validation depth cannot be
   bounded from the schema alone.
3. Every `pattern` and every `patternProperties` KEY: length cap, then syntax, then safe-regex2 star
   height, then the empirical probe behind the sandbox worker’s hard deadline. Star height sits ahead of
   the probe because the probe has to guess an igniting payload and cannot in general — an exponential
   pattern in a `patternProperties` key passed the probe during development and star height caught it.
4. `allErrors: false` (ajv’s own docs name it a DoS vector on untrusted schemas), `validateFormats:
   false`, `$data: false`, and `coerceTypes` / `useDefaults` / `removeAdditional` all false — a validator
   that mutated the instance would change what the repeat detector hashes.
5. Rejections are cached alongside acceptances, so a hostile catalogue resent a thousand times pays its
   probe cost once per process.
6. A rung that trips rejects the WHOLE tool’s schema. A partially applied schema reporting a call valid
   is a false all-clear about a security-relevant class.

**One tuning note, because it is a trap this repository has fallen into before.** The compile ceiling is
wall-clock and therefore deliberately generous (1s). A tight one refuses honest schemas on a loaded
host — the guard-ladder test caught a three-property object schema being rejected at 50ms during
development — and a checker that randomly stops checking is worse than one that occasionally pays a
second. The static caps are the boundary; the ceiling is a hang-killer that caches its refusal.

**The residual, stated.** The probe is a courtesy and not a boundary, and on this path there is no
boundary behind it: ajv inlines a pattern into generated code and runs it on the main thread, so a
polynomial pattern that survives star height and does not ignite the probe will run there. What bounds it
is everything around it — the instance is capped at 64 KiB, the pattern count at 24, the per-schema probe
at 2s, and `eval.validateToolArguments` turns the whole path off without an uninstall.
## Operational notes

- **When a new Dependabot alert opens:** add a section here within one PR cycle. The CI gate (`scripts/security/check-exposure-coverage.mjs`) will fail PRs that introduce or surface a new ≥medium alert without a corresponding row.
- **When an advisory is patched upstream:** update the affected sections to reflect the patched-and-installed state, or remove the section if the alert auto-closes.
- **When iris's call graph changes:** re-verify the reachability claims for any open advisory whose package is on the changed code path. The `Assessed against iris commit X` line records the snapshot.
- **When upstream releases a fix that removes a dep:** the affected section can be retired.

### The no-self-deadlock rule for dependency gates

**A blocking gate must always be satisfiable by a change made inside the pull request it blocks.** If clearing it requires some *other* pull request to merge first, the gate can deadlock the repository against itself.

This is not hypothetical. `lint-and-typecheck` used to run `npm audit --audit-level=high`, which fails on the *whole set* of open advisories. Once four independent HIGHs were outstanding (`brace-expansion`, `fast-uri`, `ip-address`, `postcss`), every PR went red — including each Dependabot PR that fixed one of them, because the other three remained. No single PR could turn the gate green, so nothing merged, so the advisories never drained: 4 advisories froze all 40 open PRs. Removed 2026-08-06.

`check-exposure-coverage.mjs` is the authoritative dependency-security gate because it satisfies the rule: both of its exits — add a triage row here, or bump the dependency — are edits within the PR being gated. It is also *stricter* than the check it replaced (≥moderate rather than ≥high, and it demands documented analysis rather than just a version number).

Remediation pressure is preserved without blocking: the gate prints a **REMEDIATION AVAILABLE** report for advisories npm can already fix. That is informational on purpose — making it fatal would recreate the deadlock, since the fix usually lives in a separate Dependabot PR.

When adding any future dependency gate, ask: *if this fires, can the PR author clear it without merging something else first?* If no, it belongs in a scheduled/reporting job, not a PR-blocking one.

This file is a working operational record, not a marketing document. It exists so any auditor or contributor can read the actual exposure analysis instead of guessing from a count of red dots.
