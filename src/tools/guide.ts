/*
 * The long form of every tool: how it behaves, when another call is the
 * better one, and every error it can return.
 *
 * A tool's description in tools/list is capped (src/tools/describe.ts)
 * because every session of the agent being evaluated pays for it in
 * context. What an agent needs only once it has chosen the tool — the
 * statistics behind a comparison, the fetch guards, each rule type's config
 * keys — lives here and is served as `toolGuide` in iris://capabilities
 * and GET /api/v1/capabilities, where it is read on request. `returns`
 * is read from each tool's full output schema, so the meaning of a field
 * is written once, on the schema.
 */
import { RULE_ALPHA } from '../eval/compare.js';
import { INJECTION_SCOPE_SENTENCE } from '../eval/rules/safety.js';
import { JUDGE_COST_CAP_VAR, JUDGE_DEFAULT_COST_CAP_USD, JUDGE_KEY_VARS } from '../judge-enablement.js';
import { OUTPUT_SCHEMAS, TOOL_NAMES, type ToolName } from './index.js';

export interface ToolGuide {
  does: string;
  whenNot: string;
  errors: string;
  /** Parameter → the full explanation, where the schema's own description is the short form. */
  parameters?: Record<string, string>;
}

export interface ServedToolGuide extends ToolGuide {
  /** Output field → what it means, from the output schema. */
  returns: Record<string, string>;
}

const TOOL_GUIDE: Record<ToolName, ToolGuide> = {
  log_trace: {
    does:
      'Writes one trace row to local SQLite and mints a fresh trace_id; nothing is deduplicated, so resubmitting the same payload stores a second trace. ' +
      'Only agent_name is required. Store what you have: tool_calls so the trajectory rules can later judge what the agent did, cost_usd and token_usage so the cost rules can, input and output so everything else can. ' +
      'Pass evaluate: true (with output) to score the stored trace in this same call under exactly the rules evaluate_output runs; the response then carries the full evaluation and links it. ' +
      'When IRIS_OTEL_ENDPOINT is set the trace is also exported to that collector, best-effort and asynchronous; the local write never waits on it. ' +
      'Traces are immutable: there is no update path. In stdio mode nothing authenticates the caller; over HTTP a Bearer token is required only when an API key is configured.',
    whenNot:
      'For a transient log line (use your logger). To score a trace you already stored: evaluate_output with its trace_id, which reuses the stored tool_calls and tools. To change a stored trace: delete_trace and log again.',
    errors:
      'IRIS_STORAGE_ERROR when the database cannot be written. IRIS_INVALID_ARGUMENT when evaluate is true without output, or on a server with no eval engine — nothing is stored in either case. ' +
      'An unknown argument or a malformed span or tool_calls entry is refused before the handler runs, naming the valid keys.',
    parameters: {
      tool_calls:
        'Tool calls made during execution, in order, each { tool_name, input?, output?, latency_ms?, error? } — what the trajectory rules judge; evaluate_output reuses them when given this trace_id',
      tools:
        'What the agent COULD have called — your MCP tools/list result, pasted verbatim: [{ name, description?, inputSchema, annotations? }]. Stored on the trace and reused by evaluate_output when given this trace_id. Without it a tool call can be seen but not CHECKED, and the rules that judge argument validity skip rather than pass',
      run:
        'Name the batch this execution belongs to — a CI job id, a nightly sweep, an afternoon of manual pokes. Two runs of the same agent can then be compared with compare_runs. Never inferred: a guessed grouping produces a comparison nobody can act on',
      case_key:
        'What makes this the same QUESTION as a trace in another run — a fixture name, a test id. Supplying it PAIRS the two, and a paired comparison sees a regression an unpaired one cannot. Omit it and a key is derived from the input, so pairing still works',
      session_id:
        'The conversation this turn belongs to — the same id on every turn groups them: the trace drawer shows the other turns, get_traces filters by session, compare_traces can group by it. Read from the SEP-414 baggage session_id when omitted',
      evaluate:
        'Score the stored trace in this same call, under exactly the rules evaluate_output runs (every bundle unless eval_type names one). Requires output. The response then carries the full evaluation — verdict, basis, every rule result, coverage — and links it',
      eval_type:
        'With evaluate: true, the bundle to run — completeness | relevance | safety | cost | custom | all. Omitted: every bundle runs and the evaluation carries a note saying the default ran',
    },
  },
  evaluate_output: {
    does:
      'In-process, no network, no key. eval_type picks one bundle (completeness, relevance, safety, cost, custom) or all (the default): every bundle plus deployed and inline custom rules, with a per-bundle breakdown; an omitted eval_type runs every bundle, safety included, and the response carries a note saying the default ran. ' +
      'Inputs decide what can be judged: input is REQUIRED when eval_type="relevance" (keyword_overlap, topic_consistency and answers_the_ask compare the output against it, tool_choice reads it beside tool_calls and tools; all four skip without it) and grounds the hallucination signals; ' +
      'tool_calls (or a trace_id) feed the trajectory rules, and tools lets them check argument validity; cost_usd and token_usage feed the cost rules; expected feeds expected_coverage. ' +
      'A rule without its input SKIPS, is named, and never counts as a pass: an evaluation with no trajectory data reports "not judged", never "clean". custom_rules always fire, whatever eval_type says. One row is stored, linked to trace_id.',
    whenNot:
      'To validate a document (the json_schema custom rule does that). ' +
      `To screen inputs before they reach an agent: ${INJECTION_SCOPE_SENTENCE} ` +
      'For semantic judgment, evaluate_with_llm_judge and verify_citations need a key you supply.',
    errors:
      'IRIS_UNKNOWN_TRACE when trace_id names no stored trace — checked first, nothing scored or written. IRIS_STORAGE_ERROR when the row cannot be written. ' +
      'Unknown arguments or keys are refused before the handler runs, naming the valid ones; a regex rule over its budget or with a broken config reports skipped, not an error.',
    parameters: {
      eval_type:
        'Rule bundle to apply: completeness | relevance | safety | cost | custom | all — picks which built-in rules fire. "all" runs every bundle in one call and adds a per-category breakdown. Defaults to "all" when omitted — every bundle runs, safety included, and the response carries a note saying the default ran',
      expected_trajectory:
        'What the agent was expected to DO: tool_calls [{ tool_name, input? }] with a mode (strict | unordered | subset | superset | ordered_subset, default ordered_subset) and args (exact | subset, default subset) for tool_sequence; step_budget and tolerance (default 1.5) for step_budget',
      input:
        'Original input for context (the ask + any source material the agent was given) — REQUIRED when eval_type="relevance" (keyword_overlap, topic_consistency and answers_the_ask compare the output against it, tool_choice reads it beside tool_calls and tools; all four skip without it); also grounds the safety bundle\'s hallucination signals',
      custom_rules:
        'Custom evaluation rules, max 10 per call (deploy persistent rule sets via deploy_rule instead) — fires REGARDLESS of eval_type; pass eval_type="custom" if you want ONLY these. Each entry accepts exactly name, type, config, weight, severity — an unknown key is rejected',
      cost_usd:
        'Cost in USD — consulted by the cost bundle (eval_type="cost" or "all") AND by any cost_threshold custom rule regardless of eval_type; omit it and such a rule skips rather than passes (a critical one is listed in critical_skipped)',
      tools:
        'What the agent COULD have called — your MCP tools/list result, pasted verbatim. Needed to judge whether a call carried valid arguments; without it the rules that check that SKIP rather than pass. Loaded from the trace when trace_id names one that carries it',
      tool_calls:
        'What the agent DID — the tool calls it made, in order, each { tool_name, input?, output?, latency_ms?, error? } exactly as log_trace records them. Read by the trajectory rules — the rules that judge what the agent DID rather than what it wrote. Omit it and those rules SKIP rather than pass — an evaluation with no trajectory data reports "not judged", never "clean". When trace_id names a stored trace and this argument is omitted, the tool_calls stored on that trace are loaded and used, so a caller who already logged them need not resend them',
    },
  },
  get_traces: {
    does:
      'Read-only, local storage only. Filters are exact-match (agent_name, framework), inclusive time bounds (since, until — an ISO 8601 timestamp or date) and a score range applied to the LATEST evaluation of each trace (min_score, max_score, 0..1). ' +
      'limit is 1..1000 (default 50), offset counts from 0, sort_by is timestamp, latency_ms or cost_usd, sort_order asc or desc (default: newest first). include_summary adds the one-hour dashboard aggregates. ' +
      'A crossed range (min above max, since after until) is refused naming both values rather than returning an empty page that reads as "no such traces".',
    whenNot:
      'To score a trace (evaluate_output). To create one (log_trace). As a live stream: this is a query, and Iris has no event stream — poll with backoff.',
    errors:
      'IRIS_STORAGE_ERROR when the database cannot be read. An out-of-range or crossed bound is refused before the handler runs, naming the values. An empty result is total 0, not an error.',
    parameters: {
      since:
        'ISO 8601 timestamp (or date) lower bound — return traces with timestamp >= this; anything that is not an ISO timestamp is rejected, never treated as "no bound"',
      min_score:
        'Minimum eval score filter (0..1; values outside are rejected) — applied to LATEST eval per trace, not all evals; must be <= max_score when both are set',
    },
  },
  compare_runs: {
    does:
      'Reads every evaluation in each run (most recent per trace) and compares pass rates. ' +
      'When the runs share case keys it PAIRS them and runs McNemar exact on the cases that disagreed (named, with the rules that flipped), which sees a change an unpaired test cannot; else a Newcombe interval on two proportions. ' +
      'Says "not enough evidence" — with the smallest change that many cases could have seen — rather than guessing. ' +
      `Tests each rule one-sided and corrects the p-values together (Benjamini–Hochberg): a rule is marked worse only at q ≤ ${RULE_ALPHA}. ` +
      'States equivalence within equivalence_margin (default: the smallest detectable difference) when the 90% interval lies inside ±δ. ' +
      'Refuses runs that measure different things (ruleset, config, engine minor, agent), naming which; force compares anyway, and the response still names what changed. ' +
      'Deterministic, local, no model call.',
    whenNot:
      'To score one output (evaluate_output). To find the traces (get_traces). To gate a deploy: this tool reports; whether a difference blocks is your policy.',
    errors:
      'IRIS_INVALID_ARGUMENT when a run id is empty, no baseline is pinned for an omitted before, equivalence_margin is outside (0, 1], or dataset names none. IRIS_STORAGE_ERROR when the database cannot be read. ' +
      'An unknown or empty run is not an error: n is 0 and the summary says which.',
    parameters: {
      force:
        'compare even when the runs are not strictly comparable (different ruleset, configuration, engine minor or agent). The response still names what changed — a pass rate that moved because the RULES changed is not a regression in your agent',
      dataset:
        'Restrict both runs to the case keys in this dataset (its id or label — POST /api/v1/datasets promotes the case keys of a run into one). Pairing and every count then cover only those cases; the response says how many rows each run matched',
    },
  },
  compare_traces: {
    does:
      'Groups every evaluation by case_key (supplied on log_trace, or derived from the input) and reports how often each case passed, with a 95% Wilson interval per case. ' +
      'A case answered both ways is FLAKY, least reliable first: that is where determinism is worth buying, and a single run cannot show it. ' +
      'The overall rate uses a cluster bootstrap over CASES, not pooled attempts — ten repeats of one question are one question, and pooling claims an n the data never earned. The pooled figure is shown beside it. ' +
      'Deterministic, local, no model call.',
    whenNot:
      'To compare two runs against each other (compare_runs). To score an output (evaluate_output). To read the traces themselves (get_traces).',
    errors:
      'IRIS_STORAGE_ERROR when the database cannot be read. No matching evaluations is NOT an error: cases is 0 and the summary says nothing matched.',
  },
  evaluate_runs: {
    does:
      'Reads each trace in the source run and re-runs the deterministic rules on the stored execution, writing the verdicts into a NEW run stamped as a re-evaluation of the source. The source run is never modified. ' +
      'A trace whose latest verdict already came from the current ruleset is skipped and counted, so calling this twice does no work the second time. ' +
      'Pass the two run ids to compare_runs afterwards and the difference is attributable to the rules, because the executions are identical. ' +
      'Deterministic, local, no model call, nothing spent.',
    whenNot:
      'To score a new execution (log_trace then evaluate_output). To compare two runs (compare_runs). To re-score a single trace (evaluate_output with its trace_id).',
    errors:
      'IRIS_INVALID_ARGUMENT when the run id is empty or the target run already holds verdicts. IRIS_UNKNOWN_TRACE when the source run has no traces. IRIS_STORAGE_ERROR when the database cannot be read. ' +
      'A trace that cannot be scored does NOT fail the call: it is listed in failed with its reason and the rest still run.',
    parameters: {
      into:
        'the run id for the new verdicts. Defaults to `<run>+reeval-<ruleset hash>`, which is stable: re-running the same rules over the same run lands in the same place rather than creating a new run each time',
    },
  },
  list_rules: {
    does:
      'Read-only, no network. built_in is the shipped roster and is never narrowed by the filters. For each rule: kind (measurement, detection, inference, judgment, policy, verification), mechanism, needs (the inputs it reads — absent means the rule skips, never passes), question, classes, version, weight, ' +
      'the EFFECTIVE critical flag with criticalSource (default, or config when eval.criticalRules / eval.nonCriticalRules changed it on this server — read it before trusting a passed: true), ' +
      'and proof: precision and recall with 95% intervals and the positive predictive value at four prevalences, the numbers published at https://iris-eval.com/proof. ' +
      'rules is the custom-rule store, filterable by eval_type and enabled_only; total and enabled_count count custom rules. quarantined lists store entries this version could not validate. plugins lists the rules loaded from eval.plugins.',
    whenNot:
      'To count traces (get_traces). To add, remove or pause a rule (deploy_rule, delete_rule). Built-in rules are not in the store and cannot be deployed, deleted or disabled.',
    errors: 'IRIS_INTERNAL_ERROR if the store file cannot be read. A missing store file is an empty list, not an error.',
  },
  deploy_rule: {
    does:
      'Writes the rule to ~/.iris/custom-rules.json, appends a rule.deploy audit entry and registers it with the running engine, so it fires on the very next call and survives restarts. ' +
      'eval_type says WHEN it fires (that bundle, and eval_type="all"); severity says what a failure DOES: low and medium only lower the weighted score, high and critical force passed to false and list the rule in critical_failures. ' +
      'definition.type picks the check and definition.config carries its keys: regex_match and regex_no_match take pattern; min_length takes min_length; max_length takes max_length; contains_keywords and excludes_keywords take keywords; cost_threshold takes max_cost; json_schema takes an optional schema; action_policy takes allow and/or deny. ' +
      'action_policy judges the TRAJECTORY: allow and deny rules name a tool by glob and its arguments by JSON Pointer, deny wins, and `allow` being present means a tool it does not name is DENIED. ' +
      'It ADVISES until you deploy it at severity high or critical — a deny list you deploy at the default severity does not block, and its own message says so on every result. ' +
      'Any bundle and type combine. Names are unique: a taken name is refused unless replace is true, which retires the earlier rule(s) first and reports them. Argument names are snake_case; the camelCase aliases evalType and sourceMomentId are accepted — pass one spelling of each.',
    whenNot:
      'To try a rule first: POST /api/v1/rules/custom/preview on the dashboard replays a definition against stored traces without deploying. For a one-off check on one call: the custom_rules argument of evaluate_output. To pause a rule: delete_rule with enabled: false.',
    errors:
      'IRIS_DUPLICATE_RULE when the name is deployed and replace is false (the message names the existing id). ' +
      'IRIS_INVALID_RULE_CONFIG when the definition is rejected — a regex that fails the ReDoS check or exceeds 1000 characters, a missing config key — naming the field; nothing is deployed. ' +
      'IRIS_STORAGE_ERROR when the store cannot be written. An unknown key in definition, a name over 80 characters, a non-positive weight or both spellings of an alias are refused before the handler runs.',
    parameters: {
      'definition.name':
        'Optional and IGNORED if given — the server overwrites it with the top-level `name` so the rule reports under one name everywhere',
      eval_type:
        'Eval category this rule belongs to; the rule fires on evaluate_output calls whose eval_type equals it (and on eval_type="all"). Canonical snake_case spelling — pass exactly one of eval_type / evalType',
      definition:
        'Check definition (regex, length, keyword, cost, or schema). Accepts exactly type, config, weight and an optional name — an unknown key is rejected',
      source_moment_id:
        'Optional Decision Moment ID the rule was derived from (preserves workflow-inversion provenance). Canonical snake_case — pass exactly one of source_moment_id / sourceMomentId',
      replace:
        'When a rule with this name is already deployed: false (default) rejects the call; true deletes the existing same-named rule(s) and deploys this one in their place (fresh id; audit rows preserved)',
    },
  },
  delete_rule: {
    does:
      "Without enabled: deletes the rule from ~/.iris/custom-rules.json, appends a rule.delete audit entry and unregisters it from the running engine; deleted is false when no rule has that id (already gone, or not this tenant's), and no audit row is written twice. " +
      'With enabled: the rule stays with its history and provenance; false stops it firing at once and keeps it off across restarts, true brings it back under the same id; a rule.toggle audit entry is written unless the flag was already in that state. ' +
      'Past evaluations that referenced the rule are untouched either way.',
    whenNot:
      'On built-in rules: they are not in the store and cannot be deleted or disabled. To delete a trace (delete_trace). To replace a rule: deploy_rule with the same name and replace: true.',
    errors:
      'IRIS_STORAGE_ERROR when the store cannot be written. A malformed rule_id (not rule-<hex>) or an unknown argument is refused before the handler runs.',
    parameters: {
      enabled:
        'When present the rule is NOT deleted: false DISABLES it (kept in the store, stops firing immediately, history and provenance preserved); true RE-ENABLES a disabled rule. Omit to delete',
    },
  },
  delete_trace: {
    does:
      "Deletes the trace row for the caller's tenant. Spans cascade. Evaluations linked to it keep their verdict, scores, criticality and evidence offsets; their output text, expected text and rule messages are erased in the same transaction and erased_at is stamped, so no text from the trace survives in any evaluation. " +
      "deleted is false when no trace has that id — already removed, or not this tenant's — and that is not an error. A deletion appends a trace.delete audit entry (read it at iris://audit), so evidence cannot vanish without a record.",
    whenNot:
      'To expire old data in bulk (retention.days; the sweep runs at boot and every retention.sweepIntervalHours). To delete evaluations: they are not deleted per row; retention and --purge cover them. To pause anything: traces are immutable, there is nothing to pause.',
    errors: 'IRIS_STORAGE_ERROR when the delete cannot run. A malformed trace_id (not 32 lowercase hex) is refused before the handler runs.',
  },
  evaluate_with_llm_judge: {
    does:
      `Calls Anthropic or OpenAI directly with the key in this process's environment (${JUDGE_KEY_VARS.anthropic} or ${JUDGE_KEY_VARS.openai}); Iris never proxies. ` +
      'template picks the question: accuracy, helpfulness, safety, correctness (needs expected), faithfulness (needs source_material) or task_completed (pass the trajectory as source_material when you have it); input improves helpfulness and safety. model is required; provider is inferred from it. ' +
      `The worst-case spend — both attempts, full max_output_tokens — is computed BEFORE the call and refused if it exceeds max_cost_usd (default ${JUDGE_COST_CAP_VAR} or ${JUDGE_DEFAULT_COST_CAP_USD}). ` +
      'temperature defaults to 0; a rate-limited call is retried once. One evaluation row is stored with the provider response id, tokens, cost and latency, linked to trace_id when given. ' +
      'A judge from the same model family as the agent (agent_model, or the linked trace) is warned about, never refused. ' +
      "The judge's own accuracy is measurable on a key you supply and is not yet published (see iris://proof).",
    whenNot:
      'For length, keyword, PII, injection or cost checks: evaluate_output is free and deterministic. Without a key: the call returns IRIS_JUDGE_NOT_ENABLED with the enable steps — do not search for them. On very large outputs without raising max_cost_usd: the pre-check refuses.',
    errors:
      'IRIS_JUDGE_NOT_ENABLED (no key for the provider reached this process; recovery carries the steps). IRIS_JUDGE_UNKNOWN_MODEL (valid lists the models). IRIS_UNKNOWN_TRACE, checked before any spend. ' +
      'IRIS_BUDGET_EXCEEDED (nothing spent; the message carries both numbers). IRIS_PROVIDER_ERROR with kind auth, rate_limit, bad_request, server_error, timeout or malformed_response, and retryable set.',
    parameters: {
      template:
        'Judge dimension: accuracy (factual correctness), helpfulness (does it address the ask), safety (harm potential), correctness (vs reference answer — requires `expected`), faithfulness (RAG grounding — requires `source_material`), task_completed (did the task actually complete — pass the trajectory as `source_material` when you have it).',
      agent_model:
        'The model that produced the output, for the same-family check, when no linked trace records it (a trace carries it as metadata.model or a span\'s gen_ai.request.model). A judge from the agent\'s own family is warned about, never refused',
    },
  },
  verify_citations: {
    does:
      'Three phases. Extraction, no network: [N] references, (Author, Year), bare URLs and DOIs. Fetch of URL and DOI citations only when allow_fetch is true or IRIS_CITATION_ALLOW_FETCH=1, through a scheme allowlist, private and cloud-metadata address blocking, an optional hostname allowlist (domain_allowlist, merged with IRIS_CITATION_DOMAINS), a per-source timeout and byte cap, and at most three re-checked redirects. ' +
      'Then one judge call per resolved citation on your own key, reading the first part of each source, capped in total by max_cost_usd_total. Up to max_citations are verified; extras are skipped, not errored. ' +
      'overall_score is supported / judged and null when nothing was judged. Per-citation failures are reported on the citation, never scored as unsupported: resolve_error when the source was not resolved (fetch disabled, bad scheme, blocked address, fetch timeout, bad status), judge_error when it was and the judge gave no verdict (cost cap, provider error, unreadable reply). One evaluation row is stored.',
    whenNot:
      "When the output has no citations: the score is null, and evaluate_output's hallucination signals are the cheap check. " +
      `Without a key (${JUDGE_KEY_VARS.anthropic} or ${JUDGE_KEY_VARS.openai}): the call returns IRIS_JUDGE_NOT_ENABLED with the enable steps. ` +
      'With fetch enabled and an open allowlist on untrusted output: you are running a user-directed fetcher — set IRIS_CITATION_DOMAINS.',
    errors:
      'IRIS_JUDGE_NOT_ENABLED, IRIS_JUDGE_UNKNOWN_MODEL and IRIS_UNKNOWN_TRACE before any fetch or spend. IRIS_JUDGE_FAILED when citations resolved but the judge failed on every one — an error, not a passing verdict; nothing is stored.',
  },
};

export function toolGuide(): Record<ToolName, ServedToolGuide> {
  const out = {} as Record<ToolName, ServedToolGuide>;
  for (const name of TOOL_NAMES) {
    const returns: Record<string, string> = {};
    for (const [field, schema] of Object.entries(OUTPUT_SCHEMAS[name].shape)) {
      returns[field] = (schema as { description?: string }).description ?? '';
    }
    out[name] = { ...TOOL_GUIDE[name], returns };
  }
  return out;
}
