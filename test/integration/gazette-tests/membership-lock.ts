import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { setEngineTransactionRunnerForTests } from '../../../src/engine.ts'
import { GAZETTE_WEEK_MILLISECONDS } from '../../../src/gazette-schedule.ts'
import { gazetteRuntime, taggedFor } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerMembershipLockTests(
  t: TestContext,
  database: Pool,
): Promise<void> {
  await t.test('the shared lock makes printer-first and submitter-first membership deterministic', async () => {
    const printGazetteIssuesDue = gazetteRuntime.printGazetteIssuesDue!
    setEngineTransactionRunnerForTests(null)
    const databaseNow = (await database.query<{ current_time: Date }>(
      'SELECT clock_timestamp() AS current_time',
    )).rows[0]!.current_time
    const printerFirstCutoff = gazetteRuntime.gazetteCycleFor(databaseNow).startsAt

    const printInTransaction = async (through: string): Promise<void> => {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await printGazetteIssuesDue(taggedFor(client), through)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }

    const printer = await database.connect()
    try {
      await printer.query('BEGIN')
      await printGazetteIssuesDue(taggedFor(printer), printerFirstCutoff)
      let printerSecondSettled = false
      const printerSecond = database.query<{ id: number; created_at: Date }>(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES (454, 8, 'printer-first lock order')
        RETURNING id, created_at
      `).finally(() => { printerSecondSettled = true })
      await delay(100)
      assert.equal(printerSecondSettled, false, 'the note must wait for the printer lock')
      const printerReleaseFloor = (await printer.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      await printer.query('COMMIT')
      const printerSecondNote = (await printerSecond).rows[0]!
      assert.ok(
        printerSecondNote.created_at >= printerReleaseFloor,
        'a printer-first note receives its database time only after the printer releases the lock',
      )
      assert.equal((await database.query(`
        SELECT count(*)::integer AS count
        FROM gazette_issue_entries entry
        JOIN gazette_issues issue USING (issue_number)
        WHERE issue.scheduled_for = $1::timestamptz AND entry.note_id = $2
      `, [printerFirstCutoff, printerSecondNote.id])).rows[0].count, 0)

      const printerNextCutoff = gazetteRuntime.gazetteCycleFor(printerSecondNote.created_at).endsAt
      await printInTransaction(printerNextCutoff)
      assert.deepEqual((await database.query(`
        SELECT count(*)::integer AS count,
          count(*) FILTER (WHERE issue.scheduled_for = $1::timestamptz)::integer AS selected_issue
        FROM gazette_issue_entries entry
        JOIN gazette_issues issue USING (issue_number)
        WHERE entry.note_id = $2
      `, [printerNextCutoff, printerSecondNote.id])).rows[0], { count: 1, selected_issue: 1 })
    } catch (error) {
      await printer.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      printer.release()
    }

    const submitter = await database.connect()
    try {
      await submitter.query('BEGIN')
      const submitterFirstNote = (await submitter.query<{ id: number; created_at: Date }>(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES (454, 9, 'submitter-first lock order')
        RETURNING id, created_at
      `)).rows[0]!
      const latestPrintedAt = (await submitter.query<{ scheduled_for: Date }>(`
        SELECT scheduled_for FROM gazette_issues ORDER BY issue_number DESC LIMIT 1
      `)).rows[0]!.scheduled_for
      // The first scenario may have simulated printing the current week's future slot.
      // This note must enter its next unprinted eligible slot, preserving the real DB clock.
      const submitterPrintCutoff = new Date(Math.max(
        Date.parse(gazetteRuntime.gazetteCycleFor(submitterFirstNote.created_at).endsAt),
        latestPrintedAt.getTime() + GAZETTE_WEEK_MILLISECONDS,
      )).toISOString()
      let printSettled = false
      const print = printInTransaction(submitterPrintCutoff)
        .finally(() => { printSettled = true })
      await delay(100)
      assert.equal(printSettled, false, 'the printer must wait for the submission lock')
      await submitter.query('COMMIT')
      await print
      assert.ok(
        submitterFirstNote.created_at < new Date(submitterPrintCutoff),
        'a submitter-first note keeps the database time assigned while it held the lock',
      )
      assert.deepEqual((await database.query(`
        SELECT count(*)::integer AS count,
          count(*) FILTER (WHERE issue.scheduled_for = $1::timestamptz)::integer AS selected_issue,
          count(*) FILTER (WHERE issue.scheduled_for = $2::timestamptz)::integer AS preceding_issue
        FROM gazette_issue_entries entry
        JOIN gazette_issues issue USING (issue_number)
        WHERE entry.note_id = $3
      `, [submitterPrintCutoff, latestPrintedAt, submitterFirstNote.id])).rows[0], {
        count: 1, selected_issue: 1, preceding_issue: 0,
      })
    } catch (error) {
      await submitter.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      submitter.release()
    }
  })

}
