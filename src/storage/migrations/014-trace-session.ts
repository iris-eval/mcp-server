import type { Driver } from '../driver.js';

/*
 * Sessions (arc 9, N-15).
 *
 * A trace is one turn; a conversation is many. Until now the id that ties
 * them together rode in metadata, where nothing could filter on it and the
 * trace drawer could not show the other turns. It is a column now, with the
 * index the two reads take: the turns of one session, in time order, and
 * "is this trace part of a session at all". Filled from an explicit
 * `session_id` on log_trace or POST /api/v1/traces, from
 * `gen_ai.conversation.id` on the OTLP door, or from the SEP-414 baggage
 * `session_id` when a request carried one and named nothing else.
 */
export const id = '014-trace-session';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE traces ADD COLUMN session_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_session ON traces(tenant_id, session_id, timestamp);
  `);
}
