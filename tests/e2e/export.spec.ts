/*
 * Export (#4) through the real dashboard in a real browser: the button on
 * the trace list, with a search and a filter set, downloads a file the
 * browser saves, holding exactly the traces the list API returns for the
 * same search and filter; the evaluation list downloads JSON Lines the
 * same way. The file is read from disk, as a user would open it.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { parseCsv } from '../helpers/csv.js';

test.describe('export', () => {
  test('the trace list downloads every trace its search and filter match, as CSV', async ({ page, request }) => {
    await page.goto('/traces?q=drafter');
    await page.getByRole('combobox', { name: 'Filter by agent' }).selectOption('content-drafter');

    const listed = (await (await request.get('/api/v1/traces?q=drafter&agent_name=content-drafter&limit=1000')).json()) as { total: number; traces: Array<{ trace_id: string }> };
    expect(listed.total).toBeGreaterThan(0);

    const trigger = page.getByRole('button', { name: `Export ${listed.total} ${listed.total === 1 ? 'trace' : 'traces'}` });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: /CSV/ }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^iris-traces-\d{4}-\d{2}-\d{2}T\d{6}Z\.csv$/);

    const bytes = readFileSync((await download.path())!);
    expect([...bytes.subarray(0, 3)], 'UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
    const [header, ...rows] = parseCsv(bytes.subarray(3).toString('utf8'));
    expect(header[0]).toBe('trace_id');
    expect(rows.map((r) => r[0]).sort()).toEqual(listed.traces.map((t) => t.trace_id).sort());
    expect(rows.every((r) => r[header.indexOf('agent_name')] === 'content-drafter')).toBe(true);
  });

  test('the evaluation list downloads its filtered rows as JSON Lines', async ({ page, request }) => {
    await page.goto('/evals');
    await page.getByRole('combobox', { name: 'Filter by result' }).selectOption('false');

    const listed = (await (await request.get('/api/v1/evaluations?passed=false&limit=1000')).json()) as { total: number; results: Array<{ id: string }> };
    expect(listed.total).toBeGreaterThan(0);

    await page.getByRole('button', { name: new RegExp(`^Export ${listed.total} evaluations?$`) }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: /JSON Lines/ }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^iris-evaluations-.*\.jsonl$/);

    const lines = readFileSync((await download.path())!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; passed: boolean });
    expect(lines.map((l) => l.id)).toEqual(listed.results.map((r) => r.id));
    expect(lines.every((l) => l.passed === false)).toBe(true);
  });
});
