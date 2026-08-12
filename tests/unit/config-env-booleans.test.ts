import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

/*
 * Pins the IRIS_DASHBOARD spelling contract. The variable used to be read
 * as `value === 'true'`, so IRIS_DASHBOARD=1 (or yes, on, TRUE) silently
 * meant an explicit DISABLE that overrode config.json — while the startup
 * pointer log told the user to set the very variable they believed they
 * had set. Common truthy/falsy spellings now parse; anything else throws,
 * same contract as the port env vars.
 *
 * The global test setup already points IRIS_HOME at a scratch directory,
 * so loadConfig here never reads a real config.json.
 */

const VAR = 'IRIS_DASHBOARD';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[VAR];
});

afterEach(() => {
  if (saved === undefined) delete process.env[VAR];
  else process.env[VAR] = saved;
});

describe('IRIS_DASHBOARD env parsing', () => {
  it.each(['true', '1', 'yes', 'on', 'TRUE', ' On '])('%j enables the dashboard', (v) => {
    process.env[VAR] = v;
    expect(loadConfig().dashboard.enabled).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'FALSE'])('%j disables the dashboard', (v) => {
    process.env[VAR] = v;
    expect(loadConfig().dashboard.enabled).toBe(false);
  });

  it('an unrecognized value throws with the variable named', () => {
    process.env[VAR] = 'banana';
    expect(() => loadConfig()).toThrow(/IRIS_DASHBOARD.*banana.*boolean/);
  });

  it('unset leaves the dashboard off by default', () => {
    delete process.env[VAR];
    expect(loadConfig().dashboard.enabled).toBe(false);
  });
});
