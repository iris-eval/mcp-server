/*
 * The published claims schema describes the file it is published for.
 *
 * website/public/claims-schema-v1.json is served at
 * iris-eval.com/claims-schema-v1.json and named by .claims.json's own
 * `$schema`. It had fallen behind: the top-level `clients` block (added with
 * the installer) was not in it, and `additionalProperties: false` made the
 * repository's own truthbase invalid against it. This test validates the
 * committed .claims.json against the committed schema, so a new block or key
 * cannot land in one without the other.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf-8')) as Record<string, unknown>;

describe('claims-schema-v1.json', () => {
  it('validates the committed .claims.json', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(read('website/public/claims-schema-v1.json'));
    const ok = validate(read('.claims.json'));
    expect(ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message} ${JSON.stringify(e.params)}`)).toEqual([]);
  });

  it('names every top-level block the truthbase carries', () => {
    const schema = read('website/public/claims-schema-v1.json') as { properties: Record<string, unknown> };
    const claims = read('.claims.json');
    expect(Object.keys(claims).filter((k) => !(k in schema.properties))).toEqual([]);
  });
});
