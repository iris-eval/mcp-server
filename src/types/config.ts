import type { WebhookEventName, WebhookFormat } from '../notify/event-names.js';

/**
 * An outbound webhook on a moment (arc 9, N-16). `url` is the only required
 * key; `events` omitted means every event; the `iris` format (the default)
 * signs every delivery and so needs `secret` or `secretFile`.
 */
export interface WebhookConfig {
  url: string;
  events?: WebhookEventName[];
  /** The signing key. A `whsec_`-prefixed base64 secret is read the Standard Webhooks way; any other string signs as its bytes. */
  secret?: string;
  /** The signing key read from a file (trimmed) — the secret-file pattern. */
  secretFile?: string;
  /** Minutes before the same event for the same agent and subject is sent again. Default 10. */
  cooldownMinutes?: number;
  /** `iris` (signed JSON: id, type, timestamp, data), `slack` ({ text }) or `discord` ({ content }). Default `iris`. */
  format?: WebhookFormat;
  /** One attempt's limit in milliseconds. Default 10000. */
  timeoutMs?: number;
}

export interface IrisConfig {
  storage: {
    type: 'sqlite';
    path: string;
    /**
     * `critical_spans` stores each evaluation's output text with the spans a
     * critical detector flagged replaced by `[REDACTED:<pattern>]`, so a tool
     * that detects leaks need not keep the leak it found. The evidence
     * offsets still index the original text the caller saw. Default `none`.
          *
     * It covers the OUTPUT only. A span into a tool result — which
     * `no_injection_compliance` reports — is never spliced here, and the
     * stored trace keeps any injected payload it carried, deliberately: that
     * text is the record of the attack the verdict points at. Delete the
     * trace to erase it.
     */
    redact?: 'none' | 'critical_spans';
  };
  server: {
    name: string;
    version: string;
  };
  transport: {
    type: 'stdio' | 'http';
    port: number;
    host: string;
  };
  dashboard: {
    enabled: boolean;
    port: number;
    /**
     * Bind address. Defaults to loopback: the dashboard is unauthenticated
     * by default (security.apiKey is undefined) and serves the full trace
     * history, so binding it to every interface exposes agent inputs and
     * outputs to the local network. Set explicitly to share it.
     */
    host: string;
  };
  eval: {
    defaultThreshold: number;
    ruleThresholds?: {
      min_output_length?: number;
      min_sentences?: number;
      keyword_overlap?: number;
      topic_consistency?: number;
      cost_threshold?: number;
      max_token_ratio?: number;
      max_tool_repeats?: number;
      max_target_rereads?: number;
      max_steps?: number;
    };
    /**
     * Internal, set by loadConfig: the threshold keys the config FILE
     * supplied, so a rule can say whether its threshold is the deployment's
     * policy or our shipped guess without comparing values. Never written by
     * a user; a strict config validator (arc 8) treats it as reserved.
     */
    configuredThresholdKeys?: string[];
    /**
     * Built-in rule names promoted to CRITICAL — a failure vetoes `passed`
     * regardless of the weighted score. Validated against the rule registry
     * when the config loads; an unknown name is a startup error naming the
     * valid list, never a silent no-op.
     */
    criticalRules?: string[];
    /**
     * Built-in rule names demoted from critical — they still score and still
     * report a failure, but they stop vetoing `passed`. Same validation. A
     * name in both lists is a config error: it does not say what you want.
     */
    nonCriticalRules?: string[];
    /*
     * The verdict's six defaults (0.10.0). Each is a RECOMMENDATION the AI
     * council closed on with its failure mode stated, not a founder ruling;
     * every surface that shows one says so until it is ruled. The record is
     * in the arc-2 council report.
     */
    /**
     * How the verdict is composed: by kind — gates, vetoes, unknown, then the
     * risk. `risk` is the only value from 0.12.0; `legacy` ran the pre-0.10.0
     * weighted mean and was announced in 0.10.0 as lasting two minors.
     *
     * The key survives its only alternative on purpose: a config that still
     * names `legacy` is refused at startup with a sentence, rather than
     * silently switched. Tune the shipped composer with `falsePassCost`.
     */
    composer?: 'risk';
    /**
     * How many wrongly blocked builds one shipped failure is worth. The risk
     * threshold is 1 / (1 + this), so 1 means a false pass and a false block
     * cost the same; a continuous-integration gate that hates flakiness sets
     * it low, a compliance gate sets it high.
     */
    falsePassCost?: number;
    /**
     * What a critical rule that was ASKED and could not answer does to the
     * verdict — defeated by the output, or configured invalidly. Not the
     * same as never asked, which is coverage. Today's behaviour is `pass`,
     * which is the fail-open seam; the default is `unknown`.
     */
    onCriticalSkipped?: 'unknown' | 'fail' | 'pass';
    /** Inputs every evaluation must carry; an absent one makes the verdict unknown rather than clean. */
    requiredEvidence?: string[];
    /**
     * Whether a threshold IRIS ships decides the verdict, or only advises.
     * A default is our guess about a deployment we have never seen; a
     * threshold you set is your decision. A policy with no number in it —
     * "the output is empty" — gates either way.
     */
    defaultsGate?: boolean;
    /** Check tool-call arguments against the catalogue's schemas. See defaults.ts. */
    validateToolArguments?: boolean;
    /**
     * Rules you wrote as code (arc 8, R-3): ES modules whose default export
     * is `{ name, kind, mechanism, version, needs, evaluate(ctx) }`, each
     * pinned by the sha256 of its file. A plugin runs in-process, so a file
     * whose hash does not match, or that lacks the contract, refuses
     * startup naming the path. Relative paths resolve against the Iris home.
     */
    plugins?: Array<{ path: string; sha256: string }>;
    /** The prior that an output is bad before any rule speaks. 0.5 matches the proof corpus, not your traffic. */
    prior?: number;
    /**
     * How that prior is spread over the failure classes the detectors
     * examine. `per-output` keeps it at the stated value for the output as a
     * whole; `per-class` applies it to each class independently, which makes
     * installing another detector raise the prior before that detector has
     * looked at anything.
     */
    priorMode?: 'per-output' | 'per-class';
    /**
     * Whether the deployment SET eval.prior (loadConfig records it, as it
     * records configuredThresholdKeys), so a verdict can say whose prior it
     * used: `config` when this is true, `estimated` when the deployment's
     * own labels implied one, `default` otherwise. Never written by a user;
     * reserved like configuredThresholdKeys.
     */
    priorConfigured?: boolean;
  };
  /**
   * Traces arriving by OTLP/HTTP at `POST /v1/traces` (arc 8, R-2). They
   * are stored with what they carry; `evaluateOnIngest` scores each one
   * that carries an output, off by default because an OTLP feed is a
   * firehose the operator did not necessarily mean to grade.
   */
  otel: {
    evaluateOnIngest: boolean;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  /** Outbound notifications (arc 9, N-16). `webhook: null` (the default) sends nothing. */
  notify: {
    webhook: WebhookConfig | null;
  };
  retention: {
    days: number;
    /** How often the sweep re-runs after boot, in hours; 0 disables the timer (the boot sweep still runs). Default 24. */
    sweepIntervalHours: number;
  };
  security: {
    /** The primary key, in plaintext (IRIS_API_KEY / --api-key). Its id is `primary`. */
    apiKey?: string;
    /**
     * The primary key read from a file — its trimmed contents
     * (IRIS_API_KEY_FILE). The secret-file pattern Docker and Kubernetes
     * mount. Set this or `apiKey`, not both. See src/security/keys.ts.
     */
    apiKeyFile?: string;
    /**
     * Further keys, so a rotation has no gap: add the new one, restart,
     * move the clients, remove the old one, restart. Each has an `id`,
     * exactly one of `keyFile` (a file whose trimmed contents are the key)
     * or `keyHash` (the sha256 hex of the key, so the config file holds no
     * secret), and an optional `expiresAt` (ISO 8601) after which it stops
     * matching at that instant.
     */
    apiKeys?: Array<{ id: string; keyFile?: string; keyHash?: string; expiresAt?: string }>;
    /**
     * Run a non-loopback bind with no API key on purpose (IRIS_ALLOW_UNAUTHENTICATED=1).
     * Without it such a bind is refused at startup — see src/utils/bind-policy.ts.
     */
    allowUnauthenticated: boolean;
    allowedOrigins: string[];
    rateLimit: {
      api: number;
      mcp: number;
      /**
       * What the MCP endpoint's per-minute limit is counted against: the
       * client address (default), or the API key that authenticated the
       * request — so several agents behind one NAT each get their own
       * budget. A request with no key falls back to its address.
       */
      mcpKeyBy?: 'ip' | 'apiKey';
    };
    requestSizeLimit: string;
  };
}
