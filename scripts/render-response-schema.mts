#!/usr/bin/env tsx
/*
 * Writes website/public/response-schema-v1.json from the zod schema the
 * server validates with (arc 9, N-22).
 *
 *   npm run schema:render     # write it
 *   npm run schema:check      # fail when the committed file has drifted
 *
 * The check also runs inside the test suite
 * (tests/response-schema-published.test.ts), so a drift is caught on every
 * required check rather than only where this script is wired.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderResponseSchema, RESPONSE_SCHEMA_PATH } from '../src/eval/response-schema-json.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, RESPONSE_SCHEMA_PATH);
const check = process.argv.includes('--check');
const rendered = renderResponseSchema();

if (check) {
  const committed = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (committed !== rendered) {
    process.stderr.write(`[schema:check] FAIL — ${RESPONSE_SCHEMA_PATH} differs from the zod schema. Run \`npm run schema:render\` and commit.\n`);
    process.exit(2);
  }
  process.stdout.write(`[schema:check] OK — ${RESPONSE_SCHEMA_PATH} matches the schema the server validates with\n`);
} else {
  writeFileSync(file, rendered);
  process.stdout.write(`[schema:render] wrote ${RESPONSE_SCHEMA_PATH} (${rendered.length} bytes)\n`);
}
