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

export type SupportedClient = 'claude-code' | 'cursor' | 'windsurf' | 'continue';

export interface ClientProfile {
  id: SupportedClient;
  displayName: string;
  configPath: string;
  /**
   * Some clients use a top-level mcpServers field on a shared config.json
   * (Continue); others have a dedicated mcp.json. This flag tells the
   * config writer which strategy to use.
   */
  configMode: 'dedicated-mcp-json' | 'embedded-in-config-json';
}

const isWindows = platform() === 'win32';
const home = homedir();

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
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
    case 'windsurf':
      // Codeium-managed dir; mcp_config.json (note: NOT mcp.json — Windsurf-specific)
      return isWindows
        ? join(home, '.codeium', 'windsurf', 'mcp_config.json')
        : join(home, '.codeium', 'windsurf', 'mcp_config.json');
    case 'continue':
      return join(home, '.continue', 'config.json');
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
    // Detection signal: the parent dir exists. The mcp.json file itself
    // may not yet exist (that's what we'd create); the dir's existence
    // means the client is installed.
    const parentDir = profile.configPath.replace(/[\\/][^\\/]+$/, '');
    return existsSync(parentDir);
  });
}
