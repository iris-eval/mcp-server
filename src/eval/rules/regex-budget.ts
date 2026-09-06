/*
 * Empirical backtracking probe for user-supplied regex patterns.
 *
 * safe-regex2 is a STATIC heuristic built on star height — it catches
 * EXPONENTIAL blowup like `(a+)+$` and nothing else. Polynomial patterns
 * sail through it: `a*a*a*a*a*b` is judged safe, and takes 156ms on 40
 * characters, 237ms on 60, and effectively forever on a realistic agent
 * output. Deployed rules are re-registered into the engine at every
 * startup, so a pattern like that keeps wedging the server after a
 * restart — a permanent, self-inflicted denial of service.
 *
 * Static analysis of backtracking is hard; actually running the pattern is
 * not. This measures it against short adversarial payloads and rejects
 * anything already slow at trivial sizes.
 *
 * The catch-22 — running an untrusted regex to find out whether it hangs —
 * is handled twice over. First, probes escalate from a tiny payload upward
 * and bail the moment the budget is exceeded. Second — and this is the part
 * that actually holds — every probe executes in the sandbox worker
 * (regex-sandbox.ts) under a hard deadline. The original version ran probes
 * on the MAIN thread and checked Date.now() after each `.test()` returned:
 * a synchronous call cannot be interrupted from behind, and a pattern the
 * payload families did ignite blocked the probe itself for 43,380ms against
 * this 50ms budget. Now the worker is terminated mid-backtrack instead.
 *
 * This probe remains a deploy-time UX courtesy (reject obviously dangerous
 * patterns with a clear message before they are persisted), NOT the safety
 * boundary. Probing depends on guessing an igniting payload, which is not
 * possible in general — S79's fuel search failed to ignite `^(a|ab)+$` at
 * all. The boundary is the same sandbox deadline applied at every
 * evaluation in custom.ts.
 */

import { sandboxedRegexTest } from './regex-sandbox.js';

/** Total match-execution time a candidate pattern may spend across all
 * probes, as measured INSIDE the sandbox worker. Metering on worker-measured
 * time (not wall-clock) matters: wall-clock includes OS scheduling, and on a
 * busy host a 1ms match can take 60ms of wall time — the original wall-clock
 * budget rejected perfectly ordinary patterns whenever the machine was loaded
 * (every parallel test run reproduced it). */
/**
 * The longest pattern any caller may supply — a custom rule's `pattern`, or
 * a `pattern` inside a tool's JSON Schema. Lives here rather than with the
 * custom-rule factory because it is a fact about regex limits, and because
 * both consumers importing it from the factory would make a cycle.
 */
export const MAX_PATTERN_LENGTH = 1000;

const BUDGET_MS = 50;
/** Wall-clock ceiling per single probe call — the hang-killer, not the
 * meter. Generous so scheduling noise can never trip it; a genuinely
 * superlinear pattern burns through BUDGET_MS of measured time long before
 * this fires. */
const PROBE_WALL_DEADLINE_MS = 1000;
const PROBE_SIZES = [16, 32, 64, 128];
/** Appended to every probe payload to force a failed match (backtracking
 * happens on failure). NUL beats a space here: space matches `\s` and
 * several probe alphabets contain it, which would let the match succeed
 * quickly instead of exploring alternatives. NOTE: this was previously a
 * literal 0x00 byte inside the string — invisible in review and enough to
 * make git treat the whole file as binary. Same behavior, now spelled out. */
const TERMINATOR = '\0';

/**
 * Characters that tend to maximise backtracking pressure for a given
 * pattern: the literals it mentions, plus generic filler. Feeding a
 * pattern its own alphabet is what makes the engine explore alternatives
 * rather than fail at the first character.
 */
function probeAlphabets(source: string): string[] {
  const literals = source.replace(/[^A-Za-z0-9 ._@-]/g, '');
  const fromPattern = [...new Set(literals)].join('').slice(0, 4);
  const alphabets = ['a', ' ', 'a.', 'ab'];
  if (fromPattern.length > 0) alphabets.unshift(fromPattern);
  return alphabets;
}

/**
 * Returns a human-readable reason when `source` shows superlinear
 * backtracking, or null when it looks safe to deploy.
 */
export function regexBacktrackingBudgetExceeded(source: string, flags = ''): string | null {
  try {
    new RegExp(source, flags);
  } catch {
    // Syntax is validated separately and reported with a better message.
    return null;
  }

  let spentMs = 0;
  for (const size of PROBE_SIZES) {
    for (const alphabet of probeAlphabets(source)) {
      const payload = alphabet.repeat(Math.ceil(size / alphabet.length)).slice(0, size) + TERMINATOR;
      // The wall deadline is only the hang-killer; the budget meters on the
      // worker-measured match duration, immune to scheduling noise.
      const outcome = sandboxedRegexTest(source, flags, payload, PROBE_WALL_DEADLINE_MS);
      if (outcome.kind === 'match') spentMs += outcome.durationMs;
      const elapsed = Math.round(spentMs);
      if (outcome.kind === 'timeout' || elapsed > BUDGET_MS) {
        return (
          `Regex pattern rejected: superlinear backtracking (still running after ${elapsed}ms ` +
          `on a ${size}-character input). safe-regex2 only catches exponential blowup, so ` +
          `polynomial patterns like a*a*a*a*a*b pass it while still hanging the server. ` +
          `Avoid adjacent unbounded quantifiers over overlapping character classes; bound them ` +
          `instead, e.g. \\s{0,8} rather than \\s*.`
        );
      }
    }
  }
  return null;
}
