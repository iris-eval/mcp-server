# @iris-eval/init

**Universal installer for Iris** — detects your MCP client and writes the right config in one command.

[Iris](https://iris-eval.com) scores every agent output for quality, safety, and cost — so you stop shipping agents on vibes. This package gets it into your client without you hunting for the right config path or syntax.

## Install + use (one shot)

```bash
npx @iris-eval/init claude-code      # install for Claude Code
npx @iris-eval/init cursor           # install for Cursor
npx @iris-eval/init windsurf         # install for Windsurf
npx @iris-eval/init zed              # install for Zed
```

After install, **restart your client**. The next agent call gets scored by Iris.

## Other commands

```bash
npx @iris-eval/init --list                       # show detected MCP clients on this machine
npx @iris-eval/init --help                       # full help
npx @iris-eval/init <client> --uninstall         # remove the iris entry from <client>
```

## Supported clients (all ten)

`claude-code` · `claude-desktop` · `cursor` · `windsurf` · `continue` · `vscode` · `cline` · `zed` · `codex` · `gemini`

Each client gets its config written to the correct OS-specific path (e.g. Claude Code → `~/.claude.json`, merged under the top-level `mcpServers` key, Windsurf → `~/.codeium/windsurf/mcp_config.json`, Zed → `settings.json` `context_servers`), preserving every entry you already have. Run `npx @iris-eval/init --list` to see which clients are detected on your machine.

A future release adds MCP-spec-driven auto-detection for unrecognized clients.

For per-client install docs, friction notes, and troubleshooting, see [Hook up your own agent](https://github.com/iris-eval/mcp-server#hook-up-your-own-agent).

## What it does

For each client, the installer:

1. Computes the correct config path for your OS.
2. Reads the existing config (if any).
3. Adds an `iris` entry under `mcpServers` without touching any other entries.
4. Writes the file back, preserving formatting where possible.

The operation is **idempotent** — re-running with the same client is a no-op if Iris is already configured.

## What it doesn't do

- Doesn't restart your client (you do).
- Doesn't install Iris's MCP server itself — that's `npx @iris-eval/mcp-server` (or `npm install -g @iris-eval/mcp-server` if you prefer).
- Doesn't change `mcpServers` entries you've added for other tools.
- Doesn't write outside your home directory.

## Programmatic use

```ts
import { detectInstalledClients, installIris, profileFor } from '@iris-eval/init';

// Find all detected clients on this machine
const detected = detectInstalledClients();

// Install Iris for a specific client
const profile = profileFor('cursor');
const result = installIris(profile);
console.log(result.action); // 'created' | 'updated' | 'no-change'
```

## License

MIT.
