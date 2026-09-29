/*
 * `install --list` shows the Iris each client runs, and `install --upgrade`
 * moves every client that runs Iris to this version (#704) — against a
 * scratch home, for every client the installer knows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInstall } from '../../../src/cli/install/command.js';
import { SUPPORTED_CLIENTS, configPathFor, profileFor, type Environment } from '../../../src/cli/install/clients.js';
import { pinOf, readClientPins } from '../../../src/cli/install/pins.js';
import { readIrisEntry } from '../../../src/cli/install/config-writer.js';
import { staleClientsLine, announceUpgrade } from '../../../src/cli/upgrade-notice.js';
import type { UpgradeReport } from '../../../src/storage/sqlite-adapter.js';

let home: string;
let e: Environment;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-install-upgrade-'));
  e = { platform: process.platform, home, env: { APPDATA: join(home, 'AppData', 'Roaming') } };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[], version: string) {
  let stdout = '';
  let stderr = '';
  const code = await runInstall(args, {
    stdout: { write: (s: string) => ((stdout += s), true) },
    stderr: { write: (s: string) => ((stderr += s), true) },
    environment: e,
    version,
  });
  return { code, stdout, stderr };
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const pinnedTo = (client: (typeof SUPPORTED_CLIENTS)[number]) => {
  const pin = pinOf(profileFor(client, e), readIrisEntry(profileFor(client, e)));
  return pin.kind === 'pinned' ? pin.version : pin.kind;
};

describe('install --upgrade', () => {
  it.each([...SUPPORTED_CLIENTS])('moves %s from the release that installed it to this one, and --list shows both', async (client) => {
    expect((await run([client], '0.19.0')).code).toBe(0);
    expect(pinnedTo(client)).toBe('0.19.0');
    expect((await run(['--list'], '0.20.0')).stdout).toMatch(new RegExp(`${client} +Iris 0\\.19\\.0 `));

    const up = await run(['--upgrade'], '0.20.0');
    expect(up.code, up.stderr).toBe(0);
    expect(up.stdout).toContain(`${client.padEnd(15)} 0.19.0 -> 0.20.0   ${configPathFor(client, e)}`);
    expect(up.stdout).toContain(`Restart ${profileFor(client, e).displayName} to load it.`);
    expect(pinnedTo(client)).toBe('0.20.0');
    expect((await run(['--list'], '0.20.0')).stdout).toMatch(new RegExp(`${client} +Iris 0\\.20\\.0 `));
  });

  it('keeps what the user added to the entry, pins an unpinned one, and leaves newer pins and other launchers alone', async () => {
    write(configPathFor('cursor', e), JSON.stringify({ mcpServers: { other: { command: 'x' }, 'iris-eval': { type: 'stdio', command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.19.0', '--dashboard'], env: { IRIS_LOG_LEVEL: 'debug' } } } }, null, 2));
    write(configPathFor('gemini', e), JSON.stringify({ mcpServers: { 'iris-eval': { command: 'npx', args: ['-y', '@iris-eval/mcp-server'] } } }));
    write(configPathFor('zed', e), JSON.stringify({ context_servers: { 'iris-eval': { command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.21.0'], env: {} } } }));
    write(configPathFor('claude-desktop', e), JSON.stringify({ mcpServers: { 'iris-eval': { command: 'iris-mcp', args: [] } } }));
    write(configPathFor('cline', e), JSON.stringify({ mcpServers: { iris: { command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.18.0'] } } }));

    const list = await run(['--list'], '0.20.0');
    expect(list.stdout).toMatch(/gemini +Iris, unpinned /);
    expect(list.stdout).toMatch(/claude-desktop +runs iris-mcp /);
    expect(list.stdout).toContain('cursor, cline, gemini run another Iris than this one (0.20.0)');

    const up = await run(['--upgrade'], '0.20.0');
    expect(up.code).toBe(0);
    expect(up.stdout).toMatch(/cursor +0\.19\.0 -> 0\.20\.0/);
    expect(up.stdout).toMatch(/gemini +unpinned \(@iris-eval\/mcp-server\) -> 0\.20\.0/);
    expect(up.stdout).toMatch(/cline +0\.18\.0 -> 0\.20\.0/);
    expect(up.stdout).toMatch(/zed +left at 0\.21\.0, newer than 0\.20\.0/);
    expect(up.stdout).toMatch(/claude-desktop +left as it is: it runs iris-mcp, not the npm package/);

    expect(JSON.parse(readFileSync(configPathFor('cursor', e), 'utf-8'))).toEqual({
      mcpServers: { other: { command: 'x' }, 'iris-eval': { type: 'stdio', command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.20.0', '--dashboard'], env: { IRIS_LOG_LEVEL: 'debug' } } },
    });
    // The legacy `iris` key moves to `iris-eval`, as install does.
    expect(JSON.parse(readFileSync(configPathFor('cline', e), 'utf-8')).mcpServers).toEqual({ 'iris-eval': { command: 'npx', args: ['-y', '@iris-eval/mcp-server@0.20.0'] } });
    expect(pinnedTo('gemini')).toBe('0.20.0');
    expect(pinnedTo('zed')).toBe('0.21.0');
    expect(JSON.parse(readFileSync(configPathFor('claude-desktop', e), 'utf-8')).mcpServers['iris-eval'].command).toBe('iris-mcp');
  });

  it('adds Iris to no client that did not have it, and says so when none does', async () => {
    mkdirSync(join(home, '.cursor'));
    const up = await run(['--upgrade'], '0.20.0');
    expect(up.code).toBe(0);
    expect(up.stdout).toContain('(no client config on this machine runs Iris)');
    expect(readClientPins(e).every((p) => p.kind === 'absent')).toBe(true);
  });

  it('a config it cannot read is reported, left untouched, and exits 1 while the others still move', async () => {
    write(configPathFor('cursor', e), '{ nope');
    await run(['gemini'], '0.19.0');
    const up = await run(['--upgrade'], '0.20.0');
    expect(up.code).toBe(1);
    expect(up.stdout).toMatch(/cursor +not changed: Failed to parse existing config/);
    expect(readFileSync(configPathFor('cursor', e), 'utf-8')).toBe('{ nope');
    expect(pinnedTo('gemini')).toBe('0.20.0');
  });

  it('takes no client, and does not combine with --uninstall or --list', async () => {
    for (const args of [['--upgrade', 'cursor'], ['--upgrade', '--uninstall'], ['--list', '--upgrade']]) {
      const r = await run(args, '0.20.0');
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toContain('Usage:');
    }
  });
});

describe('the line a start prints when it strands pinned clients', () => {
  const report = (floorBefore: string | null, floorAfter: string | null): UpgradeReport => ({
    dbPath: '/data/iris.db',
    from: '0.19.0',
    to: '0.20.0',
    applied: ['015-trace-search'],
    floorBefore,
    floorAfter,
    backup: { taken: true, path: '/data/iris.db.bak', bytes: 1 },
  });

  it('names each client pinned below the new floor and the command, and nothing else', async () => {
    await run(['claude-code'], '0.19.0');
    await run(['cursor'], '0.20.0');
    await run(['codex'], '0.18.0');
    expect(staleClientsLine(report('0.16.0', '0.20.0'), e)).toBe(
      '[iris] Claude Code (Iris 0.19.0) and OpenAI Codex CLI (Iris 0.18.0) cannot open /data/iris.db now that it is upgraded. Move every client to Iris 0.20.0 with: npx -y @iris-eval/mcp-server@0.20.0 install --upgrade',
    );
    let written = '';
    announceUpgrade(report('0.16.0', '0.20.0'), { environment: e, write: (t) => (written += t) });
    expect(written.endsWith('install --upgrade\n')).toBe(true);
  });

  it('is silent when the floor did not move, when no pinned client is below it, and when nothing was migrated', async () => {
    await run(['claude-code'], '0.19.0');
    expect(staleClientsLine(report('0.20.0', '0.20.0'), e)).toBeNull();
    expect(staleClientsLine(report('0.16.0', '0.19.0'), e)).toBeNull();
    let written = '';
    announceUpgrade(undefined, { environment: e, write: (t) => (written += t) });
    expect(written).toBe('');
  });
});
