import { describe, expect, it } from 'vitest';
import {
  allProfiles,
  configPathFor,
  profileFor,
} from '../src/detect.js';

describe('detect', () => {
  it('returns four supported profiles', () => {
    const profiles = allProfiles();
    expect(profiles).toHaveLength(4);
    expect(profiles.map((p) => p.id).sort()).toEqual([
      'claude-code',
      'continue',
      'cursor',
      'windsurf',
    ]);
  });

  it('configPathFor returns a non-empty path per supported client', () => {
    expect(configPathFor('claude-code')).toMatch(/\.claude/);
    expect(configPathFor('cursor')).toMatch(/\.cursor/);
    expect(configPathFor('windsurf')).toMatch(/codeium/);
    expect(configPathFor('continue')).toMatch(/\.continue/);
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
