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

---

## Operational notes

- **When a new Dependabot alert opens:** add a section here within one PR cycle. The CI gate (`scripts/security/check-exposure-coverage.mjs`) will fail PRs that introduce or surface a new ≥medium alert without a corresponding row.
- **When an advisory is patched upstream:** update the affected sections to reflect the patched-and-installed state, or remove the section if the alert auto-closes.
- **When iris's call graph changes:** re-verify the reachability claims for any open advisory whose package is on the changed code path. The `Assessed against iris commit X` line records the snapshot.
- **When upstream releases a fix that removes a dep:** the affected section can be retired.

This file is a working operational record, not a marketing document. It exists so any auditor or contributor can read the actual exposure analysis instead of guessing from a count of red dots.
