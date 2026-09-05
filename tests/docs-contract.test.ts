/*
 * The docs contract — prose names only things that exist.
 *
 * Arc zero (2026-09-05) found three surfaces that named things the product
 * does not have: delete_trace's description told an agent to use a
 * `--retention-days` flag (no such flag; retention is `retention.days` in
 * config.json), get_traces pointed at "the dashboard's SSE endpoint" (no such
 * endpoint), and server.json omitted three IRIS_* variables the server reads.
 * tests/manifest-env-parity.test.ts checks that the manifests name only
 * variables the code reads, but not the reverse, and nothing checked flags,
 * routes or resource URIs at all.
 *
 * This test extracts each vocabulary FROM THE CODE and asserts every mention
 * on a prose surface is in it:
 *
 *   --flags        ⊆ the CLI's parseArgs options (src/index.ts) ∪ an explicit
 *                    list of other tools' flags the docs quote in commands
 *   /api/v1/...    ⊆ the routes the dashboard router registers
 *   iris://...     ⊆ the resources the MCP server registers
 *   IRIS_*         ⊆ the variables src/ reads — and every variable src/ reads
 *                    is listed in server.json, bar the internal test hook
 *   rule names     no prose names a retired rule; every shipped rule is in
 *                    both skill files
 *
 * Every extractor asserts a floor — a thing it must find — so a regex that
 * stops matching fails loudly instead of passing vacuously (the scanner's
 * "MATCHED NOTHING" rule, in test form). Dated artifacts (docs/blog,
 * docs/launch) keep their period voice and are not surfaces here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rulesByType } from '../src/eval/rules/index.js';
import { ERROR_CODE_CATALOGUE } from '../src/tools/errors.js';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

/** The prose an agent or a developer reads: not the blog, not the frozen launch drafts. */
const PROSE_SURFACES: string[] = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
  'skills/iris-eval/SKILL.md',
  'claude-plugin/skills/agent-eval/SKILL.md',
  'server.json',
  'smithery.yaml',
  ...readdirSync(join(root, 'src', 'tools'))
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => `src/tools/${f}`),
  // The agent-native surfaces (0.9.0): the server instructions, the prompt,
  // the judge enablement steps and the capabilities object are prose an
  // agent reads at connection, so they are held to the same contract.
  'src/instructions.ts',
  'src/prompts.ts',
  'src/judge-enablement.ts',
  'src/capabilities.ts',
];

const prose = PROSE_SURFACES.map((rel) => ({ rel, text: read(rel) }));

const claims = JSON.parse(read('.claims.json')) as {
  mcpTools: { names: string[] };
  evalRules: { customRuleTypes: string[] };
};

/* ── --flags ─────────────────────────────────────────────────────── */

/** The CLI's own flags, read off the parseArgs options block in src/index.ts. */
function cliFlags(): Set<string> {
  const src = read('src/index.ts');
  const block = src.match(/parseArgs\(\{\s*options:\s*\{([\s\S]*?)\n\s*\},\s*strict:/);
  if (!block) throw new Error('docs-contract: the parseArgs options block in src/index.ts was not found');
  const flags = new Set<string>();
  for (const m of block[1].matchAll(/^\s*'?([a-z][a-z0-9-]*)'?:\s*\{/gm)) flags.add(m[1]);
  return flags;
}

/**
 * Flags that belong to OTHER tools and appear in commands the docs quote
 * (npm, cosign, the proof runner). Explicit so a new foreign flag is a
 * conscious addition, and each must still appear somewhere so the list
 * cannot rot into an exemption nobody uses.
 */
const FOREIGN_FLAGS = new Set([
  'check', // npm run proof -- --check, claims --check
  'composite', // npm run proof -- --composite (the verdict on the composite corpus)
  'yes', // cosign sign --yes
  'ignore-scripts', // npm ci --ignore-scripts
  'provenance', // npm publish --provenance
  'certificate-oidc-issuer', // cosign verify-blob
  'certificate-identity-regexp', // cosign verify-blob
]);

describe('docs contract — every --flag in prose is a flag the CLI parses', () => {
  const known = cliFlags();

  it('the extractor found the CLI flags (guards the regex itself)', () => {
    for (const f of ['dashboard', 'self-test', 'purge', 'transport', 'api-key']) expect(known.has(f), f).toBe(true);
  });

  it('no prose surface names a flag that does not exist', () => {
    const unknown: string[] = [];
    const seenForeign = new Set<string>();
    for (const { rel, text } of prose) {
      for (const m of text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) {
        const flag = m[1];
        if (known.has(flag)) continue;
        if (FOREIGN_FLAGS.has(flag)) {
          seenForeign.add(flag);
          continue;
        }
        unknown.push(`${rel}: --${flag}`);
      }
    }
    expect(unknown).toEqual([]);
    // The foreign list must earn its place: a flag nobody quotes any more is
    // an exemption to delete, not to keep.
    expect([...FOREIGN_FLAGS].filter((f) => !seenForeign.has(f))).toEqual([]);
  });
});

/* ── /api/v1 routes ──────────────────────────────────────────────── */

const normaliseRoute = (path: string): string =>
  path
    .replace(/[.,;:)`'"]+$/, '')
    .replace(/:[A-Za-z_]+|\{[A-Za-z_]+\}|<[A-Za-z_]+>/g, ':param')
    .replace(/\/+$/, '');

/** Every route the dashboard router registers, mounted at /api/v1 (src/dashboard/server.ts). */
function registeredRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of walk(join(root, 'src', 'dashboard', 'routes'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/router\.(?:get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
      routes.add(normaliseRoute(`/api/v1${m[1]}`));
    }
  }
  return routes;
}

describe('docs contract — every /api/v1 path in prose is a registered route', () => {
  const routes = registeredRoutes();

  it('the extractor found the routes (guards the regex itself)', () => {
    for (const r of ['/api/v1/health', '/api/v1/traces', '/api/v1/traces/:param', '/api/v1/rules/custom']) {
      expect(routes.has(r), r).toBe(true);
    }
  });

  it('no prose surface names a route that does not exist', () => {
    const unknown: string[] = [];
    for (const { rel, text } of prose) {
      for (const m of text.matchAll(/\/api\/v1\/[A-Za-z0-9_\-/:{}<>.]+/g)) {
        const route = normaliseRoute(m[0]);
        if (!routes.has(route)) unknown.push(`${rel}: ${m[0]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

/* ── iris:// resources ───────────────────────────────────────────── */

/** Every resource URI src/resources registers. */
function registeredResources(): Set<string> {
  const uris = new Set<string>();
  for (const file of walk(join(root, 'src', 'resources'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/'(iris:\/\/[^']+)'/g)) uris.add(m[1]);
  }
  return uris;
}

describe('docs contract — every iris:// URI in prose is a registered resource', () => {
  const uris = registeredResources();

  it('the extractor found the resources (guards the regex itself)', () => {
    expect(uris.has('iris://dashboard/summary')).toBe(true);
    expect(uris.size).toBeGreaterThanOrEqual(2);
  });

  it('no prose surface names a resource that does not exist', () => {
    const unknown: string[] = [];
    for (const { rel, text } of prose) {
      for (const m of text.matchAll(/iris:\/\/[A-Za-z0-9_/{}:.-]+/g)) {
        const uri = m[0].replace(/[.,;:)]+$/, '');
        if (!uris.has(uri)) unknown.push(`${rel}: ${uri}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

/* ── IRIS_* environment variables, both directions ───────────────── */

function envVarsReadBySrc(): Set<string> {
  const names = new Set<string>();
  for (const file of walk(join(root, 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\.(IRIS_[A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return names;
}

function envVarsInServerJson(): Set<string> {
  const j = JSON.parse(read('server.json')) as { packages: Array<{ environmentVariables?: Array<{ name: string }> }> };
  return new Set(j.packages.flatMap((p) => (p.environmentVariables ?? []).map((e) => e.name)));
}

/** Read by the code, deliberately not in the registry manifest: a test hook, not a user setting. */
const INTERNAL_ENV_VARS = new Set(['IRIS_NO_AUTO_LAUNCH']);

describe('docs contract — IRIS_* variables', () => {
  const read_ = envVarsReadBySrc();
  const listed = envVarsInServerJson();

  it('the extractor found the variables (guards the regex itself)', () => {
    for (const v of ['IRIS_API_KEY', 'IRIS_HOME', 'IRIS_OTEL_ENDPOINT']) expect(read_.has(v), v).toBe(true);
  });

  it('no prose surface names a variable the server does not read', () => {
    const unknown: string[] = [];
    for (const { rel, text } of prose) {
      for (const m of text.matchAll(/\bIRIS_[A-Z0-9_]+\b/g)) {
        // The error catalogue shares the prefix; a code is not a variable.
        if ((ERROR_CODE_CATALOGUE as readonly string[]).includes(m[0])) continue;
        if (!read_.has(m[0])) unknown.push(`${rel}: ${m[0]}`);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('every variable the server reads is listed in server.json (the reverse of manifest-env-parity)', () => {
    const missing = [...read_].filter((v) => !listed.has(v) && !INTERNAL_ENV_VARS.has(v)).sort();
    expect(missing).toEqual([]);
  });
});

/* ── rule names ──────────────────────────────────────────────────── */

/**
 * Names a rule no longer has. A rename (arc 3 renames token_efficiency)
 * adds the old name here, and any prose still quoting it fails.
 */
const RETIRED_RULE_NAMES = new Set<string>([]);

describe('docs contract — rule names', () => {
  // The runtime registry, not the truthbase: .claims.json evalRules.names are the
  // camelCase export identifiers; the prose quotes the rule's own snake_case name.
  const ruleNames = new Set(Object.values(rulesByType).flat().map((r) => r.name));
  const customTypes = new Set(claims.evalRules.customRuleTypes);

  it('the registry and the truthbase carry the roster (guards the read itself)', () => {
    expect(ruleNames.has('no_pii')).toBe(true);
    expect(customTypes.has('regex_match')).toBe(true);
  });

  it('both skill files name every shipped rule and every custom-rule type', () => {
    for (const rel of ['skills/iris-eval/SKILL.md', 'claude-plugin/skills/agent-eval/SKILL.md']) {
      const text = read(rel);
      for (const name of ruleNames) expect(text, `${rel} lacks ${name}`).toContain(name);
      for (const type of customTypes) expect(text, `${rel} lacks ${type}`).toContain(`\`${type}\``);
    }
  });

  it('no prose surface names a retired rule', () => {
    const stale: string[] = [];
    for (const { rel, text } of prose) {
      for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        if (RETIRED_RULE_NAMES.has(m[1])) stale.push(`${rel}: ${m[1]}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('every tool name the prose quotes in backticks is a registered tool or a known identifier', () => {
    // Only the nine verbs: a backticked snake_case token that ENDS with _trace,
    // _traces, _rule, _rules, _output or _citations is a tool-shaped name and
    // must be one of the registered tools.
    const tools = new Set(claims.mcpTools.names);
    const toolShaped = /^(?:log|get|delete|evaluate|list|deploy|verify)_[a-z_]+$/;
    const unknown: string[] = [];
    for (const { rel, text } of prose) {
      for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        if (toolShaped.test(m[1]) && !tools.has(m[1])) unknown.push(`${rel}: ${m[1]}`);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });
});
