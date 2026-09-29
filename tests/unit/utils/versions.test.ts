import { describe, expect, it } from 'vitest';
import { compareVersions, isVersion, latestVersion } from '../../../src/utils/versions.js';

describe('versions', () => {
  it('orders releases by major, minor and patch as numbers, not strings', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.20.0', '0.19.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.20.0', 'v0.20.0')).toBe(0);
  });

  it('puts a pre-release before its release, orders pre-releases by semver, and ignores build metadata', () => {
    expect(compareVersions('0.20.0-rc.1', '0.20.0')).toBeLessThan(0);
    expect(compareVersions('0.20.0-rc.2', '0.20.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('0.20.0-alpha', '0.20.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('0.20.0-1', '0.20.0-alpha')).toBeLessThan(0);
    expect(compareVersions('0.20.0+dev', '0.20.0')).toBe(0);
  });

  it('refuses what is not a version, and says which', () => {
    expect(isVersion('latest')).toBe(false);
    expect(isVersion('^0.19.0')).toBe(false);
    expect(isVersion('0.19.0')).toBe(true);
    expect(() => compareVersions('0.19.0', 'latest')).toThrow(/"latest"/);
  });

  it('latestVersion skips null and non-versions', () => {
    expect(latestVersion([null, '0.9.0', 'junk', '0.20.0', undefined, '0.16.0'])).toBe('0.20.0');
    expect(latestVersion([null])).toBeNull();
  });
});
