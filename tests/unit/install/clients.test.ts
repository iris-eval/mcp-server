/*
 * Where each client reads its MCP servers, per platform and per the
 * override variables the clients document — resolved against a described
 * environment, never this machine's.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SUPPORTED_CLIENTS,
  allProfiles,
  configPathFor,
  detectInstalledClients,
  launchCommand,
  profileFor,
  resolveClientName,
  type Environment,
} from '../../../src/cli/install/clients.js';

const HOME = resolve('/home/u');
const linux: Environment = { platform: 'linux', home: HOME, env: {} };
const mac: Environment = { platform: 'darwin', home: HOME, env: {} };
const win: Environment = { platform: 'win32', home: HOME, env: { APPDATA: join(HOME, 'AppData', 'Roaming') } };
const APPDATA = join(HOME, 'AppData', 'Roaming');

describe('the client list', () => {
  it('names ten clients, in the order the public table shows them', () => {
    expect(allProfiles(linux).map((p) => p.id)).toEqual([...SUPPORTED_CLIENTS]);
    expect(SUPPORTED_CLIENTS).toEqual(['claude-code', 'claude-desktop', 'cursor', 'windsurf', 'continue', 'vscode', 'cline', 'zed', 'codex', 'gemini']);
  });

  it('every profile names an https documentation page and a config strategy', () => {
    for (const p of allProfiles(linux)) {
      expect(p.docsUrl, p.id).toMatch(/^https:\/\//);
      expect(p.detectPaths.length, p.id).toBeGreaterThan(0);
    }
    expect(profileFor('vscode').configMode).toBe('vscode-servers');
    expect(profileFor('zed').configMode).toBe('zed-context-servers');
    expect(profileFor('codex').configMode).toBe('codex-toml');
    // ~/.claude.json carries projects, history and preferences next to mcpServers: Iris adds to it, never owns it.
    expect(profileFor('claude-code').configMode).toBe('embedded-in-config-json');
    for (const id of ['claude-desktop', 'cursor', 'windsurf', 'continue', 'cline', 'gemini'] as const) expect(profileFor(id).configMode, id).toBe('dedicated-mcp-json');
  });

  it('accepts the new product name for Windsurf, and nothing ambiguous', () => {
    expect(resolveClientName('devin')).toBe('windsurf');
    expect(resolveClientName('Cursor')).toBe('cursor');
    expect(resolveClientName('claude')).toBeUndefined();
    expect(resolveClientName('bogus')).toBeUndefined();
  });
});

describe('config paths — each as its client documents it', () => {
  it('Linux', () => {
    expect(configPathFor('claude-code', linux)).toBe(join(HOME, '.claude.json'));
    expect(configPathFor('claude-desktop', linux)).toBe(join(HOME, '.config', 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('cursor', linux)).toBe(join(HOME, '.cursor', 'mcp.json'));
    expect(configPathFor('windsurf', linux)).toBe(join(HOME, '.config', 'devin', 'mcp_config.json'));
    expect(configPathFor('continue', linux)).toBe(join(HOME, '.continue', 'mcpServers', 'iris-eval.json'));
    expect(configPathFor('vscode', linux)).toBe(join(HOME, '.config', 'Code', 'User', 'mcp.json'));
    expect(configPathFor('cline', linux)).toBe(join(HOME, '.cline', 'data', 'settings', 'cline_mcp_settings.json'));
    expect(configPathFor('zed', linux)).toBe(join(HOME, '.config', 'zed', 'settings.json'));
    expect(configPathFor('codex', linux)).toBe(join(HOME, '.codex', 'config.toml'));
    expect(configPathFor('gemini', linux)).toBe(join(HOME, '.gemini', 'settings.json'));
  });

  it('macOS', () => {
    const support = join(HOME, 'Library', 'Application Support');
    expect(configPathFor('claude-desktop', mac)).toBe(join(support, 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('vscode', mac)).toBe(join(support, 'Code', 'User', 'mcp.json'));
    expect(configPathFor('windsurf', mac)).toBe(join(HOME, '.config', 'devin', 'mcp_config.json'));
    expect(configPathFor('zed', mac)).toBe(join(HOME, '.config', 'zed', 'settings.json'));
  });

  it('Windows', () => {
    expect(configPathFor('claude-desktop', win)).toBe(join(APPDATA, 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('vscode', win)).toBe(join(APPDATA, 'Code', 'User', 'mcp.json'));
    expect(configPathFor('windsurf', win)).toBe(join(APPDATA, 'devin', 'mcp_config.json'));
    expect(configPathFor('zed', win)).toBe(join(APPDATA, 'Zed', 'settings.json'));
    expect(configPathFor('cursor', win)).toBe(join(HOME, '.cursor', 'mcp.json'));
    // %APPDATA% unset: the default roaming folder.
    expect(configPathFor('claude-desktop', { ...win, env: {} })).toBe(join(APPDATA, 'Claude', 'claude_desktop_config.json'));
  });

  it('honours each client’s own override variable', () => {
    const at = (name: string) => resolve('/custom', name);
    const env = (vars: Record<string, string>): Environment => ({ ...linux, env: vars });
    expect(configPathFor('claude-code', env({ CLAUDE_CONFIG_DIR: at('claude') }))).toBe(join(at('claude'), '.claude.json'));
    expect(configPathFor('codex', env({ CODEX_HOME: at('codex') }))).toBe(join(at('codex'), 'config.toml'));
    expect(configPathFor('continue', env({ CONTINUE_GLOBAL_DIR: at('continue') }))).toBe(join(at('continue'), 'mcpServers', 'iris-eval.json'));
    expect(configPathFor('cline', env({ CLINE_DATA_DIR: at('cline-data') }))).toBe(join(at('cline-data'), 'settings', 'cline_mcp_settings.json'));
    expect(configPathFor('cline', env({ CLINE_DIR: at('cline') }))).toBe(join(at('cline'), 'data', 'settings', 'cline_mcp_settings.json'));
    expect(configPathFor('gemini', env({ GEMINI_CLI_HOME: at('g') }))).toBe(join(at('g'), '.gemini', 'settings.json'));
    expect(configPathFor('windsurf', env({ XDG_CONFIG_HOME: at('xdg') }))).toBe(join(at('xdg'), 'devin', 'mcp_config.json'));
    expect(configPathFor('vscode', env({ XDG_CONFIG_HOME: at('xdg') }))).toBe(join(at('xdg'), 'Code', 'User', 'mcp.json'));
    // A relative XDG_CONFIG_HOME is invalid by the spec and ignored.
    expect(configPathFor('windsurf', env({ XDG_CONFIG_HOME: 'rel' }))).toBe(join(HOME, '.config', 'devin', 'mcp_config.json'));
  });

  it('Claude Code: the FILE ~/.claude.json, never the ~/.claude/ directory', () => {
    /*
     * The exact filename, not a loose /\.claude/ match: that loose assertion
     * is how ~/.claude/mcp.json — a path Claude Code never reads — once
     * shipped with a passing test.
     */
    expect(configPathFor('claude-code', linux)).toMatch(/[/\\]\.claude\.json$/);
    expect(configPathFor('claude-code', linux)).not.toMatch(/[/\\]\.claude[/\\]/);
  });
});

describe('detection', () => {
  it('finds a client by its directory, and Claude Code by ~/.claude.json or ~/.claude — not by the home directory existing', () => {
    const home = mkdtempSync(join(tmpdir(), 'iris-detect-'));
    try {
      const e: Environment = { platform: 'linux', home, env: {} };
      expect(detectInstalledClients(e)).toEqual([]);
      mkdirSync(join(home, '.cursor'));
      writeFileSync(join(home, '.claude.json'), '{}');
      mkdirSync(join(home, '.codeium', 'windsurf'), { recursive: true });
      expect(detectInstalledClients(e).map((p) => p.id)).toEqual(['claude-code', 'cursor', 'windsurf']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('launchCommand', () => {
  it('pins the version and keeps -y', () => {
    expect(launchCommand(profileFor('cursor', linux), '1.2.3', 'linux')).toEqual({ command: 'npx', args: ['-y', '@iris-eval/mcp-server@1.2.3'] });
  });

  it('on Windows writes npx for a client that resolves it, and cmd /c npx for one whose docs ask for the wrapper', () => {
    const p = profileFor('claude-desktop', win);
    expect(launchCommand(p, '1.2.3', 'win32')).toEqual({ command: 'npx', args: ['-y', '@iris-eval/mcp-server@1.2.3'] });
    expect(launchCommand({ ...p, windowsLaunch: 'cmd-c' }, '1.2.3', 'win32')).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', '@iris-eval/mcp-server@1.2.3'] });
    expect(launchCommand({ ...p, windowsLaunch: 'cmd-c' }, '1.2.3', 'darwin')).toEqual({ command: 'npx', args: ['-y', '@iris-eval/mcp-server@1.2.3'] });
  });
});
