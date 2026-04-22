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
