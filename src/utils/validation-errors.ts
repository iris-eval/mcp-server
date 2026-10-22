/*
 * Validation errors of a bounded size.
 *
 * A request a schema refuses is answered with what was wrong, so the
 * sender can fix it. Zod reports every failing element, so a list passed
 * on whole grows with the request, and the answer could be far larger than
 * the request it answers.
 *
 * Every answer built from validation issues now goes through here. It
 * lists at most MAX_LISTED_ISSUES of them, says how many there were
 * (`issueCount`) and, when it left some out, says so in a sentence
 * (`detailsNote`). Within a listed issue, a message, a path, a list of
 * unknown keys and the branches of a union are cut to a bounded size too,
 * so one issue cannot carry the whole payload back either.
 *
 * Twenty, because the largest body the API validates, a trace, has 18
 * top-level fields: a trace with every one of them wrong is still answered
 * in full, and so is any request that is wrong in a handful of ways. A
 * request wrong in more places than that is almost always wrong in one way
 * many times (every span, every element), and the first twenty show the
 * pattern; fixing them and sending again shows what is left.
 */

/** Issues listed in one validation error. */
export const MAX_LISTED_ISSUES = 20;
/** Unknown keys named in one issue, or in one sentence about them. */
export const MAX_LISTED_KEYS = 20;
/** Characters kept of one issue's message. */
export const MAX_ISSUE_MESSAGE_CHARS = 1_000;
/** Segments kept of one issue's path. */
export const MAX_ISSUE_PATH_SEGMENTS = 32;
/** Issues kept in each branch of a union's nested errors. */
const MAX_BRANCH_ISSUES = 3;
/** How deep nested union errors are followed. */
const MAX_UNION_DEPTH = 2;

const count = (n: number): string => n.toLocaleString('en-US');

/** `"a", "b", "c"`: at most MAX_LISTED_KEYS of them, then how many more there were. */
export function listKeys(keys: readonly string[]): string {
  const named = keys.slice(0, MAX_LISTED_KEYS).map((k) => `"${k}"`).join(', ');
  return keys.length > MAX_LISTED_KEYS ? `${named} and ${count(keys.length - MAX_LISTED_KEYS)} more` : named;
}

function cutText(text: string): string {
  return text.length > MAX_ISSUE_MESSAGE_CHARS ? `${text.slice(0, MAX_ISSUE_MESSAGE_CHARS)}…` : text;
}

/** One issue, cut to a bounded size; an issue already small comes back with the same fields and values. */
function boundIssue(issue: unknown, depth: number): unknown {
  if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) return issue;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(issue)) {
    if (key === 'message' && typeof value === 'string') out[key] = cutText(value);
    else if (key === 'path' && Array.isArray(value)) out[key] = value.slice(0, MAX_ISSUE_PATH_SEGMENTS);
    else if (key === 'keys' && Array.isArray(value)) {
      out[key] = value.slice(0, MAX_LISTED_KEYS);
      if (value.length > MAX_LISTED_KEYS) out.keyCount = value.length;
    } else if (key === 'errors' && Array.isArray(value)) {
      // An invalid_union's branches: each its own list of issues.
      out[key] =
        depth >= MAX_UNION_DEPTH
          ? []
          : value
              .slice(0, MAX_LISTED_ISSUES)
              .map((branch) => (Array.isArray(branch) ? branch.slice(0, MAX_BRANCH_ISSUES).map((i) => boundIssue(i, depth + 1)) : branch));
    } else out[key] = value;
  }
  return out;
}

export interface BoundedIssues {
  /** The first issues, each cut to a bounded size. */
  details: unknown[];
  /** How many issues there were in all. */
  issueCount: number;
  /** Present when issues were left out: a sentence saying how many are listed of how many. */
  detailsNote?: string;
}

/** At most MAX_LISTED_ISSUES of `issues`, how many there were, and a note when some were left out. */
export function boundIssues(issues: unknown): BoundedIssues {
  const all = Array.isArray(issues) ? issues : [];
  const details = all.slice(0, MAX_LISTED_ISSUES).map((i) => boundIssue(i, 0));
  return {
    details,
    issueCount: all.length,
    ...(all.length > MAX_LISTED_ISSUES
      ? { detailsNote: `The first ${MAX_LISTED_ISSUES} of ${count(all.length)} issues are listed; the rest are left out to keep this response small.` }
      : {}),
  };
}

/** The body of a 400 for a request a schema refused: `{ error, details, issueCount, detailsNote? }`. */
export function validationErrorBody(error: string, issues: unknown): { error: string } & BoundedIssues {
  return { error, ...boundIssues(issues) };
}

/**
 * Issues as one line: `path: message; path: message`, at most `max` of
 * them, then how many more. `root` names an issue with an empty path.
 */
export function issuesText(issues: readonly { path: readonly PropertyKey[]; message: string }[], options: { max: number; root: string }): string {
  const listed = issues
    .slice(0, options.max)
    .map((i) => `${i.path.slice(0, MAX_ISSUE_PATH_SEGMENTS).map(String).join('.') || options.root}: ${cutText(i.message)}`)
    .join('; ');
  return issues.length > options.max ? `${listed}; and ${count(issues.length - options.max)} more` : listed;
}
