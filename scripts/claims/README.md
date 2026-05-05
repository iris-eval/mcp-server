# Truthbase (`scripts/claims/`)

Single source of truth for every fact about Iris that appears on multiple surfaces.

The truthbase exists because hand-edited claim values drift between artifact and surface — the hero badge that read `stars: invalid` for an unknown duration; the 17-surface alignment sweep; the `374 tests` claim that went stale within one release cycle. Three canaries, one bug class. The structural fix is to generate the values from artifacts (package.json, vitest output, MCP tool registry, rule registry, LLM-judge templates) and have every surface import from a reader.

## Files

- **`.claims.json`** (at repo root) — the generated truthbase. Versioned schema. Do not hand-edit.
- **`scripts/claims/generate.mjs`** — orchestrator. Runs all generators, assembles the JSON, writes if changed.
- **`scripts/claims/generators/*.mjs`** — one generator per fact category (version, tests, mcp-tools, eval-rules, llm-judge-templates, brand, release).
- **`scripts/claims/capture-tests.mjs`** — runs vitest with `--reporter=json` and writes `.claims-cache/tests.json` for the test generator to read. CI runs this before `generate.mjs`.
- **`scripts/claims/check-no-hardcoded.mjs`** — regex scanner. Fails if any source file outside the allow-list contains a hardcoded claim that should come from the truthbase.
- **`scripts/claims/allow-list.json`** — explicit exemptions. Each entry justifies why a literal stays uncovered (historical CHANGELOG entries, generator regex sources, etc.). Entries are removed as surfaces migrate to the reader.
- **`src/lib/claims.ts`** — reader for the mcp-server.
- **`website/src/lib/claims.ts`** — reader for the website.
- **`dashboard/src/lib/claims.ts`** — reader for the dashboard.
- **`.github/workflows/claims-alignment.yml`** — CI workflow that runs the scanner + verifies the truthbase regenerator output matches the committed `.claims.json`.

## Commands

```bash
npm run claims:capture-tests   # runs vitest, writes .claims-cache/tests.json
npm run claims:generate         # regenerates .claims.json
npm run claims:check            # fails if .claims.json doesn't match the regenerator output
npm run claims:check-hardcoded  # fails if any unguarded hardcoded claim is found
```

## How a fact gets added

1. Add a generator function under `scripts/claims/generators/<name>.mjs` (or extend an existing one).
2. Wire it into `generate.mjs`'s generators array.
3. Run `npm run claims:generate` and commit the updated `.claims.json`.
4. Add the field to the reader (`src/lib/claims.ts`) and the two mirrors (`website/src/lib/claims.ts`, `dashboard/src/lib/claims.ts`).
5. Update surfaces to import the new const from the reader instead of hardcoding.

## Adding a hardcoded-claim pattern

When a new claim type starts appearing on surfaces (e.g., `\d+ supported clients` becomes a hero claim), add a regex pattern to `check-no-hardcoded.mjs`'s `PATTERNS` list with a fix message that points to the right reader const. CI then catches new instances as they're introduced.

## Allow-list discipline

Allow-list entries are deliberate, time-boxed exemptions. Reviewing the allow-list quarterly is the right cadence — entries that have outlived their reason get removed; sites still hardcoded get migrated.

The substrate's principle: **drift is a class, not a bug.** Patching a single surface forward is IC work; eliminating the hardcode is the structural fix that compounds.
