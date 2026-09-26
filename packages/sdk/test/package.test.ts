/*
 * The package as a consumer loads it: the version the spans report is the
 * manifest's, and the built ESM and CommonJS entry points export the same
 * names.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SDK_NAME, SDK_VERSION } from '../src/index.js';
import { PACKAGE_ROOT } from './helpers.js';

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { name: string; version: string; dependencies?: Record<string, string> };

describe('the package', () => {
  it('reports the name and version in its manifest', () => {
    assert.equal(SDK_NAME, manifest.name);
    assert.equal(SDK_VERSION, manifest.version);
  });

  it('has no runtime dependencies', () => {
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  });

  it('the built ESM and CommonJS entry points export the same names', async (t) => {
    const esm = join(PACKAGE_ROOT, 'dist', 'esm', 'index.js');
    const cjs = join(PACKAGE_ROOT, 'dist', 'cjs', 'index.js');
    if (!existsSync(esm) || !existsSync(cjs)) {
      assert.fail('run `npm run build` before the tests: dist/ is what a consumer loads');
    }
    const fromImport = Object.keys(await import(pathToFileURL(esm).href)).sort();
    const fromRequire = Object.keys(createRequire(import.meta.url)(cjs) as object).sort();
    assert.deepEqual(fromRequire, fromImport);
    for (const name of ['wrapOpenAI', 'wrapAnthropic', 'irisMiddleware', 'IrisRecorder']) assert.ok(fromImport.includes(name), name);
    t.diagnostic(`${fromImport.length} exports`);
  });
});
