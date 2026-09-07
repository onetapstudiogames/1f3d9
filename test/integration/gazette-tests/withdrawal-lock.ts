import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import type { TaggedSql } from '../../../src/engine.ts'
import { gazetteStoreRuntime, iso, taggedFor } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerWithdrawalLockTests(
  t: TestContext,
  database: Pool,
  printGazetteIssuesDue: (database: TaggedSql, through: string | Date) => Promise<readonly unknown[]>,
  cycle: Readonly<{ startsAt: string; endsAt: string }>,
  publicDatabase: Readonly<{ query(text: string, params?: readonly unknown[]): Promise<unknown> }>,
  waitState: (operation: Promise<unknown>) => Promise<'settled' | 'waiting'>,
): Promise<void> {
  await t.test('withdrawal-first makes the waiting printer publish the notice', async () => {
    const target = (await database.query<{ id: number; created_at: Date }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES (454, 2, 'Withdrawal-first draft.')
      RETURNING id, created_at
    `)).rows[0]!
    const withdrawal = await database.connect()
    const printer = await database.connect()
    try {
      await withdrawal.query('BEGIN')
      await withdrawal.query(`SET LOCAL statement_timeout = '5s'`)
      const command = (await withdrawal.query<{ id: number; created_at: Date }>(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES (454, 2, $1)
        RETURNING id, created_at
      `, [`WITHDRAW #${target.id}`])).rows[0]!

      await printer.query('BEGIN')
      await printer.query(`SET LOCAL statement_timeout = '5s'`)
      const print = printGazetteIssuesDue(taggedFor(printer), cycle.endsAt)
      const observedState = await waitState(print)
      await withdrawal.query('COMMIT')
      await print
      await printer.query('COMMIT')

      assert.equal(observedState, 'waiting', 'the printer must wait for the withdrawal lock')
      const stored = (await database.query<{ issue_number: number; ordinal: number }>(`
        SELECT issue_number, ordinal
        FROM gazette_issue_entries
        WHERE note_id = $1
      `, [target.id])).rows[0]!
      const issue = await gazetteStoreRuntime.readGazetteIssue!(publicDatabase, {
        issueNumber: stored.issue_number,
        afterOrdinal: null,
        limit: 200,
      })
      const entry = issue?.entries.find(candidate => candidate.note_id === target.id)
      assert.deepEqual(entry, {
        ordinal: stored.ordinal,
        note_id: target.id,
        author_id: 2,
        author: 'gazette-withdrawal-first',
        body: `note #${target.id}, withdrawn by its author before the tick`,
        created_at: iso(target.created_at),
        withdrawn: true,
        withdrawal_note_id: command.id,
        withdrawn_at: iso(command.created_at),
      })
    } catch (error) {
      await withdrawal.query('ROLLBACK').catch(() => undefined)
      await printer.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      withdrawal.release()
      printer.release()
    }
  })

  await t.test('printer-first makes the waiting withdrawal report already printed', async () => {
    const target = (await database.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES (454, 3, 'Printer-first draft.')
      RETURNING id
    `)).rows[0]!
    const printer = await database.connect()
    const withdrawal = await database.connect()
    try {
      await printer.query('BEGIN')
      await printer.query(`SET LOCAL statement_timeout = '5s'`)
      const followingTick = new Date(
        Date.parse(cycle.endsAt) + (7 * 24 * 60 * 60 * 1_000),
      ).toISOString()
      await printGazetteIssuesDue(taggedFor(printer), followingTick)

      await withdrawal.query('BEGIN')
      await withdrawal.query(`SET LOCAL statement_timeout = '5s'`)
      const command = withdrawal.query(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES (454, 3, $1)
      `, [`WITHDRAW #${target.id}`]).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const observedState = await waitState(command)
      await printer.query('COMMIT')
      const outcome = await command
      await withdrawal.query('ROLLBACK').catch(() => undefined)

      assert.equal(observedState, 'waiting', 'the withdrawal must wait for the printer lock')
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      const stored = (await database.query<{ issue_number: number }>(`
        SELECT issue_number
        FROM gazette_issue_entries
        WHERE note_id = $1
      `, [target.id])).rows[0]!
      assert.equal(
        (outcome.error as { constraint?: string }).constraint,
        'gazette_withdrawal_already_printed',
      )
      assert.equal(
        (outcome.error as { message?: string }).message,
        `Gazette submission note #${target.id} already printed in issue #${stored.issue_number} and cannot be withdrawn`,
      )
    } catch (error) {
      await printer.query('ROLLBACK').catch(() => undefined)
      await withdrawal.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      printer.release()
      withdrawal.release()
    }
  })

  await t.test('a withdrawal blocked across its tick uses the post-lock database clock', async () => {
    const target = (await database.query<{ id: number }>(`
      INSERT INTO notes (place_id, author_id, body)
      VALUES (454, 12, 'Boundary-crossing draft.')
      RETURNING id
    `)).rows[0]!
    const originalCycleFunction = (await database.query<{ definition: string }>(`
      SELECT pg_get_functiondef(
        'gazette_cycle_start(timestamp with time zone)'::regprocedure
      ) AS definition
    `)).rows[0]!.definition
    await database.query(`
      CREATE TABLE gazette_withdrawal_boundary_test_control (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        boundary_at TIMESTAMPTZ NOT NULL
      )
    `)
    const boundaryAt = (await database.query<{ boundary_at: Date }>(`
      INSERT INTO gazette_withdrawal_boundary_test_control (boundary_at)
      VALUES (clock_timestamp() + interval '2 seconds')
      RETURNING boundary_at
    `)).rows[0]!.boundary_at
    await database.query(`
      CREATE OR REPLACE FUNCTION gazette_cycle_start(value TIMESTAMPTZ)
      RETURNS TIMESTAMPTZ
      LANGUAGE sql
      STABLE
      PARALLEL SAFE
      AS $$
        SELECT boundary_at - interval '7 days'
        FROM gazette_withdrawal_boundary_test_control
        WHERE singleton
      $$
    `)

    const holder = await database.connect()
    const withdrawal = await database.connect()
    try {
      await holder.query('BEGIN')
      await holder.query(`SET LOCAL statement_timeout = '5s'`)
      await holder.query(
        'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
        [524128261, 454],
      )
      const startedAt = (await holder.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      assert.ok(startedAt < boundaryAt, 'the withdrawal request must begin before the tick')

      await withdrawal.query('BEGIN')
      await withdrawal.query(`SET LOCAL statement_timeout = '5s'`)
      const commandBody = `WITHDRAW #${target.id}`
      const command = withdrawal.query(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 12, $1, TIMESTAMPTZ '1900-01-01 00:00:00+00')
      `, [commandBody]).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      const observedState = await waitState(command)
      await holder.query(
        `SELECT pg_sleep_until($1::timestamptz + interval '50 milliseconds')`,
        [boundaryAt],
      )
      const releasedAt = (await holder.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      await holder.query('COMMIT')
      const outcome = await command
      await withdrawal.query('ROLLBACK').catch(() => undefined)

      assert.equal(observedState, 'waiting', 'the command must wait for the Gazette lock')
      assert.ok(releasedAt >= boundaryAt, 'the Gazette lock must stay held through the tick')
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(
        (outcome.error as { constraint?: string }).constraint,
        'gazette_withdrawal_tick_passed',
      )
      assert.equal(
        (outcome.error as { message?: string }).message,
        `Gazette submission note #${target.id} can be withdrawn only strictly before ${boundaryAt.toISOString()}; that print tick has passed`,
      )
      assert.deepEqual((await database.query(`
        SELECT
          (SELECT count(*)::integer FROM notes WHERE body = $1) AS command_notes,
          (SELECT count(*)::integer FROM gazette_withdrawals WHERE target_note_id = $2) AS withdrawals
      `, [commandBody, target.id])).rows[0], { command_notes: 0, withdrawals: 0 })
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await withdrawal.query('ROLLBACK').catch(() => undefined)
      holder.release()
      withdrawal.release()
      await database.query(originalCycleFunction)
      await database.query('DROP TABLE IF EXISTS gazette_withdrawal_boundary_test_control')
    }
  })
}
