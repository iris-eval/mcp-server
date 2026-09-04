export interface IrisConfig {
  storage: {
    type: 'sqlite';
    path: string;
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
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  retention: {
    days: number;
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
