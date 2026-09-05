export interface IrisConfig {
  storage: {
    type: 'sqlite';
    path: string;
    /**
     * `critical_spans` stores each evaluation's output text with the spans a
     * critical detector flagged replaced by `[REDACTED:<pattern>]`, so a tool
     * that detects leaks need not keep the leak it found. The evidence
     * offsets still index the original text the caller saw. Default `none`.
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
