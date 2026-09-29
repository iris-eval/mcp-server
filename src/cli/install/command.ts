/*
 * `iris-eval install` — write Iris into an MCP client's config, or take it out.
 *
 *   npx -y @iris-eval/mcp-server install <client>              add Iris to <client>
 *   npx -y @iris-eval/mcp-server install <client> --uninstall  remove it
 *   npx -y @iris-eval/mcp-server install --list                the clients found on this machine, and the Iris each runs
 *   npx -y @iris-eval/mcp-server install --upgrade             move every client that runs Iris to this version
 *   npx -y @iris-eval/mcp-server install --help
 *
 * The verb lives in the server package itself, so the command a reader
 * copies from the README is the same package the client will run: there is
 * no second package to publish, version and keep in step. The config it
 * writes pins the version doing the install (see config-writer.ts).
 *
 * Not on the MCP server path: src/index.ts hands `install` off before any
 * server code runs, so stdout here is the user's terminal, never a JSON-RPC
 * stream. Output that answers the command goes to stdout; errors and usage
 * after an error go to stderr.
 */
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { PKG_VERSION } from '../../config/defaults.js';
import { COMMAND } from '../../identity.js';
import {
  IRIS_PACKAGE,
  SUPPORTED_CLIENTS,
  currentEnvironment,
  detectInstalledClients,
  launchCommand,
  profileFor,
  resolveClientName,
  type Environment,
  type SupportedClient,
} from './clients.js';
import { installIris, uninstallIris, IRIS_SERVER_KEY, LEGACY_IRIS_SERVER_KEY } from './config-writer.js';
import { readClientPins, type ClientPin } from './pins.js';
import { compareVersions } from '../../utils/versions.js';

/*
 * The per-client docs link, in ONE place: the README section that shows
 * every client's config by hand. It used to be a `/docs/clients` page on the
 * marketing site, restated across three surfaces, and that page never
 * existed — a 404 printed at exactly the moment someone was stuck.
 * tests/unit/install/command.test.ts holds this to a real README heading.
 */
export const CLIENT_DOCS_URL = 'https://github.com/iris-eval/mcp-server#hook-up-your-own-agent';

export interface InstallIo {
  stdout: Pick<Writable, 'write'>;
  stderr: Pick<Writable, 'write'>;
  /** The environment client paths resolve against. Defaults to this process's. */
  environment?: Environment;
  /** The version the written config pins. Defaults to this package's. */
  version?: string;
}

const RUN = `npx -y ${IRIS_PACKAGE}`;

function usage(): string {
  return `Add Iris to an MCP client's config, or remove it.

Usage:
  ${RUN} install <client>              add Iris to <client>'s MCP config
  ${RUN} install <client> --uninstall  remove it again
  ${RUN} install --list                show the clients found on this machine and the Iris each runs
  ${RUN} install --upgrade             move every client that runs Iris to this version
  ${RUN} install --help                show this message

  After a global install (npm install -g ${IRIS_PACKAGE}), \`${COMMAND} install <client>\` is the same command.

Clients: ${SUPPORTED_CLIENTS.join(', ')}

The config runs \`npx -y ${IRIS_PACKAGE}@<this version>\` under the key "${IRIS_SERVER_KEY}". Every client shares one
database, and a release that upgrades it can leave clients pinned to an older release unable to open it:
\`${RUN}@latest install --upgrade\` moves every client that runs Iris at once. Other servers in the file are kept.
An entry under the older key "${LEGACY_IRIS_SERVER_KEY}" moves to "${IRIS_SERVER_KEY}" when it runs Iris; one that runs another
server is left as it is.

Examples:
  ${RUN} install claude-code
  ${RUN} install cursor --uninstall

Every client's config by hand: ${CLIENT_DOCS_URL}
`;
}

/** What a client's Iris entry runs, in a few words. */
function pinText(pin: ClientPin): string {
  switch (pin.kind) {
    case 'pinned':
      return `Iris ${pin.version}`;
    case 'unpinned':
      return 'Iris, unpinned';
    case 'other':
      return `runs ${pin.detail}`;
    case 'unreadable':
      return 'config unreadable';
    case 'absent':
      return 'no Iris entry';
  }
}

function listText(e: Environment, version: string): string {
  const detected = new Set(detectInstalledClients(e).map((p) => p.id));
  const pins = readClientPins(e);
  const lines = ['MCP clients found on this machine:'];
  const found = pins.filter((p) => detected.has(p.profile.id) || p.kind !== 'absent');
  if (found.length === 0) lines.push('  (none found)');
  for (const p of found) lines.push(`  ${p.profile.id.padEnd(15)} ${pinText(p).padEnd(17)} ${p.profile.configPath}`);
  const behind = found.filter((p) => p.kind === 'unpinned' || (p.kind === 'pinned' && compareVersions(p.version, version) < 0));
  if (behind.length > 0) {
    lines.push('', `${behind.map((p) => p.profile.id).join(', ')} ${behind.length === 1 ? 'runs' : 'run'} another Iris than this one (${version}): \`${RUN}@${version} install --upgrade\` moves every client to it.`);
  }
  const rest = pins.filter((p) => !found.includes(p));
  if (rest.length > 0) lines.push('', `Not found here (install still writes their config if you name them): ${rest.map((p) => p.profile.id).join(', ')}`);
  return lines.join('\n') + '\n';
}

/**
 * `--upgrade`: every client whose config runs the Iris package — pinned to
 * an older release, or unpinned, which npx resolves to whatever it cached —
 * is moved to this version, the way `install <client>` moves one. A pin to
 * a newer release is left alone (this command never moves a client back),
 * as is an entry that runs something other than the npm package. Returns
 * the exit code: 1 when a config could not be read or written.
 */
function runUpgrade(io: InstallIo, e: Environment, version: string): number {
  const pins = readClientPins(e);
  const out: string[] = [`Moving every MCP client that runs Iris to ${version}:`];
  const moved: string[] = [];
  let failed = false;
  for (const pin of pins) {
    const { profile } = pin;
    const row = (text: string) => out.push(`  ${profile.id.padEnd(15)} ${text}`);
    if (pin.kind === 'absent') continue;
    if (pin.kind === 'unreadable') {
      failed = true;
      row(`not changed: ${pin.detail}`);
      continue;
    }
    if (pin.kind === 'other') {
      row(`left as it is: it ${pinText(pin)}, not the npm package, so install does not manage it`);
      continue;
    }
    if (pin.kind === 'pinned' && compareVersions(pin.version, version) > 0) {
      row(`left at ${pin.version}, newer than ${version}; run install --upgrade from ${pin.version} to move the others up to it`);
      continue;
    }
    if (pin.kind === 'pinned' && compareVersions(pin.version, version) === 0) {
      row(`already on ${version}`);
      continue;
    }
    try {
      installIris(profile, launchCommand(profile, version, e.platform));
      moved.push(profile.displayName);
      row(`${pin.kind === 'pinned' ? pin.version : `unpinned (${pin.spec})`} -> ${version}   ${profile.configPath}`);
    } catch (err) {
      failed = true;
      row(`not changed: ${(err as Error).message}`);
    }
  }
  if (out.length === 1) out.push('  (no client config on this machine runs Iris)');
  out.push('');
  if (moved.length > 0) out.push(`Restart ${moved.join(', ')} to load it.`);
  out.push(
    'Not in these files: the Claude Desktop extension (iris-eval.mcpb) moves when you open a newer bundle, and the Claude Code plugins ' +
      'move with `claude plugin marketplace update iris-eval` then `claude plugin update iris-eval@iris-eval` (and `iris-eval-capture@iris-eval`).',
  );
  io.stdout.write(out.join('\n') + '\n');
  return failed ? 1 : 0;
}

interface Parsed {
  help: boolean;
  list: boolean;
  upgrade: boolean;
  uninstall: boolean;
  client?: SupportedClient;
}

function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      list: { type: 'boolean' },
      upgrade: { type: 'boolean' },
      uninstall: { type: 'boolean' },
      client: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) throw new Error(`install takes one client, got ${positionals.length}: ${positionals.join(' ')}`);
  const flagClient = values.client;
  const positionalClient = positionals[0];
  if (flagClient && positionalClient && flagClient !== positionalClient) {
    throw new Error(`two different clients named: "${positionalClient}" and --client "${flagClient}"`);
  }
  const candidate = flagClient ?? positionalClient;
  let client: SupportedClient | undefined;
  if (candidate !== undefined) {
    client = resolveClientName(candidate);
    if (!client) throw new Error(`unknown client "${candidate}". Clients: ${SUPPORTED_CLIENTS.join(', ')}`);
  }
  if (values.list && (client || values.uninstall || values.upgrade)) throw new Error('--list takes no client and cannot be combined with --uninstall or --upgrade');
  if (values.upgrade && (client || values.uninstall)) throw new Error('--upgrade moves every client that runs Iris; it takes no client and cannot be combined with --uninstall');
  return { help: Boolean(values.help), list: Boolean(values.list), upgrade: Boolean(values.upgrade), uninstall: Boolean(values.uninstall), client };
}

/** Run `install` with the arguments after the verb. Resolves to the process exit code. */
export async function runInstall(argv: string[], io: InstallIo): Promise<number> {
  const e = io.environment ?? currentEnvironment();
  const version = io.version ?? PKG_VERSION;

  let args: Parsed;
  try {
    args = parse(argv);
  } catch (err) {
    io.stderr.write(`${COMMAND} install: ${(err as Error).message}\n\n${usage()}`);
    return 2;
  }

  if (args.help) {
    io.stdout.write(usage());
    return 0;
  }
  if (args.list) {
    io.stdout.write(listText(e, version));
    return 0;
  }
  if (args.upgrade) return runUpgrade(io, e, version);
  if (!args.client) {
    io.stderr.write(`${COMMAND} install: name a client.\n\n${usage()}\n${listText(e, version)}`);
    return 2;
  }

  const profile = profileFor(args.client, e);
  try {
    if (args.uninstall) {
      const result = uninstallIris(profile);
      io.stdout.write(
        result.action === 'removed'
          ? `Removed ${IRIS_SERVER_KEY} from the ${profile.displayName} config.\n  ${result.configPath}\nRestart ${profile.displayName} to drop the server.\n`
          : `No change: ${IRIS_SERVER_KEY} was not in the ${profile.displayName} config.\n  ${result.configPath}\n`,
      );
      if (result.note) io.stderr.write(`${result.note}\n`);
      return 0;
    }

    const launch = launchCommand(profile, version, e.platform);
    const result = installIris(profile, launch);
    const line = `${launch.command} ${launch.args.join(' ')}`;
    const head =
      result.action === 'no-change'
        ? `No change: the ${profile.displayName} config already runs ${line}.`
        : `${result.action === 'created' ? 'Added' : 'Updated'} ${IRIS_SERVER_KEY} in the ${profile.displayName} config: ${line}`;
    io.stdout.write(
      `${head}\n  ${result.configPath}\n\n` +
        (result.action === 'no-change' ? '' : `Restart ${profile.displayName} to load it.\n`) +
        (profile.note ? `${profile.note}\n` : '') +
        `Check the install: ${RUN}@${version} --self-test\n` +
        `See scored traces: ${RUN}@${version} --dashboard\n`,
    );
    if (result.note) io.stderr.write(`${result.note}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`${COMMAND} install: ${(err as Error).message}\n`);
    return 1;
  }
}
