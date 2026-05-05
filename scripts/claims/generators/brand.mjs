// Brand generator — emits canonical brand constants.
//
// For PR-1 these are hardcoded here as the single source of truth, with the
// tagline + description verified against package.json.description for
// consistency. Future PRs can extract a website/src/lib/brand-constants.ts
// module that this generator reads from instead.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const TAGLINE = 'The agent eval standard for MCP';

export async function generate() {
  // Cross-check: package.json.description should start with the tagline.
  const pkgRaw = await readFile(resolve(root, 'package.json'), 'utf-8');
  const pkg = JSON.parse(pkgRaw);
  if (!pkg.description?.startsWith(TAGLINE)) {
    throw new Error(
      `Brand generator: package.json description should start with tagline "${TAGLINE}", got "${pkg.description?.slice(0, 60) ?? '(empty)'}"`,
    );
  }

  return {
    tagline: TAGLINE,
    categoryName: 'Agent Eval',
    coinedTerms: [
      'Eval Tax',
      'Eval Drift',
      'Eval Gap',
      'Eval Coverage',
      'Eval-Driven Development',
      'Eval Loop',
    ],
    websiteUrl: 'https://iris-eval.com',
    publicRepoUrl: 'https://github.com/iris-eval/mcp-server',
    npmPackage: '@iris-eval/mcp-server',
    supportEmail: 'hello@iris-eval.com',
    securityEmail: 'security@iris-eval.com',
  };
}
