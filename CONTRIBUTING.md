# Contributing to Iris

Thank you for your interest in contributing to Iris. We welcome contributions that improve the project for everyone.

## Contributor License Agreement

By submitting a pull request, you agree to our [Contributor License Agreement](.github/CLA.md). This is required before any contribution can be reviewed or merged. The CLA ensures that the project can be maintained, distributed, and — if necessary — relicensed in the future.

## AI-Generated Code

You are welcome to use AI tools (Copilot, Claude, etc.) to assist with your contributions. However, by submitting a PR, you represent that you have reviewed all code for correctness and security, and that you accept full responsibility for the contribution under the CLA — regardless of how it was generated.

## Security

If you discover a security vulnerability, **do not open a public issue**. Please email security@iris-eval.com instead. See [SECURITY.md](SECURITY.md) for details.

## Development Setup

```bash
git clone https://github.com/iris-eval/mcp-server.git
cd mcp-server
npm install
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with tsx |
| `npm run build` | Build TypeScript |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Run unit tests |
| `npm run test:integration` | Run integration tests |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | Lint source code |
| `npm run format` | Format with Prettier |

## Dashboard Development

```bash
cd dashboard
npm install
npm run dev    # Starts Vite dev server with HMR
```

The dev server proxies API requests to `http://localhost:6920`.

## PR Process

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure all tests pass: `npm test && npm run test:integration`
4. Ensure code is formatted: `npm run format:check`
5. Submit a PR against `main` with a clear description of changes

### What to expect after you open a PR

- **CI must pass.** Branch protection blocks merge until all eleven required checks are green. These are the exact context names, as GitHub reports them:

  | Check | What it covers |
  |---|---|
  | `lint-and-typecheck` | ESLint + `tsc --noEmit` over `src/` and `tests/` |
  | `test (20)` | Unit suite on Node 20 |
  | `test (22)` | Unit suite on Node 22 |
  | `integration` | `tests/integration/` |
  | `e2e` | Playwright end-to-end |
  | `build` | `tsc -p tsconfig.build.json` |
  | `docker-build` | The published image builds |
  | `security-exposure` | The exposure surface matches `SECURITY-EXPOSURE.md` |
  | `website-lint-and-typecheck` | Lint + typecheck for `website/` |
  | `Hardcoded-claim scanner` | No number/claim restated outside the truthbase |
  | `Truthbase regen vs committed` | `.claims.json` regenerates byte-identical to what you committed |

  Other workflows (Lighthouse, CodeQL, the Vercel preview) run on PRs and are worth reading, but they do **not** block merge.

- **The two claims checks are the ones docs contributors hit first.** Every public number in Iris — rule counts, pattern counts, tool counts, the current version — is generated into [`.claims.json`](.claims.json) from source. If you change any of those, or any doc that quotes them, run `npm run claims:generate` and commit the regenerated `.claims.json` in the same PR; use `npm run claims:check-hardcoded` locally to see what the scanner sees before you push.
- **One CODEOWNER approval** is required (see [.github/CODEOWNERS](.github/CODEOWNERS)). Direct pushes to `main` are forbidden — every change goes through the PR cycle, no exceptions, including hotfixes.
- **Squash-merge** is the default. Your branch is deleted automatically on merge; the squash commit message is what lands in `main` history, so write the PR title carefully.
- **Conventional Commits** for the PR title: `fix(scope):`, `feat(scope):`, `chore(scope):`, `docs(scope):`, `test(scope):`. Scope examples: `claims`, `security`, `website`, `dashboard`, `cors`, `tests`.

## Issues, labels and milestones

Every issue carries a kind (`bug` / `enhancement`), exactly one priority (`P0`–`P3`), at least one area (`server`, `dashboard`, `website`, `docs`, `security`, `dx`), and — when we know it — a provenance (`acceptance-testing`, `review`, `user-report`). The templates apply the kind and `needs-triage`; a maintainer sets the rest at triage and removes `needs-triage`. Open `P0`/`P1` issues always have a milestone, and a milestone is closed the day its version ships. The full vocabulary, what each label means, and the milestone rules are in [.github/LABELS.md](.github/LABELS.md).

If you are picking something up: `good first issue` is scoped for a newcomer, and the priority label tells you how much it matters — a `P0` is a shipped surface reporting success while failing.

### Dependabot PRs

Dependabot opens dependency PRs weekly (config: [.github/dependabot.yml](.github/dependabot.yml)). If one required check is red on *every* Dependabot PR at once, the cause is on `main`, not in the PRs — typically a regenerated file (`.claims.json`) the branches were cut before. Fix `main` first, then comment `@dependabot rebase` on each PR; Dependabot rebuilds the branch on the repaired base. Never merge a Dependabot PR by bypassing the red check, and never "fix" one by pushing to its branch (Dependabot will overwrite it).

## Coding Standards

- TypeScript strict mode
- ESM modules (no CommonJS)
- Vitest for testing
- Write to stderr for logging (stdout reserved for stdio transport)
- Serialize complex objects as JSON in SQLite columns
- Use Zod schemas for MCP tool input validation
