import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../utils/logger.js';
import { validationErrorBody } from '../utils/validation-errors.js';

/**
 * A field of what was thrown, read without throwing: a getter that throws,
 * or a proxy whose every read throws, reads as nothing. What reaches this
 * handler is whatever a route or a store threw, and a handler that threw
 * while reading it left the answer to Express's own page, which writes the
 * stack out when NODE_ENV is not "production".
 */
function fieldOf(err: unknown, key: string): unknown {
  try {
    return (err !== null && typeof err === 'object') || typeof err === 'function' ? (err as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/** The name of what was thrown, or of its class, read without throwing. */
function namesOf(err: unknown): unknown[] {
  let ctor: unknown;
  try {
    ctor = (fieldOf(err, 'constructor') as { name?: unknown } | undefined)?.name;
  } catch {
    ctor = undefined;
  }
  return [fieldOf(err, 'name'), ctor];
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const names = namesOf(err);
    const said = textOf(fieldOf(err, 'message'));
    // Handle Zod validation errors: at most 20 issues, and how many there were (utils/validation-errors.ts).
    if (names.includes('ZodError')) {
      res.status(400).json(validationErrorBody('Validation error', fieldOf(err, 'issues') ?? fieldOf(err, 'errors')));
      return;
    }

    /*
     * A rule change or trace deletion refused because its audit entry could
     * not be written (custom-rule-store.ts). Said in words, without the
     * error's own message: that one names the audit log's path, which is
     * for the server log and the local MCP caller, not an HTTP client.
     */
    if (names[0] === 'AuditWriteError') {
      logger.error(`Request error: ${said ?? 'an audit entry could not be written'}`, { status: 503 });
      res.status(503).json({
        error: 'The audit log could not be written, so the change was refused. Nothing was changed. The server log names the file and the cause.',
        code: 'IRIS_STORAGE_ERROR',
      });
      return;
    }

    const status = (fieldOf(err, 'status') ?? fieldOf(err, 'statusCode') ?? 500) as number;

    /*
     * Never echo a Node system error to the client. Their messages embed
     * absolute paths — an ENOENT from res.sendFile returned
     *   "ENOENT: no such file or directory, stat 'C:\...\dist\dashboard\index.html'"
     * with a 404, disclosing the install path and OS user to anyone who
     * could reach the dashboard (CWE-209). 5xx was already masked; the leak
     * was in the 4xx branch, where echoing err.message is otherwise useful
     * (body-parser's "request entity too large", Zod messages, etc.).
     *
     * Identify system errors by the shape Node gives them — a string `code`
     * plus `syscall` — rather than by matching path-ish text, which would
     * miss cases and mangle legitimate messages.
     */
    const isSystemError = typeof fieldOf(err, 'code') === 'string' && typeof fieldOf(err, 'syscall') === 'string';
    const message =
      status >= 500 || isSystemError
        ? status >= 500
          ? 'Internal server error'
          : 'Not found'
        : (said ?? 'Unknown error');
    const stack = textOf(fieldOf(err, 'stack'));

    logger.error(`Request error: ${said ?? 'a failure whose message cannot be read'}`, { status, stack });

    res.status(status).json({
      error: message,
      ...(process.env.NODE_ENV === 'development' ? { stack } : {}),
    });
  };
}
