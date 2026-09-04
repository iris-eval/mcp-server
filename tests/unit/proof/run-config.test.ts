import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../../proof/judge/run.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const runPath = resolve(repoRoot, 'proof/judge/run.ts');
const resultsPath = resolve(repoRoot, 'proof/judge-results.json');
const resultsMdPath = resolve(repoRoot, 'proof/judge/RESULTS.md');

describe('readConfig', () => {
  it('refuses when no key is set for the chosen provider', () => {
    const r = readConfig({ PROOF_JUDGE_PROVIDER: 'anthropic' });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/IRIS_ANTHROPIC_API_KEY/);
  });

  it('refuses the openai provider without its key', () => {
    const r = readConfig({ PROOF_JUDGE_PROVIDER: 'openai' });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/IRIS_OPENAI_API_KEY/);
  });

  it('accepts a key and applies the documented defaults', () => {
    const r = readConfig({ PROOF_JUDGE_PROVIDER: 'anthropic', IRIS_ANTHROPIC_API_KEY: 'test-key' });
    expect('config' in r).toBe(true);
    if ('config' in r) {
      expect(r.config.provider).toBe('anthropic');
      expect(r.config.model).toBe('claude-haiku-4-5-20251001');
      expect(r.config.maxCostUsd).toBe(2.0);
      expect(r.config.perEvalCapUsd).toBe(0.25);
    }
  });

  it('reads the cost caps from the environment', () => {
    const r = readConfig({
      PROOF_JUDGE_PROVIDER: 'openai',
      IRIS_OPENAI_API_KEY: 'k',
      PROOF_JUDGE_MAX_COST_USD: '0.50',
      IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL: '0.10',
    });
    expect('config' in r).toBe(true);
    if ('config' in r) {
      expect(r.config.maxCostUsd).toBe(0.5);
      expect(r.config.perEvalCapUsd).toBe(0.1);
    }
  });

  it('rejects an unknown provider and an unpriced model', () => {
    const bad = readConfig({ PROOF_JUDGE_PROVIDER: 'cohere', IRIS_ANTHROPIC_API_KEY: 'k' });
    expect('error' in bad && /must be/.test(bad.error)).toBe(true);
    const noPrice = readConfig({ PROOF_JUDGE_PROVIDER: 'anthropic', PROOF_JUDGE_MODEL: 'made-up-9', IRIS_ANTHROPIC_API_KEY: 'k' });
    expect('error' in noPrice && /pricing/.test(noPrice.error)).toBe(true);
  });
});

describe('runner end-to-end without a key', () => {
  it('exits 2 and writes NOTHING', () => {
    // Preserve the committed results file to prove the run did not touch it.
    const before = readFileSync(resultsPath, 'utf-8');
    if (existsSync(resultsMdPath)) rmSync(resultsMdPath);

    const env = { ...process.env };
    delete env.IRIS_ANTHROPIC_API_KEY;
    delete env.IRIS_OPENAI_API_KEY;
    env.PROOF_JUDGE_PROVIDER = 'anthropic';

    let status: number | null = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', runPath], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      status = e.status ?? null;
      stderr = e.stderr?.toString() ?? '';
    }

    expect(status).toBe(2);
    expect(stderr).toMatch(/Nothing was measured or written/);
    // The committed pending file is byte-identical, and no RESULTS.md appeared.
    expect(readFileSync(resultsPath, 'utf-8')).toBe(before);
    expect(existsSync(resultsMdPath)).toBe(false);
  }, 30_000);
});
