/*
 * Discovery manifests must name only environment variables the server reads,
 * and must all name the ones that enable the paid tools.
 *
 * Found 2026-09-04 in the arc-zero inventory: server.json (the Official MCP
 * Registry manifest) listed three variables and none of the four that switch
 * on the LLM judge and the citation verifier — the two tools a registry
 * reader most needs to know how to enable — while smithery.yaml described
 * IRIS_PORT as "the HTTP transport or dashboard" port (the dashboard listens
 * on IRIS_DASHBOARD_PORT). A manifest that disagrees with the code is a
 * discovery-stage defect: the agent reading it configures the wrong thing.
 *
 * The lock: every IRIS_* name a manifest mentions is read somewhere under
 * src/, and the judge/citation variables appear in server.json.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

function envVarsReadBySrc(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.(IRIS_[A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return names;
}

function envVarsInServerJson(): string[] {
  const j = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
  return j.packages.flatMap((p: { environmentVariables?: { name: string }[] }) =>
    (p.environmentVariables ?? []).map((e) => e.name),
  );
}

function envVarsInSmithery(): string[] {
  const y = readFileSync(join(root, 'smithery.yaml'), 'utf8');
  return [...new Set([...y.matchAll(/\b(IRIS_[A-Z0-9_]+)\b/g)].map((m) => m[1]))];
}

const JUDGE_AND_CITATION_VARS = [
  'IRIS_ANTHROPIC_API_KEY',
  'IRIS_OPENAI_API_KEY',
  'IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL',
  'IRIS_CITATION_ALLOW_FETCH',
];

describe('discovery manifests name only environment variables the server reads', () => {
  const read = envVarsReadBySrc();

  it('the code reads the variables this test relies on (guards the grep itself)', () => {
    expect(read.has('IRIS_API_KEY')).toBe(true);
    expect(read.has('IRIS_DASHBOARD_PORT')).toBe(true);
    for (const v of JUDGE_AND_CITATION_VARS) expect(read.has(v)).toBe(true);
  });

  it('server.json lists no variable the server does not read', () => {
    const unknown = envVarsInServerJson().filter((n) => !read.has(n));
    expect(unknown).toEqual([]);
  });

  it('server.json names the variables that enable the judge and the citation verifier', () => {
    const listed = new Set(envVarsInServerJson());
    for (const v of JUDGE_AND_CITATION_VARS) expect(listed.has(v), v).toBe(true);
  });

  it('server.json describes IRIS_DASHBOARD_PORT and IRIS_PORT as different ports', () => {
    const j = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
    const vars: { name: string; description: string }[] = j.packages[0].environmentVariables;
    const dash = vars.find((v) => v.name === 'IRIS_DASHBOARD_PORT');
    expect(dash?.description).toMatch(/6920/);
    expect(dash?.description).toMatch(/IRIS_PORT/);
  });

  it('smithery.yaml names no variable the server does not read', () => {
    const unknown = envVarsInSmithery().filter((n) => !read.has(n));
    expect(unknown).toEqual([]);
  });

  it('smithery.yaml does not describe IRIS_PORT as the dashboard port', () => {
    const y = readFileSync(join(root, 'smithery.yaml'), 'utf8');
    const portBlock = y.slice(y.indexOf('irisPort:'), y.indexOf('commandFunction:'));
    expect(portBlock).not.toMatch(/transport or dashboard/i);
    expect(portBlock).toMatch(/IRIS_DASHBOARD_PORT/);
    expect(portBlock).toMatch(/3000/);
  });
});
