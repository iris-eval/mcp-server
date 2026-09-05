/*
 * Writes the eight conformance families under proof/corpus/custom/ (arc 2,
 * M9). Every case is authored here, by hand, against the type's documented
 * definition under the family's config; the script only assembles ids,
 * labels and counts so the files cannot drift from each other. Re-run with
 *   npx tsx proof/tools/compose-custom-v1.ts
 * and never hand-edit the output.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomRuleType } from '../../src/types/eval.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'corpus', 'custom');
const AUTHORED = '2026-09-05';

type Case = { label: 'positive' | 'negative'; output: string; context?: Record<string, unknown>; notes: string };

interface Family {
  type: CustomRuleType;
  definition: string;
  config: Record<string, unknown>;
  cases: Case[];
}

const pos = (output: string, notes: string, context?: Record<string, unknown>): Case => ({ label: 'positive', output, notes, ...(context ? { context } : {}) });
const neg = (output: string, notes: string, context?: Record<string, unknown>): Case => ({ label: 'negative', output, notes, ...(context ? { context } : {}) });

const chars = (n: number, ch = 'x'): string => ch.repeat(n);
const prose = (n: number): string => {
  const s = 'The order has shipped and the tracking number will arrive by email within the hour. ';
  let out = '';
  while (out.length < n) out += s;
  return out.slice(0, n);
};

const FAMILIES: Family[] = [
  {
    type: 'regex_match',
    definition: 'regex_match — passes when the pattern matches somewhere in the output (JavaScript RegExp, no flags unless config.flags); fails when it does not. Under this family the pattern is ^Ticket #[0-9]{6}\\b: the output must START with "Ticket #" and exactly six digits followed by a word boundary. Positive = the rule should FAIL the output.',
    config: { pattern: '^Ticket #[0-9]{6}\\b' },
    cases: [
      neg('Ticket #482910 has been closed.', 'starts with the token, six digits, boundary after'),
      neg('Ticket #000001', 'six digits, end of string is a boundary'),
      neg('Ticket #123456: escalated to tier 2', 'colon after the digits is a boundary'),
      neg('Ticket #999999\nResolved by the on-call engineer.', 'first line matches; the anchor is the start of the output'),
      neg('Ticket #555000 — duplicate of #555001', 'first token matches; the second is irrelevant'),
      neg('Ticket #100200 (reopened)', 'parenthesis after the digits is a boundary'),
      neg('Ticket #777777.', 'full stop is a boundary'),
      neg('Ticket #314159 was merged into #271828.', 'six digits then a space'),
      neg('Ticket #424242 closed; customer notified.', 'six digits then a space'),
      neg('Ticket #808080', 'exactly the pattern, nothing else'),
      pos('ticket #482910 has been closed.', 'lowercase t — the pattern is case-sensitive'),
      pos('Re: Ticket #482910 has been closed.', 'the token is not at the start; ^ anchors to the beginning'),
      pos('Ticket #48291 has been closed.', 'five digits'),
      pos('Ticket #4829105 has been closed.', 'seven digits — the boundary after six fails on a digit'),
      pos('Ticket#482910', 'missing the space'),
      pos('Ticket # 482910', 'a space after the hash'),
      pos('Ticket #48A910', 'a letter among the digits'),
      pos('', 'empty output cannot match'),
      pos('\nTicket #482910', 'a leading newline: ^ without the m flag is the start of the string'),
      pos('Closed. Ticket #482910', 'the token follows other text'),
      pos('Ticket #482910x', 'a letter right after the digits — no word boundary'),
      pos('TICKET #482910', 'uppercase — case-sensitive'),
      pos(' Ticket #482910', 'a leading space'),
      pos('Ticket #4829-10', 'a hyphen inside the digits'),
    ],
  },
  {
    type: 'regex_no_match',
    definition: 'regex_no_match — passes when the pattern matches nowhere in the output; fails when it is found. Under this family the pattern is \\bTODO\\b: the word TODO, case-sensitive, as a whole word. Positive = the rule should FAIL the output.',
    config: { pattern: '\\bTODO\\b' },
    cases: [
      pos('TODO: wire the retry path.', 'the word at the start'),
      pos('Left a TODO in the handler.', 'the word mid-sentence'),
      pos('(TODO)', 'parentheses are boundaries'),
      pos('TODO', 'the word alone'),
      pos('done.\nTODO\n', 'the word on its own line'),
      pos('// TODO remove before release', 'inside a comment'),
      pos('Two items: TODO and FIXME.', 'the word followed by a space'),
      pos('#TODO', 'a hash before the word is a boundary'),
      pos('TODO, then ship', 'comma after'),
      pos('"TODO"', 'quoted'),
      pos('The TODO count is zero.', 'the word used as a noun still matches'),
      pos('TODO:TODO', 'two occurrences'),
      neg('todo: wire the retry path.', 'lowercase — the pattern is case-sensitive'),
      neg('Todo list for Monday.', 'title case'),
      neg('TODOS remain in the backlog.', 'TODOS — no boundary after TODO'),
      neg('MYTODO is a product name.', 'no boundary before'),
      neg('TO DO: call the vendor.', 'split into two words'),
      neg('Nothing left to do.', 'no occurrence'),
      neg('', 'empty output has no match'),
      neg('ToDo', 'mixed case'),
      neg('T.O.D.O.', 'punctuated letters'),
      neg('TODO_1 is the ticket id.', 'underscore is a word character — no boundary'),
      neg('All work is complete and reviewed.', 'no occurrence'),
      neg('The label says TODAY, not the other word.', 'TODAY shares a prefix only'),
    ],
  },
  {
    type: 'min_length',
    definition: 'min_length — passes when the output is at least config.min_length characters long (a JavaScript string length: UTF-16 code units, whitespace included); fails when shorter. Under this family the minimum is 80. Positive = the rule should FAIL the output.',
    config: { min_length: 80 },
    cases: [
      neg(prose(80), 'exactly 80 characters'),
      neg(prose(81), '81 characters'),
      neg(prose(200), 'well over'),
      neg(chars(80, ' '), '80 spaces — whitespace counts'),
      neg(chars(40, 'ab'), '80 characters of repeated letters'),
      neg(prose(79) + '\n', '79 characters plus a trailing newline is 80'),
      neg('😀'.repeat(40), '40 emoji are 80 UTF-16 code units'),
      neg(prose(500), 'long output'),
      neg(chars(80, '-'), '80 punctuation characters'),
      neg(prose(120), '120 characters'),
      neg(prose(80).toUpperCase(), 'case does not change length'),
      pos('', 'empty'),
      pos('Short.', 'six characters'),
      pos(prose(79), '79 characters — one short'),
      pos(chars(79, ' '), '79 spaces'),
      pos('😀'.repeat(39), '39 emoji are 78 code units'),
      pos(prose(40), '40 characters'),
      pos('ok', 'two characters'),
      pos(prose(60), '60 characters'),
      pos('\n\n\n', 'three newlines'),
      pos(prose(1), 'one character'),
      pos(prose(78), '78 characters'),
      pos(chars(10, 'é'), 'ten precomposed accented letters are ten code units'),
      pos(prose(75), '75 characters'),
    ],
  },
  {
    type: 'max_length',
    definition: 'max_length — passes when the output is at most config.max_length characters long (a JavaScript string length: UTF-16 code units, whitespace included); fails when longer. Under this family the maximum is 120. Positive = the rule should FAIL the output.',
    config: { max_length: 120 },
    cases: [
      neg(prose(120), 'exactly 120 characters'),
      neg(prose(119), '119'),
      neg('', 'empty is within any maximum'),
      neg('Short.', 'six characters'),
      neg(chars(120, ' '), '120 spaces'),
      neg('😀'.repeat(60), '60 emoji are 120 code units'),
      neg(prose(100), '100'),
      neg(prose(119) + '\n', '119 plus a newline is 120'),
      neg(prose(50), '50'),
      neg(chars(120, '-'), '120 punctuation characters'),
      pos(prose(121), '121 — one over'),
      pos(prose(200), '200'),
      pos(chars(121, ' '), '121 spaces'),
      pos('😀'.repeat(61), '61 emoji are 122 code units'),
      pos(prose(120) + '\n', '120 plus a trailing newline is 121'),
      pos(prose(1000), 'long output'),
      pos(prose(150), '150'),
      pos(prose(120) + '.', '120 plus a full stop'),
      pos(prose(121).toUpperCase(), 'case does not change length'),
      pos(chars(61, 'ab'), '122 characters of repeated letters'),
      pos(prose(300), '300'),
      pos(prose(122), '122'),
      pos(chars(130, 'é'), '130 precomposed accented letters'),
      pos(prose(125), '125'),
    ],
  },
  {
    type: 'contains_keywords',
    definition: 'contains_keywords — passes when at least config.threshold (a share, default 1 = all) of config.keywords appear in the output, matched case-insensitively as substrings; fails otherwise. Under this family the keywords are refund, policy and days with threshold 1. Positive = the rule should FAIL the output.',
    config: { keywords: ['refund', 'policy', 'days'], threshold: 1 },
    cases: [
      neg('Our refund policy allows returns within 30 days.', 'all three present'),
      neg('REFUND POLICY: 14 DAYS.', 'uppercase — case-insensitive'),
      neg('Refunds are issued under the policy after 5 days.', '"refunds" contains "refund" (substring match)'),
      neg('policy, days, refund', 'order does not matter'),
      neg('The days-to-refund clause is in the policy document.', 'hyphenated and embedded'),
      neg('Policyholders may request a refund; allow ten days.', '"policyholders" contains "policy"'),
      neg('refund\npolicy\ndays', 'one per line'),
      neg('A prepaid refund under our policy lands in 3 business days.', 'all three, in prose'),
      neg('Nowadays the policy is a full refund.', '"nowadays" contains "days"'),
      neg('Refund. Policy. Days.', 'punctuated'),
      pos('Our refund policy is generous.', '"days" missing'),
      pos('Returns accepted within 30 days under our policy.', '"refund" missing'),
      pos('A refund arrives in 5 days.', '"policy" missing'),
      pos('', 'empty output contains nothing'),
      pos('Contact support for help.', 'none present'),
      pos('re-fund pol-icy da-ys', 'hyphens break the substrings'),
      pos('Refund and policy only.', '"days" missing'),
      pos('The day the policy changed we refunded everyone.', '"day" is not "days"; "refunded" contains "refund"; "days" missing'),
      pos('policy', 'one of three'),
      pos('r e f u n d p o l i c y d a y s', 'spaced letters'),
      pos('Reimbursement rules: 30 days.', '"refund" and "policy" missing'),
      pos('Refund policy: see the terms.', '"days" missing'),
      pos('daysrefund', 'two of three'),
      pos('Policies and refunds take time.', '"policies" does not contain "policy"; "days" missing'),
    ],
  },
  {
    type: 'excludes_keywords',
    definition: 'excludes_keywords — passes when none of config.keywords appears in the output, matched case-insensitively as substrings; fails when any does. Under this family the keywords are guarantee and risk-free. Positive = the rule should FAIL the output.',
    config: { keywords: ['guarantee', 'risk-free'] },
    cases: [
      pos('We guarantee a 20% return.', 'the word present'),
      pos('This is risk-free.', 'the hyphenated phrase present'),
      pos('GUARANTEE', 'uppercase — case-insensitive'),
      pos('Guaranteed results.', '"guaranteed" contains "guarantee" (substring match)'),
      pos('A money-back guarantee applies.', 'compound phrase'),
      pos('Risk-Free trial for 30 days.', 'mixed case'),
      pos('guarantee risk-free', 'both present'),
      pos('No guarantee, but likely.', 'negated use still matches'),
      pos('Our "guarantee" is informal.', 'quoted'),
      pos('risk-free\n', 'trailing newline'),
      pos('The guarantees section is below.', '"guarantees" contains "guarantee"'),
      neg('Returns vary and are not assured.', 'neither present'),
      neg('', 'empty output contains nothing'),
      neg('This is risk free.', 'no hyphen — "risk free" is not "risk-free"'),
      neg('The guarantor signs here.', '"guarantor" does not contain "guarantee"'),
      neg('Low risk, free shipping.', 'the words are separated by a comma'),
      neg('Guaranty bond.', '"guaranty" is a different spelling'),
      neg('risk-averse investors', 'shares only a prefix'),
      neg('Nothing is certain.', 'neither present'),
      neg('GUARANT', 'a truncated prefix'),
      neg('risk_free', 'underscore instead of hyphen'),
      neg('We cannot promise outcomes.', 'neither present'),
      neg('riskfree', 'no hyphen'),
      neg('guaran tee', 'a space inside the word'),
    ],
  },
  {
    type: 'json_schema',
    definition: 'json_schema — in this version passes when the output parses as JSON (JSON.parse succeeds) and fails when it does not; the schema in config is not consulted (README: config `{}`; validating against a schema is on the roadmap). Positive = the rule should FAIL the output.',
    config: {},
    cases: [
      neg('{}', 'an empty object'),
      neg('[]', 'an empty array'),
      neg('{"ok": true, "items": [1, 2, 3]}', 'a nested document'),
      neg('"a bare string"', 'a JSON string is valid JSON'),
      neg('42', 'a bare number'),
      neg('null', 'the null literal'),
      neg('true', 'a boolean'),
      neg('  {"padded": 1}  \n', 'surrounding whitespace is allowed'),
      neg('{"unicode": "caf\\u00e9"}', 'an escaped code point'),
      neg('[[[[1]]]]', 'deep nesting'),
      neg('{"a": {"b": {"c": null}}}', 'nested nulls'),
      neg('{"n": -1.5e10}', 'an exponent number'),
      pos('', 'empty output is not JSON'),
      pos('{"trailing": 1,}', 'a trailing comma'),
      pos("{'single': 'quotes'}", 'single quotes'),
      pos('{unquoted: 1}', 'an unquoted key'),
      pos('NaN', 'NaN is not a JSON literal'),
      pos('undefined', 'undefined is not a JSON literal'),
      pos('{"a": 1} // comment', 'a comment'),
      pos('```json\n{"fenced": true}\n```', 'a markdown fence around valid JSON is not JSON'),
      pos('{"a": 1} {"b": 2}', 'two documents'),
      pos('Here is the result: {"a": 1}', 'prose before the object'),
      pos('[1, 2, 3', 'an unclosed array'),
      pos('{"a": 0x1F}', 'a hex literal'),
      pos('{"schema": "ignored", "extra": true}', 'valid JSON that would violate a strict schema — passes today (pos here would be wrong); see next case'),
    ].map((c, i, all) => (i === all.length - 1 ? { ...c, label: 'negative' as const, notes: 'valid JSON that a schema might reject: passes, because the schema is not consulted in this version' } : c)),
  },
  {
    type: 'cost_threshold',
    definition: 'cost_threshold — passes when the evaluation\'s cost_usd is at most config.max_cost; fails when it is greater; SKIPS (does not fail) when no cost was supplied, so a fail-closed gate sees it in critical_skipped rather than a silent pass. Under this family max_cost is 0.05. Positive = the rule should FAIL the output.',
    config: { max_cost: 0.05 },
    cases: [
      neg('Done.', 'cost 0.05 — equal to the maximum passes', { costUsd: 0.05 }),
      neg('Done.', 'cost 0', { costUsd: 0 }),
      neg('Done.', 'cost 0.01', { costUsd: 0.01 }),
      neg('Done.', 'cost 0.049', { costUsd: 0.049 }),
      neg('Done.', 'cost 0.0499999', { costUsd: 0.0499999 }),
      neg('A longer answer that cost very little.', 'cost 0.02; the text does not matter', { costUsd: 0.02 }),
      neg('Done.', 'no cost supplied — the rule skips and does not fail', {}),
      neg('Done.', 'no cost supplied (second case) — skipped, not failed', {}),
      neg('Done.', 'cost 0.03', { costUsd: 0.03 }),
      neg('', 'empty output at cost 0.04 — the rule reads the cost only', { costUsd: 0.04 }),
      neg('Done.', 'cost 0.045', { costUsd: 0.045 }),
      neg('Done.', 'cost 0.005', { costUsd: 0.005 }),
      pos('Done.', 'cost 0.0501 — just over', { costUsd: 0.0501 }),
      pos('Done.', 'cost 0.06', { costUsd: 0.06 }),
      pos('Done.', 'cost 0.1', { costUsd: 0.1 }),
      pos('Done.', 'cost 1', { costUsd: 1 }),
      pos('Done.', 'cost 100', { costUsd: 100 }),
      pos('', 'empty output at cost 0.5 — the rule reads the cost only', { costUsd: 0.5 }),
      pos('Done.', 'cost 0.051', { costUsd: 0.051 }),
      pos('Done.', 'cost 0.07', { costUsd: 0.07 }),
      pos('Done.', 'cost 2.5', { costUsd: 2.5 }),
      pos('Done.', 'cost 0.055', { costUsd: 0.055 }),
      pos('Done.', 'cost 0.09', { costUsd: 0.09 }),
      pos('Done.', 'cost 10', { costUsd: 10 }),
    ],
  },
];

mkdirSync(OUT, { recursive: true });
for (const f of FAMILIES) {
  const cases = f.cases.map((c, i) => ({ id: `custom-${f.type}-${String(i + 1).padStart(3, '0')}`, rule: `proof_${f.type}`, ...c }));
  const positive = cases.filter((c) => c.label === 'positive').length;
  const file = {
    schemaVersion: 1,
    type: f.type,
    family: f.type,
    positiveClass: 'fail',
    definition: f.definition,
    source: `authored ${AUTHORED} by proof/tools/compose-custom-v1.ts — do not hand-edit; every case is written against the documented definition under \`config\``,
    labelling: 'by the documented definition (conformance): a positive is an output the rule should fail under this config; no judgement is involved, so a disagreement is a rule defect or a definition error, never an opinion',
    authored: AUTHORED,
    config: f.config,
    counts: { n: cases.length, positive, negative: cases.length - positive },
    cases,
  };
  writeFileSync(resolve(OUT, `${f.type}.json`), JSON.stringify(file, null, 2) + '\n');
  process.stdout.write(`wrote ${f.type}.json (${cases.length} cases, ${positive} positive)\n`);
}
