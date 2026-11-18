import type { Driver } from '../driver.js';
import { storedRowOriginSql } from '../label-rows.js';

/*
 * Whose row a label was written on (0.22.0).
 *
 * A label is written on the first row of its name on an evaluation, and the
 * labels under the name of a rule Iris ships weigh that rule's fires. Before
 * 0.22.0 a custom rule could carry such a name, and a label written on its
 * fire weighed the rule Iris ships; the tally leaves those out
 * (storage labelTallies). Whose row a label is on can be read from the
 * stored evaluation only while it is held, and the retention sweep deletes
 * evaluations after retention.days while it keeps every label. So a label
 * keeps it: written with it from 0.22.0 (routes/labels.ts), and filled here,
 * once, for every label whose evaluation is still held.
 *
 * `row_origin` is the row's `origin`, or `custom` for a row older than
 * `origin` that carries a deployed rule's `ruleId`, or NULL where the row
 * says neither or the evaluation is gone (label-rows.ts). A NULL is read
 * from the stored evaluation while it is held, as before.
 */
export const id = '024-label-row-origin';
/**
 * Every release from 0.20.0 writes and reads the labels table by naming its
 * columns, so the column is one it never sees, and a label it writes leaves
 * it NULL, which is read as above.
 */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  const has = db.prepare("SELECT 1 AS present FROM pragma_table_info('verdict_labels') WHERE name = 'row_origin'").get() !== undefined;
  if (!has) db.exec('ALTER TABLE verdict_labels ADD COLUMN row_origin TEXT');
  db.exec(`UPDATE verdict_labels SET row_origin = (${storedRowOriginSql('verdict_labels')}) WHERE rule_name IS NOT NULL AND row_origin IS NULL`);
}
