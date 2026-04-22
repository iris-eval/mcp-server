/*
 * open-browser — minimal cross-platform browser launcher.
 *
 * Avoids the `open` npm dep so iris-mcp's install size stays small.
 * Uses the platform's default URL handler:
 *   Windows: `cmd /c start "" "<url>"`
 *   macOS:   `open "<url>"`
 *   Linux:   `xdg-open "<url>"`
 *
 * Spawns detached + ignores stdio so the iris-mcp process doesn't depend
 * on the launched browser staying alive.
 */
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'win32') {
    // The empty title argument is required so cmd treats the URL as the
    // target rather than as the window title.
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    // Linux + BSDs.
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Best-effort: if the launch fails (no browser, missing utility,
    // sandboxed environment), the dashboard is still reachable manually
    // at the URL we logged.
  }
}
