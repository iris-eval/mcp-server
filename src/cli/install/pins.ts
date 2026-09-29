/*
 * Which Iris each MCP client on this machine runs (0.20.0, #704).
 *
 * Every client shares one database, and `install` pins each one to the
 * release that wrote its config. After an upgrade migrates the database, a
 * client still pinned below the new compatibility floor refuses to start.
 * This module reads each client's config — never writes it — and says what
 * its Iris entry runs: `install --list` prints it, `install --upgrade` moves
 * it, the self-test and a start that migrated the file warn about it.
 */
import { compareVersions, isVersion } from '../../utils/versions.js';
import { allProfiles, currentEnvironment, IRIS_PACKAGE, type ClientProfile, type Environment } from './clients.js';
import { readIrisEntry, type IrisEntry } from './config-writer.js';

export type ClientPin =
  /** No Iris entry in the client's config (or no config). */
  | { profile: ClientProfile; kind: 'absent' }
  /** The config could not be read; `detail` says why. */
  | { profile: ClientProfile; kind: 'unreadable'; detail: string }
  /** `npx … @iris-eval/mcp-server@<version>`. */
  | { profile: ClientProfile; kind: 'pinned'; version: string }
  /** The package with no version, or a tag or range: npx runs whatever version it resolves, often one it cached long ago. */
  | { profile: ClientProfile; kind: 'unpinned'; spec: string }
  /** Something other than the npm package (a global bin, a path to a checkout): `install` does not manage it. */
  | { profile: ClientProfile; kind: 'other'; detail: string };

/** What an entry's launch line runs. */
export function pinOf(profile: ClientProfile, entry: IrisEntry): ClientPin {
  if (entry.state === 'absent') return { profile, kind: 'absent' };
  if (entry.state === 'unreadable') return { profile, kind: 'unreadable', detail: entry.error };
  const spec = entry.args.find((a) => a === IRIS_PACKAGE || a.startsWith(`${IRIS_PACKAGE}@`));
  if (spec === undefined) return { profile, kind: 'other', detail: [entry.command, ...entry.args].filter(Boolean).join(' ') || '(no command)' };
  const version = spec.slice(IRIS_PACKAGE.length + 1);
  return version !== '' && isVersion(version) ? { profile, kind: 'pinned', version: version.replace(/^v/, '') } : { profile, kind: 'unpinned', spec };
}

/** Every supported client's Iris entry on this machine, in the installer's order. */
export function readClientPins(e: Environment = currentEnvironment()): ClientPin[] {
  return allProfiles(e).map((profile) => pinOf(profile, readIrisEntry(profile)));
}

/** Pinned clients that cannot open a database whose compatibility floor is `floor`. */
export function pinsBelow(pins: readonly ClientPin[], floor: string): Array<Extract<ClientPin, { kind: 'pinned' }>> {
  return pins.filter((p): p is Extract<ClientPin, { kind: 'pinned' }> => p.kind === 'pinned' && compareVersions(p.version, floor) < 0);
}

/** "Claude Code and Cursor", "Claude Code, Cursor and Zed". */
export function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
