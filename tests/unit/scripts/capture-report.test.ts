/*
 * The truthbase capture refuses a report whose counts would lie.
 *
 * A test file that fails to load is not a failed test: vitest's JSON report
 * lists the file with status "failed" and no assertions, counts none of its
 * tests, and leaves numFailedTests at 0. A capture that read only the counts
 * once recorded 3,533/3,533 with nothing failed for a branch whose
 * otlp.test.ts no longer parsed, eleven tests short. The capture now fails,
 * naming the file and the reason.
 *
 * The fixture tests/fixtures/capture/vitest-report-load-errors.json is a real
 * vitest 5 JSON report (paths replaced by <root>) of three files: one that
 * does not parse, one that throws at import, one that passes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — plain .mjs module
import { CaptureRefused, checkReport, fileLevelFailures } from '../../../scripts/claims/capture-report.mjs';

const ROOT = resolve(__dirname, '..', '..', '..');
const fixturePath = join(ROOT, 'tests', 'fixtures', 'capture', 'vitest-report-load-errors.json');
const loadErrors = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

const clean = (tests: number) => ({
  numTotalTests: tests,
  numPassedTests: tests,
  numFailedTests: 0,
  success: true,
  testResults: [{ name: '<root>/tests/a.test.ts', status: 'passed', message: '', assertionResults: Array.from({ length: tests }, () => ({ status: 'passed' })) }],
});

describe('what a report may not become', () => {
  it('a file that does not parse and a file that throws at import are named, with their reasons, and the capture is refused', () => {
    expect(fileLevelFailures(loadErrors, '<root>')).toEqual([
      { file: 'tests/zz/broken.test.ts', reason: 'Transform failed with 1 error:' },
      { file: 'tests/zz/throws.test.ts', reason: 'boom at import' },
    ]);
    // The counts alone look green: 1 of 1, nothing failed.
    expect([loadErrors.numTotalTests, loadErrors.numFailedTests]).toEqual([1, 0]);
    expect(() => checkReport(loadErrors, { scope: 'root', root: '<root>' })).toThrow(CaptureRefused);
    expect(() => checkReport(loadErrors, { scope: 'root', root: '<root>' })).toThrow(/2 test file\(s\) in scope "root" failed to load[\s\S]*tests\/zz\/broken\.test\.ts: Transform failed[\s\S]*tests\/zz\/throws\.test\.ts: boom at import/);
  });

  it('an ordinary failed assertion is a counted failure, not a load error', () => {
    const report = {
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      success: false,
      testResults: [{ name: '<root>/tests/a.test.ts', status: 'failed', message: '', assertionResults: [{ status: 'passed' }, { status: 'failed' }] }],
    };
    expect(fileLevelFailures(report)).toEqual([]);
    expect(checkReport(report)).toEqual({ total: 2, passed: 1, failed: 1 });
  });

  it('a run that failed with no failing test and no failing file (an unhandled error) is refused', () => {
    expect(() => checkReport({ ...clean(3), success: false })).toThrow(/failed \(success: false\) with no failing test and no failing file/);
  });

  it('a skipped test is refused, as before', () => {
    expect(() => checkReport({ ...clean(3), numPassedTests: 2 })).toThrow(/1 test\(s\) skipped/);
  });

  it('a clean report is its counts', () => {
    expect(checkReport(clean(3))).toEqual({ total: 3, passed: 3, failed: 0 });
  });
});

describe('claims:capture-tests', () => {
  it('exits non-zero on a report with a file that failed to load, names it, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-capture-'));
    const report = join(dir, 'root.json');
    // As vitest writes it on this machine: absolute paths under the repository root.
    writeFileSync(report, JSON.stringify(loadErrors).split('<root>').join(ROOT.split('\\').join('/')));
    const cache = join(ROOT, '.claims-cache', 'tests.json');
    const before = existsSync(cache) ? statSync(cache).mtimeMs : null;

    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'claims', 'capture-tests.mjs'), '--report', `root=${report}`, '--report', `dashboard=${report}`], { cwd: ROOT, encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/failed to load or errored outside any test/);
    expect(run.stderr).toContain('tests/zz/broken.test.ts: Transform failed with 1 error:');
    expect(run.stderr).toContain('tests/zz/throws.test.ts: boom at import');
    expect(existsSync(cache) ? statSync(cache).mtimeMs : null).toBe(before);
  });
});
