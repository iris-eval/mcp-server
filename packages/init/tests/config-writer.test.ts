import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIris, uninstallIris } from '../src/config-writer.js';
import type { ClientProfile } from '../src/detect.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-init-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeProfile(filename = 'mcp.json'): ClientProfile {
  return {
    id: 'claude-code',
    displayName: 'Test Client',
    configPath: join(tmpDir, filename),
    configMode: 'dedicated-mcp-json',
  };
}

describe('installIris', () => {
  it('creates a new mcp.json with the iris entry when none exists', () => {
    const profile = makeProfile();
    const result = installIris(profile);
    expect(result.action).toBe('created');
    expect(existsSync(result.configPath)).toBe(true);
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(written.mcpServers.iris.command).toBe('npx');
    expect(written.mcpServers.iris.args).toEqual(['-y', '@iris-eval/mcp-server']);
  });

  it('preserves existing mcpServers entries when adding iris', () => {
    const profile = makeProfile();
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      profile.configPath,
      JSON.stringify({ mcpServers: { other: { command: 'echo', args: ['hi'] } } }),
      'utf-8',
    );
    installIris(profile);
    const written = JSON.parse(readFileSync(profile.configPath, 'utf-8'));
    expect(written.mcpServers.other).toEqual({ command: 'echo', args: ['hi'] });
    expect(written.mcpServers.iris).toBeDefined();
  });

  it('preserves top-level fields when iris is embedded in config.json (Continue-style)', () => {
    const profile: ClientProfile = {
      id: 'continue',
      displayName: 'Continue',
      configPath: join(tmpDir, 'config.json'),
      configMode: 'embedded-in-config-json',
    };
    writeFileSync(
      profile.configPath,
      JSON.stringify({ models: ['claude-3-5-sonnet'], customCommands: [{ name: 'test' }] }),
      'utf-8',
    );
    installIris(profile);
    const written = JSON.parse(readFileSync(profile.configPath, 'utf-8'));
    expect(written.models).toEqual(['claude-3-5-sonnet']);
    expect(written.customCommands).toEqual([{ name: 'test' }]);
    expect(written.mcpServers.iris).toBeDefined();
  });

  it('is idempotent — second install returns no-change', () => {
    const profile = makeProfile();
    installIris(profile);
    const second = installIris(profile);
    expect(second.action).toBe('no-change');
  });

  it('throws a clear error when the existing JSON is malformed', () => {
    const profile = makeProfile();
    writeFileSync(profile.configPath, '{ this is not json', 'utf-8');
    expect(() => installIris(profile)).toThrow(/Failed to parse existing config/);
  });
});

describe('uninstallIris', () => {
  it('returns not-present when the config does not exist', () => {
    const profile = makeProfile();
    const result = uninstallIris(profile);
    expect(result.action).toBe('not-present');
  });

  it('removes the iris entry but leaves other servers intact', () => {
    const profile = makeProfile();
    writeFileSync(
      profile.configPath,
      JSON.stringify({
        mcpServers: {
          iris: { command: 'npx', args: ['-y', '@iris-eval/mcp-server'] },
          other: { command: 'echo', args: ['hi'] },
        },
      }),
      'utf-8',
    );
    const result = uninstallIris(profile);
    expect(result.action).toBe('removed');
    const written = JSON.parse(readFileSync(profile.configPath, 'utf-8'));
    expect(written.mcpServers.iris).toBeUndefined();
    expect(written.mcpServers.other).toEqual({ command: 'echo', args: ['hi'] });
  });

  it('returns not-present when iris is not in mcpServers', () => {
    const profile = makeProfile();
    writeFileSync(
      profile.configPath,
      JSON.stringify({ mcpServers: { other: { command: 'echo', args: ['hi'] } } }),
      'utf-8',
    );
    const result = uninstallIris(profile);
    expect(result.action).toBe('not-present');
  });
});

describe('vscode-servers strategy', () => {
  function vscodeProfile(): ClientProfile {
    return {
      id: 'vscode',
      displayName: 'VS Code',
      configPath: join(tmpDir, 'mcp.json'),
      configMode: 'vscode-servers',
    };
  }

  it('writes under "servers", not "mcpServers"', () => {
    const result = installIris(vscodeProfile());
    expect(result.action).toBe('created');
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(written.servers.iris.command).toBe('npx');
    expect(written.mcpServers).toBeUndefined();
  });

  it('is idempotent and uninstalls only the iris entry', () => {
    const profile = vscodeProfile();
    installIris(profile);
    expect(installIris(profile).action).toBe('no-change');
    writeFileSync(
      profile.configPath,
      JSON.stringify({
        servers: {
          iris: { command: 'npx', args: ['-y', '@iris-eval/mcp-server'] },
          other: { command: 'echo', args: [] },
        },
      }),
      'utf-8',
    );
    const removed = uninstallIris(profile);
    expect(removed.action).toBe('removed');
    const written = JSON.parse(readFileSync(profile.configPath, 'utf-8'));
    expect(written.servers.iris).toBeUndefined();
    expect(written.servers.other).toBeDefined();
  });
});

describe('zed-context-servers strategy', () => {
  function zedProfile(): ClientProfile {
    return {
      id: 'zed',
      displayName: 'Zed',
      configPath: join(tmpDir, 'settings.json'),
      configMode: 'zed-context-servers',
    };
  }

  it('writes a nested command object under context_servers', () => {
    const result = installIris(zedProfile());
    expect(result.action).toBe('created');
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    expect(written.context_servers.iris.command.path).toBe('npx');
    expect(written.context_servers.iris.command.args).toEqual([
      '-y',
      '@iris-eval/mcp-server',
    ]);
  });

  it('preserves unrelated Zed settings and is idempotent', () => {
    const profile = zedProfile();
    writeFileSync(
      profile.configPath,
      JSON.stringify({ theme: 'One Dark', vim_mode: true }),
      'utf-8',
    );
    installIris(profile);
    expect(installIris(profile).action).toBe('no-change');
    const written = JSON.parse(readFileSync(profile.configPath, 'utf-8'));
    expect(written.theme).toBe('One Dark');
    expect(written.vim_mode).toBe(true);
    expect(uninstallIris(profile).action).toBe('removed');
    const after = JSON.parse(readFileSync(profile.configPath, 'utf-8'));
    expect(after.theme).toBe('One Dark');
    expect(after.context_servers.iris).toBeUndefined();
  });

  it('refuses to rewrite a Zed settings file with comments (invalid strict JSON)', () => {
    const profile = zedProfile();
    writeFileSync(profile.configPath, '{\n  // my settings\n  "theme": "x"\n}', 'utf-8');
    expect(() => installIris(profile)).toThrow(/manually/);
  });
});

describe('codex-toml strategy', () => {
  function codexProfile(): ClientProfile {
    return {
      id: 'codex',
      displayName: 'OpenAI Codex CLI',
      configPath: join(tmpDir, 'config.toml'),
      configMode: 'codex-toml',
    };
  }

  it('creates config.toml with an [mcp_servers.iris] section', () => {
    const result = installIris(codexProfile());
    expect(result.action).toBe('created');
    const raw = readFileSync(result.configPath, 'utf-8');
    expect(raw).toContain('[mcp_servers.iris]');
    expect(raw).toContain('command = "npx"');
    expect(raw).toContain('args = ["-y", "@iris-eval/mcp-server"]');
  });

  it('appends without disturbing existing sections and is idempotent', () => {
    const profile = codexProfile();
    writeFileSync(profile.configPath, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "echo"\n', 'utf-8');
    const result = installIris(profile);
    expect(result.action).toBe('updated');
    expect(installIris(profile).action).toBe('no-change');
    const raw = readFileSync(profile.configPath, 'utf-8');
    expect(raw).toContain('model = "o4"');
    expect(raw).toContain('[mcp_servers.other]');
    expect(raw).toContain('[mcp_servers.iris]');
  });

  it('uninstall removes only the iris section', () => {
    const profile = codexProfile();
    writeFileSync(profile.configPath, 'model = "o4"\n', 'utf-8');
    installIris(profile);
    const removed = uninstallIris(profile);
    expect(removed.action).toBe('removed');
    const raw = readFileSync(profile.configPath, 'utf-8');
    expect(raw).toContain('model = "o4"');
    expect(raw).not.toContain('[mcp_servers.iris]');
  });
});
