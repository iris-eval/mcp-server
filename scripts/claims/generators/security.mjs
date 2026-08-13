// Security generator — emits the shipped security defaults that public
// surfaces quote, read straight out of src/config/defaults.ts.
//
// Why this exists: website/src/app/security/page.tsx published "100 requests
// per minute" for the dashboard API while the shipped default had been 600
// for a release — wrong by 6x, on the one page a reader consults precisely
// because they do not trust prose. There was no `security` key in the
// truthbase at all, so neither claims gate could have caught it. Now the
// number has a single source, and check-no-hardcoded.mjs carries a
// `rate-limit` pattern that flags any surface restating a different one.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const DEFAULTS_PATH = 'src/config/defaults.ts';

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

export async function generate() {
  const src = await readFile(resolve(root, DEFAULTS_PATH), 'utf-8');
  return {
    // Requests per minute, per limiter. windowMs is 60_000 in
    // src/middleware/rate-limit.ts for both.
    rateLimit: readRateLimit(src),
    defaultBindHost: {
      transport: readHost(src, 'transport'),
      dashboard: readHost(src, 'dashboard'),
    },
    // The auth middleware is a pass-through when no key is configured
    // (src/middleware/auth.ts) — stated here so no surface can imply that
    // HTTP mode is authenticated by default.
    apiKeyRequiredByDefault: false,
  };
}
