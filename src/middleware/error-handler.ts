import type { ErrorRequestHandler, Request } from 'express';
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

/** A failure's message where it is text, and "Unknown error" where it is not. */
function messageOf(err: unknown): string {
  const message = fieldOf(err, 'message');
  return typeof message === 'string' ? message : 'Unknown error';
}

/** A failure's stack where it is text. */
function stackOf(err: unknown): string | undefined {
  const stack = fieldOf(err, 'stack');
  return typeof stack === 'string' ? stack : undefined;
}

type Log = (line: string, meta: Record<string, unknown>) => void;

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let logged = false;
    const log: Log = (line, meta) => {
      logged = true;
      logger.error(line, meta);
    };
    try {
      const { status, body } = replyTo(err, log);
      if (res.headersSent) {
        // A validation error is logged here too: it is not answered with its issues.
        if (!logged) log(`Request error: ${messageOf(err)}`, { status, stack: stackOf(err) });
        endTheResponse(req);
        return;
      }
      res.status(status).json(body);
    } catch {
      // A failure the steps above could not answer (a list of issues that throws as it is walked, say): answered as any other.
      if (!logged) log(`Request error: ${messageOf(err)}`, { status: 500, stack: stackOf(err) });
      try {
        if (res.headersSent) endTheResponse(req);
        else res.status(500).json({ error: 'Internal server error' });
      } catch {
        // Not even that can be written (a Content-Type a route set that cannot be read, say): the connection is ended.
        endTheResponse(req);
      }
    }
  };
}

/*
 * A failure after part of the response was written cannot be answered: its
 * status and head are gone. The connection is ended, as Express's own
 * handler ends it, so the client sees the response fail rather than wait
 * for the rest of it.
 */
function endTheResponse(req: Request): void {
  req.socket?.destroy();
}

/** The status and body that answer `err`, with its line in the log. */
function replyTo(err: unknown, log: Log): { status: number; body: object } {
  const name = fieldOf(err, 'name');

  // Handle Zod validation errors: at most 20 issues, and how many there were (utils/validation-errors.ts).
  if (name === 'ZodError' || fieldOf(fieldOf(err, 'constructor'), 'name') === 'ZodError') {
    return { status: 400, body: validationErrorBody('Validation error', either(fieldOf(err, 'issues'), fieldOf(err, 'errors'))) };
  }

  const text = messageOf(err);

  /*
   * A rule change or trace deletion refused because its audit entry could
   * not be written (custom-rule-store.ts). Said in words, without the
   * error's own message: that one names the audit log's path, which is
   * for the server log and the local MCP caller, not an HTTP client.
   */
  if (name === 'AuditWriteError') {
    log(`Request error: ${text}`, { status: 503 });
    return {
      status: 503,
      body: {
        error: 'The audit log could not be written, so the change was refused. Nothing was changed. The server log names the file and the cause.',
        code: 'IRIS_STORAGE_ERROR',
      },
    };
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

  const stack = stackOf(err);
  log(`Request error: ${text}`, { status, stack });

  return {
    status,
    body: {
      error: message,
      ...(process.env.NODE_ENV === 'development' && stack !== undefined ? { stack } : {}),
    },
  };
}
