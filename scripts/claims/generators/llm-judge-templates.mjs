// LLM-judge templates generator — reads src/eval/llm-judge/templates/index.ts
// and parses the TemplateName union; reads src/judge-enablement.json for the
// enable workflow every surface renders (the runtime imports the same file).

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const TEMPLATE_NAME_RE = /export\s+type\s+TemplateName\s*=\s*([\s\S]*?);/;

/**
 * The model ids the judge prices and has not marked retired, in the table's
 * order, parsed from src/eval/llm-judge/pricing.ts: an unpriced model is
 * refused at call time, so this is exactly what a caller can use.
 */
async function pricedCurrentModels() {
  const src = await readFile(resolve(root, 'src/eval/llm-judge/pricing.ts'), 'utf-8');
  const rows = [...src.matchAll(/^\s*\{\s*provider:\s*'[a-z]+',\s*model:\s*'([^']+)'[^\n]*\},?\s*$/gm)];
  const current = rows.filter((r) => !/\bretired:/.test(r[0])).map((r) => r[1]);
  if (current.length < 5) throw new Error(`llm-judge-templates: parsed only ${current.length} priced models from pricing.ts`);
  return current;
}

export async function generate() {
  const src = await readFile(resolve(root, 'src/eval/llm-judge/templates/index.ts'), 'utf-8');
  const m = src.match(TEMPLATE_NAME_RE);
  const names = m
    ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
    : [];

  const enable = JSON.parse(await readFile(resolve(root, 'src/judge-enablement.json'), 'utf-8'));
  if (typeof enable.title !== 'string' || !Array.isArray(enable.steps) || enable.steps.length === 0) {
    throw new Error('src/judge-enablement.json must carry a title and a non-empty steps array');
  }

  return {
    count: names.length,
    names,
    supportedProviders: ['anthropic', 'openai'],
    // Read from the pricing table the judge enforces, never typed here: a
    // hand list drifted (it named a retired model and no current one).
    supportedModels: await pricedCurrentModels(),
    enable: { title: enable.title, steps: enable.steps },
  };
}
