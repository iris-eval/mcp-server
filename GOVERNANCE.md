# Governance

Iris is an open-source project with one maintainer. This page says who decides what, how a change reaches `main`, how a release is made, and how a contributor becomes a maintainer.

## Roles

**Maintainer.** Ian Parent ([@irparent](https://github.com/irparent)), the code owner for every path in the repository ([.github/CODEOWNERS](.github/CODEOWNERS)). The maintainer sets direction, triages issues, reviews and merges pull requests, cuts releases and answers security reports.

**Contributors.** Anyone who opens an issue, starts a discussion, reviews a pull request or sends one. Code contributions are made under the [Contributor License Agreement](.github/CLA.md), accepted by opening the pull request.

## How decisions are made

- **Direction is public.** What Iris can judge today, and what it cannot yet, is the [capability map](https://iris-eval.com/capabilities); the work ahead is organised in [three tracks](https://iris-eval.com/#roadmap): proof, coverage and reach.
- **Proposals start in the open.** An idea starts in [Discussions → Ideas](https://github.com/iris-eval/mcp-server/discussions/categories/ideas) or an issue. The maintainer decides, and the reasoning is written on the issue or pull request where the decision is made.
- **Evidence decides rule changes.** Every built-in rule has a published precision and recall, and CI re-measures them on every pull request and fails when the committed numbers differ, so a change to a rule carries its new numbers and the review reads them ([docs/proof.md](docs/proof.md)).
- **Public claims are bound to the code.** Every number Iris states in public is generated from source into [`.claims.json`](.claims.json), and contract tests hold the README, the docs and the site to what the code does.
- **Compatibility is a written policy.** What each version number promises, and what has to be true before 1.0, is in [VERSIONING.md](VERSIONING.md).

## How a change lands

- **Every change goes through a pull request**, the maintainer's included. Nothing is pushed to `main` directly, and `main` cannot be force-pushed or deleted.
- **The required checks bind everyone.** They are listed in [.github/required-checks.json](.github/required-checks.json) and enforced by a repository ruleset with no bypass list, so no pull request merges with a check red or pending, maintainers included. CI compares that file with the live repository settings on every run, so the published list is the enforced one. What each check covers is in [CONTRIBUTING.md](CONTRIBUTING.md#what-to-expect-after-you-open-a-pr).
- **Review.** A contributor's pull request needs the code owner's approval. GitHub does not let an author approve their own pull request, so the maintainer's own pull requests merge through the administrator's exception to the review rule; the required checks have no such exception. [SECURITY.md](SECURITY.md#review-posture) states this for anyone setting a threat model, with how to verify a release independently.
- **History.** Pull requests are squash-merged under a Conventional Commits title, so each commit on `main` is one reviewed change.
- **Dependencies** arrive as weekly Dependabot pull requests and go through the same checks. A new advisory of moderate severity or above fails the `security-exposure` check until it is patched or assessed in [SECURITY-EXPOSURE.md](SECURITY-EXPOSURE.md).

## Releases

- **When.** A release is cut when a body of work is complete and has passed its acceptance pass, not on a calendar ([VERSIONING.md](VERSIONING.md#release-cadence)). Every release is recorded in [CHANGELOG.md](CHANGELOG.md); a change a caller can observe is called out in a bold **Behaviour change:** sentence.
- **How.** A version-roll pull request goes through the full check set, then a `v*` tag starts the release workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)). The workflow refuses a tag whose commit is not on `main`, or whose commit did not pass `main`'s required checks. Release tags are immutable: a ruleset forbids moving or deleting them.
- **What ships, and how to verify it.**
  - npm: published by Trusted Publishing through GitHub's OIDC identity, with no long-lived token, and with npm provenance.
  - Container image (`ghcr.io/iris-eval/mcp-server`): signed with cosign keyless signing, with build-provenance and SBOM attestations on the manifest.
  - GitHub release: SPDX SBOMs for the npm package and the image, each signed with a Sigstore bundle beside it, and the MCPB bundle for Claude Desktop, built twice and compared byte for byte, then signed and attested.
  - The Official MCP Registry entry.
- **Verified from outside.** The workflow's last job reads npm, the container registry, the release page and the MCP Registry back and compares each with the tag. A release counts as made only when that job is green. Each release's notes carry the commands to verify every signature yourself.
- **Support window.** The current minor receives every fix; the previous minor receives security fixes for 90 days ([SECURITY.md](SECURITY.md#supported-versions)).

The Python client, the JavaScript SDK, the LangChain.js handler and the npm launcher version on their own; the Python client publishes to PyPI by trusted publishing from its own `py-v*` tag.

## Becoming a maintainer

Maintainers are added for sustained, high-quality work on the project: merged pull requests, careful reviews, and triage that others can rely on. A contributor who has done that work is invited by the existing maintainer, usually first as code owner of the area they know best, recorded in [.github/CODEOWNERS](.github/CODEOWNERS), and added to this page. Anyone who wants to work toward it can say so in [Discussions](https://github.com/iris-eval/mcp-server/discussions) or by email to hello@iris-eval.com.

## Changing this page

This page changes the way everything else does: by pull request, through the same checks.
