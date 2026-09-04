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

export const TARGETS = [
  { template: 'website/llms.template.txt', output: 'website/public/llms.txt' },
  { template: 'website/llms-full.template.txt', output: 'website/public/llms-full.txt' },
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
    `generated ${date} at commit ${proof.commit}; reproduce with \`npm run proof\`.`
  );
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
  const slots = slotsFrom(claims);
  const results = [];
  for (const t of TARGETS) {
    const template = await readFile(resolve(rootDir, t.template), 'utf-8');
    results.push({ ...t, text: render(template, slots, t.template) });
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
    console.log('[llms:check] OK — llms.txt and llms-full.txt match their templates + .claims.json');
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
