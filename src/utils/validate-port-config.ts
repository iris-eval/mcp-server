/*
 * validatePortConfig — F-006 pre-flight guard.
 *
 * If the HTTP transport and the dashboard are both enabled, they must
 * bind to different TCP ports. Without this check the MCP HTTP transport
 * wins the bind race; the dashboard's app.listen() emits EADDRINUSE to
 * an unhandled 'error' event and the process continues in a broken state
 * (every dashboard SPA request returns "Cannot GET /" from the MCP
 * handler). Users see a broken dashboard with no log indicating why.
 *
 * This check catches the misconfiguration at startup — before any port
 * is bound — so the error message is maximally actionable. The dashboard
 * server additionally attaches an 'error' listener to its own Server
 * instance as defense-in-depth; most users should never hit that path.
 *
 * Lives in its own module (not inline in src/index.ts) so tests can
 * import it without triggering the CLI's main() side effects.
 */
import type { IrisConfig } from '../types/index.js';

export function validatePortConfig(config: IrisConfig): void {
  if (
    config.transport.type === 'http' &&
    config.dashboard.enabled &&
    config.transport.port === config.dashboard.port
  ) {
    throw new Error(
      `Port collision: HTTP transport and dashboard are both configured for port ${config.transport.port}. ` +
        `Pass --dashboard-port <other> or set IRIS_DASHBOARD_PORT to a different port. ` +
        `Default dashboard port is 6920; a common pair is --port 6919 --dashboard-port 6920.`,
    );
  }
}
