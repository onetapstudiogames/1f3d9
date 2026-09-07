import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { setEngineTransactionRunnerForTests, type TaggedSql } from '../../../src/engine.ts'
import { runTalkNoteAction } from '../../../src/note-action.ts'
import { taggedFor } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerWriteTimeTests(
  t: TestContext,
  database: Pool,
  sql: TaggedSql,
  postgresTransactionRunner: NonNullable<Parameters<typeof setEngineTransactionRunnerForTests>[0]>,
): Promise<void> {
  await t.test('a note and its event share one write time while exact replay stays side-effect free', async t => {
    t.after(() => setEngineTransactionRunnerForTests(postgresTransactionRunner))
    setEngineTransactionRunnerForTests(async (_ignored, work) => {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_sleep(0.05)')
        const result = await work(taggedFor(client), true)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    })

    const input = {
      placeId: 455,
      residentId: 12,
      residentHandle: 'gazette-write-time',
      text: 'one clock for one public write',
    } as const
    const first = await runTalkNoteAction(input, sql)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.replayed, false)

    const stored = (await database.query<{
      created_at: string
      event_at: string
      action_created_at: string
      note_count: number
      event_count: number
      notes_today: number
    }>(`
      SELECT note.created_at::text,
        event.at::text AS event_at,
        (SELECT max(action.created_at)::text FROM action_runs action
          WHERE action.actor_id = 12 AND action.action_name = 'talk') AS action_created_at,
        (SELECT count(*)::integer FROM notes candidate
          WHERE candidate.author_id = 12 AND candidate.body = $2) AS note_count,
        (SELECT count(*)::integer FROM events candidate
          WHERE candidate.kind = 'note'
            AND candidate.detail->>'note_id' = note.id::text) AS event_count,
        resident.notes_today
      FROM notes note
      JOIN residents resident ON resident.id = note.author_id
      JOIN events event
        ON event.kind = 'note' AND event.detail->>'note_id' = note.id::text
      WHERE note.id = $1
    `, [first.note.id, input.text])).rows[0]!
    assert.equal(stored.created_at, stored.event_at, 'one logical write must expose one exact timestamp')
    assert.ok(
      Date.parse(stored.created_at) > Date.parse(stored.action_created_at),
      'an ordinary note must take its write time after the transaction began and waited',
    )
    assert.deepEqual(
      { note_count: stored.note_count, event_count: stored.event_count, notes_today: stored.notes_today },
      { note_count: 1, event_count: 1, notes_today: 1 },
    )

    const replay = await runTalkNoteAction(input, sql)
    assert.deepEqual(replay, { ok: true, note: first.note, replayed: true })
    assert.deepEqual((await database.query(`
      SELECT
        (SELECT count(*)::integer FROM notes
          WHERE author_id = 12 AND body = $1) AS note_count,
        (SELECT count(*)::integer FROM events
          WHERE kind = 'note' AND detail->>'note_id' = $2) AS event_count,
        (SELECT notes_today FROM residents WHERE id = 12) AS notes_today
    `, [input.text, String(first.note.id)])).rows[0], {
      note_count: 1,
      event_count: 1,
      notes_today: 1,
    })

    const seeded = (await database.query<{ id: number; author_id: number }>(`
      INSERT INTO notes (place_id, author_id, body, created_at)
      VALUES
        (455, 13, 'inside the replay window', statement_timestamp() - interval '4 minutes'),
        (455, 14, 'outside the replay window', statement_timestamp() - interval '6 minutes')
      RETURNING id, author_id
    `)).rows
    const insideId = seeded.find(row => row.author_id === 13)!.id
    const outsideId = seeded.find(row => row.author_id === 14)!.id

    const inside = await runTalkNoteAction({
      placeId: 455,
      residentId: 13,
      residentHandle: 'note-replay-inside',
      text: 'inside the replay window',
    }, sql)
    assert.equal(inside.ok, true)
    if (!inside.ok) return
    assert.deepEqual(
      { id: inside.note.id, replayed: inside.replayed },
      { id: insideId, replayed: true },
    )

    const outside = await runTalkNoteAction({
      placeId: 455,
      residentId: 14,
      residentHandle: 'note-replay-outside',
      text: 'outside the replay window',
    }, sql)
    assert.equal(outside.ok, true)
    if (!outside.ok) return
    assert.equal(outside.replayed, false)
    assert.notEqual(outside.note.id, outsideId)
    assert.deepEqual((await database.query(`
      SELECT
        (SELECT count(*)::integer FROM notes WHERE author_id = 13) AS inside_notes,
        (SELECT count(*)::integer FROM events
          WHERE kind = 'note' AND actor = 'note-replay-inside') AS inside_events,
        (SELECT notes_today FROM residents WHERE id = 13) AS inside_quota,
        (SELECT count(*)::integer FROM notes WHERE author_id = 14) AS outside_notes,
        (SELECT count(*)::integer FROM events
          WHERE kind = 'note' AND actor = 'note-replay-outside') AS outside_events,
        (SELECT notes_today FROM residents WHERE id = 14) AS outside_quota
    `)).rows[0], {
      inside_notes: 1,
      inside_events: 0,
      inside_quota: 0,
      outside_notes: 2,
      outside_events: 1,
      outside_quota: 1,
    })
  })

}
