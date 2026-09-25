/*
 * `iris-eval install` as a command: arguments, output, exit codes, and a
 * full install → re-install → uninstall for every client against a scratch
 * home directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLIENT_DOCS_URL, runInstall } from '../../../src/cli/install/command.js';
import { SUPPORTED_CLIENTS, configPathFor, type Environment } from '../../../src/cli/install/clients.js';
import { PKG_VERSION } from '../../../src/config/defaults.js';

let home: string;
let e: Environment;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-install-cmd-'));
  e = { platform: process.platform, home, env: { APPDATA: join(home, 'AppData', 'Roaming') } };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[], version?: string) {
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

/** The Iris entry as the client's own file holds it, whatever the format. */
function entry(client: (typeof SUPPORTED_CLIENTS)[number]): unknown {
  const path = configPathFor(client, e);
  const text = readFileSync(path, 'utf-8');
  if (client === 'codex') return text;
  const json = JSON.parse(text);
  return (json.servers ?? json.context_servers ?? json.mcpServers)['iris-eval'];
}

describe('install — arguments and output', () => {
  it('--help prints the usage on stdout, names every client and the docs link, exits 0', async () => {
    const { code, stdout, stderr } = await run(['--help']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('npx -y @iris-eval/mcp-server install <client>');
    for (const id of SUPPORTED_CLIENTS) expect(stdout).toContain(id);
    expect(stdout.trimEnd().endsWith(CLIENT_DOCS_URL)).toBe(true);
  });

  it('--list shows the clients found and says which were not', async () => {
    mkdirSync(join(home, '.cursor'));
    const { code, stdout } = await run(['--list']);
    expect(code).toBe(0);
    expect(stdout).toContain(`cursor          ${join(home, '.cursor', 'mcp.json')}`);
    expect(stdout).toMatch(/Not found here .*claude-desktop/);
  });

  it('--list with nothing found says so', async () => {
    const { stdout } = await run(['--list']);
    expect(stdout).toContain('(none found)');
  });

  it('refuses a missing, unknown or doubled client, and bad flags, with exit 2 and the usage on stderr', async () => {
    for (const args of [[], ['bogus'], ['cursor', 'zed'], ['--nope'], ['cursor', '--client', 'zed'], ['--list', 'cursor']]) {
      const { code, stdout, stderr } = await run(args);
      expect(code, args.join(' ')).toBe(2);
      expect(stdout, args.join(' ')).toBe('');
      expect(stderr, args.join(' ')).toContain('Usage:');
    }
    expect((await run(['bogus'])).stderr).toContain('unknown client "bogus"');
  });

  it('a config it cannot parse is an error on stderr with exit 1, and the file is untouched', async () => {
    const path = configPathFor('cursor', e);
    mkdirSync(join(home, '.cursor'));
    writeFileSync(path, '{ nope');
    const { code, stderr } = await run(['cursor']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Failed to parse existing config/);
    expect(readFileSync(path, 'utf-8')).toBe('{ nope');
  });

  it('says what it wrote, where, and what to run next', async () => {
    const { code, stdout } = await run(['cursor'], '9.9.9');
    expect(code).toBe(0);
    expect(stdout).toContain('Added iris-eval in the Cursor config: npx -y @iris-eval/mcp-server@9.9.9');
    expect(stdout).toContain(configPathFor('cursor', e));
    expect(stdout).toContain('Restart Cursor');
    expect(stdout).toContain('npx -y @iris-eval/mcp-server@9.9.9 --self-test');
    expect((await run(['cursor'], '9.9.9')).stdout).toMatch(/^No change/);
    expect((await run(['cursor'], '9.9.10')).stdout).toMatch(/^Updated iris-eval/);
  });

  it('pins this package’s own version by default', async () => {
    await run(['gemini']);
    expect((entry('gemini') as { args: string[] }).args).toEqual(['-y', `@iris-eval/mcp-server@${PKG_VERSION}`]);
  });
});

describe.each([...SUPPORTED_CLIENTS])('install %s — end to end in a scratch home', (client) => {
  it('writes the entry, is a no-op the second time, and uninstall takes it out', async () => {
    const first = await run([client], '1.2.3');
    expect(first.code).toBe(0);
    const path = configPathFor(client, e);
    expect(path.startsWith(home)).toBe(true);
    expect(existsSync(path)).toBe(true);
    if (client === 'codex') {
      expect(entry(client)).toBe('[mcp_servers.iris-eval]\ncommand = "npx"\nargs = ["-y", "@iris-eval/mcp-server@1.2.3"]\n');
    } else {
      expect(entry(client)).toEqual({
        ...(client === 'cursor' ? { type: 'stdio' } : {}),
        command: 'npx',
        args: ['-y', '@iris-eval/mcp-server@1.2.3'],
        ...(client === 'zed' ? { env: {} } : {}),
      });
    }
    expect((await run([client], '1.2.3')).stdout).toMatch(/^No change/);
    const removed = await run([client, '--uninstall']);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toMatch(/^Removed iris-eval/);
    if (client === 'codex') expect(readFileSync(path, 'utf-8')).not.toContain('iris-eval');
    else expect(entry(client)).toBeUndefined();
    expect((await run([client, '--uninstall'])).stdout).toMatch(/^No change/);
  });
});

describe('the per-client docs link', () => {
  /*
   * It used to be https://iris-eval.com/docs/clients, restated in three
   * places, and that page never existed: a 404 was the last thing the
   * installer showed a stuck user. It is now one constant, pointing at a
   * README heading that exists.
   */
  it('is a real heading in the root README, and the retired path is gone', () => {
    const readme = readFileSync(resolve(__dirname, '../../../README.md'), 'utf-8');
    const anchor = CLIENT_DOCS_URL.split('#')[1];
    const headings = readme
      .split('\n')
      .filter((l) => l.startsWith('#'))
      .map((l) =>
        l
          .replace(/^#+\s*/, '')
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-'),
      );
    expect(headings).toContain(anchor);
    expect(readFileSync(resolve(__dirname, '../../../src/cli/install/command.ts'), 'utf-8')).not.toContain('iris-eval.com/docs/clients');
  });
});
