/*
 * A run read against the same agent's earlier runs of its own case
 * (src/eval/case-history.ts and the two rules in
 * src/eval/rules/case-history.ts).
 *
 * What is held here: where the two lines sit (no earlier run, every earlier
 * run) and that a steady agent cannot keep crossing them; which tools are
 * known to act, which read, and which nothing places; what counts as an
 * earlier run; every way each rule declines; what a result quotes; and what
 * each rule does to a verdict: the unusual action weighed from five earlier
 * runs and reported below that, the dropped step reported.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CASE_HISTORY_MIN,
  CASE_HISTORY_WEIGH_MIN,
  CASE_HISTORY_WINDOW,
  MAX_NAMES_IN_MESSAGE,
  MAX_RUN_TOOLS,
  MAX_TOOL_NAME_CHARS,
  caseRunOf,
  droppedSteps,
  hasNoUsualWay,
  nameWords,
  ownToolName,
  placementOf,
  toolsOfSteps,
  unusualActions,
} from '../../../src/eval/case-history.js';
import { caseHistoryRules, noDroppedStep, noUnusualAction } from '../../../src/eval/rules/case-history.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { MAX_STEPS_DERIVED, toSteps } from '../../../src/eval/steps.js';
import { mulberry32 } from '../../../src/eval/stats.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { CaseRun, EvalContext, EvalRuleResult } from '../../../src/types/eval.js';
import type { ToolCallRecord } from '../../../src/types/trace.js';

const run = (tools: string[] | null): CaseRun => ({ tools });
/** m earlier runs that each called `base`; the first k of them also called `tool`. */
const history = (m: number, tool?: string, k = 0, base: string[] = ['get_balance']): CaseRun[] => Array.from({ length: m }, (_, i) => run(tool !== undefined && i < k ? [...base, tool] : [...base]));
const calls = (...names: string[]): ToolCallRecord[] => names.map((tool_name) => ({ tool_name, input: {}, output: 'ok' }));

describe('a tool that acts, one that reads, and one nothing places', () => {
  it('reads a name as words: at anything that is not a letter or a digit, and where camelCase turns', () => {
    expect(nameWords('get_user_info')).toEqual(['get', 'user', 'info']);
    expect(nameWords('listFiles')).toEqual(['list', 'files']);
    expect(nameWords('HTTPFetch')).toEqual(['http', 'fetch']);
    expect(nameWords('mcp__mail__list-and.post')).toEqual(['mcp', 'mail', 'list', 'and', 'post']);
  });

  it('the first verb in a name decides: a look-up may fetch a thing whose name is also a verb that acts', () => {
    for (const name of ['get_iban', 'listFiles', 'readFile', 'WebFetch', 'search_emails', 'describe-table']) expect(placementOf(name, undefined), name).toBe('reads');
    // The object of a look-up is not what the tool does: an order, a post, a commit, a schedule, a refund, a run.
    for (const name of ['get_order', 'fetch_order', 'get_post', 'get_commit', 'list_schedule', 'get_refund', 'get_workflow_run', 'github_get_issue', 'file_read']) expect(placementOf(name, undefined), name).toBe('reads');
    for (const name of ['delete_list', 'drop_view', 'run_query', 'execute_query', 'send_money', 'sendEmail', 'api_call', 'slack_post_message', 'git_commit', 'order_pizza', 'mark_all_notifications_read']) {
      expect(placementOf(name, undefined), name).toBe('acts');
    }
  });

  it('a verb that acts directly after a joiner decides, whatever verb came first', () => {
    for (const name of ['find_and_replace', 'select_all_and_delete', 'show_and_send_email', 'mcp__slack__list_and_post', 'get_or_create_user', 'lookup_then_update', 'findOneAndUpdate', 'search_and_then_delete']) {
      expect(placementOf(name, undefined), name).toBe('acts');
    }
    // A verb that reads after a joiner changes nothing either way.
    expect(placementOf('delete_and_list', undefined)).toBe('acts');
    expect(placementOf('get_and_list', undefined)).toBe('reads');
    // A joiner whose own verb reads joins nothing that acts: the later word is the thing it reads.
    for (const name of ['food_and_beverage_get_order', 'h_and_m_get_order', 'authenticate_then_get_post']) expect(placementOf(name, undefined), name).toBe('reads');
  });

  it('a name that reads and then, some words after a joiner, holds a verb that acts can be read two ways, and is not placed', () => {
    // A second action, with a word between the joiner and its verb.
    for (const name of ['search_and_bulk_update', 'find_and_soft_delete', 'lookup_and_auto_assign', 'get_or_auto_create', 'findAllAndBulkUpdate', 'fetch_and_force_push']) expect(placementOf(name, undefined), name).toBe('unplaced');
    // Two things looked up, and the thing they belong to named by a word that also acts.
    for (const name of ['get_name_and_address_for_order', 'get_title_and_body_of_post', 'list_users_and_groups_with_write_access', 'get_shipping_and_handling_charge', 'get_or_tools_schedule']) {
      expect(placementOf(name, undefined), name).toBe('unplaced');
    }
    // A name that begins by acting acts, whatever follows; and a later joiner with its verb next to it still decides.
    expect(placementOf('update_name_and_address_for_order', undefined)).toBe('acts');
    expect(placementOf('get_name_and_address_for_order_and_delete', undefined)).toBe('acts');
    // The catalogue places either kind.
    expect(placementOf('search_and_bulk_update', [{ name: 'search_and_bulk_update', annotations: { readOnlyHint: false } }])).toBe('acts');
    expect(placementOf('get_name_and_address_for_order', [{ name: 'get_name_and_address_for_order', annotations: { readOnlyHint: true } }])).toBe('reads');
  });

  it('a tool reached through MCP is read by its own name, and the server\'s name takes no part', () => {
    expect(ownToolName('mcp__github__create_issue')).toBe('create_issue');
    expect(ownToolName('mcp__claude_ai_Gmail__search_threads')).toBe('search_threads');
    // The first separator after the prefix ends the server's name; a tool's own name may hold another.
    expect(ownToolName('mcp__db__get__row')).toBe('get__row');
    // Not that shape: the name is read whole.
    for (const name of ['send_email', 'mcp_send_email', 'mcp__send_email', 'mcp__server__', 'github__create_issue']) expect(ownToolName(name), name).toBe(name);

    // A server named for something that acts does not make its look-ups act.
    for (const name of ['mcp__store__get_products', 'mcp__order-management__get_order', 'mcp__call-center__get_transcript', 'mcp__deploy__get_status', 'mcp__cloud-run__list_services']) {
      expect(placementOf(name, undefined), name).toBe('reads');
    }
    // A server named for something that reads does not make its actions read.
    for (const name of ['mcp__todo-list__add_task', 'mcp__shopping-list__remove_item', 'mcp__web-search__save_result', 'mcp__google-search__submit_feedback']) {
      expect(placementOf(name, undefined), name).toBe('acts');
    }
    // A verb in the server's name is not the tool's: with no verb of its own, the tool is unplaced.
    for (const name of ['mcp__store__status', 'mcp__search__index_document', 'mcp__run__status', 'mcp__get__thing']) expect(placementOf(name, undefined), name).toBe('unplaced');
    // A server that is a shell, an interpreter or a computer is another matter: a tool there with no verb of its own acts, as the same words do without the prefix.
    for (const name of ['mcp__shell__command', 'mcp__computer-use__type', 'mcp__python-repl__code', 'mcp__terminal__input']) expect(placementOf(name, undefined), name).toBe('acts');
    expect(placementOf('shell_command', undefined)).toBe('acts');
    // With a verb of its own, the verb decides there too.
    for (const name of ['mcp__shell__list_files', 'mcp__computer-use__read_clipboard', 'mcp__terminal__get_output']) expect(placementOf(name, undefined), name).toBe('reads');
    // The catalogue is matched on the name the agent called, whole.
    expect(placementOf('mcp__store__get_products', [{ name: 'mcp__store__get_products', annotations: { readOnlyHint: false } }])).toBe('acts');
  });

  it('a name with no verb that is a shell\'s or an interpreter\'s acts; with a verb, the verb decides', () => {
    for (const name of ['Bash', 'bash', 'shell', 'PowerShell', 'pwsh', 'mcp__host__sh', 'zsh', 'cmd', 'python_repl', 'code_interpreter', 'computer']) expect(placementOf(name, undefined), name).toBe('acts');
    expect(placementOf('run_in_terminal', undefined)).toBe('acts');
    for (const name of ['get_shell_history', 'read_terminal_output', 'list_shell_sessions']) expect(placementOf(name, undefined), name).toBe('reads');
    // A word is matched whole: neither of these holds one.
    for (const name of ['bashful_notes', 'cmdline_docs']) expect(placementOf(name, undefined), name).toBe('unplaced');
  });

  it('a name that says neither is not placed, and is never taken to act', () => {
    for (const name of ['webhook', 'Glob', 'calculator', 'document_parse', 'code_analysis', 'memory_retrieve', 'check_opening_hours', 'Skill', 'Task', 'curl']) expect(placementOf(name, undefined), name).toBe('unplaced');
  });

  it('the catalogue\'s word comes before the name\'s, and places a name that says nothing', () => {
    expect(placementOf('send_money', [{ name: 'send_money', annotations: { readOnlyHint: true } }])).toBe('reads');
    expect(placementOf('get_report', [{ name: 'get_report', annotations: { readOnlyHint: false } }])).toBe('acts');
    expect(placementOf('get_report', [{ name: 'other_tool', annotations: { readOnlyHint: false } }])).toBe('reads');
    expect(placementOf('webhook', [{ name: 'webhook', annotations: { readOnlyHint: false } }])).toBe('acts');
    expect(placementOf('calculator', [{ name: 'calculator', annotations: { readOnlyHint: true } }])).toBe('reads');
    // A tool the catalogue calls destructive acts, unless the catalogue also calls it read-only.
    expect(placementOf('factory_wipeout', [{ name: 'factory_wipeout', annotations: { destructiveHint: true } }])).toBe('acts');
    expect(placementOf('factory_wipeout', [{ name: 'factory_wipeout', annotations: { destructiveHint: true, readOnlyHint: true } }])).toBe('reads');
    expect(placementOf('factory_wipeout', [{ name: 'factory_wipeout', annotations: { destructiveHint: false } }])).toBe('unplaced');
    // A catalogue entry with no hint says nothing, and the name is read.
    expect(placementOf('calculator', [{ name: 'calculator' }])).toBe('unplaced');
    // A name longer than the rules keep is matched by the characters they keep, as a stored run's is.
    const long = `send_${'x'.repeat(MAX_TOOL_NAME_CHARS)}`;
    expect(placementOf(long.slice(0, MAX_TOOL_NAME_CHARS), [{ name: long, annotations: { readOnlyHint: true } }])).toBe('reads');
  });
});

describe('one stored run, as an earlier run', () => {
  it('keeps the distinct tools in first-call order, and nothing else of the run', () => {
    expect(caseRunOf({ tool_calls: [{ tool_name: 'search', output: 'a secret result' }, { tool_name: 'read' }, { tool_name: 'search' }, { tool_name: 'send', input: { to: 'x@y.z' } }] })).toEqual({ tools: ['search', 'read', 'send'] });
  });

  it('an explicit empty list is a run that made no call; no list at all is a run whose calls were not recorded', () => {
    expect(caseRunOf({ tool_calls: [] }).tools).toEqual([]);
    expect(caseRunOf({}).tools).toBeNull();
    expect(caseRunOf({ tool_calls: null }).tools).toBeNull();
  });

  it('reads TOOL spans when no tool calls were sent', () => {
    const spans = [
      { span_id: 'a', trace_id: 't', name: 'llm', kind: 'LLM' as const, status_code: 'OK' as const, start_time: '2026-01-01T00:00:00Z' },
      { span_id: 'b', trace_id: 't', name: 'send_money', kind: 'TOOL' as const, status_code: 'OK' as const, start_time: '2026-01-01T00:00:01Z', attributes: { 'tool.name': 'send_money' } },
    ];
    expect(caseRunOf({ spans }).tools).toEqual(['send_money']);
  });

  it('a run that cannot be listed whole is kept as one whose calls were not recorded, never as a shorter list', () => {
    // More calls than the step layer reads: a tool called only among the rest would look never called.
    expect(caseRunOf({ tool_calls: calls(...Array.from({ length: MAX_STEPS_DERIVED + 1 }, () => 'read_file')) }).tools).toBeNull();
    expect(caseRunOf({ tool_calls: calls(...Array.from({ length: MAX_STEPS_DERIVED }, () => 'read_file')) }).tools).toEqual(['read_file']);
    // More distinct tools than are kept.
    expect(caseRunOf({ tool_calls: calls(...Array.from({ length: MAX_RUN_TOOLS + 1 }, (_, i) => `tool_${i}`)) }).tools).toBeNull();
    // A call that cannot be read, or has no name.
    expect(caseRunOf({ tool_calls: [null as unknown as ToolCallRecord] }).tools).toBeNull();
    expect(caseRunOf({ tool_calls: [{} as ToolCallRecord] }).tools).toBeNull();
  });

  it('holds a tool name to its first characters, on a stored run and on the run being judged alike', () => {
    const long = 'x'.repeat(MAX_TOOL_NAME_CHARS + 50);
    const kept = caseRunOf({ tool_calls: calls(long) }).tools!;
    expect(kept[0]).toHaveLength(MAX_TOOL_NAME_CHARS);
    expect(toolsOfSteps(toSteps({ toolCalls: calls(long) }))).toEqual(kept);
  });
});

describe('an unusual action', () => {
  it('is a tool known to act that no earlier run called; called once before is not unusual', () => {
    expect(unusualActions(['get_balance', 'send_money'], undefined, history(6))).toEqual({ m: 6, unusual: ['send_money'], unusualLookups: [], unplaced: [], departing: 0 });
    expect(unusualActions(['get_balance', 'send_money'], undefined, history(6, 'send_money', 1))!.unusual).toEqual([]);
    expect(unusualActions(['get_balance', 'send_money'], undefined, history(20, 'send_money', 1))!.unusual).toEqual([]);
  });

  it('a look-up no earlier run made is noted and never counted', () => {
    const reading = unusualActions(['get_balance', 'get_iban'], undefined, history(6))!;
    expect(reading.unusual).toEqual([]);
    expect(reading.unusualLookups).toEqual(['get_iban']);
  });

  it('a tool nothing places that no earlier run called is noted and never counted, until the catalogue says it acts', () => {
    const reading = unusualActions(['get_balance', 'calculator', 'Glob'], undefined, history(6))!;
    expect(reading.unusual).toEqual([]);
    expect(reading.unusualLookups).toEqual([]);
    expect(reading.unplaced).toEqual(['calculator', 'Glob']);
    const placed = unusualActions(['get_balance', 'calculator'], [{ name: 'calculator', annotations: { readOnlyHint: false } }], history(6))!;
    expect([placed.unusual, placed.unplaced]).toEqual([['calculator'], []]);
    // Called before, it is not new to the case and is not named at all.
    expect(unusualActions(['get_balance', 'calculator'], undefined, history(6, 'calculator', 1))!.unplaced).toEqual([]);
  });

  it('earlier runs that each called an unplaced tool of their own do not make the case one with no usual way', () => {
    const own = ['calculator', 'document_parse', 'code_analysis', 'memory_retrieve'];
    const scattered = history(6).map((r, i) => (i < 4 ? run([...r.tools!, own[i]]) : r));
    const reading = unusualActions(['get_balance', 'send_money'], undefined, scattered)!;
    expect(reading.departing).toBe(0);
    expect(reading.unusual).toEqual(['send_money']);
  });

  it('says nothing below the floor, and counts only runs whose calls were recorded', () => {
    expect(unusualActions(['send_money'], undefined, history(CASE_HISTORY_MIN - 1))).toBeNull();
    expect(unusualActions(['send_money'], undefined, [...history(2), run(null), run(null), run(null)])).toBeNull();
    expect(unusualActions(['send_money'], undefined, [...history(3), run(null)])!.m).toBe(3);
  });

  it('reads at most the window, newest first', () => {
    const old = Array.from({ length: 10 }, () => run(['get_balance', 'send_money']));
    const reading = unusualActions(['send_money'], undefined, [...history(CASE_HISTORY_WINDOW), ...old])!;
    expect(reading.m).toBe(CASE_HISTORY_WINDOW);
    expect(reading.unusual).toEqual(['send_money']);
  });

  it('asks the same of each earlier run against the rest: more than half departing is no usual way of going', () => {
    const own = ['delete_file', 'post_message', 'create_event', 'update_password'];
    const scattered = history(6).map((r, i) => (i < 4 ? run([...r.tools!, own[i]]) : r));
    const reading = unusualActions(['send_money'], undefined, scattered)!;
    expect(reading.departing).toBe(4);
    expect(hasNoUsualWay(reading)).toBe(true);
    const half = history(6).map((r, i) => (i < 3 ? run([...r.tools!, own[i]]) : r));
    expect(hasNoUsualWay(unusualActions(['send_money'], undefined, half)!)).toBe(false);
    // With three earlier runs each would be read against two, which is below the floor: not asked.
    expect(unusualActions(['send_money'], undefined, history(3))!.departing).toBeNull();
    expect(hasNoUsualWay({ m: 3, departing: null })).toBe(false);
  });
});

describe('a dropped step', () => {
  it('is a tool every earlier run called and this run did not; a look-up is a step like any other', () => {
    expect(droppedSteps(new Set(['send_money']), history(6, 'send_money', 6))).toEqual({ m: 6, dropped: ['get_balance'], usual: 2 });
    expect(droppedSteps(new Set(['get_balance', 'send_money']), history(6, 'send_money', 6))!.dropped).toEqual([]);
  });

  it('all but one earlier run is not every earlier run', () => {
    expect(droppedSteps(new Set(['get_balance']), history(6, 'send_money', 5))!.dropped).toEqual([]);
    expect(droppedSteps(new Set(['get_balance']), history(20, 'send_money', 19))!.dropped).toEqual([]);
    expect(droppedSteps(new Set(['get_balance']), history(20, 'send_money', 20))!.dropped).toEqual(['send_money']);
  });

  it('says how many steps the run was held to, so a history that shares none can be told from a pass', () => {
    expect(droppedSteps(new Set(['x']), history(5, undefined, 0, []))).toEqual({ m: 5, dropped: [], usual: 0 });
    expect(droppedSteps(new Set(['x']), history(2, 'send_money', 2))).toBeNull();
  });
});

describe('an agent that has not changed cannot keep firing', () => {
  /*
   * The first version drew its lines at a share of the earlier runs, and a
   * steady agent with a step it takes one run in ten fired on about one run
   * in ten for ever. With the lines at none and all, a habit of probability
   * p fires on p · (1 − p)^m of the runs at most: under 2% at a full window,
   * whatever p is. Simulated here on a seeded stream, each run read against
   * the twenty before it.
   */
  const simulate = (p: number, rule: 'action' | 'step'): number => {
    const rng = mulberry32(20261110);
    const stream = Array.from({ length: 4000 }, () => (rng() < p ? ['get_balance', 'send_money'] : ['get_balance']));
    let fired = 0;
    let judged = 0;
    for (let i = CASE_HISTORY_WINDOW; i < stream.length; i += 1) {
      const earlier = stream.slice(i - CASE_HISTORY_WINDOW, i).reverse().map(run);
      judged += 1;
      if (rule === 'action') fired += unusualActions(stream[i], undefined, earlier)!.unusual.length > 0 ? 1 : 0;
      else fired += droppedSteps(new Set(stream[i]), earlier)!.dropped.length > 0 ? 1 : 0;
    }
    return fired / judged;
  };

  it('an optional action, however often it is taken, is flagged on under 3% of runs at a full window', () => {
    for (const p of [0.02, 0.05, 0.1, 0.25, 0.5]) expect(simulate(p, 'action'), `p = ${p}`).toBeLessThan(0.03);
  });

  it('a step, however often it is taken, is reported dropped on under 3% of runs at a full window', () => {
    for (const p of [0.5, 0.75, 0.85, 0.95, 0.98]) expect(simulate(p, 'step'), `p = ${p}`).toBeLessThan(0.03);
  });
});

describe('the two rules', () => {
  const base: EvalContext = { output: 'The transfer is done.', input: 'Pay the invoice.', toolCalls: calls('get_balance', 'send_money') };

  it('sit in the completeness bundle and answer the tool-use question: the unusual action is an inference, the dropped step a measurement', () => {
    expect(caseHistoryRules.map((r) => [r.name, r.kind, r.evalType, r.question, r.needs])).toEqual([
      ['no_unusual_action', 'inference', 'completeness', 'tool_use_correct', ['tool_calls']],
      ['no_dropped_step', 'measurement', 'completeness', 'tool_use_correct', ['tool_calls']],
    ]);
  });

  it('no_unusual_action fails naming the tool, which is this run\'s own, with the call as evidence', () => {
    const result = noUnusualAction.evaluate({ ...base, caseHistory: history(6) });
    expect(result.passed).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.message).toBe('Unusual action for this case: send_money, called in none of its 6 earlier runs');
    expect(result.value).toEqual({ stat: 'unusual_actions', unit: 'tools', value: 1 });
    expect(result.evidence).toEqual([
      { type: 'count', stat: 'unusual_actions', unit: 'tools', value: 1, threshold: 0, thresholdSource: 'rule' },
      { type: 'toolCall', index: 1, toolName: 'send_money', label: 'called in none of the 6 earlier runs of this case' },
    ]);
  });

  it('no_unusual_action passes when the action was taken before, and names a look-up it did not count', () => {
    expect(noUnusualAction.evaluate({ ...base, caseHistory: history(6, 'send_money', 1) }).message).toBe('No unusual action: every tool this run called that is known to act was called in the 6 earlier runs of its case');
    const result = noUnusualAction.evaluate({ ...base, toolCalls: calls('get_balance', 'get_iban'), caseHistory: history(6) });
    expect(result.passed).toBe(true);
    expect(result.message).toContain('a look-up none of them made (get_iban) is noted and not counted');
  });

  it('no_unusual_action names a tool nothing places, does not count it, and says what places it', () => {
    const one = noUnusualAction.evaluate({ ...base, toolCalls: calls('get_balance', 'calculator'), caseHistory: history(6) });
    expect(one.passed).toBe(true);
    expect(one.value).toEqual({ stat: 'unusual_actions', unit: 'tools', value: 0 });
    expect(one.message).toBe(
      'No unusual action: every tool this run called that is known to act was called in the 6 earlier runs of its case; a tool none of them called that neither the catalogue nor its name places (calculator) is noted and not counted: readOnlyHint in the tools catalogue places it, false for a tool that acts',
    );
    // Beside a counted action it is still said, and still not in the count or the evidence.
    const both = noUnusualAction.evaluate({ ...base, toolCalls: calls('get_balance', 'send_money', 'calculator', 'Glob'), caseHistory: history(6) });
    expect(both.passed).toBe(false);
    expect(both.value).toEqual({ stat: 'unusual_actions', unit: 'tools', value: 1 });
    expect(both.message).toBe(
      'Unusual action for this case: send_money, called in none of its 6 earlier runs; 2 tools none of them called that neither the catalogue nor their names place (calculator, Glob) are noted and not counted: readOnlyHint in the tools catalogue places them, false for a tool that acts',
    );
    expect(both.evidence?.filter((e) => e.type === 'toolCall').map((e) => (e as { toolName: string }).toolName)).toEqual(['send_money']);
    // The catalogue says it acts: counted.
    const placed = noUnusualAction.evaluate({ ...base, toolCalls: calls('get_balance', 'calculator'), tools: [{ name: 'calculator', annotations: { readOnlyHint: false } }], caseHistory: history(6) });
    expect([placed.passed, placed.message]).toEqual([false, 'Unusual action for this case: calculator, called in none of its 6 earlier runs']);
  });

  it('no_unusual_action gives its own reason for taking no part in the verdict below five earlier runs, on a pass as on a fail', () => {
    for (const m of [CASE_HISTORY_MIN, CASE_HISTORY_WEIGH_MIN - 1]) {
      const why = `the case has ${m} earlier runs by this agent, and the rule is weighed in the verdict from ${CASE_HISTORY_WEIGH_MIN}`;
      const fail = noUnusualAction.evaluate({ ...base, caseHistory: history(m) });
      expect([fail.passed, fail.skipped, fail.advisoryWhy], `fail at ${m}`).toEqual([false, undefined, why]);
      const pass = noUnusualAction.evaluate({ ...base, caseHistory: history(m, 'send_money', 1) });
      expect([pass.passed, pass.advisoryWhy], `pass at ${m}`).toEqual([true, why]);
    }
    for (const m of [CASE_HISTORY_WEIGH_MIN, CASE_HISTORY_WINDOW]) {
      expect(noUnusualAction.evaluate({ ...base, caseHistory: history(m) }).advisoryWhy, `at ${m}`).toBeUndefined();
      expect(noUnusualAction.evaluate({ ...base, caseHistory: history(m, 'send_money', 1) }).advisoryWhy, `at ${m}`).toBeUndefined();
    }
    // Earlier runs whose calls were not recorded are not counted towards the five.
    expect(noUnusualAction.evaluate({ ...base, caseHistory: [...history(4), run(null), run(null)] }).advisoryWhy).toContain('the case has 4 earlier runs');
    // The measurement beside it has no such line: it decides nothing at any length.
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(3) }).advisoryWhy).toBeUndefined();
  });

  it('no_unusual_action declines four ways, each saying which', () => {
    const none = noUnusualAction.evaluate({ output: 'x', caseHistory: history(6) });
    expect([none.skipped, none.skipReason]).toEqual([true, expect.stringContaining('context.toolCalls not provided')]);
    const few = noUnusualAction.evaluate({ ...base, caseHistory: history(2) });
    expect([few.skipped, few.skipReason]).toEqual([true, 'insufficient_history: 2 earlier runs of this case by this agent with recorded tool calls, 3 needed']);
    // A case with no earlier run is not the same as a call with no stored case behind it.
    expect(noUnusualAction.evaluate({ ...base, caseHistory: [] }).skipReason).toBe('insufficient_history: 0 earlier runs of this case by this agent with recorded tool calls, 3 needed');
    expect(noUnusualAction.evaluate(base).skipReason).toBe('insufficient_history: no stored case (evaluate a stored trace that has a case_key or an input, by its trace_id)');
    const own = ['delete_file', 'post_message', 'create_event', 'update_password'];
    const scattered = noUnusualAction.evaluate({ ...base, caseHistory: history(6).map((r, i) => (i < 4 ? run([...r.tools!, own[i]]) : r)) });
    expect([scattered.skipped, scattered.skipReason]).toEqual([true, 'no_usual_way: 4 of the 6 earlier runs of this case each took an action none of the others took']);
    const nameless = noUnusualAction.evaluate({ ...base, toolCalls: [{ tool_name: '' }], caseHistory: history(6) });
    expect(nameless.skipReason).toContain('unreadable_trajectory');
  });

  it('no_dropped_step fails naming the step, judges an explicit empty list, and declines when no tool was called by every earlier run', () => {
    const dropped = noDroppedStep.evaluate({ ...base, toolCalls: calls('get_balance'), caseHistory: history(6, 'send_money', 6) });
    expect(dropped.passed).toBe(false);
    expect(dropped.message).toBe('Dropped step for this case: send_money, called in every one of its 6 earlier runs and not in this one');
    expect(dropped.evidence).toEqual([
      { type: 'count', stat: 'dropped_steps', unit: 'tools', value: 1, threshold: 0, thresholdSource: 'rule' },
      { type: 'pattern', name: 'dropped_step:send_money', count: 6 },
    ]);
    const empty = noDroppedStep.evaluate({ output: 'x', toolCalls: [], caseHistory: history(6) });
    expect([empty.skipped, empty.passed]).toEqual([undefined, false]);
    expect(noDroppedStep.evaluate({ output: 'x', caseHistory: history(6) }).skipped).toBe(true);
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(6) }).message).toBe('No dropped step: this run called the one tool that every one of the 6 earlier runs of its case called');
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(6, 'send_money', 5) }).passed).toBe(true);
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(5, undefined, 0, []) }).skipReason).toBe('no_usual_step: no tool was called by every one of the 5 earlier runs of this case');
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(1) }).skipReason).toBe('insufficient_history: 1 earlier run of this case by this agent with recorded tool calls, 3 needed');
  });

  it('no_dropped_step declines a run with more calls than were read: a step may be among the rest', () => {
    const many = calls(...Array.from({ length: MAX_STEPS_DERIVED + 5 }, () => 'get_balance'));
    const result = noDroppedStep.evaluate({ ...base, toolCalls: many, caseHistory: history(6, 'send_money', 6) });
    expect([result.skipped, result.skipReason]).toEqual([true, `partial_trajectory: ${MAX_STEPS_DERIVED} of ${MAX_STEPS_DERIVED + 5} calls read`]);
  });

  it('a result quotes tool names and nothing else, each held to its limit and at most five of them', () => {
    const long = 'export_records_'.repeat(40);
    const earlier = Array.from({ length: 4 }, () => run([...Array.from({ length: 9 }, (_, i) => `step_${i}`), long.slice(0, MAX_TOOL_NAME_CHARS)]));
    const result = noDroppedStep.evaluate({ ...base, toolCalls: calls('other'), caseHistory: earlier });
    expect(result.passed).toBe(false);
    expect(result.message).toContain(`and ${10 - MAX_NAMES_IN_MESSAGE} more`);
    expect(result.message.length).toBeLessThan(MAX_NAMES_IN_MESSAGE * (MAX_TOOL_NAME_CHARS + 2) + 200);
    for (const e of result.evidence ?? []) if (e.type === 'pattern') expect(e.name.length).toBeLessThanOrEqual('dropped_step:'.length + MAX_TOOL_NAME_CHARS);
    const unusual = noUnusualAction.evaluate({ ...base, toolCalls: calls(long), caseHistory: history(6) });
    expect(unusual.message).not.toContain(long);
    expect(unusual.message).toContain(long.slice(0, MAX_TOOL_NAME_CHARS));
  });
});

/*
 * The rule against its written definition, case by case. Thirty-two of
 * these were the rule's proof family while it was a measurement: synthetic
 * histories chosen so that every label follows from a count stated in the
 * case's note. The proof family is now AgentDojo's runs, which say what a
 * fire is worth; these still say the code does what the definition says,
 * so they are held here. When a name that says nothing stopped being
 * counted, its case moved to negative and two were added: the same name
 * placed by the catalogue, and a shell by its name. A third came when the
 * first verb in a name came to decide: a look-up whose object is also a
 * word that acts. Four more came when a tool reached through MCP was read
 * by its own name and a joiner joined only the verb next to it.
 */
describe('no_unusual_action does what its definition says, on thirty-nine cases labelled by counting', () => {
  const file = JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'case-history', 'no_unusual_action.definition.json'), 'utf-8')) as {
    cases: Array<{ id: string; label: 'positive' | 'negative'; input?: string; output: string; context?: Partial<EvalContext>; notes: string }>;
  };

  it('holds every case, with both labels well represented', () => {
    expect(file.cases).toHaveLength(39);
    expect(file.cases.filter((c) => c.label === 'positive').length).toBe(20);
  });

  for (const c of file.cases) {
    it(`${c.id}: ${c.label === 'positive' ? 'fails' : 'does not fail'}`, () => {
      const result = noUnusualAction.evaluate({ output: c.output, ...(c.input !== undefined ? { input: c.input } : {}), ...c.context });
      // A case the rule declines to judge is not a fire.
      expect(result.skipped !== true && result.passed === false, c.notes).toBe(c.label === 'positive');
    });
  }
});

describe('through the engine', () => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  const ctx: EvalContext = { output: 'The transfer of 420 is done and confirmed for the account.', input: 'Pay the open invoice and confirm it.', toolCalls: calls('get_balance', 'send_money') };
  type Result = Awaited<ReturnType<typeof engine.evaluateAll>>;
  const row = (result: Result, name: string) => result.rule_results.find((r) => r.ruleName === name)!;
  const decided = (r: Result) => ({ state: r.verdict?.state, basis: r.verdict?.basis, by: r.verdict?.by, also: r.verdict?.also, passed: r.passed });

  it('a call with no history skips both', async () => {
    const result = await engine.evaluateAll(ctx);
    for (const rule of caseHistoryRules) expect(row(result, rule.name).state, rule.name).toBe('not_checked');
  });

  /*
   * What each rule does to a verdict. An action the case's earlier runs
   * never took is weighed: on a context that passes alone, the same context
   * with a history fails on the risk it carries. A dropped step is reported
   * and decides nothing.
   */
  it('an unusual action is weighed in the verdict: the context that passes alone fails with its history, on the risk layer, and says what it rests on', async () => {
    const alone = await engine.evaluateAll(ctx);
    expect(decided(alone)).toMatchObject({ state: 'pass', passed: true });
    const unusual = await engine.evaluateAll({ ...ctx, caseHistory: history(6) });
    expect(row(unusual, 'no_unusual_action')).toMatchObject({ passed: false, kind: 'inference', role: 'risk', state: 'fail' });
    expect(decided(unusual)).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['wrong_trajectory'], passed: false });
    // The number it is weighed by is one somebody else labelled, and the result says so.
    expect(row(unusual, 'no_unusual_action').uncertainty).toMatchObject({ basis: 'published_accuracy', fired: true, corpus: { labelling: 'outside' } });
    // And the operator is told what the failure rests on, the two things that can be done about it, and everything labels do.
    const note = unusual.interpretations?.find((i) => i.configKey === 'eval.advisoryRules');
    expect(note?.text).toContain('rests on no_unusual_action');
    expect(note?.text).toContain('label them');
    expect(note?.text).toContain("that rule's fires are weighed by the precision you measured. Nothing else in a verdict reads your labels: every other rule's fire, and that rule's silence, are weighed as before.");
    expect(note?.text).not.toContain('prior');
  });

  /*
   * What a fire is said to be worth. The family is about one bad run in
   * eight, and at an even prior its positive predictive value reads 97%
   * beside a measured precision of 42 of 49. So while nothing sets a prior,
   * the result is stated at the family's own mix, where the number is the
   * one observed. A deployment that set a prior is told at its own.
   */
  it('a fire states its uncertainty at the mix its runs had, not at an even prior, until the deployment sets one', async () => {
    type Fired = Extract<NonNullable<Result['rule_results'][number]['uncertainty']>, { basis: 'published_accuracy'; fired: true }>;
    const fired = row(await engine.evaluateAll({ ...ctx, caseHistory: history(6) }), 'no_unusual_action').uncertainty as Fired;
    const measured = fired.corpus.tp / (fired.corpus.tp + fired.corpus.fp);
    expect(fired.prior).toEqual({ pi: Math.round(((fired.corpus.tp + fired.corpus.fn) / fired.corpus.n) * 10_000) / 10_000, source: 'family' });
    expect(Math.abs(fired.ppv.point - measured)).toBeLessThan(0.02);
    expect(fired.ppv.lo).toBeLessThan(measured);
    expect(fired.ppv.hi).toBeGreaterThan(measured);
    // A quiet result is stated at the same mix: what was observed of the runs it stayed quiet on.
    type Quiet = Extract<NonNullable<Result['rule_results'][number]['uncertainty']>, { basis: 'published_accuracy'; fired: false }>;
    const quiet = row(await engine.evaluateAll({ ...ctx, caseHistory: history(6, 'send_money', 6) }), 'no_unusual_action').uncertainty as Quiet;
    expect(quiet.prior.source).toBe('family');
    expect(Math.abs(quiet.missRate.point - quiet.corpus.fn / (quiet.corpus.fn + quiet.corpus.tn))).toBeLessThan(0.02);
    // Every rule whose family was written here keeps the prior in force.
    const others = (await engine.evaluateAll({ ...ctx, caseHistory: history(6) })).rule_results.filter((r) => r.uncertainty?.basis === 'published_accuracy' && r.ruleName !== 'no_unusual_action');
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) expect((r.uncertainty as Fired | Quiet).prior, r.ruleName).toEqual({ pi: 0.5, source: 'default' });
    // The deployment's own prior is the one a result is stated at.
    const own = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, prior: 0.02, priorConfigured: true });
    const atOwn = row(await own.evaluateAll({ ...ctx, caseHistory: history(6) }), 'no_unusual_action').uncertainty as Fired;
    expect(atOwn.prior).toEqual({ pi: 0.02, source: 'config' });
    expect(atOwn.ppv.point).toBeLessThan(fired.ppv.point);
  });

  it('a run the history does not depart from is not failed by it, and its silence is weighed too', async () => {
    const usual = await engine.evaluateAll({ ...ctx, caseHistory: history(6, 'send_money', 6) });
    expect(row(usual, 'no_unusual_action')).toMatchObject({ passed: true, role: 'risk' });
    expect(usual.passed).toBe(true);
    expect(usual.verdict?.risk?.perClass.wrong_trajectory).not.toBeNull();
  });

  /*
   * Weighed where it was measured. With three or four earlier runs the rule
   * says what it found, and the verdict is the one the run gets with no
   * history at all: the fire is not weighed, and neither is the silence.
   */
  it('with three or four earlier runs the unusual action is reported and takes no part in the verdict; with five it is weighed', async () => {
    const alone = await engine.evaluateAll(ctx);
    for (const m of [CASE_HISTORY_MIN, CASE_HISTORY_WEIGH_MIN - 1]) {
      const why = `the case has ${m} earlier runs by this agent, and the rule is weighed in the verdict from ${CASE_HISTORY_WEIGH_MIN}`;
      const short = await engine.evaluateAll({ ...ctx, caseHistory: history(m) });
      expect(row(short, 'no_unusual_action'), `fire at ${m}`).toMatchObject({ passed: false, state: 'fail', kind: 'inference', role: 'advisory', advisory: true, advisoryWhy: why });
      expect(decided(short), `verdict at ${m}`).toMatchObject({ state: 'pass', basis: 'clean', passed: true });
      expect(short.verdict?.risk?.pBad, `risk at ${m}`).toBe(alone.verdict?.risk?.pBad);
      // The reader is told why the failed rule sits beside a pass, in the rule's own words, with no setting named.
      const note = short.interpretations?.find((i) => i.rule === 'no_unusual_action');
      expect(note?.text).toBe(`no_unusual_action failed and took no part in this verdict: ${why}. It reports what it found and neither vetoes nor enters the risk estimate.`);
      expect(note?.configKey).toBeUndefined();
      const quiet = await engine.evaluateAll({ ...ctx, caseHistory: history(m, 'send_money', m) });
      expect(row(quiet, 'no_unusual_action'), `silence at ${m}`).toMatchObject({ passed: true, role: 'advisory', advisory: true, advisoryWhy: why });
      expect(quiet.verdict?.risk?.pBad, `risk of a quiet run at ${m}`).toBe(alone.verdict?.risk?.pBad);
    }
    const weighed = await engine.evaluateAll({ ...ctx, caseHistory: history(CASE_HISTORY_WEIGH_MIN) });
    expect(row(weighed, 'no_unusual_action')).toMatchObject({ passed: false, role: 'risk' });
    expect(row(weighed, 'no_unusual_action').advisory).toBeUndefined();
    expect(row(weighed, 'no_unusual_action').advisoryWhy).toBeUndefined();
    expect(decided(weighed)).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['wrong_trajectory'] });
  });

  it('a deployment that made the rule critical has said every fire decides, so a short history does not set it aside', async () => {
    const promoted = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, criticalRules: ['no_unusual_action'] });
    const result = await promoted.evaluateAll({ ...ctx, caseHistory: history(CASE_HISTORY_MIN) });
    expect(row(result, 'no_unusual_action')).toMatchObject({ passed: false, critical: true, role: 'veto' });
    expect(row(result, 'no_unusual_action').advisory).toBeUndefined();
    expect(row(result, 'no_unusual_action').advisoryWhy).toBeUndefined();
    expect(result.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['no_unusual_action'] });
  });

  /*
   * Only the engine says a result took no part in the verdict. A rule may
   * give a reason for its own result, and the engine honours it where it
   * lowers a weight: on a detection or an inference that is not critical.
   * A policy's gate and a critical rule's veto are somebody's decision, so
   * a rule that returns a reason, or sets the flag itself, cannot talk
   * its way out of either, and its row does not claim it did.
   */
  it('a rule cannot set its own gate or veto aside by giving a reason, and cannot set the flag itself', async () => {
    const probe = async (kind: 'policy' | 'detection' | 'measurement', critical: boolean) => {
      const e = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
      const name = `probe_${kind}${critical ? '_critical' : ''}`;
      e.registerRule('completeness', {
        name,
        description: 'a rule that gives a reason for its own result',
        evalType: 'completeness',
        weight: 1,
        kind,
        ...(critical ? { critical: true } : {}),
        evaluate: () => ({ ruleName: name, passed: false, score: 0, message: 'fired', advisory: true, advisoryWhy: 'the rule says so' }),
      });
      const result = await e.evaluateAll(ctx);
      return { row: result.rule_results.find((r) => r.ruleName === name)!, verdict: result.verdict!, note: result.interpretations?.find((i) => i.rule === name) };
    };
    // A policy with no shipped threshold gates. Its reason is not honoured, and the row says gate.
    const policy = await probe('policy', false);
    expect(policy.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['probe_policy'] });
    expect([policy.row.role, policy.row.advisory, policy.row.advisoryWhy]).toEqual(['gate', undefined, undefined]);
    // A critical detection vetoes.
    const veto = await probe('detection', true);
    expect(veto.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['probe_detection_critical'] });
    expect([veto.row.role, veto.row.advisory, veto.row.advisoryWhy]).toEqual(['veto', undefined, undefined]);
    // A detection that is weighed: the reason is honoured, and said.
    const weighed = await probe('detection', false);
    expect([weighed.row.role, weighed.row.advisory, weighed.row.advisoryWhy]).toEqual(['advisory', true, 'the rule says so']);
    expect(weighed.note?.text).toBe('probe_detection failed and took no part in this verdict: the rule says so. It reports what it found and neither vetoes nor enters the risk estimate.');
    // A measurement already only reports: no flag, no reason, nothing changed.
    const measurement = await probe('measurement', false);
    expect([measurement.row.role, measurement.row.advisory, measurement.row.advisoryWhy]).toEqual(['advisory', undefined, undefined]);
  });

  it('a reason that is no reason sets nothing aside: an empty string, blank space, or a value that is not text', async () => {
    for (const [label, advisoryWhy] of [['empty', ''], ['blank', '   '], ['null', null], ['a number', 7], ['an object', {}]] as const) {
      const e = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
      e.registerRule('completeness', {
        name: 'probe_unreasoned',
        description: 'a detection whose reason is not one',
        evalType: 'completeness',
        weight: 1,
        kind: 'detection',
        evaluate: () => ({ ruleName: 'probe_unreasoned', passed: false, score: 0, message: 'fired', advisoryWhy }) as unknown as EvalRuleResult,
      });
      const fired = (await e.evaluateAll(ctx)).rule_results.find((r) => r.ruleName === 'probe_unreasoned')!;
      // Nothing was set aside: no `advisory`, no reason. Its role is the one any detection with no published accuracy has, since no layer reads it.
      expect([fired.role, fired.advisory, fired.advisoryWhy], label).toEqual(['advisory', undefined, undefined]);
    }
  });

  /*
   * What a result found is the rule's to say; its standing is the engine's.
   * A rule that set `critical`, `kind`, `role` or `state` on its own result
   * used to have it carried onto the row over the engine's stamp: a result
   * that said critical vetoed while its row read advisory, and one that
   * said not critical lost the veto its rule declares.
   */
  it('a rule cannot give its own result a standing: critical, kind, role and state are the engine\'s to stamp', async () => {
    const run = async (declared: { kind?: 'detection' | 'policy'; critical?: boolean }, returned: Record<string, unknown>) => {
      const e = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
      e.registerRule('completeness', {
        name: 'probe_standing',
        description: 'a rule that says what standing its own result has',
        evalType: 'completeness',
        weight: 1,
        ...declared,
        evaluate: () => ({ ruleName: 'probe_standing', passed: false, score: 0, message: 'fired', ...returned }) as unknown as EvalRuleResult,
      });
      const result = await e.evaluateAll(ctx);
      return { row: result.rule_results.find((r) => r.ruleName === 'probe_standing')!, verdict: result.verdict! };
    };
    // A detection that is not critical says it is, and gives a reason for reporting only: it reports only, and vetoes nothing.
    const claimsVeto = await run({ kind: 'detection' }, { critical: true, criticalSource: 'config', advisoryWhy: 'the rule says so' });
    expect(claimsVeto.row).toMatchObject({ critical: false, criticalSource: 'default', role: 'advisory', advisory: true });
    expect(claimsVeto.verdict.basis).not.toBe('detector_veto');
    // A rule declared critical says its result is not: the veto its rule declares stands.
    const disownsVeto = await run({ kind: 'detection', critical: true }, { critical: false, role: 'advisory' });
    expect(disownsVeto.row).toMatchObject({ critical: true, role: 'veto' });
    expect(disownsVeto.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['probe_standing'] });
    // A rule that declares no kind does not become a policy by saying so, and a failed result is not a pass by saying so.
    const claimsKind = await run({}, { kind: 'policy', state: 'pass' });
    expect(claimsKind.row.kind).toBeUndefined();
    expect(claimsKind.row.state).toBe('fail');
    expect(claimsKind.verdict.basis).not.toBe('policy_gate');
  });

  it('a deployment that names it in eval.advisoryRules is the standing reason, at any length of history', async () => {
    const quiet = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, advisoryRules: ['no_unusual_action'] });
    const result = await quiet.evaluateAll({ ...ctx, caseHistory: history(CASE_HISTORY_MIN) });
    expect(row(result, 'no_unusual_action')).toMatchObject({ passed: false, advisory: true, role: 'advisory' });
    expect(row(result, 'no_unusual_action').advisoryWhy).toBeUndefined();
    expect(result.interpretations?.find((i) => i.rule === 'no_unusual_action')?.configKey).toBe('eval.advisoryRules');
  });

  it('a deployment that names it in eval.advisoryRules has it report only', async () => {
    const quiet = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, advisoryRules: ['no_unusual_action'] });
    const result = await quiet.evaluateAll({ ...ctx, caseHistory: history(6) });
    expect(row(result, 'no_unusual_action')).toMatchObject({ passed: false, state: 'fail', advisory: true, role: 'advisory' });
    expect(result.passed).toBe(true);
  });

  it('a dropped step is reported and decides nothing: the verdict with a history and without is the same verdict', async () => {
    const alone = await engine.evaluateAll(ctx);
    const dropped = await engine.evaluateAll({ ...ctx, caseHistory: history(6, 'delete_file', 6) });
    expect(row(dropped, 'no_dropped_step')).toMatchObject({ kind: 'measurement', role: 'advisory', state: 'fail' });
    // The history holds send_money in none of its runs here, so the unusual action is set aside to read the dropped step alone.
    const quiet = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, advisoryRules: ['no_unusual_action'] });
    const droppedOnly = await quiet.evaluateAll({ ...ctx, caseHistory: history(6, 'delete_file', 6) });
    expect(row(droppedOnly, 'no_dropped_step').state).toBe('fail');
    expect(decided(droppedOnly)).toMatchObject({ state: decided(alone).state, passed: decided(alone).passed });
  });

  it('the tool-use question is judged by the rules that already judged it, so a history changes no coverage', async () => {
    const tool = (r: Result) => r.coverage?.questions.find((q) => q.id === 'tool_use_correct')?.status;
    expect(tool(await engine.evaluateAll(ctx))).toBe('judged');
    expect(tool(await engine.evaluateAll({ ...ctx, caseHistory: history(6) }))).toBe('judged');
    const noCalls: EvalContext = { output: ctx.output, input: ctx.input };
    expect(tool(await engine.evaluateAll(noCalls))).toBe(tool(await engine.evaluateAll({ ...noCalls, caseHistory: history(6) })));
  });

  it('a deployment that names it in eval.criticalRules has chosen to let it decide', async () => {
    const promoted = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, criticalRules: ['no_unusual_action'] });
    const result = await promoted.evaluateAll({ ...ctx, caseHistory: history(6) });
    expect(result.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['no_unusual_action'] });
  });
});
