// Security generator — emits the shipped security defaults that public
// surfaces quote, read straight out of the source that enforces them.
//
// Why this exists: website/src/app/security/page.tsx published "100 requests
// per minute" for the dashboard API while the shipped default had been 600
// for a release — wrong by 6x, on the one page a reader consults precisely
// because they do not trust prose. There was no `security` key in the
// truthbase at all, so neither claims gate could have caught it. Now the
// number has a single source, and check-no-hardcoded.mjs carries a
// `rate-limit` pattern that flags any surface restating a different one.
//
// Every figure under `limits` here is a CONFIGURATION DEFAULT — what the
// shipped code enforces out of the box — not a measurement. The page says
// so beside them. The one measured block on the security page is
// `maintenance` (generators/issues.mjs). The disclosure SLA is parsed from
// SECURITY.md (generators/security-policy.mjs) so the site and the policy
// cannot state two different promises.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate as disclosure } from './security-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const DEFAULTS_PATH = 'src/config/defaults.ts';
const SANDBOX_PATH = 'src/eval/rules/regex-sandbox.ts';
const CUSTOM_RULES_PATH = 'src/eval/rules/custom.ts';

// Pull `api:`/`mcp:` out of the rateLimit literal only — matching the whole
// file would happily read a number out of a comment (the mistake that made
// mcpTools.annotations.openWorldHintCount ship as 3 against a live 2).
function readRateLimit(src) {
  const block = src.match(/rateLimit:\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error(`Security generator: no rateLimit block in ${DEFAULTS_PATH}`);
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const read = key => {
    const m = body.match(new RegExp(`\\b${key}:\\s*(\\d+)`));
    if (!m) throw new Error(`Security generator: no ${key} in rateLimit block`);
    return Number(m[1]);
  };
  return { api: read('api'), mcp: read('mcp') };
}

function readHost(src, section) {
  const block = src.match(new RegExp(`${section}:\\s*\\{([\\s\\S]*?)\\n  \\}`));
  if (!block) throw new Error(`Security generator: no ${section} block in ${DEFAULTS_PATH}`);
  const m = block[1].match(/host:\s*'([^']+)'/);
  if (!m) throw new Error(`Security generator: no host in ${section} block`);
  return m[1];
}

function readRequestSizeLimit(src) {
  const m = src.match(/requestSizeLimit:\s*'([^']+)'/);
  if (!m) throw new Error(`Security generator: no requestSizeLimit in ${DEFAULTS_PATH}`);
  return m[1];
}

// `export const NAME = 123;` / `const NAME = 123;` — the declaration line
// only, never a comment that happens to mention the constant.
function readConst(src, name, file) {
  const m = src.match(new RegExp(`^(?:export )?const ${name}\\s*=\\s*(\\d+);`, 'm'));
  if (!m) throw new Error(`Security generator: no \`const ${name} = <number>;\` in ${file}`);
  return Number(m[1]);
}

export async function generate() {
  const [defaults, sandbox, customRules] = await Promise.all([
    readFile(resolve(root, DEFAULTS_PATH), 'utf-8'),
    readFile(resolve(root, SANDBOX_PATH), 'utf-8'),
    readFile(resolve(root, CUSTOM_RULES_PATH), 'utf-8'),
  ]);
  return {
    // Requests per minute, per limiter. windowMs is 60_000 in
    // src/middleware/rate-limit.ts for both.
    rateLimit: readRateLimit(defaults),
    defaultBindHost: {
      transport: readHost(defaults, 'transport'),
      dashboard: readHost(defaults, 'dashboard'),
    },
    // The auth middleware is a pass-through when no key is configured
    // (src/middleware/auth.ts) — stated here so no surface can imply that
    // HTTP mode is authenticated by default.
    apiKeyRequiredByDefault: false,
    // Shipped defaults, each read from the line that enforces it. Every one
    // of these is configuration, not a measurement.
    limits: {
      // express.json({ limit }) on both the dashboard and the HTTP transport.
      requestSizeLimit: readRequestSizeLimit(defaults),
      // Hard per-match deadline for user-supplied regex, in the sandbox worker.
      regexMatchBudgetMs: readConst(sandbox, 'REGEX_MATCH_BUDGET_MS', SANDBOX_PATH),
      // Per-evaluation circuit breaker: after this many budget breaches the
      // remaining regex rules in that evaluation skip.
      regexBreachesPerEvaluation: readConst(customRules, 'MAX_REGEX_BREACHES_PER_EVAL', CUSTOM_RULES_PATH),
      // Longest custom regex source accepted (fast-path rejection, not the boundary).
      customRegexMaxLength: readConst(customRules, 'MAX_PATTERN_LENGTH', CUSTOM_RULES_PATH),
    },
    // Parsed from SECURITY.md — one policy, one set of numbers.
    disclosure: await disclosure(),
  };
}
