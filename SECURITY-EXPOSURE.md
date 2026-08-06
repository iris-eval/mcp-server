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

### [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) — fast-uri host confusion via percent-encoded authority delimiters

- **Severity:** HIGH
- **Package:** `fast-uri`
- **Vulnerable:** ≤ 3.1.1 — **first patched:** 3.1.2
- **Load path:** `fast-uri` ← `ajv@8.18.0` ← `@modelcontextprotocol/sdk@1.29.0`
- **Load-graph reachable:** Yes — ajv is imported by the SDK for protocol-message validation.
- **Code-path reachable:** ajv invokes fast-uri only for `format: "uri"` JSON-Schema validation. The MCP protocol uses URI fields; iris's tool argument schemas may include URI-formatted fields.
- **Untrusted input reachable:** Indirect — MCP tool args reach ajv, which reaches fast-uri.
- **Downstream guards:** iris's only outbound URL handling is the citation-verify resolver (`src/eval/citation-verify/resolve.ts`, v0.4.0+), which does its own scheme allowlist (http/https only), private-IP block, cloud-metadata host block, and DNS pre-resolve check before fetching. fast-uri's correctness is **not** on iris's security-critical URL acceptance path — a successfully-bypassed fast-uri parse cannot smuggle a request past the resolver's independent checks.
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
- **Load-graph reachable:** **No** (same evidence as GHSA-xrhx-7g5j-rcj5). iris's source has zero uses of Hono's cookie helpers (`setCookie`/`getCookie`/`deleteCookie`); dashboard auth is a bearer token in the `Authorization` header, no cookies are set anywhere in iris's server code.
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

### 2026-08-06 advisory refresh — 16 new ≥moderate advisories triaged

Batch triage of the advisories `npm audit` surfaced at root since the 2026-06-09 pass. Assessed against iris commit `62ed307` (branch `fix/ssrf-ipv6-literal-bypass`).

**Load-graph correction (supersedes the "hono is never loaded" claim in the rows above).** `@modelcontextprotocol/sdk@1.29.0` rearchitected `StreamableHTTPServerTransport` into a thin wrapper over a Web-Standard transport. `dist/esm/server/streamableHttp.js:9` now **statically imports** `getRequestListener` from `@hono/node-server`, and iris's HTTP transport (`src/transport/http.ts:4`) imports that module — so on the **HTTP transport**, `@hono/node-server` IS loaded into iris's process. (On the default **stdio** transport it is not imported at all.) What iris uses from it is exactly one function, `getRequestListener`, a Node↔Web request/response bridge. The vulnerable code in the hono family — `@hono/node-server`'s `serveStatic`, and hono core's `jsx` / `cors()` middleware / lambda + api-gateway adapters — is reached only via `serve-static.mjs` / `vercel.mjs` / hono submodules that iris never imports. Verified 2026-08-06: `getRequestListener`'s code path pulls no `hono` core module; `serveStatic` has zero call sites in `src/`.

#### [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) — @hono/node-server serveStatic path traversal on Windows via encoded backslash (`%5C`)

- **Severity:** moderate — **Package:** `@hono/node-server` (1.19.13 installed) — **Load path:** `@hono/node-server` ← `@modelcontextprotocol/sdk@1.29.0`
- **Load-graph reachable:** **Yes on HTTP transport** (see load-graph correction above); no on stdio.
- **Code-path reachable:** **No.** The vulnerability is in `serveStatic` (static file serving). iris uses only `getRequestListener`; `serveStatic` has zero call sites in `src/`. iris serves no static files through `@hono/node-server` (dashboard static assets are served by Express `express.static`).
- **Untrusted input reachable:** N/A — vulnerable function not invoked.
- **Decision:** **Dismiss as `tolerable_risk`** — loaded but the vulnerable static-file handler is off iris's call graph. Patch tracks upstream via the SDK/`@hono/node-server` bump (Dependabot).
- **Assessed:** 2026-08-06 against `62ed307`.

#### [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239), [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj), [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59), [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) — hono core (CORS-middleware ReDoS, hono/jsx cross-request context leak, cx() JSX XSS, API-Gateway v1 adapter header de-dup)

- **Severity:** moderate (all four) — **Package:** `hono` (transitive, ≤ @hono/node-server)
- **Load-graph reachable:** hono **core** is imported only by `@hono/node-server`'s `serve-static` and `vercel` adapters, neither of which iris loads; `getRequestListener` (iris's only entry) does not pull hono core.
- **Code-path reachable:** **No.** Every affected surface is a hono submodule iris never invokes: CORS middleware (iris uses its own `src/middleware/cors.ts` on Express), `hono/jsx` SSR (iris renders no hono JSX), the `cx()` utility, and the AWS API-Gateway adapter.
- **Decision:** **Dismiss as `not_used`** — vulnerable submodules unreachable. Auto-clears when the `hono` bump lands (Dependabot #267).
- **Assessed:** 2026-08-06 against `62ed307`.

#### [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6), [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) — fast-uri host confusion (backslash authority delimiter/introducer, failed IDN canonicalization)

- **Severity:** high (all three) — **Package:** `fast-uri` (3.1.2 installed) — **Load path:** `fast-uri` ← `ajv` ← `@modelcontextprotocol/sdk@1.29.0`. **First patched:** 3.1.5.
- **Load-graph reachable:** Yes — ajv uses fast-uri for `format: "uri"` schema validation. Same path as the documented GHSA-v39h / GHSA-q3j6 rows above.
- **Code-path / untrusted-input reachable:** As previously assessed, fast-uri's URI-parse correctness is **not** on iris's security-critical URL acceptance path — the citation-verify resolver (`src/eval/citation-verify/resolve.ts`) does its own scheme allowlist, private/link-local/metadata IP blocking (IPv6-literal handling hardened in this same PR), and DNS pre-resolve. A fast-uri host-confusion bypass cannot smuggle a request past those independent checks.
- **Decision:** **Override** — the existing `overrides.fast-uri = "^3.1.2"` already permits the 3.1.5 fix; Dependabot #268 (fast-uri 3.1.2 → 3.1.5) updates the lockfile to land it. Defense in depth regardless.
- **Assessed:** 2026-08-06 against `62ed307`.

#### [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr) (high), [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh), [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) — ip-address SSRF / trust-boundary bypasses (leading-zero-octal decode, CIDR-suffix special-use suppression, IPv4-mapped/NAT64 misclassification)

- **Severity:** high + moderate + moderate — **Package:** `ip-address` (10.2.0 installed) — **Load path:** `ip-address` ← `express-rate-limit@8.5.2`.
- **Load-graph reachable:** Yes — express-rate-limit parses client IPs with ip-address.
- **Code-path / untrusted-input reachable:** **iris does not import `ip-address` anywhere** (verified: `grep -rn "ip-address" src/` is empty). It reaches iris only through express-rate-limit, which uses the parsed address **solely as a rate-limit bucket key** — never as an SSRF or trust-boundary decision. iris's SSRF authority is its own resolver, which does not use this package. So the class of bug these advisories describe (SSRF classification bypass) is not on any iris trust boundary.
- **Downstream guards:** The rate-limiter stores the address as a key only. Worst case of a misclassified key is a slightly wrong rate-limit bucket, not a security-boundary crossing.
- **Decision:** **Dismiss as `tolerable_risk`.** Patch tracks Dependabot #265 (ip-address 10.2.0 → 10.4.0).
- **Assessed:** 2026-08-06 against `62ed307`.

#### [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) — brace-expansion DoS (exponential non-expanding `{}` groups, unbounded expansion OOM, unbounded intermediate arrays)

- **Severity:** high (all three) — **Package:** `brace-expansion` (5.0.5 installed) — **First patched:** 5.0.7.
- **Load-graph reachable:** Yes — dev-tooling transitive (vitest/vite file resolution, eslint glob handling). Same class as the documented GHSA-jxxr row above.
- **Untrusted-input reachable:** **No.** iris accepts no user-supplied glob/brace pattern through any MCP tool, HTTP handler, or rule input. The only callers are dev tooling operating on checked-in patterns behind the PR review gate; a pathological expansion manifests as a CI job timeout, not a user-facing degradation.
- **Decision:** **Dismiss as `tolerable_risk`** (matches the existing brace-expansion decision). Patch tracks Dependabot #254 / #255 (→ 5.0.7).
- **Assessed:** 2026-08-06 against `62ed307`.

#### [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) (high), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) — postcss path traversal via attacker-controlled `sourceMappingURL` (arbitrary `.map` disclosure)

- **Severity:** high + moderate — **Package:** `postcss` (8.5.15 installed) — **Load path:** `postcss` ← `vite` ← `vitest`. **First patched:** 8.5.26 line (Dependabot bumps to 8.5.25+).
- **Load-graph reachable:** Yes — dev/test tooling only (Vite's CSS pipeline under Vitest). Not present in any iris runtime production path (the MCP server ships no PostCSS; the website/dashboard build their CSS at build time, not from untrusted input).
- **Untrusted-input reachable:** **No.** The exploit requires processing attacker-controlled CSS containing a crafted `sourceMappingURL`. iris processes no user-supplied CSS at runtime; the only CSS PostCSS touches is first-party source at build/test time.
- **Decision:** **Dismiss as `tolerable_risk`** — dev-tooling only, no untrusted CSS. Patch tracks Dependabot #261 / #263 (→ 8.5.25).
- **Assessed:** 2026-08-06 against `62ed307`.

---

## Operational notes

- **When a new Dependabot alert opens:** add a section here within one PR cycle. The CI gate (`scripts/security/check-exposure-coverage.mjs`) will fail PRs that introduce or surface a new ≥medium alert without a corresponding row.
- **When an advisory is patched upstream:** update the affected sections to reflect the patched-and-installed state, or remove the section if the alert auto-closes.
- **When iris's call graph changes:** re-verify the reachability claims for any open advisory whose package is on the changed code path. The `Assessed against iris commit X` line records the snapshot.
- **When upstream releases a fix that removes a dep:** the affected section can be retired.

This file is a working operational record, not a marketing document. It exists so any auditor or contributor can read the actual exposure analysis instead of guessing from a count of red dots.
