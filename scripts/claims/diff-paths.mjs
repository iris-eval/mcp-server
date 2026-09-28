// Where two JSON values differ, leaf by leaf: what `claims:check` prints
// when the committed .claims.json and the generator's output disagree, so
// the failure names the field that moved (tests.vitestRoot.passed: committed
// 3730, generated 3729) instead of only saying that something drifted.

/** A value shown in one line: JSON, cut at 80 characters; `absent` for a missing key. */
function show(value) {
  const s = value === undefined ? 'absent' : JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

const isObject = (v) => v !== null && typeof v === 'object';

/** Every leaf path where `committed` and `generated` differ: [{ path, committed, generated }], sorted by path. */
export function diffPaths(committed, generated, path = '') {
  if (isObject(committed) && isObject(generated) && Array.isArray(committed) === Array.isArray(generated)) {
    const keys = [...new Set([...Object.keys(committed), ...Object.keys(generated)])].sort();
    return keys.flatMap((k) => diffPaths(committed[k], generated[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(committed) === JSON.stringify(generated) ? [] : [{ path: path || '(root)', committed: show(committed), generated: show(generated) }];
}
