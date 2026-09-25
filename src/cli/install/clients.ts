/*
 * The MCP clients `iris-eval install` knows: where each one reads its server
 * list on this machine, the shape it expects there, and the launch line to
 * write.
 *
 * Every path and shape here is the one the client's own documentation (or,
 * where the documentation is silent, its own source) describes, and `docsUrl`
 * names that page. clients.json at the repository root carries the same URL
 * as each row's `source`, and tests/clients-contract.test.ts holds the two
 * equal, so a path cannot change here without the public client table being
 * re-read. Clients move their config between releases: re-read each page
 * before each minor release.
 *
 * Paths are resolved when asked, not at module load, so the environment a
 * run starts with (HOME, APPDATA, a client's own override variable) is the
 * one that counts — the end-to-end tests point every client at a scratch
 * home this way.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const IRIS_PACKAGE = '@iris-eval/mcp-server';

export const SUPPORTED_CLIENTS = [
  'claude-code',
  'claude-desktop',
  'cursor',
  'windsurf',
  'continue',
  'vscode',
  'cline',
  'zed',
  'codex',
  'gemini',
] as const;

export type SupportedClient = (typeof SUPPORTED_CLIENTS)[number];

export type ConfigMode =
  | 'dedicated-mcp-json'
  | 'embedded-in-config-json'
  | 'vscode-servers'
  | 'zed-context-servers'
  | 'codex-toml';

/**
 * How a client starts `npx` on native Windows. `npx` is a batch file there
 * (npx.cmd), which a plain process spawn cannot run; a client either resolves
 * it itself (every client below does, per its docs or source) or documents a
 * `cmd /c` wrapper, which `cmd-c` writes.
 */
export type WindowsLaunch = 'npx' | 'cmd-c';

export interface ClientProfile {
  id: SupportedClient;
  displayName: string;
  /** The file `install` writes, resolved for this machine and environment. */
  configPath: string;
  /**
   * Config strategies:
   *   - dedicated-mcp-json: file is { mcpServers: {...} }. Create if missing;
   *     merge if it exists.
   *   - embedded-in-config-json: file is a larger config with many top-level
   *     fields; add/update mcpServers without disturbing the others.
   *   - vscode-servers: file is { servers: {...} } — VS Code's native MCP
   *     schema uses "servers", not "mcpServers".
   *   - zed-context-servers: Zed settings.json embeds MCP under
   *     "context_servers".
   *   - codex-toml: config.toml, an [mcp_servers.<name>] table.
   */
  configMode: ConfigMode;
  /** The client's documentation for the path, the shape and the launch form. Equal to clients.json `source`. */
  docsUrl: string;
  /** How the client launches npx on native Windows, per `docsUrl` (see WindowsLaunch). */
  windowsLaunch: WindowsLaunch;
  /** Paths whose existence means the client is present on this machine. */
  detectPaths: string[];
  /** One sentence printed after an install, when the client needs a step of its own before it connects. */
  note?: string;
  /** A `type` the client's docs mark required on a stdio entry. */
  entryType?: 'stdio';
}

export interface Environment {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function currentEnvironment(): Environment {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** Platform application-data root: %APPDATA%, ~/Library/Application Support, or $XDG_CONFIG_HOME / ~/.config. */
function appDataDir({ platform, home, env }: Environment): string {
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  return xdgConfigHome({ platform, home, env });
}

function xdgConfigHome({ home, env }: Environment): string {
  return env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
}

/** An override variable a client documents for its own directory; relative values resolve against the working directory, as the clients do. */
function dirFromEnv(value: string | undefined): string | undefined {
  return value ? resolve(value) : undefined;
}

interface Definition {
  displayName: string;
  configMode: ConfigMode;
  docsUrl: string;
  windowsLaunch: WindowsLaunch;
  configPath: (e: Environment) => string;
  /** Defaults to the config file's directory. */
  detectPaths?: (e: Environment) => string[];
  note?: string;
  entryType?: 'stdio';
}

const DEFINITIONS: Record<SupportedClient, Definition> = {
  'claude-code': {
    displayName: 'Claude Code',
    /*
     * ~/.claude.json — the FILE, not the ~/.claude/ directory — holds
     * user-scope servers under mcpServers, next to projects, history and
     * preferences Claude Code owns; so this mode adds to it and never owns
     * it. An earlier version wrote ~/.claude/mcp.json, a path Claude Code
     * never reads: the install printed success and the user restarted to
     * find nothing. User scope is the right default for a general-purpose
     * eval server; project scope would tie it to whatever directory the
     * command ran in. CLAUDE_CONFIG_DIR, when set, is where Claude Code
     * keeps this file instead of the home directory.
     *
     * Windows: the docs no longer ask for a `cmd /c` wrapper, and Claude
     * Code 2.1.x connects to a bare `npx` entry on Windows (checked with
     * `claude mcp list`, which reports "Connected").
     */
    configMode: 'embedded-in-config-json',
    docsUrl: 'https://code.claude.com/docs/en/mcp',
    windowsLaunch: 'npx',
    configPath: (e) => join(dirFromEnv(e.env.CLAUDE_CONFIG_DIR) ?? e.home, '.claude.json'),
    detectPaths: (e) => {
      const dir = dirFromEnv(e.env.CLAUDE_CONFIG_DIR);
      return dir ? [join(dir, '.claude.json')] : [join(e.home, '.claude.json'), join(e.home, '.claude')];
    },
  },
  'claude-desktop': {
    displayName: 'Claude Desktop',
    // The docs' Windows example is `"command": "npx"` with no wrapper.
    configMode: 'dedicated-mcp-json',
    docsUrl: 'https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers',
    windowsLaunch: 'npx',
    configPath: (e) => join(appDataDir(e), 'Claude', 'claude_desktop_config.json'),
  },
  cursor: {
    displayName: 'Cursor',
    configMode: 'dedicated-mcp-json',
    docsUrl: 'https://cursor.com/docs/mcp',
    windowsLaunch: 'npx',
    configPath: (e) => join(e.home, '.cursor', 'mcp.json'),
    // The docs' field table marks `type` required for a stdio server.
    entryType: 'stdio',
  },
  windsurf: {
    /*
     * Windsurf became Devin Desktop on 2026-06-02. Its MCP page now names
     * ~/.config/devin/mcp_config.json ($XDG_CONFIG_HOME/devin when set) and
     * %APPDATA%\devin\mcp_config.json on Windows, and the Devin CLI
     * configuration page — which the default Devin Local agent reads — names
     * the same file. The old ~/.codeium/windsurf/mcp_config.json is no longer
     * documented. The id stays `windsurf` so the command a Windsurf user
     * types still works; `devin` is accepted too.
     */
    displayName: 'Devin Desktop (Windsurf)',
    configMode: 'dedicated-mcp-json',
    docsUrl: 'https://docs.devin.ai/desktop/cascade/mcp',
    windowsLaunch: 'npx',
    configPath: (e) =>
      e.platform === 'win32'
        ? join(appDataDir(e), 'devin', 'mcp_config.json')
        : join(xdgConfigHome(e), 'devin', 'mcp_config.json'),
    detectPaths: (e) => [
      // The MCP config directory, the IDE's own data directory, and a
      // Windsurf install from before the rename.
      e.platform === 'win32' ? join(appDataDir(e), 'devin') : join(xdgConfigHome(e), 'devin'),
      join(appDataDir(e), 'Devin'),
      join(e.home, '.codeium', 'windsurf'),
    ],
  },
  continue: {
    /*
     * A file of Iris's own in Continue's global mcpServers folder. Continue
     * reads every *.json there in the Claude Desktop format ({ mcpServers })
     * and wraps npx in cmd.exe itself on Windows. The old target,
     * ~/.continue/config.json, is deprecated and never read a top-level
     * mcpServers block. CONTINUE_GLOBAL_DIR, when set, replaces ~/.continue.
     */
    displayName: 'Continue',
    configMode: 'dedicated-mcp-json',
    docsUrl: 'https://docs.continue.dev/customize/deep-dives/mcp',
    windowsLaunch: 'npx',
    configPath: (e) => join(dirFromEnv(e.env.CONTINUE_GLOBAL_DIR) ?? join(e.home, '.continue'), 'mcpServers', 'iris-eval.json'),
    detectPaths: (e) => [dirFromEnv(e.env.CONTINUE_GLOBAL_DIR) ?? join(e.home, '.continue')],
  },
  vscode: {
    // The user-profile mcp.json ("MCP: Open User Configuration"), a "servers" block.
    displayName: 'VS Code',
    configMode: 'vscode-servers',
    docsUrl: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers',
    windowsLaunch: 'npx',
    configPath: (e) => join(appDataDir(e), 'Code', 'User', 'mcp.json'),
  },
  cline: {
    /*
     * ~/.cline/data/settings/cline_mcp_settings.json, shared by Cline's VS
     * Code extension, CLI and JetBrains plugin. CLINE_DATA_DIR replaces
     * ~/.cline/data, and CLINE_DIR replaces ~/.cline. The file used to live
     * in VS Code's extension storage; Cline no longer reads it there.
     */
    displayName: 'Cline',
    configMode: 'dedicated-mcp-json',
    docsUrl: 'https://docs.cline.bot/getting-started/config',
    windowsLaunch: 'npx',
    configPath: (e) => join(clineDataDir(e), 'settings', 'cline_mcp_settings.json'),
    detectPaths: (e) => [dirFromEnv(e.env.CLINE_DIR) ?? join(e.home, '.cline')],
  },
  zed: {
    displayName: 'Zed',
    configMode: 'zed-context-servers',
    docsUrl: 'https://zed.dev/docs/ai/mcp',
    windowsLaunch: 'npx',
    configPath: (e) => (e.platform === 'win32' ? join(appDataDir(e), 'Zed', 'settings.json') : join(e.home, '.config', 'zed', 'settings.json')),
  },
  codex: {
    // Codex resolves npx.cmd itself on Windows (PATHEXT lookup before spawn). CODEX_HOME replaces ~/.codex.
    displayName: 'OpenAI Codex CLI',
    configMode: 'codex-toml',
    docsUrl: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
    windowsLaunch: 'npx',
    configPath: (e) => join(dirFromEnv(e.env.CODEX_HOME) ?? join(e.home, '.codex'), 'config.toml'),
  },
  gemini: {
    // GEMINI_CLI_HOME, when set, replaces the home directory Gemini CLI looks under.
    displayName: 'Gemini CLI',
    configMode: 'dedicated-mcp-json',
    docsUrl: 'https://geminicli.com/docs/tools/mcp-server/',
    windowsLaunch: 'npx',
    configPath: (e) => join(dirFromEnv(e.env.GEMINI_CLI_HOME) ?? e.home, '.gemini', 'settings.json'),
    // Seen with Gemini CLI 0.61: in a folder it does not trust, `gemini mcp list` shows the server as Disabled.
    note: 'Gemini CLI connects to MCP servers only in folders it trusts: if `gemini mcp list` shows iris-eval as Disabled, run /permissions in that folder (https://geminicli.com/docs/cli/trusted-folders/).',
  },
};

function clineDataDir(e: Environment): string {
  const data = dirFromEnv(e.env.CLINE_DATA_DIR);
  if (data) return data;
  return join(dirFromEnv(e.env.CLINE_DIR) ?? join(e.home, '.cline'), 'data');
}

/** Names a user may type for a client besides its id. */
export const CLIENT_ALIASES: Readonly<Record<string, SupportedClient>> = {
  devin: 'windsurf',
  'devin-desktop': 'windsurf',
};

export function resolveClientName(name: string): SupportedClient | undefined {
  const lower = name.toLowerCase();
  if ((SUPPORTED_CLIENTS as readonly string[]).includes(lower)) return lower as SupportedClient;
  return CLIENT_ALIASES[lower];
}

export function profileFor(client: SupportedClient, e: Environment = currentEnvironment()): ClientProfile {
  const d = DEFINITIONS[client];
  if (!d) throw new Error(`Unknown client: ${client}`);
  const configPath = d.configPath(e);
  return {
    id: client,
    displayName: d.displayName,
    configPath,
    configMode: d.configMode,
    docsUrl: d.docsUrl,
    windowsLaunch: d.windowsLaunch,
    detectPaths: d.detectPaths ? d.detectPaths(e) : [dirname(configPath)],
    ...(d.note ? { note: d.note } : {}),
    ...(d.entryType ? { entryType: d.entryType } : {}),
  };
}

export function allProfiles(e: Environment = currentEnvironment()): ClientProfile[] {
  return SUPPORTED_CLIENTS.map((id) => profileFor(id, e));
}

export function configPathFor(client: SupportedClient, e: Environment = currentEnvironment()): string {
  return profileFor(client, e).configPath;
}

/**
 * The profiles whose client is present on this machine. Detection is a
 * candidate list — a config directory exists — not proof the client is
 * running or that the user wants Iris there.
 */
export function detectInstalledClients(e: Environment = currentEnvironment()): ClientProfile[] {
  return allProfiles(e).filter((p) => p.detectPaths.some((path) => existsSync(path)));
}

export interface LaunchCommand {
  command: string;
  args: string[];
}

/**
 * The command a client runs to start Iris: `npx -y @iris-eval/mcp-server@<version>`,
 * pinned to the version doing the install, wrapped in `cmd /c` on Windows
 * only for a client whose docs require it.
 */
export function launchCommand(profile: ClientProfile, version: string, platform: NodeJS.Platform = process.platform): LaunchCommand {
  const npxArgs = ['-y', `${IRIS_PACKAGE}@${version}`];
  if (platform === 'win32' && profile.windowsLaunch === 'cmd-c') {
    return { command: 'cmd', args: ['/c', 'npx', ...npxArgs] };
  }
  return { command: 'npx', args: npxArgs };
}
