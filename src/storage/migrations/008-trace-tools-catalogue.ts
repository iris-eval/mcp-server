import type Database from 'better-sqlite3';

export const id = '008-trace-tools-catalogue';

/*
 * The tools the agent could have called.
 *
 * Iris has always stored what an agent DID and never what it was ABLE to do,
 * which is why argument validity has no evaluator: a call can only be judged
 * against the schema its tool declares, and nothing held that schema. The
 * catalogue is the MCP `tools/list` result verbatim — same shape, no
 * translation step — so an MCP agent pastes what it already has.
 *
 * `tools` carries the catalogue as JSON, symmetric with `tool_calls`.
 *
 * `tools_hash` is a column rather than a derived read because it answers a
 * different question cheaply: "were these two traces run against the same
 * toolset". It hashes only the parts a rule reads — the name, the input
 * schema and the read-only hint — so two catalogues differing in nothing but
 * a description hash identically. That is correct: a description edit cannot
 * change a verdict, and a hash that moved on one would make re-evaluation
 * unexplainable for a change that never mattered.
 *
 * Deliberately NOT folded into an evaluation's config or ruleset hash. Those
 * answer "which rules, under what configuration"; the catalogue is an INPUT
 * to the evaluation, like the output text. Folding it in would break the
 * invariant the (tenant, engine_version, ruleset_hash) index exists to
 * exploit — same configuration, same hash.
 *
 * Erasure needs nothing here: the catalogue lives on the traces row, which
 * delete_trace already removes, and the critical-span redactor only rewrites
 * text a detector flagged in the output.
 */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE traces ADD COLUMN tools TEXT;
    ALTER TABLE traces ADD COLUMN tools_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_tools_hash ON traces(tenant_id, tools_hash);
  `);
}
