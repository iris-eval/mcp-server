/*
 * Real MCP clients, driven against the config `iris-eval install` writes.
 *
 * clients.json calls a client `verified` only when a test in this repository
 * drives that client's real integration surface on every CI run. This is
 * that test for the clients that can run headless and without an account:
 * Claude Code (`claude mcp list` / `claude mcp get`) and Gemini CLI
 * (`gemini mcp list`). Each one starts the server from the entry the
 * installer wrote, runs the MCP handshake, and reports "Connected".
 *
 * The CI job (`real-clients` in .github/workflows/ci.yml) builds and packs
 * this commit, installs the tarball into an empty project, installs both
 * clients at pinned versions, and runs this file on Linux, macOS and Windows
 * with IRIS_REAL_CLIENTS=1. npm runs offline for the client's `npx`, so the
 * server that connects is this commit's tarball from the project, never a
 * release from the registry. Outside that job the suite is skipped.
 *
 * Every run gets a scratch home: HOME, USERPROFILE, APPDATA, the clients'
 * own directory variables and IRIS_HOME all point inside it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const enabled = process.env.IRIS_REAL_CLIENTS === '1';
const project = process.env.IRIS_REAL_CLIENTS_PROJECT ? resolve(process.env.IRIS_REAL_CLIENTS_PROJECT) : '';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-real-client-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  const {
    CLAUDE_CONFIG_DIR: _a,
    CODEX_HOME: _b,
    CONTINUE_GLOBAL_DIR: _c,
    CLINE_DIR: _d,
    CLINE_DATA_DIR: _e,
    GEMINI_CLI_HOME: _f,
    ANTHROPIC_API_KEY: _g,
    GEMINI_API_KEY: _h,
    GOOGLE_API_KEY: _i,
    ...rest
  } = process.env;
  void [_a, _b, _c, _d, _e, _f, _g, _h, _i];
  return {
    ...rest,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    IRIS_HOME: join(home, '.iris'),
    IRIS_NO_AUTO_LAUNCH: '1',
    // The client's `npx -y @iris-eval/mcp-server@<version>` must resolve to
    // the tarball installed in the project, not to a release on the registry.
    npm_config_offline: 'true',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  };
}

function run(command: string, args: string[]): { status: number | null; out: string } {
  const options = { cwd: project, env: env(), encoding: 'utf8' as const, timeout: 180_000, windowsHide: true };
  // On Windows `claude`, `gemini` and `npx` are .cmd shims, which only a shell
  // can start; every argument here is a fixed word, so one command line is exact.
  const r = process.platform === 'win32' ? spawnSync([command, ...args].join(' '), { ...options, shell: true }) : spawnSync(command, args, options);
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The installer from the packed tarball, exactly as a user runs it after `npm install`. */
function iris(args: string[]) {
  return run('npx', ['--no-install', 'iris-eval', ...args]);
}

/** A string as a literal inside a regular expression. */
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const version = (): string => JSON.parse(readFileSync(join(project, 'node_modules', '@iris-eval', 'mcp-server', 'package.json'), 'utf8')).version;

describe.skipIf(!enabled)('real clients connect to the server install wrote', () => {
  it('the project holds the packed server', () => {
    expect(project, 'IRIS_REAL_CLIENTS_PROJECT').not.toBe('');
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('Claude Code: `claude mcp list` reports iris-eval Connected; `claude mcp get` shows user scope; uninstall removes it', () => {
    const add = iris(['install', 'claude-code']);
    expect(add.status, add.out).toBe(0);
    const list = run('claude', ['mcp', 'list']);
    expect(list.out).toMatch(new RegExp(`iris-eval: npx -y @iris-eval/mcp-server@${escapeRe(version())}\\s+-\\s+✔ Connected`));
    const get = run('claude', ['mcp', 'get', 'iris-eval']);
    expect(get.status, get.out).toBe(0);
    expect(get.out).toContain('Scope: User config');
    expect(get.out).toMatch(/Status: ✔ Connected/);
    const remove = iris(['install', 'claude-code', '--uninstall']);
    expect(remove.status, remove.out).toBe(0);
    expect(run('claude', ['mcp', 'list']).out).not.toContain('iris-eval');
  }, 300_000);

  it('Gemini CLI: `gemini mcp list` reports iris-eval Connected in a trusted folder; uninstall removes it', () => {
    // Gemini CLI connects to MCP servers only in folders it trusts (docs/cli/trusted-folders).
    const trusted = join(home, 'trustedFolders.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(trusted, JSON.stringify({ [project]: 'TRUST_FOLDER' }));
    process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = trusted;
    try {
      const add = iris(['install', 'gemini']);
      expect(add.status, add.out).toBe(0);
      const list = run('gemini', ['mcp', 'list']);
      expect(list.out).toMatch(new RegExp(`iris-eval: npx -y @iris-eval/mcp-server@${escapeRe(version())} \\(stdio\\) - Connected`));
      const remove = iris(['install', 'gemini', '--uninstall']);
      expect(remove.status, remove.out).toBe(0);
      expect(run('gemini', ['mcp', 'list']).out).not.toContain('iris-eval');
    } finally {
      delete process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH;
    }
  }, 300_000);
});
