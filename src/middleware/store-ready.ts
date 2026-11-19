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
        /*
         * A wait can end with anything at all: nothing, or a value that will
         * not say what it is. Each thing is read once, as it always was: the
         * value's `retryable` (its own or inherited), and its words, an
         * Error's message or the value, either written as text where it is
         * not text (an Error whose message was set to undefined says
         * "undefined"). A wait that ended with nothing, with empty words,
         * with only the text that names an object's kind ("[object Object]"),
         * or with words that cannot be read is answered with the gate's own
         * sentence, and what was read before a read threw stands. So the
         * request is answered, and `error` is text.
         */
        let retryable = false;
        let message = 'The store is not ready.';
        if (err !== null && err !== undefined) {
          try {
            retryable = (err as { retryable?: unknown }).retryable === true;
          } catch {
            // Its retryable would not be read: it is not one to retry.
          }
          try {
            const said: unknown = err instanceof Error ? err.message : err;
            const text = typeof said === 'string' ? said : String(said);
            if (text !== '' && !/^\[object [^\]]*\]$/.test(text)) message = text;
          } catch {
            // Its words would not be read: the gate's own sentence stands.
          }
        }
        if (retryable) res.set('Retry-After', String(RETRY_AFTER_S));
        res.status(503).json({ error: message, code: 'IRIS_STORAGE_ERROR', retryable });
      },
    );
  };
}
