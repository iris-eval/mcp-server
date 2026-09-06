/*
 * Every built-in rule declares what it is.
 *
 * Arc zero (2026-09-05) found that a rule result carried no field for what
 * KIND of claim it made — a measurement of output length, a detection of a
 * PII pattern, an inference that an output is a stub, and a policy the
 * deployment configured all produced `{ passed, score }` and were averaged
 * together. The metadata below is the first layer of the fix (arc 1): every
 * built-in declares its kind, mechanism, needs, question, failure classes
 * and definition version, the roster surfaces carry them, and the truthbase
 * records them so the public capability map can render from the registry.
 *
 * Three anchors: the runtime registry (rulesByType) declares everything and
 * only registered vocabulary; the roster surfaces (list_rules, the built-in
 * route helper) carry what the registry declares; the truthbase generator
 * and the committed .claims.json equal the registry.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { rulesByType, createCustomRule } from '../../../src/eval/rules/index.js';
import { builtInRuleRoster } from '../../../src/eval/criticality.js';
import { QUESTIONS, RULE_QUESTION_IDS, type CapabilityQuestionId } from '../../../src/eval/questions.js';
import { FAILURE_CLASS_IDS, NEEDS } from '../../../src/eval/failure-classes.js';
import type { CustomRuleType, EvalRule } from '../../../src/types/eval.js';
// @ts-ignore — plain .mjs module, no type declarations needed for a test
import { generate } from '../../../scripts/claims/generators/eval-rules.mjs';

const root = resolve(__dirname, '..', '..', '..');
const builtIns: EvalRule[] = (['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t]);
const KINDS = ['measurement', 'detection', 'inference', 'judgment', 'policy', 'verification'];
const MECHANISMS = ['formula', 'pattern', 'heuristic', 'model', 'external'];
const CUSTOM_TYPES: CustomRuleType[] = ['regex_match', 'regex_no_match', 'min_length', 'max_length', 'contains_keywords', 'excludes_keywords', 'json_schema', 'cost_threshold'];

describe('rule metadata — the registry declares everything, in registered vocabulary', () => {
  it('there are built-ins to check (guards the registry read)', () => {
    expect(builtIns.length).toBeGreaterThanOrEqual(15);
  });

  for (const rule of builtIns) {
    it(`${rule.name} declares kind, mechanism, needs, question, classes and version`, () => {
      expect(KINDS, `${rule.name}.kind`).toContain(rule.kind);
      expect(MECHANISMS, `${rule.name}.mechanism`).toContain(rule.mechanism);
      expect(rule.needs, `${rule.name}.needs`).toBeDefined();
      expect(rule.needs!.length).toBeGreaterThan(0);
      for (const n of rule.needs!) expect(NEEDS, `${rule.name} needs ${n}`).toContain(n);
      expect(RULE_QUESTION_IDS, `${rule.name}.question`).toContain(rule.question);
      expect(rule.classes, `${rule.name}.classes`).toBeDefined();
      for (const c of rule.classes!) expect(FAILURE_CLASS_IDS, `${rule.name} class ${c}`).toContain(c);
      expect(rule.version, `${rule.name}.version`).toBeGreaterThanOrEqual(1);
    });
  }

  it('the critical detections declare a failure class (a veto names what it vetoes)', () => {
    for (const rule of builtIns.filter((r) => r.critical && r.kind === 'detection')) {
      expect(rule.classes!.length, rule.name).toBeGreaterThan(0);
    }
  });

  it('a rule that reads the trajectory declares tool_calls, and one that reads cost declares cost', () => {
    const byName = new Map(builtIns.map((r) => [r.name, r]));
    expect(byName.get('no_silent_tool_failure')!.needs).toContain('tool_calls');
    expect(byName.get('no_tool_loop')!.needs).toContain('tool_calls');
    expect(byName.get('cost_under_threshold')!.needs).toContain('cost');
    expect(byName.get('keyword_overlap')!.needs).toContain('input');
  });

  it('every rule-answered question has at least one rule, and no rule names a non-rule question', () => {
    const answered = new Set(builtIns.map((r) => r.question));
    for (const id of RULE_QUESTION_IDS) {
      expect(answered.has(id), `no rule answers ${id}`).toBe(true);
    }
    const nonRule = new Set(QUESTIONS.filter((q) => q.answeredBy !== 'rule').map((q) => q.id));
    for (const rule of builtIns) expect(nonRule.has(rule.question as CapabilityQuestionId), rule.name).toBe(false);
  });

  it('every custom type is a policy with a mechanism and needs', () => {
    for (const type of CUSTOM_TYPES) {
      const rule = createCustomRule({ name: `t_${type}`, type, config: {} });
      expect(rule.kind, type).toBe('policy');
      expect(MECHANISMS, type).toContain(rule.mechanism);
      expect(rule.needs!.length, type).toBeGreaterThan(0);
      expect(rule.version).toBe(1);
    }
    expect(createCustomRule({ name: 'c', type: 'cost_threshold', config: {} }).needs).toEqual(['cost']);
  });
});

describe('rule metadata — the roster surfaces carry what the registry declares', () => {
  it('builtInRuleRoster carries the six fields for every rule', () => {
    const roster = builtInRuleRoster();
    expect(roster.length).toBe(builtIns.length);
    for (const entry of roster) {
      const rule = builtIns.find((r) => r.name === entry.name)!;
      expect(entry.kind).toBe(rule.kind);
      expect(entry.mechanism).toBe(rule.mechanism);
      expect(entry.needs).toEqual(rule.needs);
      expect(entry.question).toBe(rule.question);
      expect(entry.classes).toEqual(rule.classes);
      expect(entry.version).toBe(rule.version);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  describe('list_rules over the protocol', () => {
    let client: Client;
    let storage: SqliteAdapter;
    beforeEach(async () => {
      storage = new SqliteAdapter(':memory:');
      await storage.initialize();
      const { mcpServer } = createIrisServer(defaultConfig, storage);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      client = new Client({ name: 'test-client', version: '0.1.0' });
      await client.connect(clientTransport);
    });
    afterEach(async () => {
      await client.close();
      await storage.close();
    });

    it('built_in[] entries carry description, kind, mechanism, needs, question, classes and version', async () => {
      const res = await client.callTool({ name: 'list_rules', arguments: {} });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { built_in: Array<Record<string, unknown>> };
      expect(parsed.built_in.length).toBe(builtIns.length);
      for (const entry of parsed.built_in) {
        for (const key of ['description', 'kind', 'mechanism', 'needs', 'question', 'classes', 'version']) {
          expect(entry, `${entry.name as string}.${key}`).toHaveProperty(key);
        }
      }
    });
  });
});

describe('rule metadata — the truthbase equals the registry', () => {
  const expectedRoster = builtIns
    .map((r) => ({ name: r.name, kind: r.kind, mechanism: r.mechanism, needs: [...r.needs!], question: r.question, classes: [...r.classes!], version: r.version }))
    .sort((a, b) => a.name.localeCompare(b.name));

  it('the generator reads the same metadata the runtime declares', async () => {
    const out = (await generate()) as unknown as { roster: unknown[]; questions: unknown[] };
    expect(out.roster).toEqual(expectedRoster);
    expect(out.questions).toEqual(QUESTIONS.map((q) => ({ id: q.id, text: q.text, answeredBy: q.answeredBy })));
  });

  it('.claims.json carries the roster and the questions', () => {
    const claims = JSON.parse(readFileSync(resolve(root, '.claims.json'), 'utf-8')) as { evalRules: { roster: unknown[]; questions: unknown[] } };
    expect(claims.evalRules.roster).toEqual(expectedRoster);
    expect(claims.evalRules.questions).toEqual(QUESTIONS.map((q) => ({ id: q.id, text: q.text, answeredBy: q.answeredBy })));
  });
});
