/*
 * Linear-time trailing trims.
 *
 * A trailing-anchor regex like /\/+$/ or /[.,;:!?)"'>]+$/ looks cheap, but a
 * backtracking engine tries it from EVERY starting position: on a string of
 * n slashes followed by one other character it scans the rest of the run from
 * each slash and fails at the end, n times over. That is quadratic, and an
 * output or config value of a few hundred thousand characters turns it into
 * minutes of blocked event loop (found by the 2026-09-23 ReDoS audit). These
 * helpers walk back from the end once.
 */

/** `s` with every trailing character in `chars` removed. */
export function trimTrailingChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** `s` with trailing slashes removed — the linear form of `s.replace(/\/+$/, '')`. */
export function trimTrailingSlashes(s: string): string {
  return trimTrailingChars(s, '/');
}
