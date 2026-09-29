/*
 * Release versions compared in semver order: major.minor.patch, then a
 * pre-release (`-rc.1`) before the release itself; build metadata (`+dev`)
 * is ignored. The migration ledger's compatibility floors and the client
 * pins `install` reads are both compared with it.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether `value` is a release version this module can order. */
export function isVersion(value: string): boolean {
  return VERSION.test(value.trim());
}

function identifiers(pre: string | undefined): string[] {
  return pre === undefined ? [] : pre.split('.');
}

/** Negative when `a` comes before `b`, positive after, 0 when equal. Throws on a string that is not a version. */
export function compareVersions(a: string, b: string): number {
  const ma = VERSION.exec(a.trim());
  const mb = VERSION.exec(b.trim());
  if (!ma || !mb) throw new Error(`not a release version: ${JSON.stringify(ma ? b : a)}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = identifiers(ma[4]);
  const pb = identifiers(mb[4]);
  // A release sorts after every pre-release of itself.
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/** The later of the versions given, ignoring null; null when there are none. */
export function latestVersion(versions: ReadonlyArray<string | null | undefined>): string | null {
  let out: string | null = null;
  for (const v of versions) {
    if (v && isVersion(v) && (out === null || compareVersions(v, out) > 0)) out = v;
  }
  return out;
}
