import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { setEngineTransactionRunnerForTests } from '../../../src/engine.ts'
import { gazetteRuntime, taggedFor } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerMembershipLockTests(
  t: TestContext,
  database: Pool,
): Promise<void> {
  await t.test('the shared lock makes printer-first and submitter-first membership deterministic', async () => {
    const printGazetteIssuesDue = gazetteRuntime.printGazetteIssuesDue!
    setEngineTransactionRunnerForTests(null)

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
      await printGazetteIssuesDue(taggedFor(printer), '2026-09-28T16:00:00.000Z')
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
        FROM gazette_issue_entries
        WHERE issue_number = 5 AND note_id = $1
      `, [printerSecondNote.id])).rows[0].count, 0)

      await printInTransaction('2026-10-05T16:00:00.000Z')
      assert.equal((await database.query(`
        SELECT count(*)::integer AS count
        FROM gazette_issue_entries
        WHERE issue_number = 6 AND note_id = $1
      `, [printerSecondNote.id])).rows[0].count, 1)
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
      let printSettled = false
      const print = printInTransaction('2026-10-12T16:00:00.000Z')
        .finally(() => { printSettled = true })
      await delay(100)
      assert.equal(printSettled, false, 'the printer must wait for the submission lock')
      await submitter.query('COMMIT')
      await print
      assert.ok(
        submitterFirstNote.created_at < new Date('2026-10-12T16:00:00.000Z'),
        'a submitter-first note keeps the database time assigned while it held the lock',
      )
      assert.equal((await database.query(`
        SELECT count(*)::integer AS count
        FROM gazette_issue_entries
        WHERE issue_number = 7 AND note_id = $1
      `, [submitterFirstNote.id])).rows[0].count, 1)
    } catch (error) {
      await submitter.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      submitter.release()
    }
  })

}
