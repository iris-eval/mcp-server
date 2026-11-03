# AGENTS.md

How to build, test and land a change in this repository. Written for coding agents; it holds for people too. [CONTRIBUTING.md](CONTRIBUTING.md) is the longer version of the same rules, and wins if the two ever disagree.

Iris is an MCP server that evaluates AI agent output for quality, safety and cost. TypeScript, ESM only, Node.js 22.13 or later. The server is `src/`, built to `dist/`, and published to npm as `@iris-eval/mcp-server`. How the pieces fit: [docs/architecture.md](docs/architecture.md).

## Layout

| Path | What it is |
|---|---|
| `src/tools/` | The MCP tools, one file each |
| `src/eval/` | The evaluation engine and the verdict; built-in rules in `src/eval/rules/`, the optional model judge in `src/eval/llm-judge/` |
| `src/storage/` | SQLite storage (better-sqlite3, or Node's built-in `node:sqlite`) |
| `src/dashboard/` | The dashboard's HTTP server: its API and the `POST /api/v1/traces` ingest |
| `src/cli/` | `install`, `ingest` and `export` |
| `dashboard/` | The web dashboard: Vite and React, its own `package.json` and lockfile, built into `dist/dashboard` |
| `website/` | iris-eval.com: Next.js, its own `package.json` and lockfile |
| `packages/` | `sdk` (`@iris-eval/sdk`), `langchain` (`@iris-eval/langchain`), `python` (`iris-eval` on PyPI) and `iris-eval` (the npm launcher). Each versions on its own |
| `tests/` | Vitest: `unit/`, `integration/`, `proof/`; Playwright in `e2e/`; contract tests at the top level that hold the docs, manifests and site to the code |
| `proof/` | The labelled corpus and the runner behind the published accuracy of every rule |
| `scripts/` | Build, release and preflight scripts; `scripts/claims/` generates and checks the truthbase |
| `.claims.json` | The truthbase: every public number (rules, patterns, tools, version), generated from source |
| `clients.json` | One row per MCP client Iris names, with how it is checked |

## Setup

```bash
npm ci
npm --prefix dashboard ci
npm --prefix website ci
git config core.hooksPath scripts/git-hooks   # the pre-push hook: refuses a tree the preflight has not passed
```

## The fast gate: `npm run preflight`

Run it before every push. In a few minutes it runs the claims and render checks, lint, the type checks, the dashboard's and the website's checks when the branch touches them, and the test files the branch reaches.

- It checks a commit, not a working tree: commit first. It refuses to start with uncommitted changes and fails if a step changes a tracked file.
- On success it records the tree it verified, and the pre-push hook lets only that tree go.
- `npm run preflight -- --full` runs every check CI runs that can run locally, in about 25 minutes. Use it for a change wide enough that you want that answer before CI's.
- `npm run preflight -- --list` shows the steps, and the CI jobs that only CI runs, with the reason for each.

## Tests

| Command | Runs |
|---|---|
| `npx vitest run tests/unit/install/` | One folder or file: the fastest loop |
| `npm test` | The root suite |
| `npm run test:integration` | `tests/integration/` |
| `npm run build && npm run test:e2e` | Playwright against `dist/index.js`, so build first |
| `npm --prefix dashboard test` | The dashboard's own suite |
| `npm run proof -- --check` | The published rule accuracy regenerates identical to what is committed |
| `pip install -e "packages/python[test]" && python -m pytest packages/python -q` | The Python client |

- Tests run against a scratch Iris home (`tests/setup/iris-home.ts`). Never point one at a real `~/.iris`.
- `tests/real-clients/`, `tests/mcpb/`, `tests/stall/` and `tests/upgrade/` run only in their CI jobs, each through its own `vitest.config.ts`. The root suite excludes them.
- Run the tests your change reaches. CI runs the whole suite in parallel, on both Node lines and both SQLite drivers, with the builds, the proofs and the jobs that need other operating systems.

## Generated files: regenerate, never hand-edit

| File | Regenerate with |
|---|---|
| `.claims.json` | `npm run claims:generate` |
| `website/public/llms.txt`, `llms-full.txt`, and the clients table in `README.md` between its `<!-- iris:clients-table -->` markers | `npm run llms:render` |
| `website/public/response-schema-v1.json` | `npm run schema:render` |
| `website/src/lib/changelog.generated.json` | `npm run changelog:render` |
| `website/public/.well-known/mcp.json` | `npm run mcp-json:render` |
| Versions in every manifest | `npm run version:sync` (from `package.json`) |
| `proof/RESULTS.md` and the accuracy numbers | `npm run proof` |

Each has a check CI runs (`claims:check`, the `:check` twin of each render, `version:check`, `proof -- --check`), so a stale file fails the pull request. A public number comes from `.claims.json`: in code, import it from the truthbase reader; in prose, it must match the truthbase, and `npm run claims:check-hardcoded` shows what the scanner sees.

## Conventions

- TypeScript strict mode, ESM modules, Zod schemas for MCP tool input.
- Log to stderr. Stdout belongs to the stdio transport.
- Match the formatting of the file you edit. CI does not run Prettier and the tree is not Prettier-clean.
- A change a caller can observe is a minor bump and a bold **Behaviour change:** sentence in `CHANGELOG.md` under `[Unreleased]`. The policy: [VERSIONING.md](VERSIONING.md).
- A new built-in rule follows [docs/contributing-a-rule.md](docs/contributing-a-rule.md): the rule, its unit tests, its capability-map cell, its proof corpus and its measured numbers, in one pull request.
- Prose says what the code does. Contract tests (`tests/docs-contract.test.ts`, `tests/clients-contract.test.ts`, `tests/site-says-what-the-code-does.test.ts` and others) hold the flags, routes, variables and client rows the docs name to the code. When one fails, fix the prose or the code; change the test only when what it locks has changed.
- Comments, test names and changelog entries are written for a reader who has not seen the conversation that produced them.

## Dependencies and lockfiles

- Install with `npm ci`. Lockfiles change only through Dependabot or on Linux (WSL or Docker): an `npm install` on Windows prunes the Linux platform bindings the dashboard's lockfile carries, and CI's `npm ci` fails.
- Dependabot opens dependency PRs weekly. Never push to a Dependabot branch; if every Dependabot PR fails the same check, fix `main` and comment `@dependabot rebase`.
- A new dependency carrying an advisory of moderate or above fails `security-exposure` unless [SECURITY-EXPOSURE.md](SECURITY-EXPOSURE.md) triages it.

## Pull requests

- Branch from `main`. Every change reaches `main` through a pull request; nothing is pushed to it directly.
- Title in Conventional Commits form: `fix(scope): …`, `feat(scope): …`, `docs(scope): …`, `chore(scope): …`, `test(scope): …`. PRs are squash-merged, so the title is the commit on `main`.
- The required checks are listed in [.github/required-checks.json](.github/required-checks.json). A ruleset with no bypass list enforces them: nothing merges red or pending, maintainers included.
- The description says what changed and why, and whether a caller will see a difference.
- Submitting a pull request accepts the [Contributor License Agreement](.github/CLA.md). Code written with AI assistance is welcome; you are responsible for having reviewed it.

## Never

- Push with `--no-verify`, or work around the pre-push hook or a required check.
- Hand-edit `.claims.json` or a rendered block.
- Run `npm run format`.
- Change a lockfile on Windows, or with `--package-lock-only` there.
- Edit `docs/blog/0*.md` as a side effect: a change to a post on `main` cross-posts it to dev.to. `docs/blog/` and `docs/launch/` are dated records and keep the voice of their date.
- Write to stdout from server code.
- Commit secrets, real user traces, or data from a real `~/.iris`.
- Report a vulnerability in a public issue. [SECURITY.md](SECURITY.md) says where.
