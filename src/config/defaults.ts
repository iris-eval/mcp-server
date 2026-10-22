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

/*
 * The most array elements and object keys one input may hold before it is
 * validated (security.maxInputElements; its name before 0.21.0 was
 * maxToolInputElements, and that name is still read). It bounds two doors:
 *
 * - a tool call's arguments, on stdio and HTTP. The MCP SDK counts them
 *   before it validates them, and answers a call over the limit with an
 *   isError result (GHSA-46jr-4wx8-v453); it counts nothing unless the
 *   server sets a limit.
 * - a request body on the dashboard port: the API's JSON bodies and
 *   POST /v1/traces, JSON or protobuf (counted as it is decoded). A body over
 *   the limit is answered 413 before any schema reads it
 *   (src/utils/element-count.ts).
 *
 * The bytes were already bounded (requestSizeLimit, 1 MB on both
 * transports); the element count was not, and it is what costs memory.
 * Arguments that fail validation are reported element by element, 63 to
 * 148 characters of error text each, so one 1 MB request of 524,229 bad
 * elements cost the server 260 MB, and 20 requests of 1 MB at once (the
 * MCP endpoint's per-minute rate limit) up to 1,148 MB and 41 s to answer.
 *
 * The number is the first power of ten above every legitimate input
 * measured, even one that fills the whole 1 MB request. The largest tool
 * call in the test suite holds 39 elements, the largest stored case (a
 * proof corpus trace of 201 tool calls) 1,009. Scaled up to 1 MB, real
 * agent transcripts hold 12,615, OpenTelemetry spans exported by agent
 * frameworks up to 14,889, Iris's own tools/list 34,474, and that
 * 201-call case, the densest shape found, 68,506. At 100,000 the worst
 * burst measured cost 530 to 690 MB across runs, and 9 to 11 s. An
 * operator who exposes HTTP beyond loopback can go lower: 10,000 holds the
 * same burst to about 250 MB and 1 s, and refuses a trace of real agent
 * shape somewhere past 700 KB. An operator who raises requestSizeLimit for
 * denser data raises this with it. The bursts are measured by
 * scripts/bench-tool-input-elements.ts.
 *
 * The dashboard's bodies have the same shapes (POST /api/v1/traces takes
 * the log_trace arguments), and OpenTelemetry exports sent as JSON hold at
 * most 62,755 elements at 1 MB (the fixtures in tests/fixtures/otlp).
 * Protobuf is denser: decoded, the same exports hold 17 to 26 bytes per
 * element from the agent frameworks and 7.5 to 10 from the plain Python
 * exporter, so a protobuf batch of minimal spans reaches 100,000 past
 * about 730 KB. A collector that sends batches that dense and that large
 * raises this.
 */
export const DEFAULT_MAX_INPUT_ELEMENTS = 100_000;

/**
 * The element limit a config sets: maxInputElements, else its name before
 * 0.21.0 (an embedder's config object may still carry it), else the
 * default. A config built without either still gets the limit.
 */
export function maxInputElementsOf(security: { maxInputElements?: number; maxToolInputElements?: number } | undefined): number {
  return security?.maxInputElements ?? security?.maxToolInputElements ?? DEFAULT_MAX_INPUT_ELEMENTS;
}

export const defaultConfig: IrisConfig = {
  storage: {
    type: 'sqlite',
    redact: 'none',
    synchronous: 'normal',
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
     * The verdict's six defaults (0.10.0), each a config key so changing one is
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
  otel: {
    evaluateOnIngest: false,
  },
  logging: {
    level: 'info',
  },
  pricing: {
    estimate: true,
    models: [],
  },
  notify: {
    webhook: null,
  },
  retention: {
    days: 30,
    sweepIntervalHours: 24,
  },
  security: {
    apiKey: undefined,
    allowUnauthenticated: false,
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
    maxInputElements: DEFAULT_MAX_INPUT_ELEMENTS,
  },
};
