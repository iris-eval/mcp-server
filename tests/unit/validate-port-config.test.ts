/*
 * validatePortConfig — F-006 pre-flight guard.
 *
 * Failing this pre-flight means the HTTP transport and the dashboard
 * would race to bind the same port and the loser silently broke the
 * dashboard. These tests guard the three cases: collision (throw),
 * stdio+dashboard (ok — different binders), HTTP-only or dashboard-only
 * (ok — only one binder).
 */
import { describe, it, expect } from 'vitest';
import { validatePortConfig } from '../../src/utils/validate-port-config.js';
import { defaultConfig } from '../../src/config/defaults.js';
import type { IrisConfig } from '../../src/types/index.js';

function cfg(overrides: Partial<IrisConfig>): IrisConfig {
  return {
    ...defaultConfig,
    ...overrides,
    transport: { ...defaultConfig.transport, ...(overrides.transport ?? {}) },
    dashboard: { ...defaultConfig.dashboard, ...(overrides.dashboard ?? {}) },
  };
}

describe('validatePortConfig (F-006)', () => {
  it('throws when HTTP transport and dashboard share a port', () => {
    expect(() =>
      validatePortConfig(
        cfg({
          transport: { type: 'http', host: '127.0.0.1', port: 6920 },
          dashboard: { enabled: true, port: 6920 },
        }),
      ),
    ).toThrow(/Port collision.*6920/);
  });

  it('error message instructs the user how to fix it', () => {
    expect(() =>
      validatePortConfig(
        cfg({
          transport: { type: 'http', host: '127.0.0.1', port: 6920 },
          dashboard: { enabled: true, port: 6920 },
        }),
      ),
    ).toThrow(/--dashboard-port|IRIS_DASHBOARD_PORT/);
  });

  it('allows HTTP transport + dashboard on different ports', () => {
    expect(() =>
      validatePortConfig(
        cfg({
          transport: { type: 'http', host: '127.0.0.1', port: 6919 },
          dashboard: { enabled: true, port: 6920 },
        }),
      ),
    ).not.toThrow();
  });

  it('allows stdio transport + dashboard on the same numeric port', () => {
    // stdio doesn't bind a TCP port, so numeric collision is irrelevant.
    expect(() =>
      validatePortConfig(
        cfg({
          transport: { type: 'stdio', host: '127.0.0.1', port: 6920 },
          dashboard: { enabled: true, port: 6920 },
        }),
      ),
    ).not.toThrow();
  });

  it('allows HTTP transport without dashboard enabled', () => {
    expect(() =>
      validatePortConfig(
        cfg({
          transport: { type: 'http', host: '127.0.0.1', port: 6920 },
          dashboard: { enabled: false, port: 6920 },
        }),
      ),
    ).not.toThrow();
  });
});
