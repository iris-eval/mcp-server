/*
 * The config writer behind `iris-eval install`, strategy by strategy: what a
 * fresh install writes, what a re-install keeps, what an uninstall leaves,
 * and the legacy `iris` key folded away — against real files in a scratch
 * directory, never a user's config.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIris, uninstallIris } from '../../../src/cli/install/config-writer.js';
import { type ClientProfile, type ConfigMode, type LaunchCommand } from '../../../src/cli/install/clients.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-install-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const V1: LaunchCommand = { command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.18.0'] };
const V2: LaunchCommand = { command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.19.0'] };
const V1_ENTRY = { command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.18.0'] };
const UNPINNED = { command: 'npx', args: ['-y', '@iris-eval/mcp-server'] };

function makeProfile(mode: ConfigMode = 'dedicated-mcp-json', filename = 'mcp.json'): ClientProfile {
  return {
    id: 'cursor',
    displayName: 'Test Client',
    configPath: join(tmpDir, filename),
    configMode: mode,
    docsUrl: 'https://example.com',
    windowsLaunch: 'npx',
    detectPaths: [tmpDir],
  };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8'));

describe('installIris — mcpServers files', () => {
  it('creates the file with the pinned iris-eval entry when none exists', () => {
    const profile = makeProfile();
    const result = installIris(profile, V1);
    expect(result.action).toBe('created');
    expect(readJson(result.configPath)).toEqual({ mcpServers: { 'iris-eval': V1_ENTRY } });
  });

  it('creates missing parent directories', () => {
    const profile = { ...makeProfile(), configPath: join(tmpDir, 'a', 'b', 'mcp.json') };
    expect(installIris(profile, V1).action).toBe('created');
    expect(existsSync(profile.configPath)).toBe(true);
  });

  it('treats an empty file as no config', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, '  \n', 'utf-8');
    expect(installIris(profile, V1).action).toBe('created');
    expect(readJson(profile.configPath).mcpServers['iris-eval']).toEqual(V1_ENTRY);
  });

  it('preserves existing mcpServers entries', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { other: { command: 'echo', args: ['hi'] } } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('created');
    const written = readJson(profile.configPath);
    expect(written.mcpServers.other).toEqual({ command: 'echo', args: ['hi'] });
    expect(written.mcpServers['iris-eval']).toEqual(V1_ENTRY);
  });

  it('preserves every other top-level field of a larger config (~/.claude.json style)', () => {
    const profile = makeProfile('embedded-in-config-json', '.claude.json');
    const original = { numStartups: 12, projects: { '/x': { allowedTools: [], mcpServers: {} } }, userID: 'abc', mcpServers: { other: { type: 'stdio', command: 'echo', args: [], env: {} } } };
    writeFileSync(profile.configPath, JSON.stringify(original, null, 2), 'utf-8');
    installIris(profile, V1);
    const written = readJson(profile.configPath);
    expect(written).toEqual({ ...original, mcpServers: { ...original.mcpServers, 'iris-eval': V1_ENTRY } });
  });

  it('is idempotent — a second install at the same version is no-change and does not touch the file', () => {
    const profile = makeProfile();
    installIris(profile, V1);
    const before = readFileSync(profile.configPath, 'utf-8');
    const mtime = statSync(profile.configPath).mtimeMs;
    expect(installIris(profile, V1).action).toBe('no-change');
    expect(readFileSync(profile.configPath, 'utf-8')).toBe(before);
    expect(statSync(profile.configPath).mtimeMs).toBe(mtime);
  });

  it('re-installing from a newer version moves the pin (the upgrade path)', () => {
    const profile = makeProfile();
    installIris(profile, V1);
    expect(installIris(profile, V2).action).toBe('updated');
    expect(readJson(profile.configPath).mcpServers['iris-eval'].args).toEqual(['-y', '@iris-eval/mcp-server@0.19.0']);
  });

  it('pins an unpinned entry written by hand or by an earlier installer', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { 'iris-eval': UNPINNED } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    expect(readJson(profile.configPath).mcpServers['iris-eval']).toEqual(V1_ENTRY);
  });

  it('keeps what the user added to the entry: env, extra keys, arguments after the package', () => {
    const profile = makeProfile();
    const custom = { command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.17.0', '--dashboard'], env: { IRIS_LOG_LEVEL: 'debug' }, disabled: false };
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { 'iris-eval': custom } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    expect(readJson(profile.configPath).mcpServers['iris-eval']).toEqual({ ...custom, args: ['-y', '@iris-eval/mcp-server@0.18.0', '--dashboard'] });
    expect(installIris(profile, V1).action).toBe('no-change');
  });

  it('writes `type` for a client whose docs require it, adds it to an older entry, and keeps a type the user set', () => {
    const profile = { ...makeProfile(), entryType: 'stdio' as const };
    installIris(profile, V1);
    expect(readJson(profile.configPath).mcpServers['iris-eval']).toEqual({ type: 'stdio', ...V1_ENTRY });
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { 'iris-eval': UNPINNED } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    expect(readJson(profile.configPath).mcpServers['iris-eval']).toEqual({ type: 'stdio', ...V1_ENTRY });
    expect(installIris(profile, V1).action).toBe('no-change');
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { 'iris-eval': { type: 'custom', ...UNPINNED } } }), 'utf-8');
    installIris(profile, V1);
    expect(readJson(profile.configPath).mcpServers['iris-eval'].type).toBe('custom');
  });

  it('throws a clear error, and leaves the file alone, when the existing file is malformed', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, '{ this is not json', 'utf-8');
    expect(() => installIris(profile, V1)).toThrow(/Failed to parse existing config.*not changed/);
    expect(readFileSync(profile.configPath, 'utf-8')).toBe('{ this is not json');
  });

  it('refuses a file whose top level is not an object, or whose server map is not an object', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, '[1, 2]', 'utf-8');
    expect(() => installIris(profile, V1)).toThrow(/not a JSON object/);
    writeFileSync(profile.configPath, '{"mcpServers": []}', 'utf-8');
    expect(() => installIris(profile, V1)).toThrow(/"mcpServers" .* is not an object/);
    expect(readFileSync(profile.configPath, 'utf-8')).toBe('{"mcpServers": []}');
  });
});

describe('file handling', () => {
  it('keeps comments, key order, indentation and CRLF line endings in a JSONC file', () => {
    const profile = makeProfile('dedicated-mcp-json', 'settings.json');
    const original = '// my settings\r\n{\r\n    "theme": "dark", // keep\r\n    "mcpServers": {\r\n        "other": { "command": "echo" },\r\n    },\r\n}\r\n';
    writeFileSync(profile.configPath, original, 'utf-8');
    installIris(profile, V1);
    const text = readFileSync(profile.configPath, 'utf-8');
    expect(text.startsWith('// my settings\r\n{\r\n    "theme": "dark", // keep\r\n')).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toContain('\r\n        "iris-eval": {\r\n            "command": "npx",');
    uninstallIris(profile);
    expect(readFileSync(profile.configPath, 'utf-8')).toBe(original);
  });

  it('keeps a byte-order mark', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, '\ufeff{"mcpServers": {}}', 'utf-8');
    installIris(profile, V1);
    const text = readFileSync(profile.configPath, 'utf-8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(JSON.parse(text.slice(1)).mcpServers['iris-eval']).toEqual(V1_ENTRY);
  });

  // Both tests run on every platform so the suite's counts are the same
  // everywhere; where Windows has no equivalent, the assertion branches.
  it('keeps the file mode of an existing config', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, '{}', 'utf-8');
    chmodSync(profile.configPath, 0o640);
    // Windows keeps only the read-only bit, so 0o640 reads back as 0o666 there.
    const before = statSync(profile.configPath).mode & 0o777;
    expect(before).toBe(process.platform === 'win32' ? 0o666 : 0o640);
    installIris(profile, V1);
    expect(statSync(profile.configPath).mode & 0o777).toBe(before);
  });

  it('writes through a symlinked config instead of replacing the link', () => {
    const real = join(tmpDir, 'dotfiles', 'mcp.json');
    mkdirSync(join(tmpDir, 'dotfiles'));
    writeFileSync(real, '{}', 'utf-8');
    const profile = makeProfile();
    let linked = true;
    try {
      symlinkSync(real, profile.configPath);
    } catch (err) {
      // Windows creates file symlinks only with Developer Mode or elevation;
      // without them no user can have a linked config to preserve.
      expect(process.platform).toBe('win32');
      expect((err as NodeJS.ErrnoException).code).toBe('EPERM');
      linked = false;
    }
    installIris(profile, V1);
    if (linked) {
      expect(lstatSync(profile.configPath).isSymbolicLink()).toBe(true);
      expect(readJson(real).mcpServers['iris-eval']).toEqual(V1_ENTRY);
    } else {
      expect(readJson(profile.configPath).mcpServers['iris-eval']).toEqual(V1_ENTRY);
      expect(readJson(real)).toEqual({});
    }
  });
});

describe('uninstallIris — mcpServers files', () => {
  it('returns not-present when the config does not exist', () => {
    expect(uninstallIris(makeProfile()).action).toBe('not-present');
  });

  it('removes the iris entry but leaves other servers intact', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { 'iris-eval': V1_ENTRY, other: { command: 'echo', args: ['hi'] } } }), 'utf-8');
    expect(uninstallIris(profile).action).toBe('removed');
    expect(readJson(profile.configPath).mcpServers).toEqual({ other: { command: 'echo', args: ['hi'] } });
  });

  it('returns not-present, without writing, when iris is not in mcpServers', () => {
    const profile = makeProfile();
    const original = JSON.stringify({ mcpServers: { other: { command: 'echo', args: ['hi'] } } });
    writeFileSync(profile.configPath, original, 'utf-8');
    expect(uninstallIris(profile).action).toBe('not-present');
    expect(readFileSync(profile.configPath, 'utf-8')).toBe(original);
  });

  it('install then uninstall returns a pretty-printed file to its original bytes', () => {
    const profile = makeProfile();
    const original = JSON.stringify({ a: 1, mcpServers: { other: { command: 'echo', args: [] } }, z: [1, 2] }, null, 2) + '\n';
    writeFileSync(profile.configPath, original, 'utf-8');
    installIris(profile, V1);
    uninstallIris(profile);
    expect(readFileSync(profile.configPath, 'utf-8')).toBe(original);
  });
});

describe('vscode-servers strategy', () => {
  it('writes under "servers", not "mcpServers"', () => {
    const result = installIris(makeProfile('vscode-servers'), V1);
    expect(result.action).toBe('created');
    const written = readJson(result.configPath);
    expect(written.servers['iris-eval']).toEqual(V1_ENTRY);
    expect(written.mcpServers).toBeUndefined();
  });

  it('is idempotent and uninstalls only the iris entry', () => {
    const profile = makeProfile('vscode-servers');
    installIris(profile, V1);
    expect(installIris(profile, V1).action).toBe('no-change');
    writeFileSync(profile.configPath, JSON.stringify({ servers: { 'iris-eval': V1_ENTRY, other: { command: 'echo', args: [] } }, inputs: [] }), 'utf-8');
    expect(uninstallIris(profile).action).toBe('removed');
    expect(readJson(profile.configPath)).toEqual({ servers: { other: { command: 'echo', args: [] } }, inputs: [] });
  });
});

describe('zed-context-servers strategy', () => {
  const zed = () => makeProfile('zed-context-servers', 'settings.json');

  it('writes the documented flat entry — command, args, env — under context_servers', () => {
    const result = installIris(zed(), V1);
    expect(result.action).toBe('created');
    expect(readJson(result.configPath).context_servers['iris-eval']).toEqual({ ...V1_ENTRY, env: {} });
  });

  it('adds to the settings file Zed itself writes, comment header and all', () => {
    const profile = zed();
    const original = '// Zed settings\n//\n// For information on how to configure Zed, see the Zed\n// documentation: https://zed.dev/docs/configuring-zed\n{\n  "ui_font_size": 16,\n  "buffer_font_size": 15,\n  "theme": {\n    "mode": "system",\n    "light": "One Light",\n    "dark": "One Dark"\n  }\n}\n';
    writeFileSync(profile.configPath, original, 'utf-8');
    expect(installIris(profile, V1).action).toBe('created');
    const text = readFileSync(profile.configPath, 'utf-8');
    expect(text.startsWith('// Zed settings\n//\n')).toBe(true);
    expect(installIris(profile, V1).action).toBe('no-change');
    expect(uninstallIris(profile).action).toBe('removed');
    // Everything as it was; the emptied server map stays, as it does for every client.
    expect(readFileSync(profile.configPath, 'utf-8')).toBe(original.replace('"dark": "One Dark"\n  }\n}', '"dark": "One Dark"\n  },\n  "context_servers": {}\n}'));
  });

  it('turns an entry in the retired nested shape into the flat one, keeping its extra arguments', () => {
    const profile = zed();
    writeFileSync(profile.configPath, JSON.stringify({ theme: 'x', context_servers: { 'iris-eval': { command: { path: 'npx', args: ['-y', '@iris-eval/mcp-server', '--dashboard'] } } } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    const written = readJson(profile.configPath);
    expect(written.context_servers['iris-eval']).toEqual({ command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.18.0', '--dashboard'] });
    expect(written.theme).toBe('x');
  });

  it('still refuses a settings file that does not parse, and says so', () => {
    const profile = zed();
    writeFileSync(profile.configPath, '{\n  // my settings\n  "theme": "x"\n  "vim_mode": true\n}', 'utf-8');
    expect(() => installIris(profile, V1)).toThrow(/Failed to parse existing config.*line 4/);
  });
});

describe('codex-toml strategy', () => {
  const codex = () => makeProfile('codex-toml', 'config.toml');
  const read = (p: ClientProfile) => readFileSync(p.configPath, 'utf-8');

  it('creates config.toml with a pinned [mcp_servers.iris-eval] table', () => {
    const profile = codex();
    expect(installIris(profile, V1).action).toBe('created');
    expect(read(profile)).toBe('[mcp_servers.iris-eval]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@0.18.0"]\n');
  });

  it('appends without disturbing existing tables and is idempotent', () => {
    const profile = codex();
    writeFileSync(profile.configPath, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "echo"\n', 'utf-8');
    expect(installIris(profile, V1).action).toBe('created');
    expect(installIris(profile, V1).action).toBe('no-change');
    const raw = read(profile);
    expect(raw).toBe('model = "o4"\n\n[mcp_servers.other]\ncommand = "echo"\n\n[mcp_servers.iris-eval]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@0.18.0"]\n');
  });

  it('moves the pin in place and keeps the rest of the table: env sub-table, other keys, extra arguments, comments', () => {
    const profile = codex();
    writeFileSync(
      profile.configPath,
      'model = "o4"\n\n[mcp_servers.iris-eval]\n# pinned by the installer\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@0.17.0", "--dashboard"]\nstartup_timeout_sec = 30\n\n[mcp_servers.iris-eval.env]\nIRIS_LOG_LEVEL = "debug"\n\n[mcp_servers.other]\ncommand = "echo"\n',
      'utf-8',
    );
    expect(installIris(profile, V1).action).toBe('updated');
    expect(read(profile)).toBe(
      'model = "o4"\n\n[mcp_servers.iris-eval]\n# pinned by the installer\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@0.18.0", "--dashboard"]\nstartup_timeout_sec = 30\n\n[mcp_servers.iris-eval.env]\nIRIS_LOG_LEVEL = "debug"\n\n[mcp_servers.other]\ncommand = "echo"\n',
    );
    expect(installIris(profile, V1).action).toBe('no-change');
  });

  it('uninstall removes the iris table and its sub-tables, nothing else', () => {
    const profile = codex();
    writeFileSync(profile.configPath, 'model = "o4"\n\n[mcp_servers.iris-eval]\ncommand = "npx"\nargs = []\n\n[mcp_servers.iris-eval.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "echo"\n', 'utf-8');
    expect(uninstallIris(profile).action).toBe('removed');
    expect(read(profile)).toBe('model = "o4"\n\n[mcp_servers.other]\ncommand = "echo"\n');
    expect(uninstallIris(profile).action).toBe('not-present');
  });

  it('reads a multi-line args array with comments and literal strings, and writes it back on one line', () => {
    const profile = codex();
    writeFileSync(
      profile.configPath,
      "[mcp_servers.iris-eval]\ncommand = 'npx'\nargs = [\n  \"-y\", # answer the prompt\n  '@iris-eval/mcp-server@0.1.0',\n  \"--dashboard\",\n]\nenv = { A = \"1\" }\n",
      'utf-8',
    );
    expect(installIris(profile, V1).action).toBe('updated');
    expect(read(profile)).toBe('[mcp_servers.iris-eval]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@0.18.0", "--dashboard"]\nenv = { A = "1" }\n');
  });

  it('a table with no command or args line gets both, after its header', () => {
    const profile = codex();
    writeFileSync(profile.configPath, '[mcp_servers.iris-eval]\nstartup_timeout_sec = 30\n', 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    expect(read(profile)).toBe('[mcp_servers.iris-eval]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@0.18.0"]\nstartup_timeout_sec = 30\n');
  });

  it('finds tables by header with spacing, quoted keys and trailing comments', () => {
    const profile = codex();
    writeFileSync(profile.configPath, 'model = "o4"\n\n[ mcp_servers . "iris-eval" ] # ours\ncommand = "npx"\nargs = []\n', 'utf-8');
    expect(uninstallIris(profile).action).toBe('removed');
    expect(read(profile)).toBe('model = "o4"\n');
  });

  it('keeps CRLF line endings', () => {
    const profile = codex();
    writeFileSync(profile.configPath, 'model = "o4"\r\n', 'utf-8');
    installIris(profile, V1);
    expect(read(profile)).toBe('model = "o4"\r\n\r\n[mcp_servers.iris-eval]\r\ncommand = "npx"\r\nargs = ["-y", "@iris-eval/mcp-server@0.18.0"]\r\n');
  });
});

/*
 * The entry key is `iris-eval`, matching every other Iris install surface.
 * Earlier installers wrote `iris`, so a user who installed both ways had two
 * live entries spawning two servers (duplicate tool names in the agent's tool
 * list) and uninstall removed only one of them. Install migrates the legacy
 * key; uninstall removes both.
 */
describe('legacy `iris` key migration', () => {
  it('install migrates a legacy iris entry to iris-eval instead of adding a second server', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { iris: UNPINNED, other: { command: 'echo', args: ['hi'] } } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    const written = readJson(profile.configPath);
    expect(written.mcpServers.iris).toBeUndefined();
    expect(written.mcpServers['iris-eval']).toEqual(V1_ENTRY);
    expect(written.mcpServers.other).toEqual({ command: 'echo', args: ['hi'] });
    expect(Object.keys(written.mcpServers).sort()).toEqual(['iris-eval', 'other']);
    expect(installIris(profile, V1).action).toBe('no-change');
  });

  it('install folds a legacy entry away even when iris-eval is already present (both installed)', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { iris: UNPINNED, 'iris-eval': V1_ENTRY } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    expect(Object.keys(readJson(profile.configPath).mcpServers)).toEqual(['iris-eval']);
  });

  it('uninstall removes a legacy-only entry', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { iris: UNPINNED, other: { command: 'echo', args: [] } } }), 'utf-8');
    expect(uninstallIris(profile).action).toBe('removed');
    expect(Object.keys(readJson(profile.configPath).mcpServers)).toEqual(['other']);
  });

  it('uninstall removes both keys when both are present', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, JSON.stringify({ mcpServers: { iris: UNPINNED, 'iris-eval': V1_ENTRY, other: { command: 'echo', args: [] } } }), 'utf-8');
    expect(uninstallIris(profile).action).toBe('removed');
    expect(Object.keys(readJson(profile.configPath).mcpServers)).toEqual(['other']);
  });

  it('Zed: migrates and removes the legacy key under context_servers', () => {
    const profile = makeProfile('zed-context-servers', 'settings.json');
    writeFileSync(profile.configPath, JSON.stringify({ theme: 'One Dark', context_servers: { iris: { command: { path: 'npx', args: ['-y', '@iris-eval/mcp-server'] } } } }), 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    let written = readJson(profile.configPath);
    expect(Object.keys(written.context_servers)).toEqual(['iris-eval']);
    expect(written.theme).toBe('One Dark');
    expect(uninstallIris(profile).action).toBe('removed');
    written = readJson(profile.configPath);
    expect(written.context_servers).toEqual({});
  });

  it('Codex: migrates a legacy [mcp_servers.iris] table (and its sub-tables); uninstall removes both keys', () => {
    const profile = makeProfile('codex-toml', 'config.toml');
    writeFileSync(
      profile.configPath,
      'model = "o4"\n\n[mcp_servers.iris]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server"]\n\n[mcp_servers.iris.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "echo"\n',
      'utf-8',
    );
    expect(installIris(profile, V1).action).toBe('updated');
    let raw = readFileSync(profile.configPath, 'utf-8');
    expect(raw).toBe('model = "o4"\n\n[mcp_servers.iris-eval]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@0.18.0"]\n\n[mcp_servers.iris-eval.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "echo"\n');
    expect(installIris(profile, V1).action).toBe('no-change');

    // Both tables present (installed two ways) → install keeps one, uninstall clears both.
    writeFileSync(profile.configPath, raw + '\n[mcp_servers.iris]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server"]\n', 'utf-8');
    expect(installIris(profile, V1).action).toBe('updated');
    expect(readFileSync(profile.configPath, 'utf-8')).not.toContain('[mcp_servers.iris]');
    writeFileSync(profile.configPath, raw + '\n[mcp_servers.iris]\ncommand = "npx"\n', 'utf-8');
    expect(uninstallIris(profile).action).toBe('removed');
    raw = readFileSync(profile.configPath, 'utf-8');
    expect(raw).toBe('model = "o4"\n\n[mcp_servers.other]\ncommand = "echo"\n');
  });
});
