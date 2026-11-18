/*
 * Makes tests/fixtures/readback/rows-stored-by-main.json: evaluations judged
 * and stored by an EARLIER version of the evaluator, with what that version
 * read back for each.
 *
 * A read composes a stored evaluation's verdict again from its rule results,
 * so a change to the composer can re-mean every row in every store. The test
 * that holds "a stored evaluation reads back as it was given"
 * (tests/unit/storage/composer-rules-readback.test.ts) has to be given rows
 * the earlier code stored. A row this version judged, with its stamp edited
 * to an earlier number, holds only what this version would have put in it.
 *
 * Run it against a checkout of the earlier version (it imports that tree's
 * engine and storage adapter and writes nothing there):
 *
 *   node --import tsx tests/fixtures/readback/make-rows-stored-by-main.mts <root of the earlier checkout> <commit>
 *
 * The committed file was made from main at 70377aac, where the composer's
 * rules are 2.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [root, commit] = process.argv.slice(2);
if (!root || !commit) throw new Error('usage: make-rows-stored-by-main.mts <root of the earlier checkout> <commit>');
const here = dirname(fileURLToPath(import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any -- the earlier checkout's modules are imported by path, and carry no types here */
const from = (path: string): Promise<any> => import(pathToFileURL(join(root, path)).href);

const { EvalEngine } = await from('src/eval/engine.ts');
const { defaultConfig } = await from('src/config/defaults.ts');
const { SqliteAdapter } = await from('src/storage/sqlite-adapter.ts');
const { LOCAL_TENANT } = await from('src/types/tenant.ts');
const { loadPlugins } = await from('src/eval/plugins.ts');

const engine = (overrides: Record<string, unknown> = {}, thresholds: Record<string, unknown> = {}) =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, ...thresholds }, { ...defaultConfig.eval, ...overrides });

// A deployment's own detection, as eval.plugins loads one: it has no published accuracy, so the risk estimate does not weigh it.
const pluginPath = join(here, 'acme-account-scan.mjs');
// And a deployment's own policy, which throws on a call that sends no ask.
const policyPluginPath = join(here, 'no-refund-promise.mjs');
const withPlugin = async (overrides: Record<string, unknown>, path: string = pluginPath) => {
  const e = engine(overrides);
  for (const p of await loadPlugins([{ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }])) e.registerRule(p.evalType, p.rule, p.id);
  return e;
};

const ask = 'Fix the failing date parser and run the test suite.';
const fixed = 'The parser now accepts ISO week dates; the change is in src/date.ts and its test.';
// A value no rule can write out, which only an embedder's own call can carry: the rules that write an input out throw on it.
const unwritable = [{ tool_name: 'read_file', input: { path: 'src/date.ts', at: 10n } }];

const ROWS: Array<{ id: string; what: string; make: () => Promise<any> }> = [
  { id: 'risk-no-class', what: 'the risk estimate fails it and no class is more likely than not by itself (an unfilled template)', make: () => engine().evaluateAll({ output: 'TODO: write the summary.' }) },
  {
    id: 'risk-no-class-and-evidence',
    what: 'the same on a deployment that requires a cost on every evaluation: the sentence names what clearing the first layer leaves',
    make: () => engine({ requiredEvidence: ['cost'] }).evaluateAll({ input: 'Summarise the quarterly report.', output: 'TODO: write the summary.' }),
  },
  {
    id: 'plugin-fire-beside-a-weighed-one',
    what: 'a plugin detection fired beside a rule the estimate weighs, under a strict loss ratio: the note that says what the estimate rests on',
    make: async () => (await withPlugin({ falsePassCost: 3 })).evaluateAll({ input: 'Summarise the account.', output: 'TODO: write the summary for account ACME-123456.' }),
  },
  { id: 'threw', what: 'a run whose loop check threw, at the shipped settings: given as a clean pass', make: () => engine().evaluateAll({ input: ask, output: fixed, toolCalls: unwritable }) },
  {
    id: 'threw-with-its-threshold-set',
    what: 'the same where the deployment had set the loop threshold: given as a clean pass',
    make: () => engine({ configuredThresholdKeys: ['max_tool_repeats'] }, { max_tool_repeats: 2 }).evaluateAll({ input: ask, output: fixed, toolCalls: unwritable }),
  },
  {
    id: 'critical-threw-beside-a-veto',
    what: 'a rule the deployment made critical threw, in an answer that also leaks an identifier: the later layer is said in a clause',
    make: () => engine({ criticalRules: ['no_tool_loop'] }).evaluateAll({ input: ask, output: `${fixed} Your SSN is 536-22-8145.`, toolCalls: unwritable }),
  },
  {
    id: 'report-only-lacking-its-input',
    what: 'a rule set to report with a threshold beside it, on a call that sent no tool calls: given as not checked',
    make: () =>
      engine({ configuredThresholdKeys: ['max_tool_repeats'], advisoryRules: ['no_tool_loop'] }, { max_tool_repeats: 2 }).evaluateAll({
        input: 'Summarise the quarterly report in two sentences.',
        output: 'Revenue rose four percent on the quarter, and costs were flat.',
      }),
  },
  // A critical rule that could not answer, in each form the earlier rules told it: these read as not checked then, and the sentence they were given is kept word for word.
  {
    id: 'critical-threw',
    what: 'a rule the deployment made critical threw: given as not checked, with the sentence a critical check was told',
    make: () => engine({ criticalRules: ['no_tool_loop'] }).evaluateAll({ input: ask, output: fixed, toolCalls: unwritable }),
  },
  {
    id: 'two-critical-could-not-answer',
    what: 'two critical rules could not answer, one that threw and an inline rule at gating severity whose pattern does not compile: the sentence joins their names',
    make: () => engine({ criticalRules: ['no_tool_loop'] }).evaluateAll({ input: ask, output: fixed, toolCalls: unwritable }, [{ name: 'no_internal_draft', type: 'regex_no_match', severity: 'critical', config: { pattern: '(internal draft', flags: 'i' } }]),
  },
  {
    id: 'critical-threw-where-that-is-a-failure',
    what: 'the same critical rule where the deployment treats an unanswered check as a failure: given as a failure, and told it was unknown',
    make: () => engine({ criticalRules: ['no_tool_loop'], onCriticalSkipped: 'fail' }).evaluateAll({ input: ask, output: fixed, toolCalls: unwritable }),
  },
  // A gate that could not answer and was not critical, three ways: the earlier rules read none of them, and each was given as a clean pass.
  {
    id: 'plugin-policy-threw',
    what: "a deployment's own policy, loaded as a plugin, threw on a call that sent no ask: given as a clean pass",
    make: async () => (await withPlugin({}, policyPluginPath)).evaluateAll({ output: 'You will get a full refund within five days, and the store opens at nine tomorrow morning.' }),
  },
  {
    id: 'shipped-threshold-threw-where-defaults-gate',
    what: 'the cost ceiling at its shipped number threw on a cost that is text, where the deployment made shipped thresholds gate: given as a clean pass',
    make: () => engine({ defaultsGate: true }).evaluateAll({ input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.', costUsd: '0.25' }),
  },
  {
    id: 'custom-broken-where-defaults-gate',
    what: 'an inline rule below gating severity whose pattern does not compile, where the deployment made defaults gate: given as a clean pass',
    make: () =>
      engine({ defaultsGate: true }).evaluateAll({ input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Internal draft, do not circulate.' }, [
        { name: 'no_internal_draft', type: 'regex_no_match', config: { pattern: '(internal draft', flags: 'i' } },
      ]),
  },
  // Two rules of one name in one evaluation: a custom rule may carry a built-in's name, and the built-in's row stands first.
  {
    id: 'critical-custom-shares-a-built-ins-name',
    what: 'an inline rule at gating severity named cost_under_threshold, whose pattern does not compile, on a call that sent no cost: the built-in of that name skipped beside it',
    make: () =>
      engine().evaluateAll({ input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.' }, [
        { name: 'cost_under_threshold', type: 'regex_no_match', severity: 'critical', config: { pattern: '(over budget', flags: 'i' } },
      ]),
  },
  {
    id: 'critical-custom-shares-a-name-beside-a-veto',
    what: 'the same under the name max_steps, in an answer that also leaks an identifier: the second form of the sentence',
    make: () =>
      engine().evaluateAll({ input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter. Your SSN is 536-22-8145.' }, [
        { name: 'max_steps', type: 'regex_no_match', severity: 'critical', config: { pattern: '(too many steps', flags: 'i' } },
      ]),
  },
];

const dir = mkdtempSync(join(tmpdir(), 'iris-readback-fixture-'));
const store = new SqliteAdapter(join(dir, 'stored.db'));
await store.initialize();
const rows: Array<{ id: string; what: string; stored: any; read: any }> = [];
try {
  for (const row of ROWS) {
    const given = await row.make();
    given.id = `stored-${row.id}`;
    await store.insertEvalResult(LOCAL_TENANT, given);
    const read = await store.getEvalById(LOCAL_TENANT, given.id);
    // What was stored, as JSON holds it, and what that version read back for it.
    rows.push({
      id: row.id,
      what: row.what,
      stored: JSON.parse(JSON.stringify(given, (_key, value) => (typeof value === 'bigint' ? String(value) : value))),
      read: JSON.parse(JSON.stringify({ verdict: read.verdict, passed: read.passed, interpretations: read.interpretations ?? [], critical_skipped: read.critical_skipped ?? [] })),
    });
    console.log(`${row.id}: rules ${given.provenance?.composer?.rules}; ${read.verdict.state}/${read.verdict.basis} by [${read.verdict.by.join(', ')}]; ${(read.interpretations ?? []).length} sentences`);
  }
  // The first row again as a release before 0.20.0 stored one: the same results, and no rules number among its composer facts.
  const unstamped = structuredClone(rows[0].stored);
  unstamped.id = 'stored-risk-no-class-unstamped';
  delete unstamped.provenance.composer.rules;
  await store.insertEvalResult(LOCAL_TENANT, unstamped);
  const read = await store.getEvalById(LOCAL_TENANT, unstamped.id);
  rows.push({
    id: 'risk-no-class-unstamped',
    what: 'the first row with no rules number among its composer facts, as a release before 0.20.0 stored one',
    stored: unstamped,
    read: JSON.parse(JSON.stringify({ verdict: read.verdict, passed: read.passed, interpretations: read.interpretations ?? [], critical_skipped: read.critical_skipped ?? [] })),
  });
  console.log(`risk-no-class-unstamped: ${read.verdict.state}/${read.verdict.basis} by [${read.verdict.by.join(', ')}]`);
} finally {
  await store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
writeFileSync(join(here, 'rows-stored-by-main.json'), `${JSON.stringify({ madeFrom: commit, madeBy: 'tests/fixtures/readback/make-rows-stored-by-main.mts', rows }, null, 1)}\n`);
console.log(`written: ${rows.length} rows, made from ${commit}`);
