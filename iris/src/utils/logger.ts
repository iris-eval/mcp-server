import pino from 'pino';
import type { IrisConfig } from '../types/index.js';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(config: Pick<IrisConfig, 'logging'>): Logger {
  const logger = pino({
    level: config.logging.level,
    // Write to stderr — stdout is reserved for stdio MCP transport
    transport: undefined,
  }, pino.destination(2));

  return {
    debug: (msg, ...args) => logger.debug(args.length ? { data: args } : {}, msg),
    info: (msg, ...args) => logger.info(args.length ? { data: args } : {}, msg),
    warn: (msg, ...args) => logger.warn(args.length ? { data: args } : {}, msg),
    error: (msg, ...args) => logger.error(args.length ? { data: args } : {}, msg),
  };
}
