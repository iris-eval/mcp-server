import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../utils/logger.js';

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    // Handle Zod validation errors
    if (err?.name === 'ZodError' || err?.constructor?.name === 'ZodError') {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors ?? err.issues,
      });
      return;
    }

    const status = err.status ?? err.statusCode ?? 500;

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
    const isSystemError = typeof err?.code === 'string' && typeof err?.syscall === 'string';
    const message =
      status >= 500 || isSystemError
        ? status >= 500
          ? 'Internal server error'
          : 'Not found'
        : (err.message ?? 'Unknown error');

    logger.error(`Request error: ${err.message}`, { status, stack: err.stack });

    res.status(status).json({
      error: message,
      ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    });
  };
}
