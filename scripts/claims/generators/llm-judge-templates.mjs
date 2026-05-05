// LLM-judge templates generator — reads src/eval/llm-judge/templates/index.ts
// and parses the TemplateName union.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const TEMPLATE_NAME_RE = /export\s+type\s+TemplateName\s*=\s*([\s\S]*?);/;

export async function generate() {
  const src = await readFile(resolve(root, 'src/eval/llm-judge/templates/index.ts'), 'utf-8');
  const m = src.match(TEMPLATE_NAME_RE);
  const names = m
    ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
    : [];

  return {
    count: names.length,
    names,
    supportedProviders: ['anthropic', 'openai'],
    supportedModels: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'gpt-4o',
      'gpt-4o-mini',
      'o1-mini',
    ],
  };
}
