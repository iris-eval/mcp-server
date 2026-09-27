/*
 * The package as a consumer loads it: the built ESM and CommonJS entry
 * points export the same names, and the recorder comes from @iris-eval/sdk
 * as a peer, so a process that also wraps a provider client shares one
 * recorder with the handler.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from './helpers.js';

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

describe('the package', () => {
  it('has no runtime dependencies of its own: the recorder and LangChain are peers', () => {
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), ['@iris-eval/sdk', '@langchain/core']);
  });

  it('the built ESM and CommonJS entry points export the same names', async () => {
    const esm = join(PACKAGE_ROOT, 'dist', 'esm', 'index.js');
    const cjs = join(PACKAGE_ROOT, 'dist', 'cjs', 'index.js');
    if (!existsSync(esm) || !existsSync(cjs)) assert.fail('run `npm run build` before the tests: dist/ is what a consumer loads');
    const fromImport = Object.keys(await import(pathToFileURL(esm).href)).sort();
    const fromRequire = Object.keys(createRequire(import.meta.url)(cjs) as object).sort();
    assert.deepEqual(fromRequire, fromImport);
    assert.deepEqual(fromImport, ['IrisCallbackHandler']);
  });
});
