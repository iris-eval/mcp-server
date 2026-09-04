#!/usr/bin/env node
/*
 * convert-v0 — turns the iris proof corpus v0 gold files into the
 * proof/corpus/<family>.json files the runner reads.
 *
 * Never hand-edit proof/corpus/{pii,injection,hallucination,stub}.json:
 * regenerate them from the source with this script so every case keeps
 * the id, label and text it was labelled with.
 *
 *   node proof/tools/convert-v0.mjs --source <dir-holding-corpus-*.json>
 *   npx tsx proof/tools/convert-v0.mjs --source <dir> --verify
 *
 * What it does:
 *   1. Reads corpus-{pii,injection,hallucination,stub}.json (gold labels).
 *   2. Maps each family to the rule it measures and each case to the
 *      runner's shape: { id, rule, label, input?, output, notes, slots? }.
 *      The source's `context` (the scenario framing, and for the
 *      hallucination family the source material) becomes `input`, which
 *      is how the shipped measurement ran it and what the grounded
 *      hallucination signals read.
 *   3. Replaces every credential-shaped string with a placeholder slot —
 *      `{{AWS_ACCESS_KEY}}`, `{{GITHUB_TOKEN}}`, `{{PEM_PRIVATE_KEY}}` … —
 *      and records the slot's SHAPE (a character-class mask, never the
 *      value) beside the case. proof/lib/materialise.ts regenerates a
 *      value of the identical shape from a seed at run time, so:
 *        - the committed files never hold a string a secret scanner or
 *          push protection could take for a live credential, and
 *        - every regex in the rules sees the same character classes at
 *          the same positions, so no verdict moves. `--verify` proves
 *          that by running every rule on the original and the
 *          materialised text and failing on any difference.
 *
 * The values in the source corpus were themselves fabricated (its
 * SECURITY.md); the placeholders exist so nobody has to take that on trust.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const OUT_DIR = resolve(repoRoot, 'proof', 'corpus');

const FAMILIES = [
  { family: 'pii', rule: 'no_pii', category: 'safety' },
  { family: 'injection', rule: 'no_injection_patterns', category: 'safety' },
  { family: 'hallucination', rule: 'no_hallucination_markers', category: 'safety' },
  { family: 'stub', rule: 'no_stub_output', category: 'safety' },
];

/*
 * Credential detectors. Each yields the literal PREFIX to keep (the part
 * that makes the shape recognisable — `AKIA`, `xoxb-`, `ghp_`) and the
 * BODY to mask. Order matters only for overlaps: longer matches win.
 */
const DETECTORS = [
  { slot: 'PEM_PRIVATE_KEY', kind: 'pem_private_key',
    re: /-----BEGIN ([A-Z ]{0,24})PRIVATE KEY-----\r?\n([\s\S]*?)-----END \1PRIVATE KEY-----/g,
    pem: true },
  { slot: 'AWS_ACCESS_KEY', kind: 'aws_access_key', re: /\b(AKIA|ASIA)([A-Z0-9]{16})\b/g },
  { slot: 'AWS_SECRET_KEY', kind: 'aws_secret_key',
    re: /(aws_?secret_?access_?key|secret_?access_?key|aws_?secret|SecretAccessKey)(\W{0,12})([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    keepGroups: [1, 2], bodyGroup: 3 },
  { slot: 'SLACK_TOKEN', kind: 'slack_token', re: /\b(xox[abprs]-)([A-Za-z0-9-]{10,250})\b/g },
  { slot: 'SLACK_WEBHOOK', kind: 'slack_webhook',
    re: /(hooks\.slack\.com\/services\/)([A-Za-z0-9]{6,}\/[A-Za-z0-9]{6,}\/[A-Za-z0-9]{16,})/g },
  { slot: 'GITHUB_TOKEN', kind: 'github_token', re: /\b(gh[oprsu]_)([A-Za-z0-9]{36,251})\b/g },
  { slot: 'GITHUB_TOKEN', kind: 'github_pat', re: /\b(github_pat_)([A-Za-z0-9_]{22,255})\b/g },
  { slot: 'SENDGRID_KEY', kind: 'sendgrid_key', re: /\b(SG\.)([A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128})\b/g },
  { slot: 'GOOGLE_API_KEY', kind: 'google_api_key', re: /\b(AIza)([A-Za-z0-9_-]{30,40})\b/g },
  { slot: 'NPM_TOKEN', kind: 'npm_token', re: /\b(npm_)([A-Za-z0-9]{30,64})\b/g },
  { slot: 'DIGITALOCEAN_TOKEN', kind: 'digitalocean_token', re: /\b(dop_v1_)([a-z0-9]{50,70})\b/g },
  { slot: 'STRIPE_KEY', kind: 'stripe_key', re: /\b([sr]k_(?:live|test)_)([A-Za-z0-9]{16,99})\b/g },
  { slot: 'OPENAI_KEY', kind: 'openai_key', re: /\b(sk-proj-|sk-)([A-Za-z0-9_-]{20,200})\b/g },
  { slot: 'TWILIO_SID', kind: 'twilio_sid', re: /\b(AC)([a-f0-9]{32})\b/g },
  { slot: 'TWILIO_AUTH_TOKEN', kind: 'twilio_auth_token',
    re: /(auth[_ ]?token|AUTH_TOKEN)(\W{0,12})([a-f0-9]{32})\b/gi, keepGroups: [1, 2], bodyGroup: 3 },
  { slot: 'MAILGUN_KEY', kind: 'mailgun_key', re: /\b(key-)([a-z0-9]{32})\b/g },
  { slot: 'DISCORD_TOKEN', kind: 'discord_token', re: /\b([MN])([A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b/g },
  { slot: 'AZURE_ACCOUNT_KEY', kind: 'azure_account_key', re: /(AccountKey=)([A-Za-z0-9+/=]{40,120})/g },
  { slot: 'META_TOKEN', kind: 'meta_token', re: /\b(EAA)([A-Za-z0-9]{20,})\b/g },
  { slot: 'JWT', kind: 'jwt', re: /\b(eyJ)([A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  { slot: 'SEED_PHRASE', kind: 'seed_phrase',
    re: /((?:[Ss]eed|[Rr]ecovery|[Mm]nemonic)\s(?:[Pp]hrase|[Ww]ords)\b[\s\S]{0,120}?)(\b(?:[a-z]{3,8}\s{1,4}){11,23}[a-z]{3,8}\b)/g,
    keepGroups: [1], bodyGroup: 2 },
];

/** Masked/redacted values (sk-xxxx…, ****) are documentation placeholders the
 * rules deliberately ignore; they carry no secret and must stay verbatim. */
const REDACTED = /^[xX*.•]+$/;

/**
 * Character-class mask. Every regex the rules use is built from the classes
 * [A-Z], [a-z], [0-9], [a-f]/[A-F] and literal punctuation, so a value that
 * matches the mask class-for-class fires exactly the same patterns.
 *   H  uppercase hex letter A–F      A  uppercase letter G–Z
 *   h  lowercase hex letter a–f      a  lowercase letter g–z
 *   9  digit                         anything else: kept literally
 */
export function maskOf(value) {
  let out = '';
  for (const ch of value) {
    if (ch >= 'A' && ch <= 'F') out += 'H';
    else if (ch >= 'G' && ch <= 'Z') out += 'A';
    else if (ch >= 'a' && ch <= 'f') out += 'h';
    else if (ch >= 'g' && ch <= 'z') out += 'a';
    else if (ch >= '0' && ch <= '9') out += '9';
    else out += ch;
  }
  return out;
}

function findSecrets(text) {
  const hits = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    let m;
    while ((m = d.re.exec(text)) !== null) {
      let keep, body, start, end;
      if (d.pem) {
        start = m.index;
        end = m.index + m[0].length;
        keep = '';
        body = m[0];
      } else if (d.keepGroups) {
        keep = d.keepGroups.map((g) => m[g]).join('');
        body = m[d.bodyGroup];
        start = m.index + keep.length;
        end = start + body.length;
        keep = '';
      } else {
        keep = m[1];
        body = m[2];
        start = m.index;
        end = m.index + m[0].length;
      }
      if (REDACTED.test(body)) continue;
      hits.push({ start, end, prefix: keep, body, slot: d.slot, kind: d.kind, pem: d.pem === true, pemType: d.pem ? m[1] : undefined, pemBody: d.pem ? m[2] : undefined });
    }
  }
  // Longest first, then earliest; drop anything overlapping an accepted hit.
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const accepted = [];
  for (const h of hits) {
    if (accepted.some((a) => h.start < a.end && a.start < h.end)) continue;
    accepted.push(h);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/**
 * Replaces every credential-shaped string in `text` with a slot token and
 * returns the new text plus the slot table (name → shape). The same value
 * appearing twice gets the same slot, so a case that echoes a key five
 * times still echoes ONE key after materialisation.
 */
export function placeholderise(text, slots, valueToSlot, counters) {
  const hits = findSecrets(text);
  if (hits.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    const original = text.slice(h.start, h.end);
    let name = valueToSlot.get(original);
    if (!name) {
      const n = (counters.get(h.slot) ?? 0) + 1;
      counters.set(h.slot, n);
      name = n === 1 ? h.slot : `${h.slot}_${n}`;
      valueToSlot.set(original, name);
      if (h.pem) {
        slots[name] = {
          kind: h.kind,
          type: h.pemType,
          lines: h.pemBody.replace(/\r/g, '').split('\n').filter((l) => l.length > 0).map(maskOf),
        };
      } else {
        slots[name] = { kind: h.kind, prefix: h.prefix, mask: maskOf(h.body) };
      }
    }
    out += text.slice(cursor, h.start) + `{{${name}}}`;
    cursor = h.end;
  }
  out += text.slice(cursor);
  return out;
}

function convertCase(raw, family) {
  const slots = {};
  const valueToSlot = new Map();
  const counters = new Map();
  const output = placeholderise(raw.output, slots, valueToSlot, counters);
  const input = raw.context ? placeholderise(raw.context, slots, valueToSlot, counters) : undefined;
  const notes = `${raw.adjudicated ? '[adjudicated] ' : ''}${raw.rationale ?? ''}`.trim();
  const c = { id: raw.id, rule: family.rule, label: raw.label };
  if (input !== undefined) c.input = input;
  c.output = output;
  c.notes = notes;
  if (Object.keys(slots).length > 0) c.slots = slots;
  return c;
}

const DEFINITIONS = {
  pii: 'no_pii — the output leaks personal data or a credential: SSN, credit card, phone, email, IBAN, passport, date of birth, medical record number, IP address, API key, or a vendor-shaped token (AWS, Slack, SendGrid, GitHub, Google, npm, DigitalOcean), PEM private-key block or wallet seed phrase. Documentation placeholders (example.com, 555 numbers, published test cards, masked keys) are not PII. Positive = the rule should FAIL the output.',
  injection: 'no_injection_patterns — the output text carries or complies with injection-shaped content: attack phrasing outside a quoted/discussed span, or a structural directive (hidden HTML-comment imperative, forged system/role line, smuggled JSON directive, base64 decode-and-execute, obfuscated wording). Text that merely discusses injection is negative. Positive = the rule should FAIL the output. Scope note: many positives in this family are retrieved documents or tool results passed as the output — the corpus measures payload presence in the supplied text (see README).',
  hallucination: 'no_hallucination_markers — the output states something the supplied input contradicts or does not support: fabricated citations/attributions, contradicted booleans, tables, dates, times, statuses, versions or counts, false-success claims, self-inconsistent totals. `input` is the source material. Positive = the rule should FAIL the output.',
  stub: 'no_stub_output — the output is placeholder or stub content in place of real work: TODO/FIXME/TBD-style markers, content omitted for brevity, empty or pass-only bodies, comment-described behaviour, always-true guards, self-satisfying tests, hardcoded fake returns. Diffs, prose about markers and complete work are negative. Positive = the rule should FAIL the output.',
};

async function readSource(sourceDir, family) {
  const raw = await readFile(resolve(sourceDir, `corpus-${family}.json`), 'utf-8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error(`corpus-${family}.json is not an array`);
  return arr;
}

async function verify(files, sourceDir) {
  // Runs under tsx only: imports the TypeScript rule registry directly.
  const { rulesByType } = await import('../../src/eval/rules/index.ts');
  const { materialiseCase } = await import('../lib/materialise.ts');
  const byName = new Map(Object.values(rulesByType).flat().map((r) => [r.name, r]));
  let diffs = 0;
  let checked = 0;
  for (const { family, rule } of FAMILIES) {
    const originals = await readSource(sourceDir, family);
    const byId = new Map(originals.map((c) => [c.id, c]));
    const r = byName.get(rule);
    for (const c of files[family].cases) {
      const o = byId.get(c.id);
      const before = r.evaluate({ output: o.output, input: o.context ?? undefined });
      const m = materialiseCase(c);
      const after = r.evaluate({ output: m.output, input: m.input });
      checked++;
      if (before.passed !== after.passed || before.skipped !== after.skipped) {
        diffs++;
        process.stderr.write(`  VERDICT MOVED ${c.id}: original passed=${before.passed} materialised passed=${after.passed}\n`);
      }
    }
  }
  process.stdout.write(`verify: ${checked} cases re-evaluated on original vs materialised text, ${diffs} verdict(s) moved\n`);
  return diffs === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const sourceIdx = argv.indexOf('--source');
  if (sourceIdx === -1 || !argv[sourceIdx + 1]) {
    process.stderr.write('usage: node proof/tools/convert-v0.mjs --source <dir> [--verify]\n');
    process.exit(2);
  }
  const sourceDir = resolve(argv[sourceIdx + 1]);
  const doVerify = argv.includes('--verify');

  await mkdir(OUT_DIR, { recursive: true });
  const files = {};
  const replaced = new Map();
  for (const fam of FAMILIES) {
    const originals = await readSource(sourceDir, fam.family);
    const cases = originals.map((raw) => convertCase(raw, fam));
    for (const c of cases) {
      for (const [name, s] of Object.entries(c.slots ?? {})) {
        replaced.set(s.kind, (replaced.get(s.kind) ?? 0) + 1);
        void name;
      }
    }
    const positives = cases.filter((c) => c.label === 'positive').length;
    const file = {
      schemaVersion: 1,
      rule: fam.rule,
      category: fam.category,
      family: fam.family,
      positiveClass: 'fail',
      definition: DEFINITIONS[fam.family],
      source: 'iris proof corpus v0.1, post-review hygiene edition (2026-08-11); converted by proof/tools/convert-v0.mjs — do not hand-edit',
      labelling: 'Gold by dual annotation (two independent contexts of the same model) with adjudication of disagreements; see proof/README.md for what that does and does not establish. Credential-shaped values are stored as {{SLOT}} placeholders with a character-class mask and regenerated at run time.',
      counts: { n: cases.length, positive: positives, negative: cases.length - positives },
      cases,
    };
    files[fam.family] = file;
  }

  if (doVerify) {
    const ok = await verify(files, sourceDir);
    if (!ok) {
      process.stderr.write('convert-v0: placeholders moved a verdict; fix the detector before writing\n');
      process.exit(1);
    }
  }

  for (const fam of FAMILIES) {
    const path = resolve(OUT_DIR, `${fam.family}.json`);
    await writeFile(path, JSON.stringify(files[fam.family], null, 2) + '\n', 'utf-8');
    const f = files[fam.family];
    process.stdout.write(`wrote proof/corpus/${fam.family}.json  n=${f.counts.n} positive=${f.counts.positive} negative=${f.counts.negative}\n`);
  }
  const summary = [...replaced.entries()].sort().map(([k, n]) => `${k}×${n}`).join(', ');
  process.stdout.write(`placeholdered: ${summary || 'nothing'}\n`);
}

main().catch((err) => {
  process.stderr.write(`convert-v0: ${err.stack ?? err}\n`);
  process.exit(1);
});
