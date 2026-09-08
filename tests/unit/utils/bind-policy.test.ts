/*
 * Refuse, don't warn (A6-7).
 *
 * Until 0.13.0 the HTTP transport and the dashboard both WARNED when bound
 * beyond loopback with no API key, then served: every trace, verdict and
 * rule on the server reachable by anyone who could route to the host. The
 * published Docker image sets IRIS_HOST=0.0.0.0 (a container must), so a
 * bare `docker run` was exactly that deployment, and the warning scrolled
 * past in a container log nobody reads.
 *
 * The policy is one pure function so both servers and the CLI pre-flight
 * cannot disagree about it. What it tests, precisely: a non-loopback bind
 * with no key is refused unless `security.allowUnauthenticated` was set on
 * purpose; loopback without a key stays a warning; a key makes any bind
 * fine.
 */
import { describe, it, expect } from 'vitest';
import {
  ALLOW_UNAUTHENTICATED_VAR,
  unauthenticatedBindRefusal,
  validateBindPolicy,
} from '../../../src/utils/bind-policy.js';
import { defaultConfig } from '../../../src/config/defaults.js';

const NON_LOOPBACK = ['0.0.0.0', '::', '192.168.1.20', '10.0.0.7', 'iris.internal'];
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

describe('unauthenticatedBindRefusal', () => {
  it.each(NON_LOOPBACK)('refuses %s with no key, naming IRIS_API_KEY and the override', (host) => {
    const refusal = unauthenticatedBindRefusal({ surface: 'HTTP transport', host, apiKey: undefined, allowUnauthenticated: false });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('IRIS_API_KEY');
    expect(refusal).toContain(ALLOW_UNAUTHENTICATED_VAR);
    expect(refusal).toContain(host);
    expect(refusal).toContain('HTTP transport');
  });

  it.each(LOOPBACK)('%s with no key is not refused (the warning path stays)', (host) => {
    expect(unauthenticatedBindRefusal({ surface: 'dashboard', host, apiKey: undefined, allowUnauthenticated: false })).toBeNull();
  });

  it.each(NON_LOOPBACK)('%s with a key is not refused', (host) => {
    expect(unauthenticatedBindRefusal({ surface: 'dashboard', host, apiKey: 'k', allowUnauthenticated: false })).toBeNull();
  });

  it.each(NON_LOOPBACK)('%s with no key but the override set on purpose is not refused', (host) => {
    expect(unauthenticatedBindRefusal({ surface: 'HTTP transport', host, apiKey: undefined, allowUnauthenticated: true })).toBeNull();
  });

  it('an empty-string key is no key', () => {
    expect(unauthenticatedBindRefusal({ surface: 'dashboard', host: '0.0.0.0', apiKey: '', allowUnauthenticated: false })).not.toBeNull();
  });
});

describe('validateBindPolicy — the CLI pre-flight over the whole config', () => {
  it('refuses an http transport bound to 0.0.0.0 without a key before anything binds', () => {
    const config = {
      ...defaultConfig,
      transport: { ...defaultConfig.transport, type: 'http' as const, host: '0.0.0.0' },
    };
    expect(() => validateBindPolicy(config)).toThrow(/IRIS_API_KEY/);
  });

  it('refuses a dashboard bound to 0.0.0.0 without a key even under stdio transport', () => {
    const config = {
      ...defaultConfig,
      dashboard: { ...defaultConfig.dashboard, enabled: true, host: '0.0.0.0' },
    };
    expect(() => validateBindPolicy(config)).toThrow(/dashboard/);
  });

  it('a disabled dashboard on 0.0.0.0 is not a bind and is not refused', () => {
    const config = {
      ...defaultConfig,
      dashboard: { ...defaultConfig.dashboard, enabled: false, host: '0.0.0.0' },
    };
    expect(() => validateBindPolicy(config)).not.toThrow();
  });

  it('stdio transport on a non-loopback IRIS_HOST is not a bind and is not refused', () => {
    const config = {
      ...defaultConfig,
      transport: { ...defaultConfig.transport, type: 'stdio' as const, host: '0.0.0.0' },
    };
    expect(() => validateBindPolicy(config)).not.toThrow();
  });

  it('the shipped defaults pass (loopback everywhere)', () => {
    expect(() => validateBindPolicy(defaultConfig)).not.toThrow();
  });

  it('a key, or the override, clears both servers', () => {
    const open = {
      ...defaultConfig,
      transport: { ...defaultConfig.transport, type: 'http' as const, host: '0.0.0.0' },
      dashboard: { ...defaultConfig.dashboard, enabled: true, host: '0.0.0.0' },
    };
    expect(() => validateBindPolicy({ ...open, security: { ...open.security, apiKey: 'k' } })).not.toThrow();
    expect(() => validateBindPolicy({ ...open, security: { ...open.security, allowUnauthenticated: true } })).not.toThrow();
  });
});
