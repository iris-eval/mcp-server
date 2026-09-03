# Labels and milestones

The vocabulary every issue and PR on `iris-eval/mcp-server` is filed under, and the rules for applying it. If a label is not on this page, it should not exist on the repo; if a rule here is not followed, the filters on the Issues tab stop meaning anything — which is how the entire v0.5.0 acceptance-test batch (#369–#377) sat with no priority, no area and no milestone for three weeks.

Labels are applied by three loaders:

- **Issue templates** (`.github/ISSUE_TEMPLATE/*.yml`) apply the *kind* label plus `needs-triage`.
- **Dependabot** (`.github/dependabot.yml`) applies `dependencies` plus the ecosystem label for the update (`ci`, `docker`). Dependabot silently drops a label that does not exist on the repo, so these are created, not implied.
- **A maintainer at triage** sets exactly one *priority*, at least one *area*, and a *provenance* when known, then removes `needs-triage`.

## Kind — what the issue is

| Label | Meaning |
|---|---|
| `bug` | Iris does not do what it says. |
| `enhancement` | Iris should do something it does not. |
| `question` | Needs an answer, not a change. Prefer Discussions. |
| `duplicate` · `invalid` · `wontfix` | GitHub defaults; closed with the label as the reason. |
| `good first issue` · `help wanted` | Scoped for a newcomer / open to outside contribution. |
| `dependencies` | Dependency update (Dependabot, or a hand-written batch). |
| `ci` · `docker` · `javascript` | Ecosystem of a dependency update, set by Dependabot config. |

## Priority — how soon, exactly one per open issue

| Label | Meaning | Response |
|---|---|---|
| `P0` | A shipped surface reports success while failing, leaks data, or blocks install. The kind of defect the release exists to prevent. | Next patch release; nothing else ships first. |
| `P1` | Wrong behaviour or a false claim a user will hit on the documented path. | Next minor. |
| `P2` | Real, reproducible, has a workaround or a narrow path. | Scheduled when the area is touched. |
| `P3` | Polish, ergonomics, nice-to-have. | No commitment. |

A priority is a statement about consequence, not effort. Effort has its own axis (`effort: small` / `medium` / `large`) so that a small P0 and a large P3 can both be read correctly.

## Area — where in the product, at least one

| Label | Covers |
|---|---|
| `server` | The MCP server: tools, eval engine and rules, storage, transports, CLI flags, config. |
| `dashboard` | The web dashboard UI and its HTTP API (`/api/v1/*`, including HTTP ingest). |
| `website` | iris-eval.com — pages, metadata, share images, the playground. |
| `docs` | README, `docs/`, the shipped skill, tool descriptions, CHANGELOG, blog. |
| `security` | Security-relevant behaviour, hardening, or data exposure — in any area. Add alongside the area label, never instead of it. |
| `dx` | Developer experience: install, first run, error messages, ergonomics. |

## Provenance — how we learned about it

| Label | Meaning |
|---|---|
| `acceptance-testing` | Found by an install-only acceptance pass against a packed release (the v0.5.0 UAT batch, `tests/uat/`). |
| `review` | Found by a code or doc review of the shipped behaviour (the 0.5.1 verdict-integrity review). |
| `user-report` | Reported by someone outside the project. These carry a person waiting on the other end; triage them first. |

## Workflow

| Label | Meaning |
|---|---|
| `needs-triage` | Applied by the templates. Removed by the maintainer who sets priority + area. An issue that has carried it for more than a week is a triage failure, not an issue failure. |

## Milestones

- One open milestone per version in flight, named exactly like the tag: `v0.6.0`. Its description says what the version is *for* in one paragraph, in the roadmap's language (`docs/roadmap.md`: proof, coverage, reach) — never a feature ladder, and never anything hosted or priced.
- Every open `P0`/`P1` issue has a milestone. `P2`/`P3` may sit unscheduled.
- When a version ships, its milestone is **closed the same day**: issues that did not ship move to the next milestone, and the description is edited to say what shipped and where the rest went. A milestone that outlives its release is a public roadmap for a version that already happened.
- No due dates unless a date is a real commitment.

## Creating or changing labels

Labels are repo metadata, created with `gh label create <name> --color <hex> --description "<text>"` and edited with `gh label edit`. Keep this page in step: a label with no row here is undocumented, and a row here with no label is lore.
