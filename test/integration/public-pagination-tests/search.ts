import assert from 'node:assert/strict'
import { loadPublicSearchResults, parsePublicSearchQuery } from '../../../src/public-search.ts'
import type { PublicQueryExecutor } from '../../../src/public-pagination.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerSearchTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  function publicSearchQuery(
    query: Readonly<Record<string, readonly string[]>>,
  ) {
    const parsed = parsePublicSearchQuery(query)
    if (!parsed.ok) assert.fail(parsed.error)
    return parsed
  }

  await t.test('search exposes aligned public note, thing, and place outlines with exact totals', async () => {
    const client = await postgres.client.connect()
    await client.query('BEGIN')
    const searchExecute: PublicQueryExecutor = async (text, values) => (
      await client.query(text, [...values])
    ).rows as Record<string, unknown>[]
    try {
    const phrase = 'wave five archive quartz'
    const noteBody = `A note carrying the ${phrase} for later readers. 🏙`
    const thingBody = 'A compact object history with multibyte text. 🏙'
    const note = (await client.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES ($1, 2, $2, '2026-08-21T18:00:00.123456Z')
        RETURNING id
      `, [city.targetPlaceId, noteBody])).rows[0]!
    const thing = (await client.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
        VALUES ($1, 'Wave Five Archive Quartz', $2, 3, 3, '2026-08-21T18:00:01.123456Z')
        RETURNING id
      `, [city.targetPlaceId, thingBody])).rows[0]!
    const place = (await client.query<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id, created_at)
        VALUES ($1, 'place', 'Wave Five Archive Quartz Annex', '', 2,
          '2026-08-21T18:00:02.123456Z')
        RETURNING id
      `, [city.targetPlaceId])).rows[0]!

    const result = await loadPublicSearchResults(
      searchExecute,
      publicSearchQuery({
        q: [phrase],
        mode: ['phrase'],
        type: ['all'],
        limit: ['200'],
      }),
    )
    assert.equal(result.totalItems, 3)
    assert.equal(
      result.totalBodyBytes,
      Buffer.byteLength(noteBody, 'utf8') + Buffer.byteLength(thingBody, 'utf8'),
    )
    assert.deepEqual(
      result.items.map(item => ({ type: item.type, id: item.id })),
      [
        { type: 'place', id: place.id },
        { type: 'thing', id: thing.id },
        { type: 'note', id: note.id },
      ],
    )
    for (const item of result.items) {
      assert.equal('body' in item, false)
      assert.equal('snippet' in item, false)
      assert.equal('rank' in item, false)
    }
    const placeOutline = result.items.find(item => item.type === 'place')
    assert.deepEqual(placeOutline, {
      type: 'place',
      id: place.id,
      name: 'Wave Five Archive Quartz Annex',
      founding_name: 'Wave Five Archive Quartz Annex',
      name_history: [{
        name: 'Wave Five Archive Quartz Annex',
        started_at: '2026-08-21T18:00:02.123456Z',
        ended_at: null,
      }],
      retired_at: null,
      status: 'active',
      created_at: '2026-08-21T18:00:02.123456Z',
    })
    const wordResult = await loadPublicSearchResults(
      searchExecute,
      publicSearchQuery({ q: ['archive quartz'], mode: ['words'], type: ['all'] }),
    )
    assert.deepEqual(
      wordResult.items.map(item => ({ type: item.type, id: item.id })),
      [
        { type: 'place', id: place.id },
        { type: 'thing', id: thing.id },
        { type: 'note', id: note.id },
      ],
    )

    const moving = (await client.query<{ id: number }>(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
        VALUES ($1, 'wavefiveoldcopper', 'wavefiveoldcopper', 3, 3,
          '2026-08-21T18:00:02.123456Z')
        RETURNING id
      `, [city.targetPlaceId])).rows[0]!
    await client.query(`
        UPDATE things
        SET name = 'wavefivenewcopper', body = 'wavefivenewcopper', place_id = $1
        WHERE id = $2
      `, [city.smallPlaceId, moving.id])
    const oldState = await loadPublicSearchResults(
      searchExecute,
      publicSearchQuery({ q: ['wavefiveoldcopper'], mode: ['phrase'], type: ['thing'] }),
    )
    assert.equal(oldState.totalItems, 0, 'an edit must replace old searchable thing text')
    const movedState = await loadPublicSearchResults(
      searchExecute,
      publicSearchQuery({ q: ['wavefivenewcopper'], mode: ['phrase'], type: ['thing'] }),
    )
    assert.equal(movedState.totalItems, 1)
    assert.equal(movedState.items[0]?.id, moving.id)
    assert.equal(movedState.items[0]?.place_id, city.smallPlaceId)
    await client.query(`UPDATE things SET withdrawn_at = now() WHERE id = $1`, [moving.id])
    const withdrawnState = await loadPublicSearchResults(
      searchExecute,
      publicSearchQuery({ q: ['wavefivenewcopper'], mode: ['phrase'], type: ['thing'] }),
    )
    assert.equal(withdrawnState.totalItems, 0, 'withdrawn things must disappear before matching')

    const moderated = (await client.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES ($1, 5, 'restorablebirchtoken', '2026-08-21T18:00:03.123456Z')
        RETURNING id
      `, [city.targetPlaceId])).rows[0]!
    const findModerated = () => loadPublicSearchResults(
      searchExecute,
      publicSearchQuery({ q: ['restorablebirchtoken'], mode: ['phrase'], type: ['note'] }),
    )
    assert.equal((await findModerated()).totalItems, 1)
    await client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('note', $1, 'remove', 1, 'integration removal')
      `, [moderated.id])
    assert.equal((await findModerated()).totalItems, 0, 'removed notes must be filtered before matching')
    await client.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('note', $1, 'restore', 1, 'integration restoration')
      `, [moderated.id])
    assert.equal((await findModerated()).totalItems, 1, 'the latest restore must make the note searchable')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  await t.test('search keyset pages exhaust equal timestamps without gaps or duplicates', async () => {
    const client = await postgres.client.connect()
    await client.query('BEGIN')
    const searchExecute: PublicQueryExecutor = async (text, values) => (
      await client.query(text, [...values])
    ).rows as Record<string, unknown>[]
    try {
    const phrase = 'wavefivepagingneedle'
    await client.query(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        SELECT $1, 2, $2 || ' note ' || item_number,
          '2026-08-21T18:10:00.654321Z'::timestamptz
            + item_number * interval '1 microsecond'
        FROM generate_series(1, 4) AS item_number
      `, [city.targetPlaceId, phrase])
    await client.query(`
        INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
        SELECT $1, $2 || ' thing ' || item_number, 'paging body ' || item_number,
          3, 3, '2026-08-21T18:10:00.654321Z'::timestamptz
            + item_number * interval '1 microsecond'
        FROM generate_series(1, 3) AS item_number
      `, [city.targetPlaceId, phrase])

    const directTotals = (await client.query<{
      total_items: string
      total_body_bytes: string
    }>(`
        SELECT count(*)::text AS total_items,
          sum(octet_length(body))::text AS total_body_bytes
        FROM (
          SELECT body FROM notes WHERE strpos(lower(body), lower($1)) > 0
          UNION ALL
          SELECT body FROM things
          WHERE withdrawn_at IS NULL AND strpos(lower(name || ' ' || body), lower($1)) > 0
        ) matching
      `, [phrase])).rows[0]!
    assert.equal(directTotals.total_items, '7')

    const complete = await loadPublicSearchResults(
      searchExecute,
      publicSearchQuery({
        q: [phrase], mode: ['phrase'], type: ['all'], limit: ['200'],
      }),
    )
    assert.equal(complete.totalItems, Number(directTotals.total_items))
    assert.equal(complete.totalBodyBytes, Number(directTotals.total_body_bytes))

    const pagedItems: typeof complete.items[number][] = []
    let before: string | null = null
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await loadPublicSearchResults(
        searchExecute,
        publicSearchQuery({
          q: [phrase],
          mode: ['phrase'],
          type: ['all'],
          limit: ['2'],
          ...(before === null ? {} : { before: [before] }),
        }),
      )
      assert.equal(page.totalItems, complete.totalItems)
      assert.equal(page.totalBodyBytes, complete.totalBodyBytes)
      pagedItems.push(...page.items)
      if (!page.hasMore) break
      assert.ok(page.nextBefore, 'every nonterminal page needs an honest continuation')
      before = page.nextBefore
    }
    const identity = (item: Readonly<Record<string, unknown>>) => `${String(item.type)}:${Number(item.id)}`
    assert.deepEqual(pagedItems.map(identity), complete.items.map(identity))
    assert.equal(new Set(pagedItems.map(identity)).size, complete.totalItems)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

}
