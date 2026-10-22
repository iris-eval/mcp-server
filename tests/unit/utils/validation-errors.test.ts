/*
 * Validation errors of a bounded size (src/utils/validation-errors.ts): a
 * short list of issues comes back exactly as before, with its count; a long
 * one is cut to the first 20, with the total and a sentence saying so; and
 * no single issue can carry an unbounded message, path or list of keys.
 * The routes, the error handler and the MCP tool error that use it are
 * held in tests/integration/bounded-validation-errors.test.ts.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import { z } from 'zod';
import {
  boundIssues,
  issuesText,
  listKeys,
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUE_PATH_SEGMENTS,
  MAX_LISTED_ISSUES,
  validationErrorBody,
} from '../../../src/utils/validation-errors.js';
import { createErrorHandler } from '../../../src/middleware/error-handler.js';
import { toIrisError } from '../../../src/tools/errors.js';

const issuesOf = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  if (r.success) throw new Error('expected the value to fail');
  return r.error.issues;
};

describe('boundIssues', () => {
  it('keeps a short list exactly as Zod reported it, and counts it', () => {
    const issues = issuesOf(z.strictObject({ a: z.string(), b: z.number() }), { a: 1, b: 'x' });
    const bounded = boundIssues(issues);
    expect(bounded.details).toEqual(JSON.parse(JSON.stringify(issues)));
    expect(bounded.issueCount).toBe(2);
    expect(bounded.detailsNote).toBeUndefined();
  });

  it(`lists the first ${MAX_LISTED_ISSUES} of a long list, with the total and a sentence saying the rest were left out`, () => {
    const issues = issuesOf(z.array(z.string()), Array(5_000).fill(0));
    const bounded = boundIssues(issues);
    expect(bounded.details).toHaveLength(MAX_LISTED_ISSUES);
    expect(bounded.details[0]).toMatchObject({ code: 'invalid_type', path: [0] });
    expect(bounded.issueCount).toBe(5_000);
    expect(bounded.detailsNote).toBe('The first 20 of 5,000 issues are listed; the rest are left out to keep this response small.');
  });

  it('names at most 20 unknown keys in one issue, with how many there were', () => {
    const body = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`k${i}`, 0]));
    const [issue] = boundIssues(issuesOf(z.strictObject({}), body)).details as Array<{ keys: string[]; keyCount: number }>;
    expect(issue.keys).toHaveLength(20);
    expect(issue.keys[0]).toBe('k0');
    expect(issue.keyCount).toBe(1_000);
  });

  it('cuts a long message and a deep path', () => {
    const [issue] = boundIssues([{ code: 'custom', path: Array.from({ length: 500 }, (_, i) => i), message: 'x'.repeat(50_000) }]).details as Array<{ path: unknown[]; message: string }>;
    expect(issue.path).toHaveLength(MAX_ISSUE_PATH_SEGMENTS);
    expect(issue.message).toHaveLength(MAX_ISSUE_MESSAGE_CHARS + 1);
    expect(issue.message.endsWith('…')).toBe(true);
  });

  it("bounds a union's nested branch errors too", () => {
    const issues = issuesOf(z.union([z.array(z.string()), z.array(z.number())]), Array(5_000).fill(true));
    const body = JSON.stringify(boundIssues(issues));
    expect(body.length).toBeLessThan(5_000);
    expect(boundIssues(issues).issueCount).toBe(1);
  });

  it('answers something sensible when there are no issues to read', () => {
    expect(validationErrorBody('Invalid request body', undefined)).toEqual({ error: 'Invalid request body', details: [], issueCount: 0 });
  });
});

describe('listKeys and issuesText', () => {
  it('list everything when short, and say how many more when long', () => {
    expect(listKeys(['a', 'b'])).toBe('"a", "b"');
    expect(listKeys(Array.from({ length: 25 }, (_, i) => `k${i}`))).toMatch(/"k19" and 5 more$/);
    const issues = issuesOf(z.array(z.string()), Array(10).fill(0));
    expect(issuesText(issues, { max: 3, root: 'span' })).toBe(
      '0: Invalid input: expected string, received number; 1: Invalid input: expected string, received number; 2: Invalid input: expected string, received number; and 7 more',
    );
    expect(issuesText(issues.slice(0, 2), { max: 3, root: 'span' })).not.toContain('more');
  });
});

describe('the HTTP error handler and the MCP rule error', () => {
  it('the error handler answers a thrown ZodError with a bounded body', async () => {
    const app = express();
    app.get('/test', () => {
      z.array(z.string()).parse(Array(3_000).fill(0));
    });
    app.use(createErrorHandler({ debug() {}, info() {}, warn() {}, error() {} }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${(server.address() as { port: number }).port}/test`);
      const body = (await res.json()) as { error: string; details: unknown[]; issueCount: number; detailsNote?: string };
      expect(res.status).toBe(400);
      expect(body.error).toBe('Validation error');
      expect(body.details).toHaveLength(MAX_LISTED_ISSUES);
      expect(body.issueCount).toBe(3_000);
      expect(body.detailsNote).toContain('3,000 issues');
    } finally {
      server.close();
    }
  });

  it('a rule definition the store refuses is named in at most 20 issues, then how many more', () => {
    const result = z.array(z.string()).safeParse(Array(500).fill(0));
    if (result.success) throw new Error('expected a failure');
    const e = toIrisError(result.error);
    expect(e.envelope.code).toBe('IRIS_INVALID_RULE_CONFIG');
    expect(e.envelope.message).toMatch(/; and 480 more$/);
    expect(e.envelope.message.split('; ')).toHaveLength(21);
  });
});
