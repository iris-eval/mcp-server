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
    const message = status >= 500 ? 'Internal server error' : (err.message ?? 'Unknown error');

    logger.error(`Request error: ${err.message}`, { status, stack: err.stack });

    res.status(status).json({
      error: message,
      ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    });
  };
}
