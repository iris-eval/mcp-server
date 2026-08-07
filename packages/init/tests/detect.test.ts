import { describe, expect, it } from 'vitest';
import {
  allProfiles,
  configPathFor,
  profileFor,
} from '../src/detect.js';

describe('detect', () => {
  it('returns ten supported profiles', () => {
    const profiles = allProfiles();
    expect(profiles).toHaveLength(10);
    expect(profiles.map((p) => p.id).sort()).toEqual([
      'claude-code',
      'claude-desktop',
      'cline',
      'codex',
      'continue',
      'cursor',
      'gemini',
      'vscode',
      'windsurf',
      'zed',
    ]);
  });

  it('configPathFor returns a non-empty path per supported client', () => {
    expect(configPathFor('claude-code')).toMatch(/\.claude/);
    expect(configPathFor('claude-desktop')).toMatch(/Claude/);
    expect(configPathFor('cursor')).toMatch(/\.cursor/);
    expect(configPathFor('windsurf')).toMatch(/codeium/);
    expect(configPathFor('continue')).toMatch(/\.continue/);
    expect(configPathFor('vscode')).toMatch(/mcp\.json/);
    expect(configPathFor('cline')).toMatch(/cline_mcp_settings/);
    expect(configPathFor('zed')).toMatch(/[Zz]ed/);
    expect(configPathFor('codex')).toMatch(/\.codex/);
    expect(configPathFor('gemini')).toMatch(/\.gemini/);
  });

  it('new clients use the correct config strategies', () => {
    expect(profileFor('vscode').configMode).toBe('vscode-servers');
    expect(profileFor('zed').configMode).toBe('zed-context-servers');
    expect(profileFor('codex').configMode).toBe('codex-toml');
    expect(profileFor('claude-desktop').configMode).toBe('dedicated-mcp-json');
    expect(profileFor('cline').configMode).toBe('dedicated-mcp-json');
    expect(profileFor('gemini').configMode).toBe('dedicated-mcp-json');
  });

  it('profileFor returns the correct displayName per client', () => {
    expect(profileFor('claude-code').displayName).toBe('Claude Code');
    expect(profileFor('cursor').displayName).toBe('Cursor');
    expect(profileFor('windsurf').displayName).toBe('Windsurf');
    expect(profileFor('continue').displayName).toBe('Continue');
  });

  it('Continue uses embedded-in-config-json mode (others use dedicated)', () => {
    expect(profileFor('continue').configMode).toBe('embedded-in-config-json');
    expect(profileFor('claude-code').configMode).toBe('dedicated-mcp-json');
    expect(profileFor('cursor').configMode).toBe('dedicated-mcp-json');
    expect(profileFor('windsurf').configMode).toBe('dedicated-mcp-json');
  });
});
