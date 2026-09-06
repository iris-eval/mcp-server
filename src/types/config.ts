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
    };
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
    /** `risk` composes by kind (gates, vetoes, unknown, then the risk); `legacy` runs the pre-0.10.0 weighted mean. */
    composer?: 'risk' | 'legacy';
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
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  retention: {
    days: number;
    /** How often the sweep re-runs after boot, in hours; 0 disables the timer (the boot sweep still runs). Default 24. */
    sweepIntervalHours: number;
  };
  security: {
    apiKey?: string;
    allowedOrigins: string[];
    rateLimit: {
      api: number;
      mcp: number;
    };
    requestSizeLimit: string;
  };
}
