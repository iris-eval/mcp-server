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
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/*
 * The two skill files are one rendered source. skills/iris-eval/SKILL.md is
 * what the npm package ships; claude-plugin/skills/agent-eval/SKILL.md is
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
name: agent-eval
description: Evaluate AI agent output quality, safety, and cost using the Iris MCP server. Use when building, testing, or shipping agents and the user wants to score output quality, detect PII or prompt injection, verify citations, track cost per query, enforce cost budgets, add tracing/observability to an agent, or set up eval-driven development. Also use when the user asks "is my agent good enough to ship" or wants quality gates on agent responses.
---`;

export const TARGETS = [
  { template: 'website/llms.template.txt', output: 'website/public/llms.txt' },
  // The capability map as a document, from the same truthbase field the
  // server serves inside iris://capabilities and the site renders at
  // /capabilities. The template holds the prose; the table is the slot.
  { template: 'docs/capabilities.template.md', output: 'docs/capabilities.md' },
  { template: 'website/llms-full.template.txt', output: 'website/public/llms-full.txt' },
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
    output: 'claude-plugin/skills/agent-eval/SKILL.md',
    slots: (base) => ({
      frontMatter: PLUGIN_SKILL_FRONT_MATTER,
      installContext:
        `If this plugin is installed, the ${base.mcpToolCount} tools are already available — no setup needed. If the tools are missing, the server starts with \`npx -y @iris-eval/mcp-server\` in any MCP client config (Quick Start below).`,
      exampleLinkBase: 'https://github.com/iris-eval/mcp-server/blob/main/skills/iris-eval/examples/',
    }),
  },
];

const SLOT_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function listProse(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** The one-line proof status — truthful before AND after the numbers land. */
export function proofSummary(claims) {
  const proof = claims.proof;
  if (!proof || !Array.isArray(proof.rules) || proof.rules.length === 0) {
    return (
      'Evaluator accuracy is being measured; https://iris-eval.com/proof explains the method ' +
      '(precision, recall and F1 per rule with 95% confidence intervals, one command to reproduce) ' +
      'and will carry the numbers when they land.'
    );
  }
  const measured = proof.rules.length;
  const date = String(proof.generatedAt).slice(0, 10);
  return (
    `Evaluator accuracy is published at https://iris-eval.com/proof: precision, recall and F1 ` +
    `with 95% confidence intervals for ${measured} built-in rules, corpus ${proof.corpusVersion}, ` +
    `generated ${date} for v${proof.version ?? claims.version.mcpServer}; reproduce with \`npm run proof\`.`
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
    ruleCount: claims.evalRules.builtInCount,
    ruleCategoryCount: claims.evalRules.categoryCount,
    ruleCategoriesProse: listProse(claims.evalRules.categories),
    ruleCategoriesList: claims.evalRules.categories.join(', '),
    ruleNamesList: claims.evalRules.names.join(', '),
    piiPatterns: claims.evalRules.piiPatterns,
    injectionPatterns: claims.evalRules.injectionPatterns,
    hallucinationMarkers: claims.evalRules.hallucinationMarkers,
    llmJudgeTemplateCount: claims.llmJudgeTemplates.count,
    llmJudgeTemplateNames: claims.llmJudgeTemplates.names.join(', '),
    capabilitySummary: capabilitySummary(claims),
    capabilityMapTable: capabilityMapTable(claims),
    // The judge enable workflow, the same shape src/judge-enablement.ts renders
    // (renderJudgeEnableBlock): the title in bold, then the numbered steps.
    judgeEnableBlock: [`**${claims.llmJudgeTemplates.enable.title}**`, ...claims.llmJudgeTemplates.enable.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n'),
    npmPackage: claims.brand.npmPackage,
    repoUrl: claims.brand.publicRepoUrl,
    websiteUrl: claims.brand.websiteUrl,
    securityEmail: claims.brand.securityEmail,
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

export async function renderAll(rootDir = root) {
  const claims = JSON.parse(await readFile(resolve(rootDir, '.claims.json'), 'utf-8'));
  const base = slotsFrom(claims);
  const results = [];
  for (const t of TARGETS) {
    const template = await readFile(resolve(rootDir, t.template), 'utf-8');
    // Per-target slots (the three facts that differ between the two skill
    // files) layer over the shared truthbase slots; a target without them
    // renders from the shared set alone.
    const slots = t.slots ? { ...base, ...t.slots(base) } : base;
    results.push({ template: t.template, output: t.output, text: render(template, slots, `${t.template} → ${t.output}`) });
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
