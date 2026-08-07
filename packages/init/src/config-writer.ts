/*
 * Config writer — adds the Iris MCP server entry to a client's config.
 *
 * Strategies (see ClientProfile.configMode):
 *   - dedicated-mcp-json: file is { mcpServers: {...} }. Create if missing;
 *     merge if exists. Iris becomes one entry alongside whatever the user
 *     already had.
 *   - embedded-in-config-json: file is a larger config (Continue) with many
 *     top-level fields. Add or update mcpServers without disturbing other
 *     fields.
 *   - vscode-servers: file is { servers: {...} } (VS Code's native MCP
 *     schema — "servers", not "mcpServers").
 *   - zed-context-servers: Zed settings.json — MCP lives under
 *     "context_servers" with a nested { command: { path, args } } object.
 *     Zed settings allow comments; if the file fails strict JSON parsing we
 *     refuse with instructions rather than risk corrupting user settings.
 *   - codex-toml: ~/.codex/config.toml — appends an [mcp_servers.iris]
 *     section. No TOML dependency: presence is detected by section header,
 *     removal deletes the exact section we write.
 *
 * All strategies are idempotent. Re-running with the same value is a no-op.
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

/** Zed nests the executable under a command object. */
const IRIS_ZED_ENTRY = {
  command: {
    path: IRIS_ENTRY.command,
    args: IRIS_ENTRY.args,
  },
};

const CODEX_SECTION_HEADER = '[mcp_servers.iris]';
const CODEX_SECTION = `${CODEX_SECTION_HEADER}
command = "${IRIS_ENTRY.command}"
args = [${IRIS_ENTRY.args.map((a) => `"${a}"`).join(', ')}]
`;

interface ConfigShape {
  mcpServers?: Record<string, IrisServerEntry>;
  servers?: Record<string, IrisServerEntry>;
  context_servers?: Record<string, typeof IRIS_ZED_ENTRY>;
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

export interface UninstallResult {
  configPath: string;
  action: 'removed' | 'not-present';
}

function sameEntry(a: IrisServerEntry | undefined, b: IrisServerEntry): boolean {
  return (
    Boolean(a) &&
    a!.command === b.command &&
    JSON.stringify(a!.args) === JSON.stringify(b.args)
  );
}

/* ---------------- JSON-map strategies (mcpServers / servers) ---------------- */

function installJsonMap(
  profile: ClientProfile,
  key: 'mcpServers' | 'servers',
): InstallResult {
  const existing = readConfig(profile.configPath);
  const map = (existing[key] as Record<string, IrisServerEntry> | undefined) ?? {};
  const wasPresent = Boolean(map.iris);

  if (wasPresent && sameEntry(map.iris, IRIS_ENTRY)) {
    return { configPath: profile.configPath, action: 'no-change' };
  }

  const next: ConfigShape = { ...existing, [key]: { ...map, iris: IRIS_ENTRY } };
  writeConfig(profile.configPath, next);
  return {
    configPath: profile.configPath,
    action: wasPresent ? 'updated' : 'created',
  };
}

function uninstallJsonMap(
  profile: ClientProfile,
  key: 'mcpServers' | 'servers',
): UninstallResult {
  if (!existsSync(profile.configPath)) {
    return { configPath: profile.configPath, action: 'not-present' };
  }
  const existing = readConfig(profile.configPath);
  const map = (existing[key] as Record<string, IrisServerEntry> | undefined) ?? {};
  if (!map.iris) {
    return { configPath: profile.configPath, action: 'not-present' };
  }
  const { iris: _removed, ...rest } = map;
  void _removed;
  writeConfig(profile.configPath, { ...existing, [key]: rest });
  return { configPath: profile.configPath, action: 'removed' };
}

/* ---------------- Zed strategy (context_servers, nested command) ---------------- */

function installZed(profile: ClientProfile): InstallResult {
  let existing: ConfigShape;
  try {
    existing = readConfig(profile.configPath);
  } catch (err) {
    // Zed settings.json allows comments; strict JSON.parse fails on them.
    throw new Error(
      `${(err as Error).message}\nZed settings may contain comments, which this ` +
        `installer does not rewrite. Add this to ${profile.configPath} manually:\n` +
        `"context_servers": { "iris": ${JSON.stringify(IRIS_ZED_ENTRY)} }`,
    );
  }
  const map = existing.context_servers ?? {};
  const current = map.iris;
  if (
    current &&
    current.command?.path === IRIS_ZED_ENTRY.command.path &&
    JSON.stringify(current.command?.args) === JSON.stringify(IRIS_ZED_ENTRY.command.args)
  ) {
    return { configPath: profile.configPath, action: 'no-change' };
  }
  const wasPresent = Boolean(current);
  writeConfig(profile.configPath, {
    ...existing,
    context_servers: { ...map, iris: IRIS_ZED_ENTRY },
  });
  return {
    configPath: profile.configPath,
    action: wasPresent ? 'updated' : 'created',
  };
}

function uninstallZed(profile: ClientProfile): UninstallResult {
  if (!existsSync(profile.configPath)) {
    return { configPath: profile.configPath, action: 'not-present' };
  }
  const existing = readConfig(profile.configPath);
  const map = existing.context_servers ?? {};
  if (!map.iris) {
    return { configPath: profile.configPath, action: 'not-present' };
  }
  const { iris: _removed, ...rest } = map;
  void _removed;
  writeConfig(profile.configPath, { ...existing, context_servers: rest });
  return { configPath: profile.configPath, action: 'removed' };
}

/* ---------------- Codex strategy (TOML section append/remove) ---------------- */

function installCodex(profile: ClientProfile): InstallResult {
  const exists = existsSync(profile.configPath);
  const raw = exists ? readFileSync(profile.configPath, 'utf-8') : '';

  if (raw.includes(CODEX_SECTION_HEADER)) {
    // Section present. If it matches exactly what we write, no-op; otherwise
    // leave the user's customized section alone (do not clobber).
    if (raw.includes(CODEX_SECTION.trim())) {
      return { configPath: profile.configPath, action: 'no-change' };
    }
    return { configPath: profile.configPath, action: 'no-change' };
  }

  const next =
    raw.length === 0 || raw.endsWith('\n\n')
      ? raw + CODEX_SECTION
      : raw.endsWith('\n')
        ? raw + '\n' + CODEX_SECTION
        : raw + '\n\n' + CODEX_SECTION;

  mkdirSync(dirname(profile.configPath), { recursive: true });
  writeFileSync(profile.configPath, next, 'utf-8');
  return { configPath: profile.configPath, action: exists ? 'updated' : 'created' };
}

function uninstallCodex(profile: ClientProfile): UninstallResult {
  if (!existsSync(profile.configPath)) {
    return { configPath: profile.configPath, action: 'not-present' };
  }
  const raw = readFileSync(profile.configPath, 'utf-8');
  if (!raw.includes(CODEX_SECTION_HEADER)) {
    return { configPath: profile.configPath, action: 'not-present' };
  }
  // Remove from our section header up to (not including) the next section
  // header or end-of-file. Only removes the iris section.
  const start = raw.indexOf(CODEX_SECTION_HEADER);
  const afterHeader = start + CODEX_SECTION_HEADER.length;
  const nextSection = raw.indexOf('\n[', afterHeader);
  const end = nextSection === -1 ? raw.length : nextSection + 1;
  const next = (raw.slice(0, start) + raw.slice(end)).replace(/\n{3,}/g, '\n\n');
  writeFileSync(profile.configPath, next, 'utf-8');
  return { configPath: profile.configPath, action: 'removed' };
}

/* ---------------- Dispatch ---------------- */

export function installIris(profile: ClientProfile): InstallResult {
  switch (profile.configMode) {
    case 'dedicated-mcp-json':
    case 'embedded-in-config-json':
      return installJsonMap(profile, 'mcpServers');
    case 'vscode-servers':
      return installJsonMap(profile, 'servers');
    case 'zed-context-servers':
      return installZed(profile);
    case 'codex-toml':
      return installCodex(profile);
  }
}

export function uninstallIris(profile: ClientProfile): UninstallResult {
  switch (profile.configMode) {
    case 'dedicated-mcp-json':
    case 'embedded-in-config-json':
      return uninstallJsonMap(profile, 'mcpServers');
    case 'vscode-servers':
      return uninstallJsonMap(profile, 'servers');
    case 'zed-context-servers':
      return uninstallZed(profile);
    case 'codex-toml':
      return uninstallCodex(profile);
  }
}
