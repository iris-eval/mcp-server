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
  /*
   * CWE-209 regression. res.sendFile on a missing index.html raises an
   * ENOENT whose message embeds an ABSOLUTE path, and the handler returned
   * err.message verbatim for any status < 500 — so an unmatched dashboard
   * route answered with the install path and OS user:
   *   {"error":"ENOENT: ... stat 'C:\...\dist\dashboard\index.html'"}
   */
  it('does not leak filesystem paths from system errors', async () => {
    const app = express();
    app.get('/test', async () => {
      const err = Object.assign(
        new Error("ENOENT: no such file or directory, stat 'C:\srv\iris\dist\dashboard\index.html'"),
        { code: 'ENOENT', syscall: 'stat', status: 404 },
      );
      throw err;
    });
    app.use(createErrorHandler(mockLogger));
    const { status, body } = await testError(app, '/test');
    expect(status).toBe(404);
    expect(body.error).toBe('Not found');
    expect(JSON.stringify(body)).not.toMatch(/ENOENT/);
    expect(JSON.stringify(body)).not.toMatch(/dist/);
    expect(JSON.stringify(body)).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });

  // The 4xx branch stays useful for errors we DO want surfaced — masking
  // everything would turn body-parser's size limit into an unexplained 413.
  it('still surfaces non-system 4xx messages', async () => {
    const app = express();
    app.get('/test', async () => {
      throw Object.assign(new Error('request entity too large'), { status: 413 });
    });
    app.use(createErrorHandler(mockLogger));
    const { status, body } = await testError(app, '/test');
    expect(status).toBe(413);
    expect(body.error).toBe('request entity too large');
  });

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
