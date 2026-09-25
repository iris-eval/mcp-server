#!/usr/bin/env node
// llms.txt renderer — writes website/public/llms.txt and llms-full.txt from
// two templates and the truthbase, so the surface written FOR language
// models can no longer misreport the release.
//
// Why this exists: on the day v0.6.0 shipped, iris-eval.com/llms.txt still
// said "Current release: v0.5.0 (2026-08-12)". Both files were hand-written
// and no gate read them — the hardcoded-claim scanner has no pattern for a
// bare "vX.Y.Z" in prose, and nothing compared the files to anything. A
// stranger's LLM read the wrong version on release day and had no way to
// know. Now every version-dependent fact is a `{{slot}}` filled from
// .claims.json, and `--check` fails CI when the committed files differ
// from the render.
//
// Usage:
//   node scripts/claims/render-llms.mjs            # render + write both files
//   node scripts/claims/render-llms.mjs --check    # exit 1 if committed files differ
//
// Template rules: `{{name}}` slots only, no logic. An unknown slot throws;
// a slot whose value is null/undefined throws. Prose that is not
// version-dependent stays in the template as plain text — the template is
// the file, minus the numbers.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/*
 * The two skill files are one rendered source. skills/iris-eval/SKILL.md is
 * the copy in the repository's skills/ directory (the npm package ships dist,
 * LICENSE, README.md and server.json only); claude-plugin/skills/iris-eval/SKILL.md is
 * what the Claude Code plugin marketplace serves, and the plugin manifest
 * cannot reference a file outside claude-plugin/. They were hand-mirrored
 * with a comment saying "edit both together", and drifted: one carried three
 * sections and a config row the other lacked. Only three things genuinely
 * differ per target — the front matter, one install-context paragraph, and
 * the base of the example links — so those are per-target slots and
 * everything else is the template. Both rendered files sit in the scanner's
 * SCAN_DIRS, and `npm run llms:check` fails CI when either drifts.
 */
const SKILL_TEMPLATE = 'skills/iris-eval/SKILL.template.md';

const NPM_SKILL_FRONT_MATTER = `---
name: iris-eval
description: Evaluate AI agent outputs for quality, safety, and cost using the Iris MCP server. Use when reviewing agent responses, checking for PII leaks, scoring output quality, or tracking execution costs.
allowed-tools: [Read, Write, Bash, Grep, Glob]
metadata:
  filePattern: ["**/mcp.json", "**/.well-known/mcp.json", "**/mcp-server*"]
  bashPattern: ["iris", "mcp-server", "evaluate", "eval"]
---`;

const PLUGIN_SKILL_FRONT_MATTER = `---
name: iris-eval
description: Evaluate AI agent output quality, safety, and cost using the Iris MCP server. Use when building, testing, or shipping agents and the user wants to score output quality, detect PII or prompt injection, verify citations, track cost per query, enforce cost budgets, add tracing/observability to an agent, or set up eval-driven development. Also use when the user asks "is my agent good enough to ship" or wants quality gates on agent responses.
---`;

export const TARGETS = [
  { template: 'website/llms.template.txt', output: 'website/public/llms.txt' },
  // The capability map as a document, from the same truthbase field the
  // server serves inside iris://capabilities and the site renders at
  // /capabilities. The template holds the prose; the table is the slot.
  { template: 'docs/capabilities.template.md', output: 'docs/capabilities.md' },
  // The evaluator-of-evaluators matrix as a document, from .claims.json →
  // evaluators (derived from the proof files by its generator).
  { template: 'docs/evaluators.template.md', output: 'docs/evaluators.md' },
  { template: 'website/llms-full.template.txt', output: 'website/public/llms-full.txt' },
  { template: '.claude-plugin/marketplace.template.json', output: '.claude-plugin/marketplace.json' },
  // The manifest the marketplace actually serves (the index above points
  // installs at ./claude-plugin). It carried "(9 tools)" by hand for a day
  // after twelve shipped, and the scanner could not see it because the
  // number had no "MCP" beside it. Rendered now, like the index.
  { template: 'claude-plugin/.claude-plugin/plugin.template.json', output: 'claude-plugin/.claude-plugin/plugin.json' },
  // The capture plugin's manifest: its version pins the package its Stop
  // hook installs, so it renders from the truthbase like the others.
  { template: 'claude-plugin-capture/.claude-plugin/plugin.template.json', output: 'claude-plugin-capture/.claude-plugin/plugin.json' },
  {
    template: 'docs/launch/directory-listing-template.template.md',
    output: 'docs/launch/directory-listing-template.md',
  },
  // One paste-ready file per directory: the send is the listing
  // owner's act; the copy is the truthbase's on the day it is pasted.
  ...['glama', 'mcp-so', 'pulsemcp', 'smithery', 'cursor-directory', 'awesome-mcp-servers', 'docker'].map((d) => ({
    template: `docs/launch/listings/${d}.template.md`,
    output: `docs/launch/listings/${d}.md`,
  })),
  {
    template: SKILL_TEMPLATE,
    output: 'skills/iris-eval/SKILL.md',
    slots: () => ({
      frontMatter: NPM_SKILL_FRONT_MATTER,
      installContext:
        'Iris runs as an MCP server: add it to your client config (Quick Start below) or start it with `npx -y @iris-eval/mcp-server`.',
      exampleLinkBase: 'examples/',
    }),
  },
  {
    template: SKILL_TEMPLATE,
    output: 'claude-plugin/skills/iris-eval/SKILL.md',
    slots: (base) => ({
      frontMatter: PLUGIN_SKILL_FRONT_MATTER,
      installContext:
        `If this plugin is installed, the ${base.mcpToolCount} tools are already available — no setup needed. If the tools are missing, the server starts with \`npx -y @iris-eval/mcp-server\` in any MCP client config (Quick Start below).`,
      exampleLinkBase: 'https://github.com/iris-eval/mcp-server/blob/main/skills/iris-eval/examples/',
    }),
  },
];

const SLOT_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** The client rows as one sentence: the verified ones, the claimed ones with where the rows live, and the open door. */
function clientsSentence(claims) {
  const rows = claims.clients.rows;
  const verified = rows.filter((r) => r.status === 'verified').map((r) => r.name);
  const claimed = rows.filter((r) => r.status === 'claimed').map((r) => r.name);
  let site = String(claims.brand.websiteUrl);
  while (site.endsWith('/')) site = site.slice(0, -1);
  return `It is verified on every CI run in ${listProse(verified)}; for ${listProse(claimed)} the installer writes the configuration shape each client documents and that writer is tested on the shape, with nobody on the Iris side having watched the client connect (claimed — every row with its source and date at ${site}/clients); and it runs in any other MCP client the same way.`;
}

function listProse(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * The one-line proof status — truthful before AND after the numbers land,
 * and truthful BETWEEN releases, which is the part that was wrong.
 *
 * This line used to end "generated <date> for v<version>", taking the
 * version `npm run proof` stamped from package.json. That is only accurate
 * on a release commit, because the release roll bumps the version BEFORE it
 * regenerates the proof. The website deploys from `main`, so on every other
 * commit the line attributed measurements of unreleased code to the last
 * RELEASED version — and on 2026-09-06 iris-eval.com said, in these words,
 * "for 20 built-in rules … for v0.10.0" while the published v0.10.0 had
 * fifteen. A reader who installed the version named would not have found
 * the rules counted.
 *
 * The numbers are pinned to `corpusVersion`, which a roll regenerates and
 * `proof --check` diffs; that is the honest anchor and it is already here.
 * The released version is stated on its own line and is not joined to these
 * numbers, because between releases they describe different code.
 */
export function proofSummary(claims) {
  const proof = claims.proof;
  if (!proof || !Array.isArray(proof.rules) || proof.rules.length === 0) {
    return (
      'Evaluator accuracy is being measured; https://iris-eval.com/proof explains the method ' +
      '(precision, recall and F1 per rule with 95% confidence intervals, one command to reproduce) ' +
      'and will carry the numbers when they land.'
    );
  }
  // Two kinds of number, never summed: a family labelled by reading the
  // failure measures detection; one labelled by the rule's own definition only
  // shows the code implements its formula (proof/lib/corpus.ts, `labelBasis`).
  // A family that does not say which is a defect in the proof file, not a
  // detection number.
  for (const r of proof.rules) {
    if (r.labelBasis !== 'reading' && r.labelBasis !== 'definition') throw new Error(`llms: proof rule ${r.name} carries no labelBasis`);
  }
  const detection = proof.rules.filter((r) => r.labelBasis === 'reading').length;
  const formula = proof.rules.filter((r) => r.labelBasis === 'definition').length;
  const date = String(proof.generatedAt).slice(0, 10);
  return (
    `Evaluator accuracy is published at https://iris-eval.com/proof: precision, recall and F1 ` +
    `with 95% confidence intervals for built-in rules — ${detection} measured for detection against labels a model gave by reading the failure (synthetic, model-labelled corpus; a human blind label is pending), ` +
    `and ${formula} checked against their own documented formula (a score there shows the code implements the formula, not that it detects the failure) — ` +
    `corpus ${proof.corpusVersion}, generated ${date} from the source these numbers were measured on; reproduce with \`npm run proof\`.`
  );
}

/** One line with the counts by status, for llms.txt and the docs header. */
export function capabilitySummary(claims) {
  const m = claims.capabilityMap;
  const c = m.counts;
  return (
    `Of ${m.total} capability cells (${m.questions.length} evaluation questions by ${m.subjects.length} subjects), ` +
    `${c.has} are answered by a shipped, measured thing, ${c.partial} are answered with a stated limit, ${c.gap} are open gaps and ${c['n/a']} do not apply — ` +
    'every answered cell names the rule, tool, resource, route, proof row or judge template behind it.'
  );
}

/** The map as markdown: the status grid, then one block per cell with its summary, evidence and needs. */
export function capabilityMapTable(claims) {
  const m = claims.capabilityMap;
  const byId = new Map(m.cells.map((c) => [c.id, c]));
  const head = `| Question | ${m.subjects.map((s) => s.text).join(' | ')} |`;
  const sep = `|---|${m.subjects.map(() => '---').join('|')}|`;
  const rows = m.questions.map((q) => `| **${q.text}** | ${m.subjects.map((s) => byId.get(`${q.id}x${s.id}`).status).join(' | ')} |`);
  const sections = m.questions.map((q) => {
    const cells = m.subjects.map((s) => {
      const c = byId.get(`${q.id}x${s.id}`);
      const evidence = c.evidence.length ? ` Evidence: ${c.evidence.map((e) => `${e.kind} \`${e.name}\``).join(', ')}.` : '';
      const needs = c.needs.length ? ` Needs: ${c.needs.map((n) => `\`${n}\``).join(', ')}.` : '';
      return `- **${s.text}** — *${c.status}*. ${c.summary}${evidence}${needs}`;
    });
    return `### ${q.text}\n\n${cells.join('\n')}`;
  });
  return [head, sep, ...rows, '', ...sections].join('\n');
}

const STATUS_MARK = { measured: '●', partial: '◐', stated: '≡', measurable: '○', 'n/a': '—' };

/** One line: how many evaluators have three or more of the thirteen questions measured, with the link. */
export function evaluatorsSummary(claims) {
  const m = claims.evaluators;
  const groups = m.groups.map((g) => `${g.text} ${m.counts.byGroup[g.id].measuredThreeOrMore} of ${m.counts.byGroup[g.id].evaluators}`).join('; ');
  return `Evaluators with three or more of the thirteen trust questions measured: ${m.counts.measuredThreeOrMore} of ${m.counts.evaluators} (${groups}) — every number behind a measured cell is on https://iris-eval.com/proof and in the proof files it names.`;
}

/** The matrix as one table of marks per group, then the evidence per evaluator. */
export function evaluatorsMatrixTable(claims) {
  const m = claims.evaluators;
  const legend = `Marks: ${Object.entries(STATUS_MARK).map(([k, v]) => `${v} ${k}`).join(' · ')}.`;
  const head = `| Evaluator | ${m.questions.map((q) => `Q${q.n}`).join(' | ')} | measured |`;
  const sep = `|---|${m.questions.map(() => ':-:').join('|')}|--:|`;
  const out = [legend, ''];
  out.push('| # | Question |');
  out.push('|--:|---|');
  for (const q of m.questions) out.push(`| ${q.n} | ${q.text} |`);
  out.push('');
  for (const g of m.groups) {
    const members = m.evaluators.filter((e) => e.group === g.id);
    out.push(`## ${g.text.charAt(0).toUpperCase() + g.text.slice(1)} — ${m.counts.byGroup[g.id].measuredThreeOrMore} of ${members.length} with three or more questions measured`);
    out.push('');
    out.push(head, sep);
    for (const e of members) out.push(`| \`${e.name}\` | ${m.questions.map((q) => STATUS_MARK[e.cells[q.id].status]).join(' | ')} | ${e.measured} |`);
    out.push('');
  }
  out.push('## Evidence, per evaluator');
  out.push('');
  out.push('Measured cells name the file and key; measurable cells name the harness; stated cells name where the declaration lives.');
  out.push('');
  for (const e of m.evaluators) {
    out.push(`### \`${e.name}\` (${m.groups.find((g) => g.id === e.group).text})`);
    out.push('');
    for (const q of m.questions) {
      const c = e.cells[q.id];
      const parts = [`**Q${q.n}** ${c.status}`];
      if (c.evidence) parts.push(`— ${c.evidence}`);
      if (c.note) parts.push(`(${c.note})`);
      out.push(`- ${parts.join(' ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Everything a template may reference. Add a slot here, never a literal in a template. */
export function slotsFrom(claims) {
  const tagline = claims.brand.tagline;
  return {
    version: claims.version.mcpServer,
    releaseDate: claims.release.currentReleaseDate,
    releaseHeadline: claims.release.currentReleaseHeadline,
    tagline,
    taglineLower: tagline.charAt(0).toLowerCase() + tagline.slice(1),
    mcpToolCount: claims.mcpTools.count,
    mcpToolNamesList: claims.mcpTools.names.join(', '),
    ruleCount: claims.evalRules.builtInCount,
    ruleCategoryCount: claims.evalRules.categoryCount,
    ruleCategoriesProse: listProse(claims.evalRules.categories),
    /*
     * How many rules read the agent's own tool calls.
     *
     * Derived from the roster's declared `needs` rather than typed, because
     * it moved 2 -> 6 in one release and a hand-written number would have
     * gone stale the moment it was written. The playground page made exactly
     * that mistake and told readers "the two that read an agent's tool
     * calls" long after there were six.
     */
    trajectoryRuleCount: (claims.evalRules.roster ?? []).filter((r) => (r.needs ?? []).includes('tool_calls')).length,
    ruleCategoriesList: claims.evalRules.categories.join(', '),
    ruleNamesList: claims.evalRules.names.join(', '),
    piiPatterns: claims.evalRules.piiPatterns,
    injectionPatterns: claims.evalRules.injectionPatterns,
    hallucinationMarkers: claims.evalRules.hallucinationMarkers,
    llmJudgeTemplateCount: claims.llmJudgeTemplates.count,
    llmJudgeTemplateNames: claims.llmJudgeTemplates.names.join(', '),
    capabilitySummary: capabilitySummary(claims),
    capabilityMapTable: capabilityMapTable(claims),
    evaluatorsSummary: evaluatorsSummary(claims),
    evaluatorsMatrixTable: evaluatorsMatrixTable(claims),
    // The judge enable workflow, the same shape src/judge-enablement.ts renders
    // (renderJudgeEnableBlock): the title in bold, then the numbered steps.
    judgeEnableBlock: [`**${claims.llmJudgeTemplates.enable.title}**`, ...claims.llmJudgeTemplates.enable.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n'),
    npmPackage: claims.brand.npmPackage,
    /*
     * The install target every rendered snippet names: the package pinned to
     * the current release, so a config copied from a rendered file keeps
     * running the version it was copied for (the plugin manifests pin the
     * same way). The render rolls it at every release.
     */
    pinnedPackage: `${claims.brand.npmPackage}@${claims.version.mcpServer}`,
    pinnedImage: `${claims.brand.publicRepoUrl.replace(/^https:\/\/github\.com\//, 'ghcr.io/')}:v${claims.version.mcpServer}`,
    repoUrl: claims.brand.publicRepoUrl,
    websiteUrl: claims.brand.websiteUrl,
    securityEmail: claims.brand.securityEmail,
    discoverySentence: claims.brand.discoverySentence,
    dataResidency: claims.brand.dataResidency,
    clientsSentence: clientsSentence(claims),
    disclosureAckHours: claims.security.disclosure.acknowledgeWithinHours,
    disclosureResponseBusinessDays: claims.security.disclosure.detailedResponseWithinBusinessDays,
    proofSummary: proofSummary(claims),
  };
}

export function render(template, slots, templateName = 'template') {
  const unknown = [];
  const out = template.replace(SLOT_RE, (_, name) => {
    if (!(name in slots)) {
      unknown.push(name);
      return '';
    }
    const v = slots[name];
    if (v === null || v === undefined) {
      throw new Error(`render-llms: slot {{${name}}} in ${templateName} has no value in .claims.json`);
    }
    return String(v);
  });
  if (unknown.length) {
    throw new Error(`render-llms: unknown slot(s) in ${templateName}: ${unknown.map(n => `{{${n}}}`).join(', ')}`);
  }
  return out;
}

/**
 * A block inside a hand-written file: the text between
 * `<!-- iris:<name>:start -->` and `<!-- iris:<name>:end -->` is replaced by
 * the render; the rest of the file is the author's. `--check` reads the
 * file, re-renders the block and compares, so a stale block fails CI the
 * way a stale rendered file does.
 */
export function spliceBlock(text, name, body, fileName) {
  const start = `<!-- iris:${name}:start -->`;
  const end = `<!-- iris:${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < 0 || j < i) throw new Error(`render-llms: ${fileName} has no ${start} … ${end} block`);
  // The block takes the file's own line endings, so a checkout that converts
  // to CRLF renders and checks the same as one that keeps LF.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return `${text.slice(0, i + start.length)}${eol}${body.replace(/\r?\n/g, eol)}${eol}${text.slice(j)}`;
}

/** The works-with table the README carries, from clients.json through the truthbase: one row per client, its status and the date it was read. */
export function clientsTable(claims) {
  const site = claims.brand.websiteUrl;
  const lines = [
    '| Client | Status | What that means | Read |',
    '|---|---|---|---|',
    ...claims.clients.rows.map((r) => {
      const meaning =
        r.status === 'verified'
          ? 'driven through the real scripts on every CI run'
          : 'the installer writes the shape the client documents, and that writer is tested on the shape; nobody on the Iris side has watched it connect';
      return `| ${r.name} | ${r.status} | ${meaning} | [${r.lastChecked}](${r.source}) |`;
    }),
    '',
    `Every row with what was checked: [${site.replace(/^https?:\/\//, '')}/clients](${site}/clients). No client is called supported without a row.`,
  ];
  return lines.join('\n');
}

/** Blocks inside hand-written files, rendered after the targets so the targets' order is theirs. */
export const BLOCKS = [{ file: 'README.md', name: 'clients-table', body: (claims) => clientsTable(claims) }];

/**
 * The compare pages, in the order the site lists them, from the one registry
 * the site renders them from (website/src/lib/compare/index.ts → COMPARISONS).
 *
 * llms.txt carried eight hand-typed compare links after the site had fourteen
 * pages, because the list was prose in the template. The registry is
 * TypeScript importing one JSON file per vendor, so this reads the two things
 * that define the list — the imports and the order of the COMPARISONS array —
 * and each file's slug and name. A registry shape this cannot read throws.
 */
export async function compareEntries(rootDir = root) {
  const dir = resolve(rootDir, 'website', 'src', 'lib', 'compare');
  const index = await readFile(resolve(dir, 'index.ts'), 'utf-8');
  const files = new Map([...index.matchAll(/^import (\w+) from "\.\/([a-z0-9-]+)\.json";?\r?$/gm)].map((m) => [m[1], m[2]]));
  const list = index.match(/export const COMPARISONS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!list || files.size === 0) throw new Error('render-llms: could not read COMPARISONS from website/src/lib/compare/index.ts');
  const ids = list[1].split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const id of ids) {
    const file = files.get(id);
    if (!file) throw new Error(`render-llms: COMPARISONS entry ${id} is not a JSON import in website/src/lib/compare/index.ts`);
    const data = JSON.parse(await readFile(resolve(dir, `${file}.json`), 'utf-8'));
    out.push({ slug: data.slug, name: data.name });
  }
  return out;
}

/**
 * The tools as the built server describes them, read from the discovery
 * manifest that scripts/claims/render-mcp-json.ts renders from tools/list
 * (and `npm run mcp-json:check` holds to the server). llms-full.txt described
 * list_rules as it worked releases earlier and listed nine of twelve tools,
 * because its tool list was prose. Render the manifest first.
 */
export async function manifestTools(rootDir = root) {
  const manifest = JSON.parse(await readFile(resolve(rootDir, 'website', 'public', '.well-known', 'mcp.json'), 'utf-8'));
  return manifest.tools;
}

/**
 * The long form of every tool — what it does, when another call is the
 * better one, and the errors it returns — from src/tools/guide.ts, the
 * source the server serves as `toolGuide` in iris://capabilities. The
 * descriptions in tools/list are capped short because every session of the
 * agent being evaluated pays for them; llms-full.txt is the full reference,
 * so it carries the long form under each one-line summary. Imported from
 * the TypeScript source, which is why llms:render runs under tsx.
 */
export async function toolGuides(rootDir = root) {
  const { toolGuide } = await import(pathToFileURL(resolve(rootDir, 'src', 'tools', 'guide.ts')).href);
  return toolGuide();
}

/** One numbered entry per tool: the summary tools/list sends, then the long form. */
export function toolReference(tools, guides) {
  return tools
    .map((t, i) => {
      const g = guides[t.name];
      if (!g) throw new Error(`render-llms: src/tools/guide.ts has no entry for ${t.name}`);
      return [
        `${i + 1}. \`${t.name}\` — ${t.description}`,
        `   - What it does: ${g.does}`,
        `   - When another call is better: ${g.whenNot}`,
        `   - Errors: ${g.errors}`,
      ].join('\n');
    })
    .join('\n');
}

/** Slots read from the site and the built server rather than from .claims.json. */
export async function sourceSlots(rootDir = root, claims) {
  const site = String(claims.brand.websiteUrl).replace(/\/+$/, '');
  const compare = await compareEntries(rootDir);
  const tools = await manifestTools(rootDir);
  if (tools.length !== claims.mcpTools.count) {
    throw new Error(`render-llms: the manifest lists ${tools.length} tools and .claims.json counts ${claims.mcpTools.count}; run npm run mcp-json:render and npm run claims:generate`);
  }
  // The runtime floor from package.json `engines`, which npm enforces; the
  // file said "Node.js 20+" for a release after Node 20 was dropped.
  const pkg = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf-8'));
  const floor = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(String(pkg.engines?.node ?? '').trim());
  if (!floor) throw new Error(`render-llms: package.json engines.node is not a ">=x.y.z" floor: ${pkg.engines?.node}`);
  return {
    nodeEngineFloor: floor[1].replace(/\.0$/, ''),
    compareLinksList: compare.map((c) => `- [Iris vs ${c.name}](${site}/compare/${c.slug})`).join('\n'),
    compareNamesProse: compare.map((c) => c.name).join(', '),
    mcpToolsList: toolReference(tools, await toolGuides(rootDir)),
  };
}

export async function renderAll(rootDir = root) {
  const claims = JSON.parse(await readFile(resolve(rootDir, '.claims.json'), 'utf-8'));
  const base = { ...slotsFrom(claims), ...(await sourceSlots(rootDir, claims)) };
  const results = [];
  for (const t of TARGETS) {
    const template = await readFile(resolve(rootDir, t.template), 'utf-8');
    // Per-target slots (the three facts that differ between the two skill
    // files) layer over the shared truthbase slots; a target without them
    // renders from the shared set alone.
    const slots = t.slots ? { ...base, ...t.slots(base) } : base;
    results.push({ template: t.template, output: t.output, text: render(template, slots, `${t.template} → ${t.output}`) });
  }
  for (const b of BLOCKS) {
    const current = await readFile(resolve(rootDir, b.file), 'utf-8');
    results.push({ template: `${b.file} (the ${b.name} block)`, output: b.file, text: spliceBlock(current, b.name, b.body(claims), b.file) });
  }
  return results;
}

async function main() {
  const check = process.argv.includes('--check');
  const rendered = await renderAll();
  let drift = 0;
  for (const r of rendered) {
    const target = resolve(root, r.output);
    let existing = null;
    try {
      existing = await readFile(target, 'utf-8');
    } catch {
      /* missing on first render */
    }
    if (check) {
      if (existing !== r.text) {
        drift++;
        console.error(`[llms:check] FAIL — ${r.output} differs from the render of ${r.template}`);
      }
      continue;
    }
    if (existing === r.text) {
      console.log(`[llms:render] ${r.output} unchanged`);
    } else {
      await writeFile(target, r.text, 'utf-8');
      console.log(`[llms:render] wrote ${r.output}`);
    }
  }
  if (check) {
    if (drift) {
      console.error('Run `npm run llms:render` and commit the result.');
      process.exit(1);
    }
    console.log(`[llms:check] OK — ${rendered.length} rendered files match their templates + .claims.json`);
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(err => {
    console.error('[llms:render] error:', err.message);
    process.exit(1);
  });
}
