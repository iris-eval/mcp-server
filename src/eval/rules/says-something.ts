/*
 * An answer that says nothing.
 *
 * Measured before this rule (the composite engine at the shipped
 * configuration, two asks from an outside review): against "Rename the
 * function parseUser to parseAccount in src/auth.ts, update its two callers,
 * and run the test suite" and "Write the quarterly revenue summary for the
 * board, with the three biggest risks", ten of twelve trivial outputs passed
 * clean: "Done.", "OK", "The task has been completed successfully.", "I can't
 * help with that.", "As an AI language model, I cannot browse the internet.",
 * "…", "null", "lorem ipsum dolor sit amet", the ask copied back, and one
 * sentence repeated four hundred times. Only an empty output and a blank one
 * failed. Four rules fired on most of them (length, sentence count, keyword
 * overlap, relevance) and each only advised, because each fires as often on
 * a short correct answer as on a non-answer.
 *
 * This rule reads the shape of a non-answer, which a short correct answer
 * does not have. Five shapes, each a separate finding:
 *
 *   placeholder      the whole output is punctuation ("…", "-"), a
 *                    serialisation artefact ("null", "undefined", "NaN",
 *                    "[object Object]") or lorem-ipsum filler
 *   acknowledgement  the whole output is an acknowledgement or a claim of
 *                    completion ("Done.", "OK", "The task has been completed
 *                    successfully."), where the ask needed more: a question
 *                    or a request for information (what, how, explain, list);
 *                    a request to write something, when the call records no
 *                    tool call that could have written it elsewhere; or an
 *                    action, when the call says no tool was called at all
 *   refusal          the whole output declines ("I can't help with that.",
 *                    "As an AI language model, I cannot …"), and the ask is
 *                    not one the deployment's blocklist flags
 *   echo             the output is the ask's own text handed back
 *   repetition       one sentence repeated five or more times makes up at
 *                    least half of the output (fenced code aside)
 *
 * Its failure class is `stub`: an answer that says nothing is a
 * placeholder or a claim in place of the work. Measured, a class of its own
 * was worse: the risk estimate spreads the prior over the classes it
 * examines, so one more class lowered every class's prior and a real
 * deferral transcript (t-20) went from blocked to shipped. In `stub`, the
 * rule's recall (measured on non-answers) is read as recall over all stubs
 * when it stays quiet, which understates the risk of an honest answer a
 * little; how a quiet detector's recall is applied is the risk layer's to
 * fix, for every rule at once.
 *
 * What it does not do: judge whether a substantive answer is right, or
 * whether work a short report claims was done (an acknowledgement after
 * tool calls is a terse report, and passes here). A yes/no question
 * answered "Done." or "OK" is answered. A refusal of an ask that names a
 * blocklisted phrase is the right answer; a refusal of a harmful ask the
 * blocklist does not name fires, and its labelled cases are published as
 * wrong fails.
 */
import type { EvalContext, EvalRule, EvalRuleResult, Evidence } from '../../types/eval.js';
import { contentTerms, FENCED_CODE } from '../terms.js';
import { sentencesOf } from '../text/sentences.js';
import { isProduceAsk } from '../text/asks.js';
import { normalise } from '../text/normalise.js';
import { DEFAULT_BLOCKLIST } from './safety.js';
import { isRefusal, MIN_ASK_TERMS_TO_JUDGE } from './relevance.js';

/** The longest output read as a bare acknowledgement or a bare refusal, in words. */
export const BARE_ANSWER_MAX_WORDS = 12;
/** How many times one sentence must recur, and how much of the output its copies must cover, to be a loop rather than a refrain. */
export const REPEAT_MIN_COUNT = 5;
export const REPEAT_MIN_SHARE = 0.5;
/** The longest output read for repetition. Past it the first part is read. */
export const REPEAT_SCAN_CHARS = 2_000_000;

/** Serialisation artefacts: what a program prints when it has nothing to print. English words ("None.", "N/A") are answers and are not here. */
const ARTEFACT = /^(?:null|undefined|nil|nan|\[object object\]|<empty>|<none>|\(empty\)|\(none\))$/i;
const LOREM = /\blorem\s+ipsum\b/i;
const LOREM_WORDS = new Set(['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'consectetuer', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo', 'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate', 'velit', 'esse', 'cillum', 'eu', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint', 'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia', 'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum']);

/** The words an acknowledgement or a claim of completion is made of. An output made only of these says the work happened and nothing about it. */
const ACK_WORDS = new Set([
  'done', 'ok', 'okay', 'k', 'sure', 'alright', 'right', 'all', 'set', 'good', 'great', 'perfect', 'fine',
  'complete', 'completed', 'finished', 'finish', 'success', 'successful', 'successfully', 'succeeded',
  'task', 'tasks', 'request', 'job', 'work', 'everything', 'it', 'this', 'that', 'the', 'your', 'my', 'as', 'requested', 'asked',
  'has', 'have', 'had', 'been', 'is', 'was', 'are', 'i', "i've", 'ive', 'we', "we've", 'now', 'just', 'fully',
  'got', 'noted', 'understood', 'will', 'do', 'roger', 'ready', 'thanks', 'thank', 'you', 'here', 'there', 'go', 'and', 'with', 'of',
]);

/** A wh-question or a request for information: the answer is the content, so an acknowledgement is not one. */
const INFORMATION_ASK = /^\s*(?:(?:please|can you|could you|would you)\s+)?(?:what|which|who|whom|whose|when|where|why|how|explain|describe|list|tell|give|show|provide|suggest|recommend|compare|define|name|summarise|summarize|outline)\b/i;
/** A yes/no question: an acknowledgement can answer it. */
const YES_NO_QUESTION = /^\s*(?:is|are|was|were|do|does|did|can|could|will|would|should|shall|has|have|had|may|might)\b[^?]*\?\s*$/i;
/** "As an AI language model," and its kin, before the refusal it introduces. */
const AI_DISCLAIMER = /^\s*as an ai(?:\s+(?:language\s+)?(?:model|assistant))?\s*,?\s*/i;
/** A refusal that names what it cannot do: "I cannot browse the internet", "I'm unable to access files". */
const CAPABILITY_REFUSAL = /^\s*i\s+(?:can(?:no|['’])t|am\s+(?:unable|not\s+able)\s+to|don['’]?t\s+have\s+(?:access|the\s+ability))\b/i;

/** The words of a text, lower case, punctuation aside. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9'’]+/).filter((w) => w.length > 0);
}

function placeholderOf(output: string): string | null {
  const bare = output.trim().replace(/^[\s"'`([{<]+|[\s"'`)\]}>]+$/g, '');
  if (!/[\p{L}\p{N}]/u.test(output)) return 'only punctuation';
  const artefact = [output.trim(), bare].find((form) => ARTEFACT.test(form));
  if (artefact !== undefined) return `"${artefact}", a value a program prints when it has nothing to print`;
  if (LOREM.test(output)) {
    const words = wordsOf(output);
    const filler = words.filter((w) => LOREM_WORDS.has(w)).length;
    if (filler / words.length >= 0.5) return 'lorem-ipsum filler';
  }
  return null;
}

function isBareAcknowledgement(output: string): boolean {
  const words = wordsOf(output);
  return words.length > 0 && words.length <= BARE_ANSWER_MAX_WORDS && words.every((w) => ACK_WORDS.has(w.replace(/[’]/g, "'")));
}

function isBareRefusal(output: string): boolean {
  const stripped = output.replace(AI_DISCLAIMER, '');
  const words = wordsOf(stripped).length;
  // "No." answers a yes/no question; it declines nothing.
  if (/^\s*(?:no|nope)[.!]?\s*$/i.test(stripped)) return false;
  return words > 0 && words <= BARE_ANSWER_MAX_WORDS * 2 && (isRefusal(stripped) || CAPABILITY_REFUSAL.test(stripped));
}

/** Lower case, one space, no surrounding quotes or closing punctuation: the form two copies of one text share. */
function plain(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^["'`“‘]+|["'`”’.!?]+$/g, '').trim();
}

/**
 * The ask's own text handed back: the output contains the whole ask and is
 * at most a fifth longer. A completion report that restates the ask in the
 * past tense ("Renamed parseUser to parseAccount and updated its callers")
 * is not this, and passes.
 */
function isAskHandedBack(output: string, ask: string): boolean {
  const a = plain(ask);
  const o = plain(output);
  return a.length > 0 && o.includes(a) && o.length <= a.length * 1.2;
}

/** The ask names a phrase on the blocklist: declining it is the answer. */
export function askNamesBlocklisted(ask: string, blocklist: readonly string[]): boolean {
  const folded = normalise(ask, { dropInsertedBreaks: true }).text.toLowerCase();
  return blocklist.some((phrase) => folded.includes(normalise(phrase).text.toLowerCase()));
}

/** One sentence that makes up most of the output by repeating, or null. */
function repetitionOf(output: string): { count: number; share: number } | null {
  const text = output.slice(0, REPEAT_SCAN_CHARS).replace(FENCED_CODE, '\n');
  if (text.length === 0) return null;
  const counts = new Map<string, { n: number; chars: number }>();
  for (const sentence of sentencesOf(text)) {
    const key = sentence.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.split(' ').length < 3) continue;
    const entry = counts.get(key) ?? { n: 0, chars: 0 };
    entry.n += 1;
    entry.chars += sentence.replace(/\s+/g, '').length;
    counts.set(key, entry);
  }
  let best: { n: number; chars: number } | null = null;
  for (const entry of counts.values()) if (best === null || entry.chars > best.chars) best = entry;
  if (best === null || best.n < REPEAT_MIN_COUNT) return null;
  // Shares are of the characters that are not whitespace, so a loop with nothing else in it is 100%.
  const share = best.chars / text.replace(/\s+/g, '').length;
  return share >= REPEAT_MIN_SHARE ? { count: best.n, share } : null;
}

/** What makes an output a non-answer: the shape, the sentence that says so, and whether the finding is the whole output. */
export interface NonAnswer {
  shape: 'placeholder' | 'acknowledgement' | 'refusal' | 'echo' | 'repetition';
  message: string;
  whole: boolean;
}

/**
 * The decision, as one function of what the call carried: the output (not
 * empty), the ask (or ''), the tool calls as sent (undefined when none were
 * sent), and whether the ask names a blocklisted phrase.
 */
export function nonAnswerOf(output: string, ask: string, toolCalls: readonly unknown[] | undefined, askBlocklisted: boolean): NonAnswer | null {
  const askTerms = new Set(contentTerms(ask)).size;
  const hasAsk = ask.trim().length > 0 && askTerms >= MIN_ASK_TERMS_TO_JUDGE;
  const noToolCalls = Array.isArray(toolCalls) && toolCalls.length === 0;
  const workRecorded = Array.isArray(toolCalls) && toolCalls.length > 0;
  const said = output.trim().slice(0, 60);

  const placeholder = placeholderOf(output);
  if (placeholder !== null) return { shape: 'placeholder', message: `The output says nothing: it is ${placeholder}`, whole: true };

  if (hasAsk && !YES_NO_QUESTION.test(ask) && isBareAcknowledgement(output)) {
    if (INFORMATION_ASK.test(ask)) {
      return { shape: 'acknowledgement', message: `The output only acknowledges ("${said}"); the ask asked for an answer, and none was given`, whole: true };
    }
    if (isProduceAsk(ask) && !workRecorded) {
      return { shape: 'acknowledgement', message: `The output only acknowledges ("${said}"); the ask asked for something written, and the call records no tool call that could have written it elsewhere`, whole: true };
    }
    if (noToolCalls) {
      return { shape: 'acknowledgement', message: `The output only says the work is done ("${said}"), and the call records no tool call that could have done it`, whole: true };
    }
  }

  if (hasAsk && isBareRefusal(output) && !askBlocklisted) {
    return { shape: 'refusal', message: `The output declines ("${said}") instead of answering, and the ask is not one the blocklist flags`, whole: true };
  }

  if (hasAsk && isAskHandedBack(output, ask)) return { shape: 'echo', message: 'The output hands the ask back instead of answering it', whole: true };

  const repeated = repetitionOf(output);
  if (repeated !== null) {
    return { shape: 'repetition', message: `One sentence repeated ${repeated.count} times makes up ${Math.round(repeated.share * 100)}% of the output`, whole: false };
  }
  return null;
}

/** The sentence for an output that is none of the shapes. */
export const SAYS_SOMETHING_PASS = 'The output says something: it is not a placeholder, a bare acknowledgement, a bare refusal, the ask handed back, or one sentence on repeat';

export const saysSomething: EvalRule = {
  name: 'says_something',
  description:
    'Fails an answer that says nothing: a placeholder ("…", "null", lorem ipsum), a bare acknowledgement or claim of completion ("Done.", "The task has been completed successfully.") where the ask needed an answer or something written, or was an action and the call records that no tool was called, a bare refusal of an ask the blocklist does not name, the ask handed back, or one sentence repeated until it is most of the output. A short correct answer ("Paris.", "329.", "None.") and an acknowledgement after tool calls pass. Skips an empty output, which non_empty_output judges',
  evalType: 'completeness',
  weight: 2,
  kind: 'detection',
  mechanism: 'pattern',
  needs: ['output', 'input', 'tool_calls'],
  outputView: 'values',
  question: 'complete',
  classes: ['stub'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const output = context.output;
    if (output.trim().length === 0) {
      return { ruleName: 'says_something', passed: false, score: 0, skipped: true, skipClass: 'not_applicable', skipReason: 'the output is empty; non_empty_output judges that', message: 'Not judged: the output is empty' };
    }
    const ask = context.input ?? '';
    const blocklist = (context.customConfig?.blocklist as string[] | undefined) ?? DEFAULT_BLOCKLIST;
    const found = nonAnswerOf(output, ask, context.toolCalls, askNamesBlocklisted(ask, blocklist));
    if (found === null) return { ruleName: 'says_something', passed: true, score: 1, message: SAYS_SOMETHING_PASS };
    const evidence: Evidence[] = [{ type: 'pattern', name: found.shape, count: 1 }];
    if (found.whole) evidence.push({ type: 'span', source: 'output', start: output.length - output.trimStart().length, end: output.trimEnd().length, label: 'the whole output' });
    return { ruleName: 'says_something', passed: false, score: 0, evidence, message: found.message };
  },
};
