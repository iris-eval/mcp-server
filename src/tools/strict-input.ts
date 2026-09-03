import { z } from 'zod';

/*
 * Wraps a tool's input shape in a STRICT object schema so unknown argument
 * names are REJECTED with an error that names the offending key(s) and
 * lists the valid ones.
 *
 * Why this exists: a bare shape (or z.object()) silently STRIPS unknown
 * keys. At the MCP tool boundary that is dangerous, not lenient — an LLM
 * guessing an argument name is the normal case, not an edge case. Before
 * this wrapper, `evaluate_output({ criteria: ["safety"], ... })` (a
 * plausible guess) and `eval_typ: "safety"` (a one-character typo) both
 * "succeeded": the arguments were dropped, the DEFAULT completeness bundle
 * ran instead of the safety rules, and the response said passed:true on
 * text containing real PII — with nothing indicating the arguments were
 * ignored. Meanwhile a missing REQUIRED field produced a precise Zod
 * error, so the failure mode was inconsistent as well as unsafe.
 *
 * The MCP SDK accepts a schema object (not just a raw shape) for
 * inputSchema and validates tool calls through it, so the custom
 * unrecognized-keys message below is exactly what the caller sees.
 * Strictness also reaches tools/list: the generated JSON Schema carries
 * additionalProperties:false, telling well-behaved clients up front.
 */
export function strictInput<T extends z.ZodRawShape>(shape: T) {
  const validKeys = Object.keys(shape).join(', ');
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `Unknown argument(s): ${issue.keys.map((k) => `"${k}"`).join(', ')}. ` +
          `Valid arguments: ${validKeys}. ` +
          'Unknown arguments are rejected rather than silently ignored, so a misspelled ' +
          'argument name cannot change what gets evaluated — check the spelling against ' +
          "the tool's input schema and retry."
        : undefined,
  });
}

/*
 * The same contract ONE LEVEL DOWN, for structured nested objects — a
 * custom_rules[] entry, deploy_rule's `definition`. Top-level strictness
 * shipped in 0.5.0 and stopped there, so `custom_rules: [{ name, type,
 * config, wieght: 5 }]` still parsed cleanly with `wieght` discarded: the
 * rule ran at the default weight and the score moved for a reason nothing
 * in the response could show (#376). Free-form record fields (a rule's
 * `config`, trace `metadata`, span `attributes`) are deliberately NOT
 * strict — arbitrary keys there are the documented contract.
 *
 * `container` names the object in the message ("a custom_rules entry");
 * the SDK appends the path (`at custom_rules.0`) so the caller sees
 * exactly which entry to fix.
 */
export function strictNested<T extends z.ZodRawShape>(shape: T, container: string) {
  const validKeys = Object.keys(shape).join(', ');
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `Unknown key(s) in ${container}: ${issue.keys.map((k) => `"${k}"`).join(', ')}. ` +
          `Valid keys: ${validKeys}. ` +
          'Unknown keys are rejected rather than silently dropped, so a misspelled key ' +
          'cannot change how the rule scores — check the spelling and retry.'
        : undefined,
  });
}
