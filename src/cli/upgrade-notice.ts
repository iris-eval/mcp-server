/*
 * The line a start prints when it has just migrated a database that MCP
 * clients on this machine, pinned to an older release, can no longer open
 * (0.20.0, #704). The storage layer has already said what it did and where
 * the copy is (sqlite-adapter.ts, upgradeLine); this names the clients that
 * will now refuse to start, and the one command that moves them.
 *
 * It reads the client configs only on a start that migrated a file, and
 * only reads them. A config it cannot read is skipped: this is a courtesy
 * on the way to serving, never a reason not to.
 */
import type { UpgradeReport } from '../storage/sqlite-adapter.js';
import { PKG_VERSION } from '../config/defaults.js';
import { COMMAND } from '../identity.js';
import { IRIS_PACKAGE, currentEnvironment, type Environment } from './install/clients.js';
import { joinNames, pinsBelow, readClientPins } from './install/pins.js';

/** The command that moves every configured client to `version`. */
export function upgradeCommand(version: string = PKG_VERSION): string {
  return `npx -y ${IRIS_PACKAGE}@${version} install --upgrade`;
}

/** The sentence for clients pinned below the database's new floor, or null when there are none. */
export function staleClientsLine(report: UpgradeReport, environment: Environment = currentEnvironment()): string | null {
  if (report.floorAfter === null || report.floorAfter === report.floorBefore) return null;
  let stale;
  try {
    stale = pinsBelow(readClientPins(environment), report.floorAfter);
  } catch {
    return null;
  }
  if (stale.length === 0) return null;
  const who = joinNames(stale.map((p) => `${p.profile.displayName} (Iris ${p.version})`));
  return `[iris] ${who} cannot open ${report.dbPath} now that it is upgraded. Move every client to Iris ${report.to} with: ${upgradeCommand(report.to)}`;
}

export interface AnnounceOptions {
  write?: (text: string) => void;
  environment?: Environment;
}

/** Print the stale-clients line on stderr when a start migrated the file; nothing otherwise. */
export function announceUpgrade(report: UpgradeReport | undefined, options: AnnounceOptions = {}): void {
  if (!report) return;
  const line = staleClientsLine(report, options.environment);
  if (line) (options.write ?? ((t: string) => process.stderr.write(t)))(`${line}\n`);
}

/** A fatal error's sentence, plain, for the terminal. */
export function fatalLine(err: unknown): string {
  return `${COMMAND}: ${err instanceof Error ? err.message : String(err)}\n`;
}
