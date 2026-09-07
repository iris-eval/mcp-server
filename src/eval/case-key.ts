import { createHash } from 'node:crypto';

/**
 * What makes two traces the SAME QUESTION asked twice.
 *
 * A case key is what turns two independent samples into a PAIRED
 * comparison, and pairing is worth more than it looks: McNemar on matched
 * pairs removes the variance BETWEEN cases and leaves only the variance
 * from the change, so six matched pairs can say something six unmatched
 * ones cannot. Without a key, a comparison of two runs is two independent
 * proportions and needs far more data to see the same effect.
 *
 * THE CALLER'S KEY ALWAYS WINS. A CI job that names its fixture knows
 * something no hash of the prompt can recover — two runs may legitimately
 * reword a question while asking the same thing, and the caller is the only
 * party who knows that. The derived key exists so that a caller who sends
 * nothing still gets pairing, not so that it can overrule one who does.
 */

/** Characters of input read when deriving a key. A prompt, not a corpus. */
export const CASE_KEY_INPUT_CHARS = 20_000;
/** Hex characters kept. 16 hex = 64 bits: collision-free at any trace count a local store will hold. */
export const CASE_KEY_LENGTH = 16;
/** Longest caller-supplied key accepted, so a key cannot become a payload. */
export const MAX_CASE_KEY_CHARS = 200;

/**
 * Collapse the incidental differences between two askings of one question.
 *
 * Whitespace only, and deliberately nothing else. It is tempting to lowercase
 * or strip punctuation — and both would be wrong here, because a case key is
 * an IDENTITY, not a similarity score. Two prompts differing by a word are
 * different questions, and quietly merging them would pair traces that are
 * not a pair and report a difference between things nobody compared. The one
 * safe normalisation is the one that changes no words: a prompt re-indented
 * by a template is the same prompt.
 */
export function normaliseForCaseKey(input: string): string {
  return input.slice(0, CASE_KEY_INPUT_CHARS).replace(/\s+/g, ' ').trim();
}

/** The derived key for an input, or null when there is no input to derive from. */
export function deriveCaseKey(input: string | undefined | null): string | null {
  if (typeof input !== 'string') return null;
  const normalised = normaliseForCaseKey(input);
  if (normalised.length === 0) return null;
  return createHash('sha256').update(normalised).digest('hex').slice(0, CASE_KEY_LENGTH);
}

/**
 * The key to store: the caller's when it gave one, else the derived one.
 *
 * A caller's key is trimmed and capped and otherwise taken as written —
 * it is an opaque identifier, and interpreting it would be inventing meaning
 * the caller did not put there.
 */
export function resolveCaseKey(supplied: string | undefined | null, input: string | undefined | null): string | null {
  if (typeof supplied === 'string') {
    const trimmed = supplied.trim().slice(0, MAX_CASE_KEY_CHARS);
    if (trimmed.length > 0) return trimmed;
  }
  return deriveCaseKey(input);
}
