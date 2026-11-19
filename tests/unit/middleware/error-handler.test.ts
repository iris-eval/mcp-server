import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  /*
   * A failure is whatever was thrown, and a value built in code can carry a
   * field that throws when it is read. The handler reads each field once,
   * and answers as JSON with one line in the log whatever it finds (#1077).
   */
  describe('a failure whose fields throw as they are read', () => {
    /** A failure with `fields`, each a value or 'throws'. */
    const failure = (fields: Record<string, unknown>): Error => {
      const err = new Error('the message');
      for (const [name, value] of Object.entries(fields)) {
        Object.defineProperty(err, name, {
          configurable: true,
          get: () => {
            if (value === 'throws') throw new Error(`${name} cannot be read`);
            return value;
          },
        });
      }
      return err;
    };
    /** The answer to one failure, and the lines it put in the log. */
    const answerTo = async (err: unknown) => {
      const lines: string[] = [];
      const logger = { ...mockLogger, error: (line: string) => void lines.push(line) };
      const app = express();
      app.get('/test', async () => {
        throw err;
      });
      app.use(createErrorHandler(logger));
      return { ...(await testError(app, '/test')), lines };
    };

    it('a status that cannot be read is a 500, answered as JSON, with one line in the log', async () => {
      const { status, body, lines } = await answerTo(failure({ status: 'throws' }));
      expect(status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(lines).toHaveLength(1);
    });

    it('a 4xx keeps its status, and a message that cannot be read, or is not text, is not echoed', async () => {
      for (const message of ['throws', 42, { text: 'x' }]) {
        const { status, body, lines } = await answerTo(failure({ status: 404, message }));
        expect(status, JSON.stringify(message)).toBe(404);
        expect(body.error).toBe('Unknown error');
        expect(lines).toHaveLength(1);
      }
    });

    it('a system error whose code or syscall cannot be read is still not echoed', async () => {
      for (const fields of [{ code: 'throws', syscall: 'stat' }, { code: 'ENOENT', syscall: 'throws' }, { code: 'throws', syscall: 'throws' }]) {
        const err = failure({ ...fields, status: 404 });
        Object.defineProperty(err, 'message', { value: "ENOENT: no such file or directory, stat 'C:\\srv\\iris\\dist\\index.html'" });
        const { status, body } = await answerTo(err);
        expect(status, JSON.stringify(fields)).toBe(404);
        expect(body.error).toBe('Not found');
        expect(JSON.stringify(body)).not.toMatch(/ENOENT|srv/);
      }
    });

    it('a name, a constructor or a stack that cannot be read: an ordinary 500', async () => {
      for (const fields of [{ name: 'throws' }, { constructor: 'throws' }, { stack: 'throws' }]) {
        const { status, body, lines } = await answerTo(failure(fields));
        expect(status, Object.keys(fields)[0]).toBe(500);
        expect(body.error).toBe('Internal server error');
        expect(lines).toHaveLength(1);
      }
    });

    it('a ZodError whose issues cannot be read is answered from its errors, as a ZodError whose issues are absent is', async () => {
      const err = failure({ name: 'ZodError', issues: 'throws' });
      Object.defineProperty(err, 'errors', { value: [{ path: ['limit'], message: 'Expected number' }] });
      const { status, body } = await answerTo(err);
      expect(status).toBe(400);
      expect(body.error).toBe('Validation error');
      expect(JSON.stringify(body)).toContain('Expected number');
    });

    it('a list of issues that throws as it is walked: a 500 answered as JSON, with one line in the log', async () => {
      const err = failure({ name: 'ZodError' });
      Object.defineProperty(err, 'issues', { value: new Proxy([], { get: () => { throw new Error('not walked'); } }) });
      const { status, body, lines } = await answerTo(err);
      expect(status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(lines).toHaveLength(1);
    });

    it('a status outside 400 to 599, or not a whole number, is a 500', async () => {
      for (const named of [302, 600, '404', 404.5, Number.NaN]) {
        const { status, body } = await answerTo(failure({ status: named }));
        expect(status, String(named)).toBe(500);
        expect(body.error).toBe('Internal server error');
      }
    });

    it('the changelog says what the handler reads and answers, word for word, under Fixed in the release to come', () => {
      const changelog = readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
      const unreleased = changelog.split('\n## [Unreleased]\n')[1]?.split('\n## [')[0] ?? '';
      const fixed = unreleased.split('\n### Fixed\n')[1]?.split('\n### ')[0] ?? '';
      expect(fixed).toContain(
        '- **The HTTP error handler answers a failure whose fields cannot be read.** It read a failure\'s `name`, `code`, `syscall`, `status` and `message` directly, so a value built in code whose field throws as it is read made the handler itself throw, and Express answered with its own error page, which outside production holds the stack and its file paths. Each field is now read once, and one that cannot be read is taken as absent, or, for `code` and `syscall`, as a sign the failure may be a system error, whose message is never echoed; every failure is answered as JSON with one line in the server log. A status is kept where it is a whole number from 400 to 599, and any other is answered as 500; a message that is not text is answered as "Unknown error".',
      );
    });

    it('a value thrown that is not an object is an ordinary 500', async () => {
      for (const thrown of ['a string', 42, null, undefined]) {
        const { status, body } = await answerTo(thrown);
        expect(status, String(thrown)).toBe(500);
        expect(body.error).toBe('Internal server error');
      }
    });
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
