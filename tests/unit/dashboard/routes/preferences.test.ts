/*
 * Route tests for GET/PATCH /preferences.
 *
 * Focus: the responses must never echo the preferences file's absolute
 * path (install-path disclosure, CWE-209 — issue #334, same class as
 * PR #286). The path embeds the OS username and the frontend never
 * read it. Assertions run against the raw wire body so a reintroduced
 * field cannot hide behind serialization.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  registerPreferencesRoutes,
  preferencesDisplayPath,
} from '../../../../src/dashboard/routes/preferences.js';
import { createPreferenceStore } from '../../../../src/preferences.js';

let tmpDir: string;
let prefsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-prefs-route-'));
  prefsPath = join(tmpDir, 'preferences.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerPreferencesRoutes(router, createPreferenceStore(prefsPath));
  app.use('/api/v1', router);
  return app;
}

async function request(
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`, init);
    const raw = await res.text();
    return { status: res.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

/** The path as it would appear inside a JSON wire body (escaped backslashes). */
function jsonEscaped(p: string): string {
  return JSON.stringify(p).slice(1, -1);
}

describe('GET /preferences', () => {
  it('returns preferences without echoing the store path (#334)', async () => {
    const res = await request(makeApp(), '/api/v1/preferences');

    expect(res.status).toBe(200);
    const prefs = res.body.preferences as Record<string, unknown>;
    expect(prefs.theme).toBe('system');
    expect(res.body).not.toHaveProperty('path');
    expect(res.raw).not.toContain(jsonEscaped(prefsPath));
    expect(res.raw).not.toContain(jsonEscaped(tmpDir));
  });
});

/*
 * The welcome banner used to hardcode `~/.iris/preferences.json` — wrong
 * under IRIS_HOME and always wrong in --demo mode (#377 item 2). The
 * server now reports WHERE the file is, in a form that still never
 * carries the absolute path (#334).
 */
describe('displayPath', () => {
  it('is present on GET and PATCH and is never the absolute path', async () => {
    const got = await request(makeApp(), '/api/v1/preferences');
    expect(got.body.displayPath).toBe('preferences.json');
    expect(got.raw).not.toContain(jsonEscaped(tmpDir));

    const patched = await request(makeApp(), '/api/v1/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(patched.body.displayPath).toBe('preferences.json');
    expect(patched.raw).not.toContain(jsonEscaped(tmpDir));
  });

  it('spells a file under IRIS_HOME as $IRIS_HOME/<name> (the demo case included)', () => {
    // The vitest setup points IRIS_HOME at a scratch directory.
    const home = process.env.IRIS_HOME as string;
    expect(home).toBeTruthy();
    expect(preferencesDisplayPath(join(home, 'demo-preferences.json'))).toBe('$IRIS_HOME/demo-preferences.json');
    // Nested paths come out with forward slashes on every platform.
    expect(preferencesDisplayPath(join(home, 'nested', 'preferences.json'))).toBe('$IRIS_HOME/nested/preferences.json');
    // Anything OUTSIDE the home shows only its file name — no directory.
    expect(preferencesDisplayPath(join(tmpDir, 'preferences.json'))).toBe('preferences.json');
  });

  it('spells the default home as ~/.iris/<name> when IRIS_HOME is unset', () => {
    const saved = process.env.IRIS_HOME;
    delete process.env.IRIS_HOME;
    try {
      expect(preferencesDisplayPath(join(homedir(), '.iris', 'preferences.json'))).toBe('~/.iris/preferences.json');
    } finally {
      process.env.IRIS_HOME = saved;
    }
  });
});

describe('PATCH /preferences', () => {
  it('applies the patch without echoing the store path (#334)', async () => {
    const res = await request(makeApp(), '/api/v1/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });

    expect(res.status).toBe(200);
    const prefs = res.body.preferences as Record<string, unknown>;
    expect(prefs.theme).toBe('dark');
    expect(res.body).not.toHaveProperty('path');
    expect(res.raw).not.toContain(jsonEscaped(prefsPath));
    expect(res.raw).not.toContain(jsonEscaped(tmpDir));
  });

  it('rejects an unknown key with 400', async () => {
    const res = await request(makeApp(), '/api/v1/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });
});
