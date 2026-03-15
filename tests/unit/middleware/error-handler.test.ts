import { describe, it, expect } from 'vitest';
import express from 'express';
import { createErrorHandler } from '../../../src/middleware/error-handler.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function testError(app: express.Application, path: string) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('error handler middleware', () => {
  it('should return 500 for unhandled errors', async () => {
    const app = express();
    app.get('/test', async () => { throw new Error('boom'); });
    app.use(createErrorHandler(mockLogger));
    const { status, body } = await testError(app, '/test');
    expect(status).toBe(500);
    expect(body.error).toBe('Internal server error');
  });

  it('should hide stack traces in production', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = express();
    app.get('/test', async () => { throw new Error('secret info'); });
    app.use(createErrorHandler(mockLogger));
    const { body } = await testError(app, '/test');
    expect(body.stack).toBeUndefined();
    process.env.NODE_ENV = origEnv;
  });

  it('should return 400 for ZodError', async () => {
    const app = express();
    app.get('/test', async () => {
      const err = new Error('Validation failed') as any;
      err.name = 'ZodError';
      err.issues = [{ path: ['limit'], message: 'Expected number' }];
      throw err;
    });
    app.use(createErrorHandler(mockLogger));
    const { status, body } = await testError(app, '/test');
    expect(status).toBe(400);
    expect(body.error).toBe('Validation error');
  });
});
