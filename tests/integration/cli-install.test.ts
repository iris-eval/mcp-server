/*
 * `iris-eval install` through the REAL entry point, the way a user runs it:
 * the verb is handed off before the server's argument parsing, writes the
 * client's config under a scratch home, and never starts a server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PKG_VERSION } from '../../src/config/defaults.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const entryPoint = join(repoRoot, 'src', 'index.ts');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-cli-install-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entryPoint, ...args], {
      cwd: repoRoot,
      // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; APPDATA and
      // XDG_CONFIG_HOME are pointed inside the scratch home too, so no client
      // path can resolve to the real user's config.
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: join(home, '.config'),
        IRIS_HOME: join(home, '.iris'),
        CLAUDE_CONFIG_DIR: '',
        CODEX_HOME: '',
        CONTINUE_GLOBAL_DIR: '',
        CLINE_DIR: '',
        CLINE_DATA_DIR: '',
        GEMINI_CLI_HOME: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.once('error', rejectPromise);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('iris-eval install (the CLI entry point)', () => {
  it('install --help answers on stdout and exits 0 without opening a database', async () => {
    const { code, stdout, stderr } = await runCli(['install', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('install <client>');
    expect(stderr).toBe('');
    expect(existsSync(join(home, '.iris'))).toBe(false);
  }, 30_000);

  it('install gemini writes the pinned entry under the scratch home and uninstall removes it', async () => {
    const add = await runCli(['install', 'gemini']);
    expect(add.code).toBe(0);
    const path = join(home, '.gemini', 'settings.json');
    expect(add.stdout).toContain(path);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ mcpServers: { 'iris-eval': { command: 'npx', args: ['-y', `@iris-eval/mcp-server@${PKG_VERSION}`] } } });
    const remove = await runCli(['install', 'gemini', '--uninstall']);
    expect(remove.code).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ mcpServers: {} });
  }, 30_000);

  it('install after a server flag is refused with a pointer, not run as a server', async () => {
    const { code, stderr } = await runCli(['--dashboard', 'install']);
    expect(code).toBe(2);
    expect(stderr).toContain('install comes first');
  }, 30_000);

  it('an unknown verb names both commands', async () => {
    const { code, stderr } = await runCli(['instal']);
    expect(code).toBe(2);
    expect(stderr).toContain('The commands are "ingest" and "install"');
  }, 30_000);

  it('--help lists the install verb', async () => {
    const { code, stderr } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stderr).toMatch(/iris-eval install <client>/);
  }, 30_000);
});
