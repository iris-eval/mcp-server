/*
 * The E2E suite tests the build it just made, on a port nothing else holds
 * (#665). These hold the two pieces that decide it: which port a run uses,
 * and whether the server answering serves this checkout's dashboard.
 */
import { describe, it, expect } from 'vitest';
import { CI_E2E_PORT, resolveE2EPort } from '../e2e/_constants.js';
import { assertServesThisBuild, buildAssets } from '../e2e/_build-identity.js';

describe('resolveE2EPort', () => {
  it('takes E2E_PORT when it is set', () => {
    expect(resolveE2EPort({ E2E_PORT: '7123' }, () => 1)).toBe(7123);
  });

  it('refuses an E2E_PORT that is not a port', () => {
    for (const bad of ['abc', '0', '70000', '12.5']) {
      expect(() => resolveE2EPort({ E2E_PORT: bad }, () => 1), bad).toThrow(/E2E_PORT must be a port number/);
    }
  });

  it('keeps 6921 in CI', () => {
    const env: NodeJS.ProcessEnv = { CI: 'true' };
    expect(resolveE2EPort(env, () => 1)).toBe(CI_E2E_PORT);
    expect(CI_E2E_PORT).toBe(6921);
    expect(env.E2E_PORT).toBe('6921');
  });

  it('outside CI picks a free port and writes it back, so workers and globalSetup agree', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveE2EPort(env, () => 54321)).toBe(54321);
    expect(env.E2E_PORT).toBe('54321');
    // A second read — a worker process importing the constants — gets the same port.
    expect(resolveE2EPort(env, () => 11111)).toBe(54321);
  });

  it('the real free-port finder returns a port nothing is listening on', async () => {
    const env: NodeJS.ProcessEnv = {};
    const port = resolveE2EPort(env);
    expect(port).toBeGreaterThan(0);
    const { createServer } = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});

const html = (js: string, css: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/${js}"></script><link rel="stylesheet" crossorigin href="/assets/${css}"></head><body><div id="root"></div></body></html>`;

describe('assertServesThisBuild', () => {
  const ours = html('index-AAA111.js', 'index-BBB222.css');

  it('passes when the server serves this build', () => {
    expect(assertServesThisBuild(ours, ours, 'http://127.0.0.1:6921')).toEqual(['/assets/index-AAA111.js', '/assets/index-BBB222.css']);
  });

  it('stops the run, naming the port and both builds, when another build answers', () => {
    const theirs = html('index-OLD999.js', 'index-BBB222.css');
    expect(() => assertServesThisBuild(theirs, ours, 'http://127.0.0.1:6921')).toThrow(
      /The server at http:\/\/127\.0\.0\.1:6921 is not the build under test\. It serves \/assets\/index-OLD999\.js.*this checkout built \/assets\/index-AAA111\.js/,
    );
  });

  it('stops the run when what answers is not a dashboard at all', () => {
    expect(() => assertServesThisBuild('{"error":"Unknown API route"}', ours, 'http://127.0.0.1:6921')).toThrow(/It serves no dashboard assets/);
  });

  it('asks for a build when there is nothing built to compare with', () => {
    expect(() => assertServesThisBuild(ours, '<html></html>', 'http://127.0.0.1:6921')).toThrow(/build the dashboard first/);
  });

  it('reads the hashed assets of a real Vite index.html', () => {
    expect(
      buildAssets(
        '<script type="module" crossorigin src="/assets/index-DLsL_hrW.js"></script>\n<link rel="modulepreload" crossorigin href="/assets/jsx-runtime-BHz_hoGM.js">\n<link rel="stylesheet" crossorigin href="/assets/index-R94ERKzU.css">',
      ),
    ).toEqual(['/assets/index-DLsL_hrW.js', '/assets/jsx-runtime-BHz_hoGM.js', '/assets/index-R94ERKzU.css']);
  });
});
