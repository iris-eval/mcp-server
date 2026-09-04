/**
 * Trust-surface drift locks.
 *
 * Three surfaces a stranger uses to decide whether Iris is maintained, each
 * of which had drifted from the truth on v0.6.0's release day:
 *
 *   - the disclosure SLA (SECURITY.md said 48 h / 5 business days, the
 *     website said 2 business days / 7 days);
 *   - llms.txt / llms-full.txt (hand-written; still said v0.5.0 was current);
 *   - the security page's figures (configured limits stated as if measured,
 *     and no measured figure at all).
 *
 * Each block below anchors the truthbase field to the artifact it derives
 * from AND checks that the surface renders from the reader rather than
 * restating a literal — the same closed loop the eval-rules-count suite
 * breaks for pattern counts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module, no type declarations needed for a test
import { parseDisclosure } from '../scripts/claims/generators/security-policy.mjs';
// @ts-ignore — plain .mjs module, no type declarations needed for a test
import { computeMaintenance, generate as generateMaintenance, percentile, sampleLive, wantsLive } from '../scripts/claims/generators/issues.mjs';
// @ts-ignore — plain .mjs module, no type declarations needed for a test
import { proofSummary, render, renderAll, slotsFrom, TARGETS } from '../scripts/claims/render-llms.mjs';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf-8');
const claims = JSON.parse(read('.claims.json')) as {
  version: { mcpServer: string };
  release: { currentReleaseDate: string };
  security: {
    disclosure: {
      acknowledgeWithinHours: number;
      detailedResponseWithinBusinessDays: number;
      publicDisclosureWindowDays: number;
      source: string;
    };
    limits: Record<string, number | string>;
  };
  maintenance: { source: string; sampledAt: string; issues: Record<string, number | null> };
};

describe('disclosure SLA — SECURITY.md is the single source', () => {
  it('.claims.json security.disclosure equals a fresh parse of SECURITY.md', () => {
    expect(claims.security.disclosure).toEqual(parseDisclosure(read('SECURITY.md')));
  });

  it('the parse fails loudly when a sentence shape disappears', () => {
    expect(() => parseDisclosure('We will get back to you soon.')).toThrow(/no longer contains a sentence/);
  });

  it('the parse fails when the policy disagrees with itself', () => {
    const text = [
      'We aim to acknowledge receipt within 48 hours and provide a detailed response within 5 business days.',
      '1. Acknowledge receipt within 24 hours',
      'Allow us 90 days by default before public disclosure',
    ].join('\n');
    expect(() => parseDisclosure(text)).toThrow(/48 and 24/);
  });

  it('the website security page renders the SLA from the reader, never as a literal', () => {
    const page = read('website/src/app/security/page.tsx');
    expect(page).not.toMatch(/within\s+\d+\s+(?:business\s+)?(?:hours?|days?)/i);
    for (const name of ['DISCLOSURE_ACK_HOURS', 'DISCLOSURE_RESPONSE_BUSINESS_DAYS', 'DISCLOSURE_WINDOW_DAYS']) {
      expect(page).toContain(name);
    }
  });

  it('the security page renders every shipped limit from the reader, never as a literal', () => {
    const page = read('website/src/app/security/page.tsx');
    for (const name of [
      'RATE_LIMIT_MCP',
      'RATE_LIMIT_API',
      'REQUEST_SIZE_LIMIT',
      'REGEX_MATCH_BUDGET_MS',
      'REGEX_BREACHES_PER_EVALUATION',
      'CUSTOM_REGEX_MAX_LENGTH',
    ]) {
      expect(page).toContain(name);
    }
    // The literals the page used to carry.
    expect(page).not.toMatch(/\b100 ms\b/);
    expect(page).not.toMatch(/\b1 MB default\b/);
    expect(page).not.toMatch(/after 3 breaches/);
    expect(page).not.toMatch(/1,000-character/);
  });
});

describe('maintenance — measured issue-close latency', () => {
  const now = new Date('2026-09-04T00:00:00Z');
  type Item = Record<string, unknown>;
  const issue = (num: number, created: string, closed: string | null, extra: Item = {}): Item => ({
    number: num,
    created_at: created,
    closed_at: closed,
    state_reason: closed ? 'completed' : null,
    ...extra,
  });

  it('excludes pull requests and out-of-window closes; percentiles interpolate', () => {
    const closed = [
      issue(1, '2026-09-01T00:00:00Z', '2026-09-01T10:00:00Z'), // 10 h
      issue(2, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'), // 24 h
      issue(3, '2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z'), // 96 h
      issue(4, '2026-08-01T00:00:00Z', '2026-08-03T00:00:00Z', { state_reason: 'not_planned' }), // 48 h
      issue(5, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), // closed before the window
      issue(6, '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z', { pull_request: { url: 'x' } }), // a PR
    ];
    const open = [issue(7, '2026-09-02T00:00:00Z', null, { pull_request: { url: 'y' } }), issue(8, '2026-09-02T00:00:00Z', null), issue(9, '2026-09-02T00:00:00Z', null)];
    const out = computeMaintenance(closed, open, { now });
    expect(out.issues.closedInWindow).toBe(4);
    expect(out.issues.closedAsCompleted).toBe(3);
    expect(out.issues.closedAsNotPlanned).toBe(1);
    // sorted hours 10, 24, 48, 96 → median (24+48)/2 = 36; p75 = 48 + 0.25 × (96 − 48) = 60
    expect(out.issues.medianHoursToClose).toBe(36);
    expect(out.issues.p75HoursToClose).toBe(60);
    expect(out.issues.openNow).toBe(2);
    expect(out.sampledAt).toBe(now.toISOString());
    expect(out.windowDays).toBe(90);
  });

  it('an empty sample yields null, never NaN', () => {
    expect(percentile([], 0.5)).toBeNull();
    const out = computeMaintenance([], [], { now });
    expect(out.issues.medianHoursToClose).toBeNull();
    expect(out.issues.p75HoursToClose).toBeNull();
    expect(out.issues.closedInWindow).toBe(0);
  });

  it('never touches the network by default or under --check, and returns the committed block verbatim', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<never> => {
      calls++;
      throw new Error('network must not be used');
    };
    expect(wantsLive(['node', 'generate.mjs'], {})).toBe(false);
    expect(wantsLive(['node', 'generate.mjs', '--live', '--check'], {})).toBe(false);
    expect(wantsLive(['node', 'generate.mjs', '--live'], {})).toBe(true);
    expect(wantsLive(['node', 'generate.mjs'], { IRIS_CLAIMS_LIVE: '1' })).toBe(true);

    const warnings: string[] = [];
    const warn = (m: string): number => warnings.push(m);
    const byDefault = await generateMaintenance({ argv: ['node', 'generate.mjs'], env: {}, fetchImpl, now, warn });
    const underCheck = await generateMaintenance({ argv: ['node', 'generate.mjs', '--live', '--check'], env: {}, fetchImpl, now, warn });
    expect(calls).toBe(0);
    expect(byDefault).toEqual(claims.maintenance);
    expect(underCheck).toEqual(claims.maintenance);
  });

  it('falls back to the committed sample with source "cached" when a live refresh fails', async () => {
    const warnings: string[] = [];
    const fetchImpl = async (): Promise<never> => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    };
    const out = await generateMaintenance({
      argv: ['node', 'generate.mjs', '--live'],
      env: {},
      fetchImpl,
      now,
      warn: (m: string) => warnings.push(m),
    });
    expect(out).toEqual({ ...claims.maintenance, source: 'cached' });
    expect(warnings.join('\n')).toMatch(/ENOTFOUND/);
    expect(warnings.join('\n')).toMatch(/source: "cached"/);
  });

  it('a live refresh paginates via the Link header, filters, and stamps source "live"', async () => {
    const urls: string[] = [];
    const res = (body: unknown, link: string | null = null) => ({
      ok: true,
      json: async () => body,
      headers: { get: (k: string) => (k === 'link' ? link : null) },
    });
    const fetchImpl = async (url: string) => {
      urls.push(url);
      if (url.includes('state=closed') && !url.includes('page=2')) {
        return res([issue(1, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')], '<https://api.github.com/repos/iris-eval/mcp-server/issues?state=closed&page=2>; rel="next"');
      }
      if (url.includes('page=2')) {
        return res([
          issue(2, '2026-09-01T00:00:00Z', '2026-09-04T00:00:00Z'),
          issue(3, '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z', { pull_request: { url: 'pr' } }),
        ]);
      }
      if (url.includes('state=open')) {
        return res([issue(4, '2026-09-02T00:00:00Z', null), issue(5, '2026-09-02T00:00:00Z', null, { pull_request: { url: 'pr' } })]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = await sampleLive({ now, fetchImpl });
    expect(out.source).toBe('live');
    expect(out.issues.closedInWindow).toBe(2);
    expect(out.issues.openNow).toBe(1);
    expect(out.issues.medianHoursToClose).toBe(48); // (24 + 72) / 2
    expect(urls).toHaveLength(3);
    expect(urls[0]).toMatch(/state=closed&since=2026-06-06T00%3A00%3A00\.000Z&per_page=100$/);
  });

  it('the committed sample is a real one and the security page renders it from the reader', () => {
    expect(['live', 'cached']).toContain(claims.maintenance.source);
    expect(Number.isNaN(Date.parse(claims.maintenance.sampledAt))).toBe(false);
    expect(read('website/src/app/security/page.tsx')).toContain('MAINTENANCE');
  });
});

describe('llms.txt / llms-full.txt — rendered from templates + the truthbase', () => {
  it('the committed files equal the render (what `npm run llms:check` enforces in CI)', async () => {
    const rendered = (await renderAll(root)) as Array<{ output: string; text: string }>;
    expect(rendered.map(r => r.output)).toEqual(TARGETS.map((t: { output: string }) => t.output));
    for (const r of rendered) expect(read(r.output)).toBe(r.text);
  });

  it('both rendered files state the shipped version and release date (v0.5.0 was live on v0.6.0 day)', async () => {
    for (const r of (await renderAll(root)) as Array<{ text: string }>) {
      expect(r.text).toContain(`Current release: v${claims.version.mcpServer} (${claims.release.currentReleaseDate})`);
    }
  });

  it('an unknown slot throws instead of rendering blank', () => {
    expect(() => render('Current release: v{{nope}}', slotsFrom(claims), 't')).toThrow(/unknown slot/);
  });

  it('a slot with no value throws instead of rendering "null"', () => {
    expect(() => render('v{{version}}', { version: null }, 't')).toThrow(/no value/);
  });

  it('the proof summary is honest before and after the numbers land', () => {
    expect(proofSummary({ ...claims, proof: undefined })).toMatch(/being measured/);
    expect(proofSummary({ ...claims, proof: { rules: [] } })).toMatch(/being measured/);
    const after = proofSummary({
      ...claims,
      proof: { rules: [{}, {}], corpusVersion: 'c1', generatedAt: '2026-09-05T12:00:00Z', commit: 'abc1234', version: '9.9.9' },
    });
    // The summary cites the release version, not the generating commit: branch commits are
    // squashed on merge, so a hash here is one no reader can resolve.
    expect(after).toMatch(/for 2 built-in rules, corpus c1, generated 2026-09-05 for v9\.9\.9/);
    expect(after).not.toMatch(/abc1234/);
  });

  it('neither template carries a literal version or a literal count', () => {
    for (const t of TARGETS as Array<{ template: string }>) {
      const text = read(t.template);
      expect(text).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
      expect(text).not.toMatch(/\b\d+ MCP tools\b/i);
      expect(text).not.toMatch(/\b\d+ built-in eval rules\b/i);
      expect(text).not.toMatch(/\b\d+ (?:PII|prompt-injection) patterns\b/i);
      expect(text).not.toMatch(/\b\d+ hallucination markers\b/i);
    }
  });
});
