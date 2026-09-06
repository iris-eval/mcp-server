import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { IrisConfig } from '../types/index.js';
import { irisHome } from '../utils/iris-home.js';

// Read version from package.json to avoid hardcoded drift
let pkgVersion = '0.1.8';
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  pkgVersion = pkg.version;
} catch {
  // Fallback if package.json isn't resolvable at runtime
}

// The single runtime source for the server's own version — import this
// instead of hardcoding a literal (OTel resource attrs, health, banners).
export const PKG_VERSION = pkgVersion;

export const defaultConfig: IrisConfig = {
  storage: {
    type: 'sqlite',
    redact: 'none',
    path: join(irisHome(), 'iris.db'),
  },
  server: {
    name: 'iris-eval',
    version: pkgVersion,
  },
  transport: {
    type: 'stdio',
    port: 3000,
    host: '127.0.0.1',
  },
  dashboard: {
    enabled: false,
    port: 6920,
    host: '127.0.0.1',
  },
  eval: {
    defaultThreshold: 0.7,
    ruleThresholds: {
      min_output_length: 50,
      min_sentences: 2,
      keyword_overlap: 0.35,
      // Share of content-bearing sentences that must connect to the input's
      // topic (a third — see topic_consistency in src/eval/rules/relevance.ts).
      topic_consistency: 0.33,
      cost_threshold: 0.10,
      max_token_ratio: 5,
      // Identical tool calls tolerated before no_tool_loop fires. Three
      // allows a legitimate retry-with-backoff; the fourth is a loop.
      max_tool_repeats: 3,
      // Reads of ONE target tolerated before no_tool_loop fires, counted
      // across every tool your catalogue marks readOnlyHint — a file read,
      // edited elsewhere and read again is three; a fourth is a loop.
      // Dormant unless you send `tools`.
      max_target_rereads: 3,
      // Tool calls a task may take. Fifty is not evidence of anything, which
      // is why max_steps advises at this default and gates the moment you
      // set it: only the deployment knows what its own agents do.
      max_steps: 50,
    },
    /*
     * Which built-in rules veto is a deployment's call, and the shipped
     * answer is "the three the rules themselves declare" — no_pii,
     * no_injection_patterns, no_blocklist_words. Both lists start empty so
     * the default behaviour is exactly the rules' own declarations; a
     * config.json that sets either one REPLACES the empty list (arrays are
     * not deep-merged). See src/eval/criticality.ts for why this is
     * configurable at all, and /proof for the error rates to decide with.
     */
    criticalRules: [],
    nonCriticalRules: [],
    /*
     * The verdict's six defaults (0.10.0), each a config key so a ruling is
     * a one-line change. Measured before shipped: on the held-out split of
     * the composite corpus the risk composer is right about shipping 57.7%
     * of the time against the legacy 38.5%, at an IDENTICAL false-block
     * rate, missing 55.6% of bad outputs against 83.3%. See
     * proof/COMPOSITE.md, which regenerates on every release.
     */
    composer: 'risk',
    falsePassCost: 1,
    onCriticalSkipped: 'unknown',
    requiredEvidence: [],
    defaultsGate: false,
    prior: 0.5,
    priorMode: 'per-output',
    /*
     * Whether tool-call arguments are checked against the schemas the tools
     * catalogue declares.
     *
     * An off switch that is not an uninstall, because this is the one path
     * where a caller supplies something Iris COMPILES rather than merely
     * parses: ajv generates JavaScript from a schema and runs it on the main
     * thread. The guard ladder in src/eval/schema-validator.ts is the answer
     * to that, and this key is the answer for an operator who would rather
     * not run the path at all. False makes the rules that need it skip,
     * naming this key.
     */
    validateToolArguments: true,
  },
  logging: {
    level: 'info',
  },
  retention: {
    days: 30,
    sweepIntervalHours: 24,
  },
  security: {
    apiKey: undefined,
    allowedOrigins: ['http://localhost:*'],
    rateLimit: {
      /* Dashboard polls ~6 endpoints every 5–10s (Health view alone hits
       * stats + trend + audit + 2× moments + priorStats). At 100/min the
       * dashboard exhausts its own quota and surfaces 429s on /rules etc.
       * 600/min ≈ 10/s — still rejects abusive crawlers, but accommodates
       * a polling-heavy first-party dashboard with headroom for navigation
       * bursts. */
      api: 600,
      mcp: 20,
    },
    requestSizeLimit: '1mb',
  },
};
