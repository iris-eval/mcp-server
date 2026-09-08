/*
 * `docker compose up` requires IRIS_API_KEY (A6-7).
 *
 * The compose file binds both servers to 0.0.0.0 inside the container (it
 * must — loopback is unreachable through a published port) and, until
 * 0.13.0, set no key: `docker compose up` was an unauthenticated eval API
 * on every published interface, with a warning in a log nobody reads.
 *
 * The server now refuses that bind at boot (src/utils/bind-policy.ts), so a
 * keyless compose would fail one layer later with a less specific message
 * and a restart loop (`restart: unless-stopped`). Compose's own
 * `${VAR:?message}` form refuses BEFORE the container starts, with the
 * sentence in this file. What this test checks, precisely: the compose
 * file passes IRIS_API_KEY through in that required form. It cannot run
 * compose in CI; the local probe is `docker compose config` with the
 * variable unset, which exits 1 naming it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const compose = readFileSync(join(resolve(__dirname, '..'), 'docker-compose.yml'), 'utf8');

describe('docker-compose.yml', () => {
  it('passes IRIS_API_KEY through as a required variable (the ${VAR:?message} form)', () => {
    expect(compose).toMatch(/IRIS_API_KEY=\$\{IRIS_API_KEY:\?[^}]+\}/);
  });

  it('still binds both servers to 0.0.0.0 — the container boundary, plus the key, is the exposure control', () => {
    expect(compose).toContain('IRIS_HOST=0.0.0.0');
    expect(compose).toContain('IRIS_DASHBOARD_HOST=0.0.0.0');
  });

  it('does not ship the override that would run the container open', () => {
    expect(compose).not.toContain('IRIS_ALLOW_UNAUTHENTICATED');
  });
});
