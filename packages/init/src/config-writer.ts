/*
 * Config writer — adds the Iris MCP server entry to a client's config.
 *
 * Two strategies depending on configMode:
 *   - dedicated-mcp-json: file is { mcpServers: {...} }. Create if missing;
 *     merge if exists. Iris becomes one entry alongside whatever the user
 *     already had.
 *   - embedded-in-config-json: file is a larger config (Continue) with many
 *     top-level fields. Add or update mcpServers without disturbing other
 *     fields.
 *
 * Both strategies are idempotent. Re-running with the same value is a no-op.
 * Re-running with --uninstall removes only the iris entry; other servers stay.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClientProfile } from './detect.js';

interface IrisServerEntry {
  command: string;
  args: string[];
}

const IRIS_ENTRY: IrisServerEntry = {
  command: 'npx',
  args: ['-y', '@iris-eval/mcp-server'],
};

interface ConfigShape {
  mcpServers?: Record<string, IrisServerEntry>;
  [key: string]: unknown;
}

function readConfig(path: string): ConfigShape {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as ConfigShape;
  } catch (err) {
    throw new Error(
      `Failed to parse existing config at ${path}: ${(err as Error).message}. ` +
        `Fix the JSON syntax and retry, or delete the file to start fresh.`,
    );
  }
}

function writeConfig(path: string, config: ConfigShape): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export interface InstallResult {
  configPath: string;
  action: 'created' | 'updated' | 'no-change';
}

export function installIris(profile: ClientProfile): InstallResult {
  const existing = readConfig(profile.configPath);
  const mcpServers = existing.mcpServers ?? {};
  const wasPresent = Boolean(mcpServers.iris);

  // Idempotency check: if iris is already present with the exact same
  // command + args, nothing to do.
  if (wasPresent) {
    const current = mcpServers.iris;
    if (
      current.command === IRIS_ENTRY.command &&
      JSON.stringify(current.args) === JSON.stringify(IRIS_ENTRY.args)
    ) {
      return { configPath: profile.configPath, action: 'no-change' };
    }
  }

  const next: ConfigShape = {
    ...existing,
    mcpServers: { ...mcpServers, iris: IRIS_ENTRY },
  };

  writeConfig(profile.configPath, next);
  return {
    configPath: profile.configPath,
    action: existsSync(profile.configPath) && wasPresent ? 'updated' : 'created',
  };
}

export interface UninstallResult {
  configPath: string;
  action: 'removed' | 'not-present';
}

export function uninstallIris(profile: ClientProfile): UninstallResult {
  if (!existsSync(profile.configPath)) {
    return { configPath: profile.configPath, action: 'not-present' };
  }

  const existing = readConfig(profile.configPath);
  const mcpServers = existing.mcpServers ?? {};

  if (!mcpServers.iris) {
    return { configPath: profile.configPath, action: 'not-present' };
  }

  const { iris: _removed, ...rest } = mcpServers;
  void _removed;
  const next: ConfigShape = { ...existing, mcpServers: rest };
  writeConfig(profile.configPath, next);

  return { configPath: profile.configPath, action: 'removed' };
}
