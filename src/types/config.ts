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
  };
  eval: {
    defaultThreshold: number;
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
