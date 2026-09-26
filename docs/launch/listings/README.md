# Directory listings — paste-ready copy, one file per directory

Each `<directory>.md` here is **rendered** from `<directory>.template.md` and `.claims.json` by `npm run llms:render`, and `npm run llms:check` fails CI when a rendered file and its template disagree. The template carries the prose; every number is a slot; nothing here is typed from memory. Edit the template, never the rendered file.

The **send is the listing owner's act** — a sign-in, a form, a PR from the organisation's fork. This directory exists so that act is a paste, not a rewrite, and so the copy pasted is the copy the truthbase holds on the day it is pasted.

| Directory | File | How it refreshes |
|---|---|---|
| Glama | `glama.md` | Build & Release (runs the server, reads `tools/list`), then Sync Server |
| mcp.so | `mcp-so.md` | ingests the Official MCP Registry; hand edit only as the claimed owner |
| PulseMCP | `pulsemcp.md` | ingests the Official MCP Registry; re-check before editing |
| Smithery | `smithery.md` | MCPB bundle: each release attaches `iris-eval.mcpb`, and the listing owner uploads it with `smithery mcp publish` (the steps are in the copy); the old `smithery.yaml` stdio form is retired and the copy says why |
| cursor.directory | `cursor-directory.md` | sign-in edit; the slug `iris` should become `iris-eval` |
| awesome-mcp-servers | `awesome-mcp-servers.md` | a one-line PR from the organisation's fork; mcpservers.org mirrors it; the line carries no numbers |
| Docker MCP Catalog | `docker.md` + `docker/server.yaml` | a pull request to `docker/mcp-registry` with the file beside the copy; Docker reviews; `source.commit` moves by a small PR after each release |

The general blocks (one-liner, short and long descriptions, tags, the awesome-list row) live one level up in `docs/launch/directory-listing-template.md`, rendered the same way.
