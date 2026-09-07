import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOOL_NAMES } from '../src/tools/index.js';

/*
 * The API reference must cover what the server actually registers.
 *
 * `docs/api-reference.md` is the page a reader opens to find out what Iris
 * can do, and nothing checked that it kept up. Three tools and four routes
 * shipped in arc 5 before anyone noticed it had not moved — and a reference
 * missing a tool is worse than a reference with none, because the omission
 * reads as "that does not exist" rather than as "look elsewhere".
 *
 * The existing docs-contract test runs the other direction: it catches prose
 * naming a tool, flag or route that does NOT exist. This is the direction it
 * cannot check — a real thing the prose never mentions.
 */

const root = resolve(__dirname, '..');
const reference = readFileSync(resolve(root, 'docs', 'api-reference.md'), 'utf8');

/*
 * Routes documented by hand rather than enumerated from the router: the
 * mounted stack does not carry a reliable path string for every layer, and a
 * test that silently matched nothing would be worse than a short list. Adding
 * a route means adding it here, which is the prompt to document it.
 */
const ROUTES_THAT_MUST_BE_DOCUMENTED = [
  'POST /api/v1/traces',
  'GET /api/v1/traces',
  'GET /api/v1/evaluations',
  'GET /api/v1/summary',
  'GET /api/v1/capabilities',
  'GET /api/v1/health',
  'GET /api/v1/runs',
  'GET /api/v1/runs/:id',
  'GET /api/v1/cases/:key',
  'GET /api/v1/eval-stats/drift',
];

describe('the API reference covers what ships', () => {
  it.each([...TOOL_NAMES])('documents the tool %s under its own heading', (name) => {
    expect(reference, `docs/api-reference.md has no "### ${name}" section`).toContain(`### ${name}`);
  });

  it.each(ROUTES_THAT_MUST_BE_DOCUMENTED)('documents the route %s', (route) => {
    expect(reference, `docs/api-reference.md does not document ${route}`).toContain(`### ${route}`);
  });

  it('documents no tool the server does not register', () => {
    /*
     * Scoped to the "MCP Tools" section. Snake_case headings elsewhere in
     * this file are custom RULE TYPES (regex_match, json_schema, …), which
     * are a different vocabulary — reading them as tools would make this
     * test fail on correct documentation, which is how a guard gets deleted
     * rather than fixed.
     */
    const start = reference.indexOf('## MCP Tools');
    expect(start, 'the reference no longer has an "MCP Tools" section').toBeGreaterThan(-1);
    const after = reference.indexOf(String.fromCharCode(10) + "## ", start + 1);
    const section = reference.slice(start, after === -1 ? undefined : after);

    const documented = [...section.matchAll(/^### ([a-z][a-z0-9_]*)$/gm)].map((m) => m[1]);
    expect(documented.length, 'no tool headings found — the extractor stopped matching').toBeGreaterThanOrEqual(TOOL_NAMES.length);
    const registered = new Set<string>(TOOL_NAMES);
    for (const name of documented) {
      // A heading here that no tool registers is a rename left behind.
      expect(registered.has(name), `docs/api-reference.md documents "${name}", which no tool registers`).toBe(true);
    }
  });
});
