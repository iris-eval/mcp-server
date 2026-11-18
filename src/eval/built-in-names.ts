/*
 * The names of the rules Iris ships.
 *
 * A custom rule may not take one: wherever a result, a sentence or a tally
 * names a rule, the two would be one name, and a reader (or the code that
 * counts a deployment's labels) could not tell them apart. A plugin's loader
 * refuses such a name (plugins.ts), and so does each door a custom rule comes
 * in by: deploy_rule, the rules API and its preview, and the inline rules of
 * evaluate_output. A rule stored under such a name before the doors refused
 * it keeps running, and the server says so when it starts; once paused, it is
 * not turned back on (delete_rule with enabled, and the rules API's toggle).
 */
import { builtInRules } from './criticality.js';

let names: ReadonlySet<string> | undefined;

/** Whether a name is the name of a rule Iris ships. */
export function isBuiltInRuleName(name: string): boolean {
  names ??= new Set(builtInRules().map((r) => r.name));
  return names.has(name);
}

/** The names of the rules Iris ships, sorted. */
export function builtInRuleNames(): string[] {
  names ??= new Set(builtInRules().map((r) => r.name));
  return [...names].sort();
}

/** What a door answers when custom rules come in under the names of rules Iris ships. */
export function builtInNameRefusal(taken: readonly string[]): string {
  const quoted = taken.map((n) => `"${n}"`).join(', ');
  return taken.length === 1
    ? `${quoted} is the name of a rule Iris ships, and a custom rule may not take it: the two would carry one name in every result. Choose another name.`
    : `${quoted} are the names of rules Iris ships, and a custom rule may not take one: two rules would carry one name in every result. Choose other names.`;
}

/** What the server says at start of a stored rule that carries such a name. */
export function builtInNameKept(rule: { id: string; name: string }): string {
  return (
    `The deployed custom rule "${rule.name}" (${rule.id}) carries the name of a rule Iris ships. It keeps running, and the two share one name in every result. ` +
    `Deploy it again under a name of its own and delete this one (delete_rule with id "${rule.id}"); a label on its fires cannot be written, so that none weighs the rule Iris ships.`
  );
}

/** What a door answers when asked to turn back on a paused stored rule that carries such a name. */
export function builtInNameNotEnabled(rule: { id: string; name: string }): string {
  return (
    `The custom rule "${rule.name}" (${rule.id}) carries the name of a rule Iris ships, and a custom rule may not take it, so it stays paused: the two would carry one name in every result. ` +
    'Deploy it again under a name of its own, then delete this one.'
  );
}
