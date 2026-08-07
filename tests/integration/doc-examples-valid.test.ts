import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCustomRuleStore } from '../../src/custom-rule-store.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

/*
 * Every custom-rule config example we publish must actually deploy.
 *
 * This exists because it did not hold. `docs/api-reference.md` taught
 * `config: { "min": 40 }` and the `deploy_rule` tool description taught
 * `config.min` / `config.max_usd`, while the evaluator read
 * `config.min_length` / `config.max_cost`. Deploy-time validation accepted
 * any object, so a rule built from our own documentation deployed cleanly
 * and then failed on every single evaluation, forever — silently dragging
 * down aggregate scores with no sign the RULE was the broken part.
 *
 * Numeric claims already have a gate (check-product-claims / claims:check).
 * Nothing checked that our *examples* were runnable. This closes that gap:
 * if someone edits a doc example into something the schema rejects, or
 * changes the schema out from under the docs, this fails.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

// Files that teach users how to write a rule definition.
const DOC_SOURCES = [
  'docs/api-reference.md',
  'docs/custom-rules.md',
  'examples/http-transport/README.md',
  'examples/http-transport/client.ts',
  'src/tools/deploy-rule.ts',
];

interface FoundExample {
  source: string;
  type: string;
  config: Record<string, unknown>;
  raw: string;
}

/**
 * Pull `"type": "x", "config": { ... }` pairs out of prose/code. Deliberately
 * simple: it only matches a config object with no nested braces, which covers
 * every example we currently ship. If a future example nests an object the
 * matcher skips it rather than guessing — a miss is safe, a wrong parse is not.
 */
function extractExamples(source: string, text: string): FoundExample[] {
  const out: FoundExample[] = [];
  const patterns = [
    /["']?type["']?\s*:\s*["']([a-z_]+)["']\s*,\s*["']?config["']?\s*:\s*(\{[^{}]*\})/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const type = m[1];
      const rawConfig = m[2];
      // Normalise JS-ish object literals to JSON: quote bare keys, swap
      // single quotes. Skip anything still unparseable.
      let jsonish = rawConfig
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/'/g, '"');
      // Trailing commas
      jsonish = jsonish.replace(/,\s*}/g, '}');
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(jsonish);
      } catch {
        continue;
      }
      out.push({ source, type, config, raw: `${m[0]}` });
    }
  }
  return out;
}

describe('published rule-config examples are deployable', () => {
  const examples: FoundExample[] = [];
  for (const rel of DOC_SOURCES) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    examples.push(...extractExamples(rel, readFileSync(abs, 'utf-8')));
  }

  it('finds rule examples to check (guards against the matcher silently breaking)', () => {
    expect(examples.length).toBeGreaterThanOrEqual(5);
  });

  it.each(examples.map((e) => [`${e.source} :: ${e.type} ${JSON.stringify(e.config)}`, e] as const))(
    'deploys %s',
    (_label, example) => {
      const dir = mkdtempSync(join(tmpdir(), 'iris-docex-'));
      try {
        const store = createCustomRuleStore({
          pathFor: () => join(dir, 'custom-rules.json'),
          auditPath: join(dir, 'audit.log'),
        });
        expect(() =>
          store.deploy(LOCAL_TENANT, {
            name: `doc-example-${example.type}`,
            description: 'from published documentation',
            evalType: 'custom',
            severity: 'medium',
            definition: {
              name: `doc-example-${example.type}`,
              type: example.type,
              config: example.config,
            },
          } as Parameters<typeof store.deploy>[1]),
        ).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
