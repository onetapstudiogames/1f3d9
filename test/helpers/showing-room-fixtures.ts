import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { TestContext } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import type { TaggedSql } from '../../src/engine.ts'
import { activationDdl, schemaDdl, startPostgres, withdrawalActivationDdl } from './gazette-fixtures/postgres.ts'

function localClock(text: string): string {
  return text.replace(/\bclock_timestamp\(\)/gu, 'showing_test_clock()')
    .replace(/\bstatement_timestamp\(\)/gu, 'showing_test_statement_clock()')
    .replace(/\bnow\(\)/gu, 'showing_test_transaction_clock()')
}

export function showingSql(queryable: Pool | PoolClient): TaggedSql {
  const sql = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const statement = strings.reduce((query, part, index) => (
      query + part + (index < values.length ? `$${index + 1}` : '')
    ), '')
    return (await queryable.query(localClock(statement), [...values])).rows
  }) as TaggedSql
  sql.query = async (statement, values = []) => (
    await queryable.query(localClock(statement), [...values])
  ).rows
  return sql
}

export async function createShowingRoomFixture(t: TestContext) {
  const { setEngineTransactionRunnerForTests } = await import('../../src/engine.ts')
  const { database, containerName } = await startPostgres()
  const migration = await readFile(new URL('../../db/migrations/20261027_showing_room.sql', import.meta.url), 'utf8')
  const transaction = async <T>(work: (sql: TaggedSql) => Promise<T>): Promise<T> => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout = '8s'")
      const result = await work(showingSql(client))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  setEngineTransactionRunnerForTests((_database, work) => transaction(sql => work(sql, true)))
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end()
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8', windowsHide: true })
  })
  const setClock = async (instant: string) => {
    await database.query(`UPDATE showing_test_clock_control
      SET clock_offset = $1::timestamptz - clock_timestamp()`, [instant])
  }
  const reset = async (instant = '2026-11-09T15:05:00.000Z') => {
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await database.query(`
      CREATE TABLE showing_test_clock_control (clock_offset INTERVAL NOT NULL);
      INSERT INTO showing_test_clock_control VALUES (interval '0 seconds');
      CREATE FUNCTION showing_test_clock() RETURNS TIMESTAMPTZ LANGUAGE sql VOLATILE AS $$
        SELECT clock_timestamp() + clock_offset FROM showing_test_clock_control
      $$;
      CREATE FUNCTION showing_test_statement_clock() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
        SELECT statement_timestamp() + clock_offset FROM showing_test_clock_control
      $$;
      CREATE FUNCTION showing_test_transaction_clock() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
        SELECT now() + clock_offset FROM showing_test_clock_control
      $$;
    `)
    await setClock(instant)
    await database.query(localClock(schemaDdl.replace(migration, '')))
    await database.query(localClock(migration))
    await database.query(`
      INSERT INTO residents (id,handle,model,secret_hash) VALUES
        (1,'founder','showing-test',repeat('1',64)),
        (2,'second-founder','showing-test',repeat('2',64)),
        (11,'entry-one','showing-test',repeat('3',64)),
        (12,'entry-two','showing-test',repeat('4',64)),
        (13,'voter','showing-test',repeat('5',64));
      INSERT INTO places (id,parent_id,place_kind,name,description,owner_id,
        open_to_building,open_to_things,open_to_notes)
      SELECT 2,id,'continent','synthetic continent','Synthetic test continent.',1,
        FALSE,FALSE,FALSE FROM places WHERE place_kind='world';
      INSERT INTO places (id,parent_id,place_kind,name,description,owner_id,
        open_to_building,open_to_things,open_to_notes) VALUES
        (3,2,'place','the square','Synthetic public square.',1,FALSE,FALSE,TRUE),
        (438,2,'place','the showing room','The founder updates this after deployment.',1,FALSE,FALSE,TRUE),
        (454,2,'place','the gazette submission room',
          'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
          1,FALSE,FALSE,FALSE);
      INSERT INTO resident_presence(resident_id,current_place_id,home_place_id)
        SELECT id,438,438 FROM residents;
    `)
    await database.query(localClock(activationDdl))
    await database.query(localClock(withdrawalActivationDdl))
    await database.query("SELECT activate_showing_room_service(repeat('a',40))")
    await database.query(`UPDATE showing_room_control SET enabled=TRUE,paused=FALSE,
      first_slot_at='2026-11-02 15:00Z',first_question_number=11 WHERE id=1`)
  }
  return { database, sql: showingSql(database), transaction, reset, setClock }
}
