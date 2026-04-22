#!/usr/bin/env node
/*
 * iris-init CLI — universal installer for Iris.
 *
 * Usage:
 *   npx @iris-eval/init                       # interactive: pick a client
 *   npx @iris-eval/init <client>              # install for the named client
 *   npx @iris-eval/init <client> --uninstall  # remove the iris entry
 *   npx @iris-eval/init --list                # show detected clients
 *   npx @iris-eval/init --help                # this message
 *
 * Supported <client> values: claude-code, cursor, windsurf, continue.
 *
 * Phase 1 (this release) handles the four first-class clients per
 * grow-plug-and-play.md §5. Phase 2 adds raycast, zed, cline, plus
 * MCP-spec-driven auto-detection for unrecognized clients.
 */
import { parseArgs } from 'node:util';
import {
  type SupportedClient,
  allProfiles,
  detectInstalledClients,
  profileFor,
} from './detect.js';
import { installIris, uninstallIris } from './config-writer.js';

const SUPPORTED: SupportedClient[] = ['claude-code', 'cursor', 'windsurf', 'continue'];

function printHelp(): void {
  process.stdout.write(`iris-init — universal installer for Iris

Usage:
  npx @iris-eval/init                       # interactive: pick a client
  npx @iris-eval/init <client>              # install for the named client
  npx @iris-eval/init <client> --uninstall  # remove the iris entry
  npx @iris-eval/init --list                # show detected clients
  npx @iris-eval/init --help                # show this message

Supported clients: ${SUPPORTED.join(', ')}

Examples:
  npx @iris-eval/init claude-code
  npx @iris-eval/init cursor --uninstall

Per-client docs: https://iris-eval.com/docs/clients
`);
}

function printList(): void {
  const detected = detectInstalledClients();
  process.stdout.write('Detected MCP clients:\n');
  if (detected.length === 0) {
    process.stdout.write('  (none — no known MCP client config dirs found)\n');
    return;
  }
  for (const profile of detected) {
    process.stdout.write(`  ${profile.id.padEnd(14)} → ${profile.configPath}\n`);
  }
}

function isSupported(value: string): value is SupportedClient {
  return (SUPPORTED as string[]).includes(value);
}

interface ParsedArgs {
  help: boolean;
  list: boolean;
  uninstall: boolean;
  client?: SupportedClient;
}

function parse(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      list: { type: 'boolean' },
      uninstall: { type: 'boolean' },
      client: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const positionalClient = positionals[0];
  const flagClient = values.client as string | undefined;
  const candidate = flagClient ?? positionalClient;

  if (candidate && !isSupported(candidate)) {
    throw new Error(
      `Unknown client "${candidate}". Supported: ${SUPPORTED.join(', ')}`,
    );
  }

  return {
    help: Boolean(values.help),
    list: Boolean(values.list),
    uninstall: Boolean(values.uninstall),
    client: candidate as SupportedClient | undefined,
  };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n\n`);
    printHelp();
    return 2;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.list) {
    printList();
    return 0;
  }

  if (!args.client) {
    // Interactive flow not implemented in Phase 1; print help + detected list.
    process.stdout.write(
      'No client specified. Pass one explicitly:\n  npx @iris-eval/init <client>\n\n',
    );
    printList();
    process.stdout.write('\nFull help: npx @iris-eval/init --help\n');
    return 1;
  }

  const profile = profileFor(args.client);

  if (args.uninstall) {
    const result = uninstallIris(profile);
    if (result.action === 'removed') {
      process.stdout.write(
        `✓ Removed iris from ${profile.displayName} config.\n  ${result.configPath}\n`,
      );
    } else {
      process.stdout.write(
        `(no change) iris was not present in ${profile.displayName} config.\n  ${result.configPath}\n`,
      );
    }
    return 0;
  }

  const result = installIris(profile);
  const verb =
    result.action === 'created'
      ? 'Wrote'
      : result.action === 'updated'
        ? 'Updated'
        : '(no change)';
  process.stdout.write(
    `${verb} iris entry in ${profile.displayName} config.\n  ${result.configPath}\n\n`,
  );
  process.stdout.write(
    `Restart ${profile.displayName} to pick up the new MCP server.\n` +
      `Then any agent call will be scored by Iris.\n` +
      `Dashboard: npx @iris-eval/mcp-server dashboard\n`,
  );
  return 0;
}

// Direct CLI invocation (skip when imported by tests).
const isMain =
  import.meta.url.startsWith('file:') &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');

if (isMain) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Fatal: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
