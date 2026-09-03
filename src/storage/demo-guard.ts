import type { IStorageAdapter } from '../types/query.js';

/*
 * Demo mode must not quietly become someone's production store.
 *
 * `--demo` serves the dashboard — and with it POST /api/v1/traces — against
 * demo.db, a seeded, DISPOSABLE database that `--demo-clear` deletes
 * outright. A reader following the README top to bottom could start the
 * demo, point their capture client at the port it printed, watch real
 * traces land beside the fake ones, and later lose all of them to the
 * cleanup command the banner recommends. Nothing warned at any step.
 *
 * The guard wraps the demo store so every WRITE of trace or eval data is
 * refused with a message that says what demo mode is and where real
 * traces go. Reads and the demo's own seeded content are untouched — the
 * dashboard keeps working exactly as before. Rule deploys are not storage
 * writes (they go to the demo-scoped rule store) and stay allowed; they
 * are part of what the demo exists to show.
 *
 * Implemented as a Proxy over the adapter rather than a subclass or a
 * hand-written delegate: any method added to IStorageAdapter later
 * delegates automatically instead of silently bypassing the guard.
 */

export const DEMO_INGEST_REFUSED_MESSAGE =
  'Demo mode does not accept trace ingest. `--demo` serves a seeded, disposable database (demo.db) — ' +
  '`--demo-clear` deletes everything in it, so real traces stored here would be lost. ' +
  'Start the real server to store traces: `iris-mcp --dashboard` for HTTP ingest on POST /api/v1/traces, ' +
  'or the MCP transport for log_trace.';

const REFUSED_METHODS: ReadonlySet<keyof IStorageAdapter> = new Set<keyof IStorageAdapter>([
  'insertTrace',
  'insertSpan',
  'insertEvalResult',
]);

export class DemoIngestRefusedError extends Error {
  /** Read by the dashboard's error handler: a client fault, not a server one. */
  readonly status = 403;
  constructor() {
    super(DEMO_INGEST_REFUSED_MESSAGE);
    this.name = 'DemoIngestRefusedError';
  }
}

export function withDemoIngestGuard(storage: IStorageAdapter): IStorageAdapter {
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && REFUSED_METHODS.has(prop as keyof IStorageAdapter)) {
        return async () => {
          throw new DemoIngestRefusedError();
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      // Class methods live on the prototype and read private fields off
      // `this`; bind them to the real adapter so `this.db` resolves.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
