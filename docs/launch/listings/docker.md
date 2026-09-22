# Docker MCP Catalog — the submission
> **Rendered from `.claims.json` by `npm run llms:render`; `llms:check` fails if this file and its template disagree.** Edit `docs/launch/listings/docker.template.md`, never this file. Every number is a slot. Never write "first", "best", "leading" or "standard"; never say Iris captures or scores anything "automatically" — under MCP a tool call is the model's decision. The paste is the listing owner's act.

**Listing:** not yet listed. The Docker MCP Catalog (Docker Desktop's MCP Toolkit) takes a pull request to `docker/mcp-registry` adding `servers/iris-eval/server.yaml`; Docker's review lands it in the catalog within a day of approval. The file is beside this one: [`docker/server.yaml`](docker/server.yaml). The image is the one this repository already publishes, `ghcr.io/iris-eval/mcp-server` (the README's Docker badge), so the entry is the "external image" kind — no Docker-built image, no Dockerfile path — and `source.commit` is the release commit, filled at submission from the tag: `git rev-list -n 1 v0.16.0`.

## The check before you save

- `about.description` is the tagline: Stop shipping agents on vibes.
- `config.secrets` names only variables the server reads — `IRIS_API_KEY`, `IRIS_ANTHROPIC_API_KEY`, `IRIS_OPENAI_API_KEY` — the same names `server.json` lists, and the test `tests/listings-hygiene.test.ts` holds them to it.
- The dashboard is off in the catalog entry: a stdio container has no port to reach it on; the entry says so in `config.description`.
- Nothing in the file says "first", "automatically" or a number that is not a slot.

## The steps (the listing owner's act)

1. Fork `docker/mcp-registry`, copy `docker/server.yaml` to `servers/iris-eval/server.yaml`, set `source.commit`.
2. `task validate` in the fork (the registry's own check), then `task build` and a run through Docker Desktop's MCP Toolkit.
3. Open the pull request; Docker reviews; after approval the entry appears in the catalog.

## Links

- The registry: https://github.com/docker/mcp-registry — the contributing guide names the two submission kinds and the review.
- The image: https://github.com/iris-eval/mcp-server/pkgs/container/mcp-server
