import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerTotalsAndCatalogsTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('counter triggers stay exact across edits, moves, withdrawals, and concurrent notes', async () => {
    const childId = city.expected.subplaces[0]!
    const thingId = city.expected.things[0]!
    await postgres.client.query(
      `UPDATE places SET description = description || ' edited 🏙' WHERE id = $1`,
      [childId],
    )
    await postgres.client.query(
      `UPDATE things SET body = body || ' edited 🏙' WHERE id = $1`,
      [thingId],
    )
    await Promise.all([
      postgres.client.query(
        `INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'parallel one 🏙')`,
        [childId],
      ),
      postgres.client.query(
        `INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'parallel two 🏙')`,
        [childId],
      ),
    ])
    const movingThings = (await postgres.client.query<{ id: number; place_id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id)
        VALUES ($1, 'opposite move a', 'move a 🏙', 1, 1),
          ($2, 'opposite move b', 'move b 🏙', 1, 1)
        RETURNING id, place_id
      `, [city.targetPlaceId, childId])).rows
    await postgres.client.query(`
        CREATE OR REPLACE FUNCTION wave_one_pause_counter_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(0.1);
          RETURN NEW;
        END$$;
        CREATE TRIGGER wave_one_pause_counter_update
        AFTER UPDATE OF thing_items ON place_reading_totals
        FOR EACH ROW
        WHEN (OLD.thing_items IS DISTINCT FROM NEW.thing_items)
        EXECUTE FUNCTION wave_one_pause_counter_update();
      `)
    let oppositeMoves: PromiseSettledResult<unknown>[]
    try {
      oppositeMoves = await Promise.allSettled([
        postgres.client.query(
          `UPDATE things SET place_id = $1 WHERE id = $2`,
          [childId, movingThings.find(row => row.place_id === city.targetPlaceId)?.id],
        ),
        postgres.client.query(
          `UPDATE things SET place_id = $1 WHERE id = $2`,
          [city.targetPlaceId, movingThings.find(row => row.place_id === childId)?.id],
        ),
      ])
    } finally {
      await postgres.client.query(`
          DROP TRIGGER wave_one_pause_counter_update ON place_reading_totals;
          DROP FUNCTION wave_one_pause_counter_update();
        `)
    }
    assert.deepEqual(
      oppositeMoves.map(result => result.status),
      ['fulfilled', 'fulfilled'],
      'opposite room moves must not deadlock their counter rows',
    )
    await postgres.client.query(`UPDATE things SET place_id = $1 WHERE id = $2`, [childId, thingId])
    await postgres.client.query(`UPDATE things SET withdrawn_at = now() WHERE id = $1`, [thingId])

    for (const placeId of [city.targetPlaceId, childId]) {
      const totals = (await postgres.client.query<Record<string, string>>(
        `SELECT * FROM place_reading_totals WHERE place_id = $1`,
        [placeId],
      )).rows[0]!
      const recomputed = (await postgres.client.query<Record<string, string>>(`
          SELECT
            (SELECT count(*) FROM places WHERE parent_id = $1) AS subplace_items,
            (SELECT coalesce(sum(octet_length(description)), 0) FROM places WHERE parent_id = $1) AS subplace_text_bytes,
            (SELECT count(*) FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_items,
            (SELECT coalesce(sum(octet_length(body)), 0) FROM things WHERE place_id = $1 AND withdrawn_at IS NULL) AS thing_text_bytes,
            (SELECT count(*) FROM notes WHERE place_id = $1) AS note_items,
            (SELECT coalesce(sum(octet_length(body)), 0) FROM notes WHERE place_id = $1) AS note_text_bytes
        `, [placeId])).rows[0]!
      for (const field of [
        'subplace_items', 'subplace_text_bytes', 'thing_items',
        'thing_text_bytes', 'note_items', 'note_text_bytes',
      ]) {
        assert.equal(Number(totals[field]), Number(recomputed[field]), `${placeId}:${field}`)
      }
    }
  })

  await t.test('the live survey note count is exact and parallel to the thing count', async () => {
    const { readPublicLiveSurvey } = await import('../../../src/public-live-survey.ts')
    const placeId = city.expected.subplaces[0]!

    const before = (await readPublicLiveSurvey())
      .find(place => place.id === placeId)
    assert.ok(before, 'the seeded child place is present in the live survey')

    const authorId = (
      await postgres.client.query<{ id: number }>('SELECT id FROM residents ORDER BY id LIMIT 1')
    ).rows[0]?.id
    assert.ok(authorId, 'a seeded resident exists to author the exact-count notes')
    await postgres.client.query(
      `INSERT INTO notes (place_id, author_id, body) VALUES
           ($1, $2, 'live survey exact-count note one 🏙'),
           ($1, $2, 'live survey exact-count note two 🏙')`,
      [placeId, authorId],
    )

    const after = (await readPublicLiveSurvey())
      .find(place => place.id === placeId)
    assert.ok(after, 'the seeded child place remains in the live survey')
    assert.equal(after?.notes, (before?.notes ?? 0) + 2, 'two new notes raise the exact survey count by exactly two')
    assert.equal(after?.things, before?.things, 'adding notes leaves the parallel exact thing count untouched')

    const recomputedNotes = (
      await postgres.client.query<{ count: string }>(
        'SELECT count(*) FROM notes WHERE place_id = $1',
        [placeId],
      )
    ).rows[0]?.count
    assert.equal(after?.notes, Number(recomputedNotes), 'the survey note count matches a direct recount')
  })

  await t.test('catalog pages report exact authored-text totals from real PostgreSQL', async () => {
    await postgres.client.query(`
        INSERT INTO traits (name, description, coiner_id)
        VALUES ('wave_one_trait', 'trait text 🏙', 1)
      `)
    await postgres.client.query(`
        WITH kind AS (
          INSERT INTO kinds (name, owner_id)
          VALUES ('wave_one_kind', 1)
          RETURNING id
        )
        INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
        SELECT id, 1, 'kind text 🏙', ARRAY['wave_one_trait'], '[]'::jsonb
        FROM kind
      `)
    await postgres.client.query(
      `INSERT INTO moderation_actions (
           target_type, target_id, action, actor_id, reason
         ) VALUES ('note', $1, 'remove', 1, 'reason text 🏙')`,
      [city.expected.notes[0]],
    )

    const { default: cityApp } = await import('../../../src/index.ts')
    const cases = [
      { path: '/api/events?limit=1', key: 'events', table: 'events', expression: "coalesce(detail->>'body', '') || coalesce(detail->>'description', '') || coalesce(detail->>'reason', '')" },
      { path: '/api/kinds?limit=1', key: 'kinds', table: 'kinds JOIN kind_revisions revision ON revision.kind_id = kinds.id AND revision.revision = kinds.current_revision', expression: 'revision.description' },
      { path: '/api/traits?limit=1', key: 'traits', table: 'traits', expression: 'description' },
      { path: '/api/agreements?limit=1', key: 'agreements', table: 'agreements', expression: 'body' },
      { path: '/api/moderation?limit=1', key: 'moderation', table: 'moderation_actions', expression: 'reason' },
    ] as const

    for (const entry of cases) {
      const expected = (await postgres.client.query<{ items: string; text_bytes: string }>(
        `SELECT count(*) AS items,
             coalesce(sum(octet_length(${entry.expression})), 0) AS text_bytes
           FROM ${entry.table}`,
      )).rows[0]!
      const response = await cityApp.request(`http://city.test${entry.path}`)
      assert.equal(response.status, 200, entry.path)
      const body = await response.json() as Record<string, unknown>
      const rows = body[entry.key] as Array<Record<string, unknown>>
      assert.equal(body.total_items, Number(expected.items), `${entry.key}:items`)
      assert.equal(body.total_text_bytes, Number(expected.text_bytes), `${entry.key}:bytes`)
      assert.equal(body.returned_items, rows.length, `${entry.key}:returned`)
      assert.equal(body.has_more, Number(expected.items) > rows.length, `${entry.key}:has_more`)
    }
  })

}
