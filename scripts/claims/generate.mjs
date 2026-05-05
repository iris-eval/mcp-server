#!/usr/bin/env node
// Truthbase orchestrator — runs every generator in parallel, assembles
// .claims.json, validates against the schema shape, writes if changed.
//
// Exit codes:
//   0 — claims.json regenerated (or already current).
//   1 — generator failure.
//   2 — schema mismatch (developer must regen + commit).
//
// Usage:
//   node scripts/claims/generate.mjs              # regen and write if changed
//   node scripts/claims/generate.mjs --check      # regen and exit non-zero if disk diff
//   node scripts/claims/generate.mjs --print      # regen and print to stdout (no write)

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate as version } from './generators/version.mjs';
import { generate as tests } from './generators/tests.mjs';
import { generate as mcpTools } from './generators/mcp-tools.mjs';
import { generate as evalRules } from './generators/eval-rules.mjs';
import { generate as llmJudgeTemplates } from './generators/llm-judge-templates.mjs';
import { generate as brand } from './generators/brand.mjs';
import { generate as release } from './generators/release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const CLAIMS_PATH = resolve(root, '.claims.json');
const SCHEMA_VERSION = 1;

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const PRINT = args.has('--print');

async function main() {
  const generators = [
    ['version', version],
    ['tests', tests],
    ['mcpTools', mcpTools],
    ['evalRules', evalRules],
    ['llmJudgeTemplates', llmJudgeTemplates],
    ['brand', brand],
    ['release', release],
  ];

  const results = await Promise.allSettled(
    generators.map(async ([key, fn]) => [key, await fn()]),
  );

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    for (const f of failed) {
      console.error('[claims:generate] generator failure:', f.reason);
    }
    process.exit(1);
  }

  const fields = Object.fromEntries(results.map(r => r.value));

  // Determine commit SHA at generation time, if available.
  let generatedFromCommit = null;
  try {
    const { execSync } = await import('node:child_process');
    generatedFromCommit = execSync('git rev-parse --short HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim() || null;
  } catch {
    /* git not available; leave null */
  }

  const claims = {
    $schema: 'https://iris-eval.com/claims-schema-v1.json',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedFromCommit,
    generatorVersion: '1.0.0',
    ...fields,
  };

  // Stable JSON for diffability — sorted keys at top level + nested.
  const serialized = stableStringify(claims);

  if (PRINT) {
    process.stdout.write(serialized + '\n');
    return;
  }

  let existing = null;
  try {
    existing = await readFile(CLAIMS_PATH, 'utf-8');
  } catch {
    /* missing is fine on first run */
  }

  // For check-mode comparison, normalize both sides — strip generatedAt +
  // generatedFromCommit since those legitimately change every commit.
  const normalize = obj => {
    const { generatedAt, generatedFromCommit, ...rest } = obj;
    return rest;
  };

  const newNormalized = stableStringify(normalize(claims));
  let oldNormalized = null;
  if (existing) {
    try {
      oldNormalized = stableStringify(normalize(JSON.parse(existing)));
    } catch {
      oldNormalized = null;
    }
  }

  if (CHECK) {
    if (oldNormalized === newNormalized) {
      console.log('[claims:check] OK — claims.json matches generator output');
      process.exit(0);
    } else {
      console.error('[claims:check] FAIL — claims.json drifted from generator output');
      console.error('Run `npm run claims:generate` and commit the result.');
      process.exit(2);
    }
  }

  if (oldNormalized === newNormalized && existing) {
    console.log('[claims:generate] no change');
    return;
  }

  await writeFile(CLAIMS_PATH, serialized + '\n', 'utf-8');
  console.log(`[claims:generate] wrote ${CLAIMS_PATH}`);
}

function stableStringify(obj, indent = 2) {
  // Recursive sort of object keys for stable output.
  const sortKeys = v => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object' && v.constructor === Object) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = sortKeys(v[k]);
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sortKeys(obj), null, indent);
}

main().catch(err => {
  console.error('[claims:generate] unexpected error:', err);
  process.exit(1);
});
