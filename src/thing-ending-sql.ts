// Leaf module: SQL fragments the ending modules share. It imports nothing, so
// src/thing-ending-record.ts can read it without importing src/thing-endings.ts, which
// imports src/engine.ts, which reaches the recorder again (an import cycle).

/**
 * The one SQL fragment a loader selects as first_label_at, the same subquery
 * thing_end_due_at_row runs. It reads the row under the alias `thing`. A door that only
 * needs the due time can read thing_end_due_at(id) instead.
 */
export const THING_FIRST_LABEL_AT_SQL = `(
  SELECT min(label.created_at)
  FROM active_labels AS label
  WHERE label.target_type = 'thing'
    AND label.target_id = thing.id
    AND label.label = thing.ending_label
    AND label.created_at > thing.ending_set_at
)`
