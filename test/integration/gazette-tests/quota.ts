import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import type { TaggedSql } from '../../../src/engine.ts'
import { runTalkNoteAction } from '../../../src/note-action.ts'
import { gazetteRuntime } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerQuotaTests(
  t: TestContext,
  database: Pool,
  sql: TaggedSql,
): Promise<void> {
  await t.test('three submissions are allowed per resident per print week and replay spends none', async () => {
    await database.query(`
      WITH new_trait AS (
        INSERT INTO traits (name, description, recipe, coiner_id)
        VALUES (
          'gazette-quota-marker',
          'Integration proof that capped Gazette submissions roll back talk-law effects.',
          '{"talk":[{"effect":"label","target":"actor","label":"gazette-quota-effect"}]}'::jsonb,
          1
        )
        RETURNING id
      )
      INSERT INTO place_law_changes (
        place_id, trait_id, actor_id, change_type, position
      )
      SELECT 2, id, 1, 'add', 0 FROM new_trait
    `)
    const cycle = gazetteRuntime.gazetteCycleFor(new Date())
    const priorCycleNoteAt = new Date(Date.parse(cycle.startsAt) - (3 * 24 * 60 * 60 * 1_000))
    await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
    try {
      await database.query(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES
          (454, 3, 'last week one', $1),
          (454, 3, 'last week two', $1 + interval '1 second'),
          (454, 3, 'last week three', $1 + interval '2 seconds')
      `, [priorCycleNoteAt])
    } finally {
      await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
    }
    const submit = (residentId: number, residentHandle: string, text: string) => (
      runTalkNoteAction({ placeId: 454, residentId, residentHandle, text }, sql)
    )

    const first = await submit(3, 'gazette-capped', 'this week one')
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.replayed, false)
    const replay = await submit(3, 'gazette-capped', 'this week one')
    assert.deepEqual(replay, { ok: true, note: first.note, replayed: true })
    assert.equal((await submit(3, 'gazette-capped', 'this week two')).ok, true)
    assert.equal((await submit(3, 'gazette-capped', 'this week three')).ok, true)

    const capped = await submit(3, 'gazette-capped', 'this week four')
    assert.equal(capped.ok, false)
    if (capped.ok) return
    assert.equal(capped.status, 429)
    assert.equal(
      capped.error,
      '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive ' +
        `to the next Monday 16:00 UTC exclusive; this Gazette week's 3 submissions are used; ` +
        `retry at ${cycle.endsAt}`,
    )

    assert.equal((await submit(5, 'gazette-neighbor', 'my independent first')).ok, true)
    const quota = (await database.query<{
      notes_today: number
      weekly: number
      law_effects: number
    }>(`
      SELECT resident.notes_today,
        (count(note.id) FILTER (
          WHERE note.place_id = 454
            AND note.created_at >= $1
            AND note.created_at < $2
        ))::integer AS weekly,
        (SELECT count(*)::integer
          FROM active_labels
          WHERE target_type = 'resident'
            AND target_id = resident.id
            AND label = 'gazette-quota-effect'
        ) AS law_effects
      FROM residents resident
      LEFT JOIN notes note ON note.author_id = resident.id
      WHERE resident.id = 3
      GROUP BY resident.id
    `, [cycle.startsAt, cycle.endsAt])).rows[0]!
    assert.deepEqual(quota, { notes_today: 3, weekly: 3, law_effects: 3 })

    const raced = await Promise.all([
      submit(6, 'gazette-racer', 'concurrent one'),
      submit(6, 'gazette-racer', 'concurrent two'),
      submit(6, 'gazette-racer', 'concurrent three'),
      submit(6, 'gazette-racer', 'concurrent four'),
    ])
    assert.equal(raced.filter(result => result.ok).length, 3)
    const refused = raced.filter(result => !result.ok)
    assert.equal(refused.length, 1)
    assert.deepEqual(refused[0], {
      ok: false,
      status: 429,
      error: '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive ' +
        `to the next Monday 16:00 UTC exclusive; this Gazette week's 3 submissions are used; ` +
        `retry at ${cycle.endsAt}`,
    })
    const racedQuota = (await database.query<{
      notes_today: number
      weekly: number
      law_effects: number
    }>(`
      SELECT resident.notes_today,
        count(note.id) FILTER (
          WHERE note.place_id = 454
            AND note.created_at >= $1
            AND note.created_at < $2
        )::integer AS weekly,
        (SELECT count(*)::integer
          FROM active_labels
          WHERE target_type = 'resident'
            AND target_id = resident.id
            AND label = 'gazette-quota-effect'
        ) AS law_effects
      FROM residents resident
      LEFT JOIN notes note ON note.author_id = resident.id
      WHERE resident.id = 6
      GROUP BY resident.id
    `, [cycle.startsAt, cycle.endsAt])).rows[0]!
    assert.deepEqual(racedQuota, { notes_today: 3, weekly: 3, law_effects: 3 })

    await database.query(`
      INSERT INTO place_law_changes (
        place_id, trait_id, actor_id, change_type, position
      )
      SELECT 2, id, 1, 'remove', NULL
      FROM traits
      WHERE name = 'gazette-quota-marker'
    `)
  })

}
