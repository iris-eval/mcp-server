import { readFileSync } from 'node:fs';
import { get } from 'node:http';
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
   * field that throws when it is read. The handler reads each field once and
   * answers as JSON whatever it finds, with one line in the log for any
   * failure but a validation error answered with its issues (#1077).
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
    /** The answer to one failure, the lines it put in the log, and what each line carried beside it. */
    const answerTo = async (err: unknown) => {
      const lines: string[] = [];
      const metas: Array<Record<string, unknown>> = [];
      const logger = {
        ...mockLogger,
        error: (line: string, meta?: Record<string, unknown>) => {
          lines.push(line);
          metas.push(meta ?? {});
        },
      };
      const app = express();
      app.get('/test', async () => {
        throw err;
      });
      app.use(createErrorHandler(logger));
      return { ...(await testError(app, '/test')), lines, metas };
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
        const { status, body, lines } = await answerTo(err);
        expect(status, JSON.stringify(fields)).toBe(404);
        expect(body.error).toBe('Not found');
        expect(JSON.stringify(body)).not.toMatch(/ENOENT|srv/);
        expect(lines).toHaveLength(1);
      }
    });

    it('a code with no syscall is no system error, so a 4xx message is echoed; a system error keeps its own 4xx', async () => {
      const { status, body } = await answerTo(failure({ code: 'ERR_X', status: 400 }));
      expect(status).toBe(400);
      expect(body.error).toBe('the message');
      const denied = await answerTo(failure({ code: 'EACCES', syscall: 'open', status: 403 }));
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('Not found');
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
      // The line names the failure's own message.
      expect(lines).toEqual(['Request error: the message']);
    });

    it('a status outside 400 to 599, or not a whole number, is a 500, and the line in the log says 500', async () => {
      for (const named of [302, 600, '404', 404.5, Number.NaN]) {
        const { status, body, lines, metas } = await answerTo(failure({ status: named }));
        expect(status, String(named)).toBe(500);
        expect(body.error).toBe('Internal server error');
        expect(lines).toHaveLength(1);
        expect(metas[0]?.status, String(named)).toBe(500);
      }
    });

    it('a status from 400 to 599 is kept at either end, and a null one gives way to statusCode', async () => {
      for (const named of [400, 599]) expect((await answerTo(failure({ status: named }))).status, String(named)).toBe(named);
      expect((await answerTo(failure({ status: null, statusCode: 404 }))).status).toBe(404);
    });

    it('a failure puts one line in the log, and a validation error answered with its issues none', async () => {
      const zod = Object.assign(new Error('Validation failed'), { name: 'ZodError', issues: [{ path: ['limit'], message: 'Expected number' }] });
      const cases: Array<[string, unknown, number]> = [
        ['an audit log that could not be written', new AuditWriteError('/home/someone/.iris/audit.log', new Error('EACCES: permission denied')), 1],
        ['a 4xx with text', Object.assign(new Error('request entity too large'), { status: 413 }), 1],
        ['a plain Error', new Error('boom'), 1],
        ['a validation error', zod, 0],
      ];
      for (const [label, err, count] of cases) expect((await answerTo(err)).lines, label).toHaveLength(count);
    });

    it('the handler reads each field of a failure once, in every path', async () => {
      const walked = Object.assign(new Error('Validation failed'), { name: 'ZodError' });
      Object.defineProperty(walked, 'issues', { value: new Proxy([], { get: () => { throw new Error('not walked'); } }) });
      const cases = [
        Object.assign(new Error('not found here'), { status: 404 }),
        Object.assign(new Error('the audit log'), { name: 'AuditWriteError' }),
        Object.assign(new Error('no such file'), { code: 'ENOENT', syscall: 'stat', status: 404 }),
        Object.assign(new Error('Validation failed'), { name: 'ZodError', issues: [{ path: ['limit'], message: 'Expected number' }] }),
        // Answered by the catch: its issues throw as they are walked.
        walked,
      ];
      for (const target of cases) {
        const reads = new Map<PropertyKey, number>();
        const counted = new Proxy(target, {
          get: (t, key, receiver) => {
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return Reflect.get(t, key, receiver) as unknown;
          },
        });
        await answerTo(counted);
        expect([...reads].filter(([, n]) => n > 1).map(([key]) => String(key)), target.message).toEqual([]);
      }
    });

    it("V8, writing out an error's stack the first time it is read, reads its name and message again; once it is written, none of the three is read twice", async () => {
      /** A real Error whose name and message count their reads, its stack written out first or not. */
      const counted = (written: boolean): { err: Error; reads: Record<string, number> } => {
        const err = new Error('the message');
        if (written) void err.stack;
        const reads: Record<string, number> = { name: 0, message: 0, stack: 0 };
        for (const [key, value] of [['name', 'Error'], ['message', 'the message']] as const) {
          Object.defineProperty(err, key, {
            configurable: true,
            get: () => {
              reads[key] += 1;
              return value;
            },
          });
        }
        if (written) {
          const stack = err.stack;
          Object.defineProperty(err, 'stack', {
            configurable: true,
            get: () => {
              reads.stack += 1;
              return stack;
            },
          });
        }
        return { err, reads };
      };
      const fresh = counted(false);
      await answerTo(fresh.err);
      expect(fresh.reads.name).toBe(2);
      expect(fresh.reads.message).toBe(2);
      const once = counted(true);
      await answerTo(once.err);
      expect(once.reads).toEqual({ name: 1, message: 1, stack: 1 });
    });

    it('a ZodError is known by its constructor\'s name as well, and its issues are read before its errors', async () => {
      class ZodError extends Error {
        issues = [{ path: ['limit'], message: 'Expected number' }];
      }
      const byClass = await answerTo(new ZodError('Validation failed'));
      expect(byClass.status).toBe(400);
      expect(JSON.stringify(byClass.body)).toContain('Expected number');
      const both = failure({ name: 'ZodError', issues: [{ path: ['a'], message: 'from issues' }], errors: [{ path: ['b'], message: 'from errors' }] });
      const { body } = await answerTo(both);
      expect(JSON.stringify(body)).toContain('from issues');
      expect(JSON.stringify(body)).not.toContain('from errors');
    });

    it('under development a stack in text is answered, and a stack that is not text, or a failure the steps could not answer, is answered with none', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        expect(typeof (await answerTo(new Error('boom'))).body.stack).toBe('string');
        const listed = await answerTo(failure({ stack: ['frame one', 'frame two'] }));
        expect(listed.body.stack).toBeUndefined();
        // Nor is it logged.
        expect(listed.metas[0]?.stack).toBeUndefined();
        const walked = failure({ name: 'ZodError' });
        Object.defineProperty(walked, 'issues', { value: new Proxy([], { get: () => { throw new Error('not walked'); } }) });
        expect((await answerTo(walked)).body).toEqual({ error: 'Internal server error' });
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it("a failure after part of the response is handed on to Express's own handler, which ends the connection once what was written has gone out, as before", async () => {
      const zod = Object.assign(new Error('Validation failed'), { name: 'ZodError', issues: [{ path: ['limit'], message: 'Expected number' }] });
      // An error puts its one line in the log; a validation error none, as one answered with its issues puts none.
      const cases: Array<[unknown, string[]]> = [
        [new Error('the stream failed'), ['Request error: the stream failed']],
        [zod, []],
      ];
      for (const [thrown, logged] of cases) {
        const lines: string[] = [];
        const logger = { ...mockLogger, error: (written: string) => void lines.push(written) };
        const app = express();
        // A route that writes the head and an event and fails in the same turn, before they have left the process.
        app.get('/test', (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: one\n\n');
          throw thrown;
        });
        app.use(createErrorHandler(logger));
        const server = app.listen(0);
        const { port } = server.address() as { port: number };
        try {
          const seen = await new Promise<{ ending: string; status?: number; body: string }>((done) => {
            let body = '';
            let status: number | undefined;
            const timer = setTimeout(() => done({ ending: 'still open after 2 s', status, body }), 2_000);
            const request = get(`http://localhost:${port}/test`, (response) => {
              status = response.statusCode;
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => {
                body += chunk;
              });
              response.on('close', () => {
                clearTimeout(timer);
                done({ ending: response.complete ? 'ended' : 'cut off', status, body });
              });
            });
            request.on('error', () => {
              clearTimeout(timer);
              done({ ending: 'cut off before an answer', status, body });
            });
          });
          expect(seen, logged.join()).toEqual({ ending: 'cut off', status: 200, body: 'data: one\n\n' });
          expect(lines).toEqual(logged);
        } finally {
          server.closeAllConnections();
          server.close();
        }
      }
    });

    it('the changelog says what the handler reads and answers, word for word, under Fixed in the release to come', () => {
      const changelog = readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
      const unreleased = changelog.split('\n## [Unreleased]\n')[1]?.split('\n## [')[0] ?? '';
      const fixed = unreleased.split('\n### Fixed\n')[1]?.split('\n### ')[0] ?? '';
      expect(fixed).toContain(
        '- **The HTTP error handler answers a failure whose fields cannot be read.** It read a failure\'s `name`, `code`, `syscall`, `status` and `message` directly, so a value built in code whose field throws as it is read made the handler itself throw, and Express answered with its own error page, which outside production holds the stack and its file paths. The handler now reads each field once (V8, writing out an error\'s stack the first time it is read, reads its name and message again), and takes one that cannot be read as absent, or, for `code` and `syscall`, as a sign the failure may be a system error, whose message is never echoed. A failure is answered as JSON whatever its fields hold, and puts one line in the server log unless it is a validation error answered with its issues; one that comes after part of the response was written is handed on to Express\'s own handler, which ends the connection, as before. A status is kept where it is a whole number from 400 to 599, and any other is answered as 500; a message that is not text is answered as "Unknown error"; a stack that is not text is neither logged nor, under `NODE_ENV=development`, answered; and a validation error whose issues cannot be read through is answered as 500.',
      );
    });

    // As it was answered before: a value with no fields at all reaches the handler as itself (null and undefined do not: Express hands on an Error in their place).
    it('a value thrown that is not an object is an ordinary 500, with one line in the log', async () => {
      for (const thrown of ['a string', 42, Symbol('thrown'), 10n, true]) {
        const { status, body, lines } = await answerTo(thrown);
        expect(status, String(thrown)).toBe(500);
        expect(body.error).toBe('Internal server error');
        expect(lines).toEqual(['Request error: Unknown error']);
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
