/*
 * Which row of an evaluation a label stands on, and whose that row is.
 *
 * A label is written on the first row of its name on an evaluation
 * (src/dashboard/routes/labels.ts), and the labels under the name of a rule
 * Iris ships weigh that rule's fires. A row is a custom rule's when it says
 * so (`origin: "custom"`), or when it was stored before `origin` existed
 * (0.10.0) and carries a deployed rule's `ruleId`. The route reads the row it
 * has in hand; the store reads the same row back from a stored evaluation.
 */

/** Whose a row is, as a label keeps it: the row's `origin`, `custom` for a row older than `origin` that carries a deployed rule's `ruleId`, or null where it says neither. */
export function rowOriginOf(row: { origin?: string | null; ruleId?: string | null }): string | null {
  return row.origin ?? (row.ruleId != null ? 'custom' : null);
}

/**
 * The same, as SQL over the stored evaluation of the label aliased `label`:
 * its first row of the label's name, in stored order. A stored list that is
 * not a JSON list, and an element of it that is not an object, are no row,
 * as every other reader of stored rows reads them (parseRuleResults), and a
 * row is named as that reader names it: by `ruleName` where it is text, else
 * by `rule` where that is (a shape of rows written by hand; no release
 * writes it).
 */
export function storedRowOriginSql(label: string): string {
  return `SELECT CASE
             WHEN json_extract(j.value, '$.origin') IS NOT NULL THEN json_extract(j.value, '$.origin')
             WHEN json_extract(j.value, '$.ruleId') IS NOT NULL THEN 'custom'
           END
      FROM eval_results e,
           json_each(CASE WHEN json_valid(e.rule_results) AND json_type(e.rule_results) = 'array' THEN e.rule_results ELSE '[]' END) j
     WHERE e.id = ${label}.eval_id AND e.tenant_id = ${label}.tenant_id AND j.type = 'object'
       AND CASE
             WHEN json_type(j.value, '$.ruleName') = 'text' THEN json_extract(j.value, '$.ruleName')
             WHEN json_type(j.value, '$.rule') = 'text' THEN json_extract(j.value, '$.rule')
           END = ${label}.rule_name
     ORDER BY CAST(j.key AS INTEGER)
     LIMIT 1`;
}
