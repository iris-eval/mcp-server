import type { ErrorRequestHandler, Response } from 'express';
import type { Logger } from '../utils/logger.js';
import { validationErrorBody } from '../utils/validation-errors.js';

/** A field that threw as it was read. */
const UNREADABLE = Symbol('unreadable');

/**
 * One field of a failure, read once. A failure is whatever was thrown, and a
 * value built in code can carry a field that throws when it is read; such a
 * field is UNREADABLE, so the handler that reads it answers all the same.
 */
function fieldOf(value: unknown, name: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return UNREADABLE;
  }
}

/** `a ?? b`, with a field that could not be read standing for nothing. */
function either(a: unknown, b: unknown): unknown {
  return a === undefined || a === null || a === UNREADABLE ? b : a;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    try {
      answer(err, res, logger);
    } catch {
      // A failure the steps above could not answer (a list of issues that throws as it is walked, say): answered as any other.
      logger.error('Request error: a failure that could not be read', { status: 500 });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };
}

function answer(err: unknown, res: Response, logger: Logger): void {
  // Handle Zod validation errors: at most 20 issues, and how many there were (utils/validation-errors.ts).
  if (fieldOf(err, 'name') === 'ZodError' || fieldOf(fieldOf(err, 'constructor'), 'name') === 'ZodError') {
    res.status(400).json(validationErrorBody('Validation error', either(fieldOf(err, 'issues'), fieldOf(err, 'errors'))));
    return;
  }

  const rawMessage = fieldOf(err, 'message');
  const text = typeof rawMessage === 'string' ? rawMessage : 'Unknown error';

  /*
   * A rule change or trace deletion refused because its audit entry could
   * not be written (custom-rule-store.ts). Said in words, without the
   * error's own message: that one names the audit log's path, which is
   * for the server log and the local MCP caller, not an HTTP client.
   */
  if (fieldOf(err, 'name') === 'AuditWriteError') {
    logger.error(`Request error: ${text}`, { status: 503 });
    res.status(503).json({
      error: 'The audit log could not be written, so the change was refused. Nothing was changed. The server log names the file and the cause.',
      code: 'IRIS_STORAGE_ERROR',
    });
    return;
  }

  // A status a failure names is kept where it is one an error can carry (400 to 599); any other, or none, is 500.
  const named = either(fieldOf(err, 'status'), fieldOf(err, 'statusCode'));
  const status = typeof named === 'number' && Number.isInteger(named) && named >= 400 && named <= 599 ? named : 500;

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
   * miss cases and mangle legitimate messages. A field that cannot be read
   * is no sign that the value is not one, so it counts as one that could be.
   */
  const code = fieldOf(err, 'code');
  const syscall = fieldOf(err, 'syscall');
  const isSystemError = (typeof code === 'string' || code === UNREADABLE) && (typeof syscall === 'string' || syscall === UNREADABLE);
  const message = status >= 500 ? 'Internal server error' : isSystemError ? 'Not found' : text;

  const rawStack = fieldOf(err, 'stack');
  const stack = typeof rawStack === 'string' ? rawStack : undefined;
  logger.error(`Request error: ${text}`, { status, stack });

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && stack !== undefined ? { stack } : {}),
  });
}
