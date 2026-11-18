import { describe, it, expect } from 'vitest';
import express from 'express';
import { createErrorHandler } from '../../../src/middleware/error-handler.js';
import { AuditWriteError } from '../../../src/custom-rule-store.js';
import { recordOf } from '../../helpers/json.js';

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
    return { status: res.status, body: recordOf(await res.json()) };
  } finally {
    server.close();
  }
}

describe('error handler middleware', () => {
  it('a change refused because the audit log could not be written is a 503 that names no path', async () => {
    const app = express();
    app.get('/test', async () => {
      throw new AuditWriteError('/home/someone/.iris/audit.log', new Error('EACCES: permission denied'));
    });
    app.use(createErrorHandler(mockLogger));
    const { status, body } = await testError(app, '/test');
    expect(status).toBe(503);
    expect(body.code).toBe('IRIS_STORAGE_ERROR');
    expect(String(body.error)).toContain('so the change was refused');
    expect(JSON.stringify(body)).not.toMatch(/someone|audit\.log|EACCES/);
  });

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

  describe('what was thrown is read without throwing', () => {
    const unreadable: Array<[string, () => unknown]> = [
      ['an Error whose message cannot be read', () => Object.defineProperty(new Error('x'), 'message', { get() { throw new Error('the message cannot be read'); } })],
      ['an Error whose code cannot be read', () => Object.defineProperty(new Error('boom'), 'code', { get() { throw new Error('the code cannot be read'); } })],
      ['an Error whose status cannot be read', () => Object.defineProperty(new Error('boom'), 'status', { get() { throw new Error('the status cannot be read'); } })],
      ['a value every read of which throws', () => new Proxy({}, { get() { throw new Error('nothing of it can be read'); } })],
    ];
    it.each(unreadable)('%s: the JSON 500, which says nothing of it, and one line in the log, with NODE_ENV unset', async (_what, make) => {
      const saved = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      const logged: string[] = [];
      const app = express();
      app.get('/test', async () => {
        throw make();
      });
      app.use(createErrorHandler({ ...mockLogger, error: (m: string) => void logged.push(m) }));
      const server = app.listen(0);
      try {
        const res = await fetch(`http://localhost:${(server.address() as { port: number }).port}/test`);
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
        expect(JSON.parse(await res.text())).toEqual({ error: 'Internal server error' });
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatch(/^Request error: /);
      } finally {
        server.close();
        if (saved === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = saved;
      }
    });

    it('a 4xx whose message cannot be read says it is unknown, and a ZodError is known by its class alone', async () => {
      const app = express();
      app.get('/four', async () => {
        throw Object.defineProperty(Object.assign(new Error('x'), { status: 409 }), 'message', { get() { throw new Error('no'); } });
      });
      app.use(createErrorHandler(mockLogger));
      expect(await testError(app, '/four')).toEqual({ status: 409, body: { error: 'Unknown error' } });
    });
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
