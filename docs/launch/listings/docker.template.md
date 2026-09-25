# Docker MCP Catalog — the submission
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/docker.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision. The paste is the listing owner's act.

**Listing:** submitted as [docker/mcp-registry#2016](https://github.com/docker/mcp-registry/pull/2016), adding `servers/iris-eval/server.yaml`. Docker's CI runs once a maintainer approves workflows from the fork; the same checks (`scripts/ci-validation.sh`: validate, build with tool listing, catalog generation) pass locally against the published image. After Docker approves and merges, the entry appears in Docker Desktop's MCP Toolkit. The file is beside this one: [`docker/server.yaml`](docker/server.yaml). It is the "external image" kind: the image is the one this repository publishes, `ghcr.io/iris-eval/mcp-server`, so there is no Docker-built image and no Dockerfile path.

## What the entry sets, and why

| Field | Value | Why |
|---|---|---|
| `config.env` `IRIS_TRANSPORT` | `stdio` | the image starts the HTTP transport by default; the Toolkit talks to a container over stdio |
| `config.env` `IRIS_DASHBOARD` | `false` | a stdio container publishes no port, so the dashboard would be unreachable |
| `run.volumes` | `iris-eval-data:/data` | traces and verdicts survive a container restart |
| `source.commit` | the release commit, `git rev-list -n 1 v{{version}}` at submission | Docker audits the source at that commit |
| `meta.category` / `tags` | `monitoring`; the repository's GitHub topics | what `task create` generates from the repository |
| `about.icon` | the site logo | passes the registry's icon check |
| secrets | none | see below |

Both variables go in `config.env` with a `value` and an `example`. `run.env` does not work here: the registry's test harness passes an unset value as the literal string `%!s(<nil>)`, which Iris rejects as a boolean.

**Why no secrets.** The optional LLM judge reads `IRIS_ANTHROPIC_API_KEY` or `IRIS_OPENAI_API_KEY`, and the registry schema can mark a secret `required: false`. Docker's open-source gateway does not read that flag. Its profile and add paths refuse a server until every declared secret has a value, and its run path passes the literal `<UNKNOWN>` for a missing one (which Iris would take as a real key). Declaring the keys would break the zero-setting start for every user to serve the judge for some. `IRIS_API_KEY` is not needed at all over stdio. A user who wants the judge runs the image with `docker run -e`, or Iris from npm, where the keys are ordinary environment variables.

## The check before you save

- `about.description` opens with the tagline: {{tagline}}.
- `IRIS_TRANSPORT` is `stdio` and `IRIS_DASHBOARD` is `false`; every variable named is one `server.json` lists. `tests/listings-hygiene.test.ts` holds both.
- No version, tool count or rule count in the description: Docker's copy changes only through a merged PR.
- Nothing says "first", "automatically" or "best".

## After each release

Docker's pin bot moves only images in its own `mcp/` namespace, so `source.commit` stays on the release it was submitted with. After each release, a one-line PR to `docker/mcp-registry` moves it to the new release commit, so the audited source matches the image `latest` serves.

## Links

- The registry: https://github.com/docker/mcp-registry
- The image: https://github.com/iris-eval/mcp-server/pkgs/container/mcp-server
