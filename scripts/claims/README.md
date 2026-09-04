# Truthbase (`scripts/claims/`)

Single source of truth for every fact about Iris that appears on multiple surfaces.

The truthbase exists because hand-edited claim values drift between artifact and surface — the hero badge that read `stars: invalid` for an unknown duration; the 17-surface alignment sweep; the `374 tests` claim that went stale within one release cycle. Three canaries, one bug class. The structural fix is to generate the values from artifacts (package.json, vitest output, MCP tool registry, rule registry, LLM-judge templates) and have every surface import from a reader.

## Files

- **`.claims.json`** (at repo root) — the generated truthbase. Versioned schema. Do not hand-edit.
- **`scripts/claims/generate.mjs`** — orchestrator. Runs all generators, assembles the JSON, writes if changed.
- **`scripts/claims/generators/*.mjs`** — one generator per fact category (version, tests, mcp-tools, eval-rules, llm-judge-templates, brand, release, security, issues). `security.mjs` folds in `security-policy.mjs`, which parses the disclosure SLA out of `SECURITY.md` and throws if a sentence changes shape or the file disagrees with itself.
- **`scripts/claims/generators/issues.mjs`** — the `maintenance` block: issue-close latency measured from the public GitHub API (pull requests excluded). **It is the only generator that can touch the network, and it does so only when asked.** By default, and always under `--check`, it returns the block already committed in `.claims.json`, verbatim — a generator that fetched on every run would move the numbers on any day an issue closed and turn an unrelated PR red. `npm run claims:generate:live` (or `IRIS_CLAIMS_LIVE=1`) re-samples and stamps `source: "live"` + `sampledAt`; if the API is unreachable the committed sample is kept with `source: "cached"` and a warning names the error. The security page renders `sampledAt`, so a stale sample reads as stale; the generator also warns when the committed sample is older than 45 days.
- **`scripts/claims/render-llms.mjs`** — renders `website/public/llms.txt` and `llms-full.txt` from `website/llms.template.txt` and `llms-full.template.txt` (`{{slot}}` placeholders, no logic; an unknown or valueless slot throws). `--check` fails when the committed files differ from the render; CI runs it in both `ci.yml` and the truthbase-regen job. Add a slot in `slotsFrom()`, never a literal in a template.
- **`scripts/claims/capture-tests.mjs`** — runs vitest with `--reporter=json` and writes `.claims-cache/tests.json` for the test generator to read. CI runs this before `generate.mjs`.
- **`scripts/claims/check-no-hardcoded.mjs`** — regex scanner. Fails if any source file outside the allow-list contains a hardcoded claim that should come from the truthbase.
- **`scripts/claims/allow-list.json`** — explicit exemptions. Each entry justifies why a literal stays uncovered (historical CHANGELOG entries, generator regex sources, etc.). Entries are removed as surfaces migrate to the reader.
- **`website/src/lib/claims.ts`** — reader for the website (the only currently-wired consumer surface).
- *(Server and dashboard readers are not currently present.)* When a server-side or dashboard-side surface needs to import a truthbase value, add the reader **in the same PR as the consumer**, and include the build-context updates the reader requires: `COPY .claims.json ./` in `Dockerfile` (server reader) and `.claims.json` in `package.json`'s `files` allowlist (npm tarball). Pre-creating an unused reader leaves a broken import in dead code that survives PR CI but breaks the Docker / tagged-release build (see CHANGELOG `[0.4.1] [WITHDRAWN]`).
- **`.github/workflows/claims-alignment.yml`** — CI workflow that runs the scanner + verifies the truthbase regenerator output matches the committed `.claims.json`.

## Commands

```bash
npm run claims:capture-tests   # runs vitest, writes .claims-cache/tests.json
npm run claims:generate         # regenerates .claims.json
npm run claims:check            # fails if .claims.json doesn't match the regenerator output
npm run claims:check-hardcoded  # fails if any unguarded hardcoded claim is found
npm run claims:generate:live    # as claims:generate, plus a fresh `maintenance` sample from the GitHub API
npm run llms:render             # renders website/public/llms.txt + llms-full.txt from the templates + .claims.json
npm run llms:check              # fails if the committed llms files differ from the render
```

## How a fact gets added

1. Add a generator function under `scripts/claims/generators/<name>.mjs` (or extend an existing one).
2. Wire it into `generate.mjs`'s generators array.
3. Run `npm run claims:generate` and commit the updated `.claims.json`.
4. Add the field to every reader that exists at the time. Today that's `website/src/lib/claims.ts` only; if a server-side or dashboard-side reader has been added, mirror the field there and assert alignment in the consumer test.
5. Update surfaces to import the new const from the reader instead of hardcoding.

## Adding a hardcoded-claim pattern

When a new claim type starts appearing on surfaces (e.g., `\d+ supported clients` becomes a hero claim), add a regex pattern to `check-no-hardcoded.mjs`'s `PATTERNS` list with a fix message that points to the right reader const. CI then catches new instances as they're introduced.

## Allow-list discipline

Allow-list entries are deliberate, time-boxed exemptions. Reviewing the allow-list quarterly is the right cadence — entries that have outlived their reason get removed; sites still hardcoded get migrated.

The substrate's principle: **drift is a class, not a bug.** Patching a single surface forward is IC work; eliminating the hardcode is the structural fix that compounds.
