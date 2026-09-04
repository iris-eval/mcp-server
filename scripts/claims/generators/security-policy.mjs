// Security-policy generator — the disclosure SLA, PARSED out of SECURITY.md.
//
// Why this exists: SECURITY.md promised acknowledgement within 48 hours and
// a detailed response within 5 business days while the website's security
// page promised 2 business days and 7 days — two SLAs for one policy, on
// the two surfaces a reporter compares. SECURITY.md is the policy GitHub
// shows under "Security" and the one an advisory links to, so it is the
// source; the website renders these figures through the truthbase reader.
//
// The parse is deliberately narrow: each figure comes from one sentence
// shape, and the generator throws if the shape changes or if two places in
// the file disagree. A silent zero here would be worse than a red build.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

export const POLICY_PATH = 'SECURITY.md';

// Every sentence shape the policy uses for each figure. The file states the
// acknowledgement window twice (the SLA paragraph and the numbered
// disclosure list); both must agree.
const SHAPES = {
  acknowledgeWithinHours: /acknowledge (?:receipt )?within (\d+) hours/gi,
  detailedResponseWithinBusinessDays: /detailed response within (\d+) business days/gi,
  publicDisclosureWindowDays: /(\d+) days by default before public disclosure/gi,
};

function readFigure(text, name, re) {
  const values = [...text.matchAll(re)].map(m => Number(m[1]));
  if (values.length === 0) {
    throw new Error(
      `Security-policy generator: ${POLICY_PATH} no longer contains a sentence matching ${re} ` +
        `(needed for security.disclosure.${name}). Restore the sentence shape or update SHAPES here.`,
    );
  }
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(
      `Security-policy generator: ${POLICY_PATH} states ${name} as ${distinct.join(' and ')} in different places — one policy, one number.`,
    );
  }
  return distinct[0];
}

/** Pure parse; exported so the drift-lock test can run it on the same file. */
export function parseDisclosure(text) {
  return {
    acknowledgeWithinHours: readFigure(text, 'acknowledgeWithinHours', SHAPES.acknowledgeWithinHours),
    detailedResponseWithinBusinessDays: readFigure(
      text,
      'detailedResponseWithinBusinessDays',
      SHAPES.detailedResponseWithinBusinessDays,
    ),
    publicDisclosureWindowDays: readFigure(text, 'publicDisclosureWindowDays', SHAPES.publicDisclosureWindowDays),
    source: POLICY_PATH,
  };
}

export async function generate() {
  const text = await readFile(resolve(root, POLICY_PATH), 'utf-8');
  return parseDisclosure(text);
}
