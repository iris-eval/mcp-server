/*
 * HTTP requests wait for the store while it is upgraded after the start
 * (storage/ready.ts), at most as long as the gate lets them, and are then
 * answered 503 with the gate's sentence and a Retry-After. Health is
 * mounted before this and always answers.
 */
import type { RequestHandler } from 'express';
import type { StoreGate } from '../storage/ready.js';

/** Seconds a refused client is told to wait before it asks again. */
const RETRY_AFTER_S = 5;

export function storeReadyMiddleware(gate: StoreGate): RequestHandler {
  return (_req, res, next) => {
    if (gate.open) return next();
    gate.wait().then(
      () => next(),
      (err: unknown) => {
        const retryable = (err as { retryable?: boolean }).retryable === true;
        if (retryable) res.set('Retry-After', String(RETRY_AFTER_S));
        res.status(503).json({ error: err instanceof Error ? err.message : String(err), code: 'IRIS_STORAGE_ERROR', retryable });
      },
    );
  };
}
