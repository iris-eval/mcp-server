/*
 * An answer that says nothing.
 *
 * Measured before this rule (the composite engine at the shipped
 * configuration, two asks from an outside review): against "Rename the
 * function parseUser to parseAccount in src/auth.ts, update its two callers,
 * and run the test suite" and "Write the quarterly revenue summary for the
 * board, with the three biggest risks", ten of twelve trivial outputs passed
 * clean: "Done.", "OK", "The task has been completed successfully.", "…",
 * "null", "lorem ipsum dolor sit amet", the ask copied back, one sentence
 * repeated four hundred times, and two refusals. Only an empty output and a
 * blank one failed. Four rules fired on most of them (length, sentence count,
 * keyword overlap, relevance) and each only advised, because each fires as
 * often on a short correct answer as on a non-answer.
 *
 * This rule reads the shape of a non-answer against what the ask asked for.
 * It fires only where a short correct answer cannot have that shape, which
 * is why most shapes need an ask that asks for something WRITTEN (write,
 * draft, summarise, explain, describe, list, translate, rewrite …): a
 * question can be answered by "OK", "null", "===" or "Done.", and an ask to
 * act can be answered by a report that it was done.
 *
 *   promise       the whole output promises the work instead of doing it
 *                 ("Sure!", "Will do!", "Working on it.") — to an ask for
 *                 something written or a wh-question, when the call records
 *                 no tool call that could have done the work elsewhere
 *   completion    the whole output says the work is done ("Done.", "Fixed.",
 *                 "The task has been completed successfully.") — to an ask
 *                 for something written, when the call says no tool was
 *                 called (`tool_calls: []`); with no list sent, the work may
 *                 be in a file, and the rule does not guess
 *   lead-in       the whole output announces content that is not there:
 *                 it ends on a colon ("Here is the summary:"), or, to an ask
 *                 for something written with no tool call recorded, it
 *                 says "here is …" and stops
 *   placeholder   the whole output is a serialisation artefact ("null",
 *                 "undefined", "NaN", "[object Object]"), only punctuation,
 *                 or lorem-ipsum filler — to an ask for something written
 *                 (lorem ipsum also to a wh-question), unless the ask asks
 *                 for filler
 *   echo          the output is the ask handed back: nothing in it the ask
 *                 does not say, apart from a few framing words, to an ask
 *                 for something written or a question, unless the ask says
 *                 to repeat it
 *   loop          one passage repeated ten or more times makes up at least
 *                 four fifths of the output, and the ask did not ask for it
 *
 * Refusals are not here. A refusal says something — that the agent will not
 * do it — and whether that was right is a judgement about the ask this rule
 * cannot make: the shapes it had flagged included correct refusals of
 * harmful asks.
 *
 * Its failure class is `stub`: an answer that says nothing is a placeholder
 * or a claim in place of the work.
 *
 * Every scan is linear in the output: no pattern here can backtrack, the
 * trimming is done by hand, and the loop is found with one pass of the
 * prefix function over at most LOOP_SCAN_CHARS.
 */
import type { EvalContext, EvalRule, EvalRuleResult, Evidence } from '../../types/eval.js';
import { contentTerms } from '../terms.js';
import { MIN_ASK_TERMS_TO_JUDGE } from './relevance.js';

/** The longest output read as a bare promise, completion claim, lead-in or placeholder, in words. */
export const BARE_ANSWER_MAX_WORDS = 12;
/** How many times one passage must recur, and how much of the output its copies must cover, to be a loop. */
export const LOOP_MIN_COUNT = 10;
export const LOOP_MIN_SHARE = 0.8;
/** The longest output read for a loop. Past it the first part is read: a loop shows long before. */
export const LOOP_SCAN_CHARS = 200_000;
/** The fewest words an ask needs before an output can be said to hand it back. */
export const ECHO_MIN_ASK_WORDS = 4;

/** Verbs that ask for something written: the output itself is the work. "reply" and "respond" are not here: "Reply with OK" asks for an acknowledgement. */
const WRITE_VERBS = new Set([
  'write', 'draft', 'compose', 'summarise', 'summarize', 'explain', 'describe', 'list', 'translate', 'rewrite',
  'paraphrase', 'outline', 'sketch', 'generate', 'produce', 'create', 'detail', 'document', 'elaborate', 'expand',
]);
/** What may come before the verb: "Please write", "Can you summarise", "Now draft". */
const ASK_PREFIX = new Set(['please', 'kindly', 'now', 'also', 'then', 'and', 'can', 'could', 'would', 'will', 'you', 'pls', 'plz']);
const WH_WORDS = new Set(['what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how']);
/** A question that opens with one of these asks yes or no, with or without its question mark. */
const AUX_WORDS = new Set(['is', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'has', 'have', 'had', 'should', 'shall', 'may', 'might', 'must', 'isn', 'aren', 'didn', 'doesn']);

/** Words a promise is made of. */
const PROMISE_WORDS = new Set([
  'sure', 'certainly', 'absolutely', 'of', 'course', 'will', 'do', "i'll", 'ill', 'i', 'am', "i'm", 'im', 'on', 'it', 'working', 'work',
  'get', 'started', 'start', 'starting', 'right', 'away', 'now', 'happy', 'glad', 'to', 'help', 'no', 'problem', 'let', 'me', 'that',
  'this', 'take', 'a', 'look', 'coming', 'up', 'one', 'moment', 'sec', 'second', 'give', 'can', 'yes', 'ok', 'okay', 'alright', 'great', 'thing',
  'thanks', 'thank', 'you', 'be', 'would', "i'd", 'id', 'love', 'with', 'for', 'the', 'request', 'task', 'shortly', 'soon',
]);
/** Each promise names one of these; "Thank you." alone is not a promise. */
const PROMISE_MARKS = ['sure', 'certainly', 'absolutely', 'course', 'will', "i'll", 'ill', 'on', 'working', 'started', 'starting', 'happy', 'glad', 'problem', 'let', 'coming', 'moment'];
/** Words a claim of completion is made of. */
const COMPLETION_WORDS = new Set([
  'done', 'ok', 'okay', 'complete', 'completed', 'finished', 'success', 'successful', 'successfully', 'succeeded', 'fixed',
  'applied', 'made', 'changes', 'change', 'processed', 'handled', 'taken', 'care', 'of', 'all', 'set', 'good', 'to', 'go',
  'task', 'tasks', 'request', 'job', 'work', 'everything', 'it', "it's", 'its', 'this', 'that', 'the', 'your', 'my', 'as', 'requested', 'asked',
  'has', 'have', 'had', 'been', 'is', 'was', 'are', 'i', "i've", 'ive', 'we', "we've", 'now', 'just', 'fully', 'there', 'you', 'go', 'and',
]);
/** Each completion claim names one of these. */
const COMPLETION_MARKS = ['done', 'complete', 'completed', 'finished', 'success', 'successful', 'successfully', 'succeeded', 'fixed', 'applied', 'made', 'processed', 'handled', 'care'];
/** Serialisation artefacts: what a program prints when it has nothing to print. "None." and "N/A" are English answers and are not here. */
const ARTEFACTS = new Set(['null', 'undefined', 'nan', 'nil', '[object object]', '<empty>', '<none>', '(empty)', '(none)']);
/** A template's slot left unfilled: "{{answer}}", "<summary>", "{response}". Bounded, so it cannot backtrack. */
const TEMPLATE_SLOT = /^(?:\{\{\s?[\w .-]{1,40}\s?\}\}|<[\w .-]{1,40}>|\{[\w .-]{1,40}\})$/;
const LOREM_WORDS = new Set(['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'consectetuer', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo', 'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate', 'velit', 'esse', 'cillum', 'eu', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint', 'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia', 'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum']);
/** An ask that names these asks for filler, and lorem ipsum answers it. */
const FILLER_ASK = ['lorem', 'ipsum', 'placeholder', 'filler', 'dummy', 'sample text', 'mock text', 'greeking'];
/** The words a hand-back may add around the ask: "Sure! Task: …", "You asked: …". */
const ECHO_FRAME = new Set(['sure', 'ok', 'okay', 'here', 'is', 'the', 'your', 'you', 'asked', 'question', 'task', 'request', 'prompt', 'query', 'input', 'answer', 'i', 'will', 'now', 're', 'regarding', 'about', 'q', 'a']);
/** An ask that says these asks to have its words back. */
const ECHO_ASK = ['repeat', 'echo', 'verbatim', 'copy', 'say back', 'read back', 'word for word', 'exactly as', 'unchanged', 'as is', 'proofread', 'redact', 'correct the'];

/** Typographic apostrophes and quotes as their plain forms, so "it’s" and "it's" are one word. */
function plainQuotes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/** The words of a text, lower case: runs of letters, digits and apostrophes, without the apostrophes at their ends. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const run of plainQuotes(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    // By hand: /^'+|'+$/ tried '+$ from every apostrophe of a long run inside a word.
    let a = 0;
    let b = run.length;
    while (a < b && run[a] === "'") a++;
    while (b > a && run[b - 1] === "'") b--;
    if (b > a) out.push(run.slice(a, b));
  }
  return out;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0';

/** The text without the characters in `strip` at either end. A loop, not a pattern: an anchored character-class run backtracks on a long run that is not at the end. */
function trimChars(text: string, strip: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && (strip.includes(text[a]) || isSpace(text[a]))) a++;
  while (b > a && (strip.includes(text[b - 1]) || isSpace(text[b - 1]))) b--;
  return text.slice(a, b);
}

/** The ask's first word that is not a politeness: the verb of an imperative, or the wh-word of a question. */
function askHead(ask: string): string {
  for (const word of wordsOf(ask)) {
    if (!ASK_PREFIX.has(word)) return word.replace(/'(?:s|re|ll|d|ve|m)$/, '');
  }
  return '';
}

/** What the ask asks for, read from its first sentence's head word. */
interface AskKind {
  /** Something written: the output is the work. */
  write: boolean;
  /** A wh-question: the answer is content. */
  wh: boolean;
  /** Any question, with or without its question mark. */
  question: boolean;
}

function askKindOf(ask: string): AskKind {
  const head = askHead(ask);
  // "Can you write the summary?" asks for something written, question mark or not.
  const write = WRITE_VERBS.has(head);
  const question = !write && (ask.includes('?') || WH_WORDS.has(head) || AUX_WORDS.has(head));
  return { write, wh: WH_WORDS.has(head), question };
}

/** Every word of the output is in `vocabulary`, it names one of `marks`, and it is short. */
function madeOf(words: readonly string[], vocabulary: ReadonlySet<string>, marks: readonly string[]): boolean {
  return words.length > 0 && words.length <= BARE_ANSWER_MAX_WORDS && words.every((w) => vocabulary.has(w)) && words.some((w) => marks.includes(w));
}

/** The ask names every word the output is made of: it asked for this answer ("Write 'done' when you have read it"). */
function askNamesAll(ask: string, words: readonly string[]): boolean {
  const asked = new Set(wordsOf(ask));
  return words.every((w) => asked.has(w) || !COMPLETION_MARKS.concat(PROMISE_MARKS).includes(w));
}

function placeholderOf(output: string, ask: string, kind: AskKind): string | null {
  const bare = trimChars(output, '"\'`()[]{}<>.!?;,').toLowerCase();
  if (kind.write) {
    if (!/[\p{L}\p{N}]/u.test(output)) return 'no word or number at all';
    const artefact = ARTEFACTS.has(trimChars(output, '"\'`.!?;,').toLowerCase()) ? trimChars(output, '"\'`.!?;,') : ARTEFACTS.has(bare) ? bare : null;
    if (artefact !== null) return `"${artefact}", a value a program prints when it has nothing to print`;
    const slot = trimChars(output, '"\'`');
    if (slot.length <= 48 && TEMPLATE_SLOT.test(slot)) return `"${slot}", a template's slot left unfilled`;
  }
  if (kind.write || kind.wh) {
    const words = wordsOf(output);
    const askLower = plainQuotes(ask).toLowerCase();
    if (words.includes('lorem') && words.includes('ipsum') && !FILLER_ASK.some((w) => askLower.includes(w))) {
      const filler = words.filter((w) => LOREM_WORDS.has(w)).length;
      if (filler / words.length >= 0.5) return 'lorem-ipsum filler';
    }
  }
  return null;
}

/** The output announces content and stops: it ends on a colon, or it is a short "here is …". */
function leadInOf(output: string, kind: AskKind, workRecorded: boolean): string | null {
  const text = output.trim();
  const words = wordsOf(text);
  if (words.length === 0 || words.length > BARE_ANSWER_MAX_WORDS || text.includes('\n')) return null;
  if (text.endsWith(':')) return 'it ends on a colon, and nothing follows';
  // "Here is the answer: 42." gives its answer after the colon.
  if (!kind.write || workRecorded || text.includes(':')) return null;
  const lead = words.slice(0, 3).join(' ');
  if (/^(?:here is|here's|heres|here are|below is|attached is|please find)\b/.test(lead) || (words[0] === 'sure' && /^(?:sure here)\b/.test(lead))) {
    return 'it says "here is" and gives nothing';
  }
  return null;
}

/**
 * The output is the ask handed back: nothing in it the ask does not say,
 * apart from a few framing words. To an ask for something written, most of
 * the ask's words are enough ("Write the summary" handed back without "the"
 * is still handed back). To a question, the question itself must be there
 * in order: "The cache is enabled in production." restates "Is the cache
 * enabled in production?" in the ask's own words, and answers it.
 */
function isAskHandedBack(output: string, ask: string, kind: AskKind): boolean {
  if (!(kind.write || kind.question)) return false;
  const askLower = plainQuotes(ask).toLowerCase();
  if (ECHO_ASK.some((w) => askLower.includes(w))) return false;
  const askWords = wordsOf(ask);
  if (askWords.length < ECHO_MIN_ASK_WORDS) return false;
  const asked = new Set(askWords);
  const said = wordsOf(output);
  // A hand-back is the ask and a few framing words, no longer.
  if (said.length === 0 || said.length > askWords.length * 2 + 8) return false;
  if (!said.every((w) => asked.has(w) || ECHO_FRAME.has(w))) return false;
  // Coverage in distinct words: a sentence the ask quotes, written out five times, covers the ask no better than once.
  if (kind.write) return new Set(said.filter((w) => asked.has(w))).size >= asked.size * 0.8;
  return ` ${said.join(' ')} `.includes(` ${askWords.join(' ')} `);
}

/*
 * The loop. The text is read with fenced and indented code left out, its
 * whitespace collapsed, in lower case. Two readings, both linear:
 *   - the whole text is one passage repeated (the prefix function gives the
 *     shortest period in one pass), which catches a loop with no full stop
 *     in it and one whose sentences start in lower case;
 *   - one sentence or line, split at any terminator or line break whatever
 *     follows, recurs and covers most of the text.
 */
function codeFree(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const t = line.trimStart();
    if (fence !== null) {
      if (t.startsWith(fence)) fence = null;
      continue;
    }
    if (t.startsWith('```') || t.startsWith('~~~')) {
      fence = t.slice(0, 3);
      continue;
    }
    if (line.startsWith('    ') || line.startsWith('\t')) continue;
    out.push(line);
  }
  return out.join('\n');
}

function collapsed(text: string): string {
  let out = '';
  let space = false;
  for (const c of text.toLowerCase()) {
    if (isSpace(c)) {
      space = out.length > 0;
      continue;
    }
    if (space) out += ' ';
    space = false;
    out += c;
  }
  return out;
}

/** The shortest p such that the text is a prefix of its first p characters repeated, by the prefix function. */
function shortestPeriod(text: string): number {
  const pi = new Int32Array(text.length);
  for (let i = 1; i < text.length; i++) {
    let k = pi[i - 1];
    while (k > 0 && text[i] !== text[k]) k = pi[k - 1];
    if (text[i] === text[k]) k++;
    pi[i] = k;
  }
  return text.length - (text.length > 0 ? pi[text.length - 1] : 0);
}

function loopOf(output: string, ask: string): { count: number; share: number } | null {
  const text = collapsed(codeFree(output.slice(0, LOOP_SCAN_CHARS)));
  if (text.length === 0) return null;
  const askText = collapsed(plainQuotes(ask));
  const asked = (unit: string): boolean => askText.includes(trimChars(unit, '.!?;,"\''));

  // A passage has two words at least: a run of zeros, "hahaha" or a rule of "=" is data, not a loop.
  const passage = (unit: string): boolean => wordsOf(unit).length >= 2;
  const period = shortestPeriod(text);
  // The last copy may have lost its trailing space when the whitespace was collapsed.
  const copies = Math.floor((text.length + 1) / period);
  if (copies >= LOOP_MIN_COUNT) {
    const unit = text.slice(0, period);
    if (passage(unit) && !asked(unit)) return { count: copies, share: 1 };
  }

  const counts = new Map<string, { n: number; chars: number }>();
  let start = 0;
  const flush = (end: number): void => {
    const unit = text.slice(start, end).trim();
    start = end;
    if (!passage(unit)) return;
    const entry = counts.get(unit) ?? { n: 0, chars: 0 };
    entry.n += 1;
    entry.chars += unit.length;
    counts.set(unit, entry);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '.' || c === '!' || c === '?') {
      let j = i + 1;
      while (j < text.length && (text[j] === '.' || text[j] === '!' || text[j] === '?')) j++;
      if (j >= text.length || text[j] === ' ') flush(j);
      // Past the run whether or not it ended a sentence: read again from each of its marks, a long run inside a word was quadratic.
      i = j - 1;
    }
  }
  flush(text.length);
  let best: [string, { n: number; chars: number }] | null = null;
  for (const entry of counts) if (best === null || entry[1].chars > best[1].chars) best = entry;
  if (best === null || best[1].n < LOOP_MIN_COUNT || asked(best[0])) return null;
  const share = best[1].chars / text.length;
  return share >= LOOP_MIN_SHARE ? { count: best[1].n, share } : null;
}

/** What makes an output a non-answer: the shape, the sentence that says so, and whether the finding is the whole output. */
export interface NonAnswer {
  shape: 'promise' | 'completion' | 'lead-in' | 'placeholder' | 'echo' | 'loop';
  message: string;
  whole: boolean;
}

/**
 * The decision, as one function of what the call carried: the output as the
 * rule reads it (not empty), the ask (or ''), the tool calls as sent
 * (undefined when no list was sent), and whether the output was structured,
 * so that `output` holds its values: a list of records that repeat is data,
 * not a loop.
 */
export function nonAnswerOf(output: string, ask: string, toolCalls: readonly unknown[] | undefined, structured = false): NonAnswer | null {
  const hasAsk = ask.trim().length > 0 && new Set(contentTerms(ask)).size >= MIN_ASK_TERMS_TO_JUDGE;
  const kind: AskKind = hasAsk ? askKindOf(ask) : { write: false, wh: false, question: false };
  const noToolCalls = Array.isArray(toolCalls) && toolCalls.length === 0;
  const workRecorded = Array.isArray(toolCalls) && toolCalls.length > 0;
  const said = trimChars(output, '').slice(0, 60);
  const words = wordsOf(output);

  const lead = leadInOf(output, kind, workRecorded);
  if (lead !== null) return { shape: 'lead-in', message: `The output announces an answer and gives none: ${lead}`, whole: true };

  if (hasAsk) {
    const placeholder = placeholderOf(output, ask, kind);
    if (placeholder !== null) return { shape: 'placeholder', message: `The output says nothing: it is ${placeholder}`, whole: true };

    if ((kind.write || kind.wh) && !workRecorded && madeOf(words, PROMISE_WORDS, PROMISE_MARKS) && !askNamesAll(ask, words)) {
      return { shape: 'promise', message: `The output promises the work ("${said}") and does not do it, and the call records no tool call that did it elsewhere`, whole: true };
    }
    // A claim of completion, when the call says no tool was called: an ask for something written got nothing, and an ask to act was not acted on.
    if (!kind.question && noToolCalls && madeOf(words, COMPLETION_WORDS, COMPLETION_MARKS) && !askNamesAll(ask, words)) {
      const what = kind.write ? 'the ask asked for something written, and none was written' : 'the ask asked for something to be done, and nothing could have done it';
      return { shape: 'completion', message: `The output only says the work is done ("${said}"); the call says no tool was called, so ${what}`, whole: true };
    }
    if (isAskHandedBack(output, ask, kind)) return { shape: 'echo', message: 'The output hands the ask back instead of answering it', whole: true };
  }

  if (!structured) {
    const loop = loopOf(output, ask);
    if (loop !== null) return { shape: 'loop', message: `One passage repeated ${loop.count} times makes up ${Math.round(loop.share * 100)}% of the output`, whole: false };
  }
  return null;
}

/** The sentence for an output that is none of the shapes. */
export const SAYS_SOMETHING_PASS = 'The output says something: it is not a promise or a bare claim of completion in place of something asked to be written, an announcement with nothing after it, a placeholder, the ask handed back, or one passage on repeat';

export const saysSomething: EvalRule = {
  name: 'says_something',
  description:
    'Fails an answer that says nothing, read against what the ask asked for. To an ask for something written (write, draft, summarise, explain, list …): a promise in place of the work ("Sure!", "Will do!") when no tool call is recorded, a bare "Done." when the call says no tool was called, a placeholder ("null", "…", lorem ipsum), or a "here is …" with nothing after it. To any ask: an output that ends on a colon with nothing after it, the ask handed back, or one passage repeated ten times or more as most of the output. A question answered "OK", "null" or "Done.", an action reported done, and a refusal pass: each can be a correct answer. Skips an empty output, which non_empty_output judges',
  evalType: 'completeness',
  weight: 2,
  kind: 'detection',
  mechanism: 'pattern',
  needs: ['output', 'input', 'tool_calls'],
  outputView: 'values',
  question: 'complete',
  classes: ['stub'],
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const output = context.output;
    if (output.trim().length === 0) {
      return { ruleName: 'says_something', passed: false, score: 0, skipped: true, skipClass: 'not_applicable', skipReason: 'the output is empty; non_empty_output judges that', message: 'Not judged: the output is empty' };
    }
    const found = nonAnswerOf(output, context.input ?? '', context.toolCalls, context.outputRead === 'values');
    if (found === null) return { ruleName: 'says_something', passed: true, score: 1, message: SAYS_SOMETHING_PASS };
    const evidence: Evidence[] = [{ type: 'pattern', name: found.shape, count: 1 }];
    if (found.whole) evidence.push({ type: 'span', source: 'output', start: output.length - output.trimStart().length, end: output.trimEnd().length, label: 'the whole output' });
    return { ruleName: 'says_something', passed: false, score: 0, evidence, message: found.message };
  },
};
