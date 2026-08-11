import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../scripts/migrate.ts'

test('PL/pgSQL dollar-quoted bodies stay inside one migration statement', () => {
  const ddl = `
    CREATE OR REPLACE FUNCTION keep_history() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'history; cannot be deleted';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TABLE audit_log (id integer);
  `

  const statements = splitSqlStatements(ddl)

  assert.equal(statements.length, 2)
  assert.match(statements[0]!, /RAISE EXCEPTION 'history; cannot be deleted';/)
  assert.match(statements[0]!, /END IF;/)
  assert.match(statements[0]!, /\$function\$/)
  assert.equal(statements[1], 'CREATE TABLE audit_log (id integer)')
})

test('schema migration reconnects valid legacy open offers to their asset mutex', () => {
  const ddl = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  const statements = splitSqlStatements(ddl)

  for (const [table, type] of [['places', 'place'], ['things', 'thing'], ['kinds', 'kind']] as const) {
    assert.ok(statements.some(statement =>
      new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(statement) &&
      /FROM\s+transfer_offers/i.test(statement) &&
      new RegExp(`asset_type\\s*=\\s*'${type}'`, 'i').test(statement) &&
      /status\s*=\s*'open'/i.test(statement) &&
      /active_offer_id\s+IS\s+NULL/i.test(statement)
    ), `missing legacy ${type} offer backfill`)
  }
})
