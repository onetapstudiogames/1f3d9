import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import type { TaggedSql } from '../../../src/engine.ts'
import { runTalkNoteAction } from '../../../src/note-action.ts'
import { iso } from '../../helpers/gazette-fixtures/postgres.ts'

export async function registerCutoffClockTests(
  t: TestContext,
  database: Pool,
  sql: TaggedSql,
): Promise<void> {
  await t.test('the locked database clock accepts a cutoff-crossing statement and returns a future retry', async () => {
    const originalCycleFunction = (await database.query<{ definition: string }>(`
      SELECT pg_get_functiondef(
        'gazette_cycle_start(timestamp with time zone)'::regprocedure
      ) AS definition
    `)).rows[0]!.definition
    await database.query(`
      CREATE TABLE gazette_boundary_test_control (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        boundary_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO gazette_boundary_test_control (boundary_at)
      VALUES (clock_timestamp() + interval '1 hour');

      CREATE OR REPLACE FUNCTION gazette_cycle_start(value TIMESTAMPTZ)
      RETURNS TIMESTAMPTZ
      LANGUAGE sql
      STABLE
      PARALLEL SAFE
      AS $$
        SELECT date_bin(interval '7 days', value, boundary_at)
        FROM gazette_boundary_test_control
        WHERE singleton
      $$;

      CREATE OR REPLACE FUNCTION pause_gazette_boundary_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        boundary_at TIMESTAMPTZ;
      BEGIN
        IF NEW.author_id = 11 AND NEW.body = 'crosses the Gazette boundary' THEN
          SELECT control.boundary_at
          INTO boundary_at
          FROM gazette_boundary_test_control control
          WHERE control.singleton;
          PERFORM pg_sleep_until(boundary_at + interval '50 milliseconds');
        END IF;
        RETURN NEW;
      END
      $$;

      CREATE TRIGGER gazette_boundary_pause
      BEFORE INSERT ON notes
      FOR EACH ROW EXECUTE FUNCTION pause_gazette_boundary_insert();
    `)

    try {
      const boundaryAt = (await database.query<{ boundary_at: Date }>(`
        UPDATE gazette_boundary_test_control
        SET boundary_at = clock_timestamp() + interval '2 seconds'
        WHERE singleton
        RETURNING boundary_at
      `)).rows[0]!.boundary_at
      await database.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
      try {
        await database.query(`
          INSERT INTO notes (place_id, author_id, body, created_at)
          VALUES
            (454, 11, 'old-cycle one', $1::timestamptz - interval '1 day'),
            (454, 11, 'old-cycle two', $1::timestamptz - interval '2 days'),
            (454, 11, 'old-cycle three', $1::timestamptz - interval '3 days')
        `, [boundaryAt])
      } finally {
        await database.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
      }

      const statementStartedAt = (await database.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      assert.ok(statementStartedAt < boundaryAt, 'the request must begin in the capped old cycle')

      const crossing = await runTalkNoteAction({
        placeId: 454,
        residentId: 11,
        residentHandle: 'gazette-boundary',
        text: 'crosses the Gazette boundary',
      }, sql)
      assert.equal(crossing.ok, true)
      if (!crossing.ok) return
      const storedAt = Date.parse(iso(crossing.note.created_at))
      assert.ok(
        storedAt >= boundaryAt.getTime(),
        'the accepted note must use the post-lock database time in the new cycle',
      )
      const pairedWriteTimes = (await database.query<{
        created_at: string
        event_at: string
      }>(`
        SELECT note.created_at::text, event.at::text AS event_at
        FROM notes note
        JOIN events event
          ON event.kind = 'note' AND event.detail->>'note_id' = note.id::text
        WHERE note.id = $1
      `, [crossing.note.id])).rows[0]!
      assert.equal(
        pairedWriteTimes.created_at,
        pairedWriteTimes.event_at,
        'the Gazette trigger-owned note clock must also reach its paired event exactly',
      )

      for (const text of ['new-cycle two', 'new-cycle three']) {
        assert.equal((await runTalkNoteAction({
          placeId: 454,
          residentId: 11,
          residentHandle: 'gazette-boundary',
          text,
        }, sql)).ok, true)
      }
      const retryAt = new Date(boundaryAt.getTime() + (7 * 24 * 60 * 60 * 1_000)).toISOString()
      const refusalObservedAt = (await database.query<{ current_time: Date }>(
        'SELECT clock_timestamp() AS current_time',
      )).rows[0]!.current_time
      const refused = await runTalkNoteAction({
        placeId: 454,
        residentId: 11,
        residentHandle: 'gazette-boundary',
        text: 'new-cycle four',
      }, sql)
      assert.deepEqual(refused, {
        ok: false,
        status: 429,
        error: '3 Gazette submissions per resident are allowed from Monday 16:00 UTC inclusive ' +
          `to the next Monday 16:00 UTC exclusive; this Gazette week's 3 submissions are used; ` +
          `retry at ${retryAt}`,
      })
      assert.ok(refusalObservedAt.getTime() < Date.parse(retryAt), 'retry must still be in the future')
      assert.deepEqual((await database.query(`
        SELECT resident.notes_today,
          count(note.id) FILTER (
            WHERE note.created_at >= $1::timestamptz
              AND note.created_at < $1::timestamptz + interval '7 days'
          )::integer AS current_cycle
        FROM residents resident
        LEFT JOIN notes note ON note.author_id = resident.id AND note.place_id = 454
        WHERE resident.id = 11
        GROUP BY resident.id
      `, [boundaryAt])).rows[0], { notes_today: 3, current_cycle: 3 })
    } finally {
      await database.query('DROP TRIGGER IF EXISTS gazette_boundary_pause ON notes')
      await database.query('DROP FUNCTION IF EXISTS pause_gazette_boundary_insert()')
      await database.query(originalCycleFunction)
      await database.query('DROP TABLE IF EXISTS gazette_boundary_test_control')
    }
  })

}
