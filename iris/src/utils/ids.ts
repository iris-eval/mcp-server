import { randomBytes, randomUUID } from 'node:crypto';

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

export function generateEvalId(): string {
  return randomUUID();
}
