/*
 * Client detection — probes filesystem for known MCP-aware clients.
 *
 * "Detect" means: a config directory exists for this client. It does NOT
 * verify the client is currently running, nor that the user wants this
 * specific client wired. Detection feeds a candidate list; the user
 * (or --client flag) selects the actual target.
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type SupportedClient =
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'windsurf'
  | 'continue'
  | 'vscode'
  | 'cline'
  | 'zed'
  | 'codex'
  | 'gemini';

export interface ClientProfile {
  id: SupportedClient;
  displayName: string;
  configPath: string;
  /**
   * Config strategies:
   *   - dedicated-mcp-json: file is { mcpServers: {...} }. Create if missing;
   *     merge if exists. (Claude Code, Claude Desktop, Cursor, Windsurf,
   *     Cline, Gemini CLI)
   *   - embedded-in-config-json: file is a larger config with many top-level
   *     fields; add/update mcpServers without disturbing others. (Continue)
   *   - vscode-servers: file is { servers: {...} } — VS Code's native MCP
   *     schema uses "servers", not "mcpServers".
   *   - zed-context-servers: Zed settings.json embeds MCP under
   *     "context_servers" with a nested command object.
   *   - codex-toml: ~/.codex/config.toml [mcp_servers.<name>] section.
   */
  configMode:
    | 'dedicated-mcp-json'
    | 'embedded-in-config-json'
    | 'vscode-servers'
    | 'zed-context-servers'
    | 'codex-toml';
}

const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';
const home = homedir();

/** Platform-appropriate app-data root used by Electron-family apps. */
function appDataDir(): string {
  if (isWindows) return process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  if (isMac) return join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
}

/**
 * Resolve the canonical config path per client per platform.
 * NOTE: clients sometimes change config locations between releases.
 * Verify before publishing each minor release.
 */
export function configPathFor(client: SupportedClient): string {
  switch (client) {
    case 'claude-code':
      // ~/.claude/mcp.json on mac/linux; %USERPROFILE%\.claude\mcp.json on Windows
      return join(home, '.claude', 'mcp.json');
    case 'claude-desktop':
      return join(appDataDir(), 'Claude', 'claude_desktop_config.json');
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
    case 'windsurf':
      // Codeium-managed dir; mcp_config.json (note: NOT mcp.json — Windsurf-specific)
      return join(home, '.codeium', 'windsurf', 'mcp_config.json');
    case 'continue':
      return join(home, '.continue', 'config.json');
    case 'vscode':
      // User-level MCP config (VS Code native MCP support); "servers" schema.
      return join(appDataDir(), 'Code', 'User', 'mcp.json');
    case 'cline':
      // VS Code extension global storage.
      return join(
        appDataDir(),
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      );
    case 'zed':
      return isWindows
        ? join(appDataDir(), 'Zed', 'settings.json')
        : join(home, '.config', 'zed', 'settings.json');
    case 'codex':
      return join(home, '.codex', 'config.toml');
    case 'gemini':
      return join(home, '.gemini', 'settings.json');
  }
}

const PROFILES: ClientProfile[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    configPath: configPathFor('claude-code'),
    configMode: 'dedicated-mcp-json',
  },
  {
    id: 'claude-desktop',
    displayName: 'Claude Desktop',
    configPath: configPathFor('claude-desktop'),
    configMode: 'dedicated-mcp-json',
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    configPath: configPathFor('cursor'),
    configMode: 'dedicated-mcp-json',
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    configPath: configPathFor('windsurf'),
    configMode: 'dedicated-mcp-json',
  },
  {
    id: 'continue',
    displayName: 'Continue',
    configPath: configPathFor('continue'),
    configMode: 'embedded-in-config-json',
  },
  {
    id: 'vscode',
    displayName: 'VS Code',
    configPath: configPathFor('vscode'),
    configMode: 'vscode-servers',
  },
  {
    id: 'cline',
    displayName: 'Cline',
    configPath: configPathFor('cline'),
    configMode: 'dedicated-mcp-json',
  },
  {
    id: 'zed',
    displayName: 'Zed',
    configPath: configPathFor('zed'),
    configMode: 'zed-context-servers',
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    configPath: configPathFor('codex'),
    configMode: 'codex-toml',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    configPath: configPathFor('gemini'),
    configMode: 'dedicated-mcp-json',
  },
];

export function profileFor(client: SupportedClient): ClientProfile {
  const profile = PROFILES.find((p) => p.id === client);
  if (!profile) {
    throw new Error(`Unknown client: ${client}`);
  }
  return profile;
}

export function allProfiles(): ClientProfile[] {
  return [...PROFILES];
}

/**
 * Returns the subset of profiles where the client's config directory exists.
 * Detection != certainty the user wants Iris there; it's a candidate list.
 */
export function detectInstalledClients(): ClientProfile[] {
  return PROFILES.filter((profile) => {
    // Detection signal: the parent dir exists. The config file itself
    // may not yet exist (that's what we'd create); the dir's existence
    // means the client is installed.
    const parentDir = profile.configPath.replace(/[\\/][^\\/]+$/, '');
    return existsSync(parentDir);
  });
}
