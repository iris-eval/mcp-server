# Contributing to Iris

Thank you for your interest in contributing to Iris. We welcome contributions that improve the project for everyone.

## Contributor License Agreement

By submitting a pull request, you agree to our [Contributor License Agreement](.github/CLA.md). This is required before any contribution can be reviewed or merged. The CLA ensures that the project can be maintained, distributed, and — if necessary — relicensed in the future.

## AI-Generated Code

You are welcome to use AI tools (Copilot, Claude, etc.) to assist with your contributions. However, by submitting a PR, you represent that you have reviewed all code for correctness and security, and that you accept full responsibility for the contribution under the CLA — regardless of how it was generated.

## Security

If you discover a security vulnerability, **do not open a public issue**. Please email security@iris-eval.com instead. See [SECURITY.md](SECURITY.md) for details.

## Development Setup

Node.js 22.13 or later (`node --version`); the `engines` field in `package.json` is the floor the server itself needs.

```bash
git clone https://github.com/iris-eval/mcp-server.git
cd mcp-server
npm install
cd dashboard && npm install && cd ..   # the dashboard is its own workspace; `npm run build` and its tests need it
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with tsx |
| `npm run build` | Build TypeScript |
| `npm run typecheck` | Type check `src/` without emitting |
| `npm run typecheck:tests` | Type check `tests/` and the end-to-end specs |
| `npm test` | Run unit tests |
| `npm run test:integration` | Run integration tests |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | Lint source code |
| `npm run preflight` | The checks a branch most often fails CI on, in a few minutes: claims and renders, lint, types, and the test files your branch changes. `-- --full` runs every check CI runs that can run here; `-- --list` shows both, and the jobs only CI runs |

## Dashboard Development

```bash
cd dashboard
npm install
npm run dev    # Starts Vite dev server with HMR
```

The dev server proxies API requests to `http://localhost:6920`.

## Versioning

Iris follows [Semantic Versioning](https://semver.org/). While the version
starts with `0.`, the minor is the compatibility lever: anything an existing
caller can observe changing bumps the minor and is written in `CHANGELOG.md` as
a bold **Behaviour change:** sentence. The full policy, including what has to be
true before 1.0, is in [VERSIONING.md](VERSIONING.md). If your change alters
what a caller sees, say so in the PR description and write that sentence.

## PR Process

1. Fork the repo and create a feature branch
2. Make your changes, and commit them
3. Run `npm run preflight`. It needs `npm ci` in the root, `dashboard/` and `website/`. In a few minutes it runs the claims and render checks, lint, the type checks, the dashboard's and the website's checks when your branch touches them, and the test files your branch adds or changes. CI then runs everything in parallel: the whole suite on both Node lines and both SQLite drivers, the builds, the proofs, and the jobs that need other operating systems. `npm run preflight -- --full` runs every check that can run here, one after another, in about 25 minutes on a desktop, for a change wide enough that you want that answer before CI's. The test totals in `.claims.json` are counted at a release, not on each pull request.
4. Submit a PR against `main` with a clear description of changes

To have git refuse a push the preflight has not passed, run `git config core.hooksPath scripts/git-hooks` once. The preflight records the tree it verified, and the hook lets a branch go only at that tree.

Match the formatting of the file you are editing. CI does not run Prettier, and the tree is not Prettier-clean, so `npm run format` would rewrite files your change does not touch; leave it out of a pull request.

### What to expect after you open a PR

- **CI must pass.** Branch protection blocks merge until every required check is green. These are the exact context names, as GitHub reports them; the list is [`.github/required-checks.json`](.github/required-checks.json), which CI compares on every run with what the live settings require (branch protection and rulesets together):

  | Check | What it covers |
  |---|---|
  | `Workflows lint (actionlint)` | Every workflow file parses, and its expressions and shell steps lint |
  | `lint-and-typecheck` | ESLint, `tsc --noEmit` over `src/`, the version and product-claim checks |
  | `typecheck-tests` | `tsc` over `tests/` and the Playwright specs |
  | `test (22)` | Unit suite on Node 22 |
  | `test (24)` | Unit suite on Node 24 |
  | `test (22, macOS)` | Unit suite on Node 22 on macOS |
  | `integration` | `tests/integration/` |
  | `e2e` | Playwright end-to-end |
  | `build` | The dashboard and the server build, and the pack carries both |
  | `docker-build` | The published image builds |
  | `native addon built from source (ubuntu-latest, Node 24)` | The SQLite addon compiled from source on Node 24: Iris predicts where that binary is unsafe, never loads it there, and still ends every session cleanly |
  | `Real clients (ubuntu-latest)` | Claude Code and Gemini CLI connect to this commit through the config `iris-eval install` writes |
  | `Real clients (macos-latest)` | The same, on macOS |
  | `Real clients (windows-latest)` | The same, on Windows |
  | `security-exposure` | Every open dependency advisory has an assessed row in `SECURITY-EXPOSURE.md` |
  | `website-lint-and-typecheck` | Lint, typecheck and production build of `website/` |
  | `Hardcoded-claim scanner` | No number/claim restated outside the truthbase |
  | `Truthbase regen vs committed` | `.claims.json` and the rendered files regenerate identical to what you committed |
  | `Proof — rule accuracy regen vs committed` | The published accuracy numbers regenerate identical, so a rule change carries its numbers |
  | `Build the sdist and the wheel` | The Python client builds |
  | `analyze (javascript-typescript)` | CodeQL static analysis |
  | `CodeQL` | GitHub's code-scanning result for that analysis: no new alert of the severity it blocks on |

  Other workflows (Lighthouse, the Vercel preview, the upgrade and bundle jobs) run on PRs and are worth reading, but they do **not** block merge.

- **The two claims checks are the ones docs contributors hit first.** Every public number in Iris — rule counts, pattern counts, tool counts, the current version — is generated into [`.claims.json`](.claims.json) from source. If you change any of those, or any doc that quotes them, run `npm run claims:generate` and commit the regenerated `.claims.json` in the same PR; use `npm run claims:check-hardcoded` locally to see what the scanner sees before you push.
- **One CODEOWNER approval** is required (see [.github/CODEOWNERS](.github/CODEOWNERS)). Direct pushes to `main` are forbidden — every change goes through the PR cycle, no exceptions, including hotfixes.
- **Squash-merge** is the default. Your branch is deleted automatically on merge; the squash commit message is what lands in `main` history, so write the PR title carefully.
- **Conventional Commits** for the PR title: `fix(scope):`, `feat(scope):`, `chore(scope):`, `docs(scope):`, `test(scope):`. Scope examples: `claims`, `security`, `website`, `dashboard`, `cors`, `tests`.

## Issues, labels and milestones

Every issue carries a kind (`bug` / `enhancement`), exactly one priority (`P0`–`P3`), at least one area (`server`, `dashboard`, `website`, `docs`, `security`, `dx`), and — when we know it — a provenance (`acceptance-testing`, `review`, `user-report`). The templates apply the kind and `needs-triage`; a maintainer sets the rest at triage and removes `needs-triage`. Open `P0`/`P1` issues always have a milestone, and a milestone is closed the day its version ships. The full vocabulary, what each label means, and the milestone rules are in [.github/LABELS.md](.github/LABELS.md).

If you are picking something up: `good first issue` is scoped for a newcomer, and the priority label tells you how much it matters — a `P0` is a shipped surface reporting success while failing.

### Dependabot PRs

Dependabot opens dependency PRs weekly (config: [.github/dependabot.yml](.github/dependabot.yml)). If one required check is red on *every* Dependabot PR at once, the cause is on `main`, not in the PRs — typically a regenerated file (`.claims.json`) the branches were cut before. Fix `main` first, then comment `@dependabot rebase` on each PR; Dependabot rebuilds the branch on the repaired base. Never merge a Dependabot PR by bypassing the red check, and never "fix" one by pushing to its branch (Dependabot will overwrite it).

## Contributing a built-in rule

The path from an idea to a shipped, measured, documented rule — every file it touches and the test that refuses the PR if a step is skipped — is [docs/contributing-a-rule.md](docs/contributing-a-rule.md). For a rule that only your deployment needs, see [custom rules](docs/custom-rules.md) or [plugin rules](docs/plugins.md) instead.

## Coding Standards

- TypeScript strict mode
- ESM modules (no CommonJS)
- Vitest for testing
- Write to stderr for logging (stdout reserved for stdio transport)
- Serialize complex objects as JSON in SQLite columns
- Use Zod schemas for MCP tool input validation
