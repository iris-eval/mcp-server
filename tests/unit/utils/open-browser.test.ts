import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Opening the dashboard in a browser is a convenience: when it cannot be
 * done, the server must go on serving the address it printed.
 *
 * spawn() does not throw for a missing command. It returns a child and
 * reports ENOENT later, as an 'error' event on it, and an 'error' event
 * with no listener is rethrown by Node. On a Linux machine with no
 * xdg-open that took `--demo` down just after it printed its address.
 */

const spawned: Array<EventEmitter & { unref: () => void }> = [];

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawned.push(child);
    return child;
  }),
}));

afterEach(() => {
  spawned.length = 0;
  vi.clearAllMocks();
});

describe('openBrowser', () => {
  it('a missing opener, reported after spawn() returns, does not throw', async () => {
    const { openBrowser } = await import('../../../src/utils/open-browser.js');
    openBrowser('http://localhost:6920');
    expect(spawned).toHaveLength(1);
    const child = spawned[0];
    // What Node does for `spawn xdg-open ENOENT`: emit 'error' on the child on a later tick.
    const enoent = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
    expect(() => child.emit('error', enoent)).not.toThrow();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('spawn() throwing at once is swallowed too', async () => {
    const childProcess = await import('node:child_process');
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      throw new Error('spawn EPERM');
    });
    const { openBrowser } = await import('../../../src/utils/open-browser.js');
    expect(() => openBrowser('http://localhost:6920')).not.toThrow();
  });

  it('detaches the opener and ignores its output, so the server does not wait on a browser', async () => {
    const childProcess = await import('node:child_process');
    const { openBrowser } = await import('../../../src/utils/open-browser.js');
    openBrowser('http://localhost:6920');
    const [, args, options] = vi.mocked(childProcess.spawn).mock.calls[0];
    expect(args).toContain('http://localhost:6920');
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
  });
});
