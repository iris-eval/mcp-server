/*
 * Route tests for GET /audit — the read-only audit log view.
 *
 * Focus: the response must never echo the audit log's absolute path
 * (install-path disclosure, CWE-209 — issue #334, same class as PR
 * #286). The path embeds the OS username and the dashboard never
 * needed it. Assertions run against the raw wire body, not a parsed
 * convenience view, so a reintroduced field cannot hide behind
 * serialization.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAuditRoutes } from '../../../../src/dashboard/routes/audit.js';
import type { CustomRuleStore } from '../../../../src/custom-rule-store.js';

let tmpDir: string;
let auditPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-audit-route-'));
  auditPath = join(tmpDir, 'audit.log');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const sample = (overrides: Record<string, unknown> = {}) => ({
  ts: '2026-04-22T20:00:00.000Z',
  action: 'rule.deploy',
  user: 'local',
  ruleId: 'rule-abc',
  ruleName: 'no_pricing',
  ...overrides,
});

function makeApp(): express.Express {
  const app = express();
  const router = express.Router();
  // The route only reads store.auditPath; a minimal stub keeps the test
  // pointed at the temp file without standing up a full rule store.
  registerAuditRoutes(router, { auditPath } as unknown as CustomRuleStore);
  app.use('/api/v1', router);
  return app;
}

async function request(
  app: express.Express,
  path: string,
): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`);
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

describe('GET /audit', () => {
  it('returns entries without echoing the audit file path (#334)', async () => {
    writeFileSync(
      auditPath,
      [JSON.stringify(sample({ ruleId: 'r1' })), JSON.stringify(sample({ ruleId: 'r2' }))].join('\n') + '\n',
      'utf-8',
    );
    const res = await request(makeApp(), '/api/v1/audit');

    expect(res.status).toBe(200);
    expect((res.body.entries as unknown[]).length).toBe(2);
    expect(res.body.total).toBe(2);
    expect(res.body).not.toHaveProperty('path');
    expect(res.raw).not.toContain(jsonEscaped(auditPath));
    expect(res.raw).not.toContain(jsonEscaped(tmpDir));
  });

  it('keeps the path out of the empty (file-missing) response too', async () => {
    const res = await request(makeApp(), '/api/v1/audit');

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body).not.toHaveProperty('path');
    expect(res.raw).not.toContain(jsonEscaped(auditPath));
  });
});
