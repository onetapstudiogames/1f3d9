import assert from 'node:assert/strict'
import { registerPublicPaginationTests } from '../helpers/public-pagination-fixtures/postgres.ts'

type CensusPage = Readonly<{
  residents: readonly Readonly<{ id: number }>[]
  count: number
  total: number
  returned: number
  page_size: number
  has_more: boolean
  next_before_id: number | null
  hidden_by_your_mutes?: number
  hidden_items?: readonly Readonly<{ id: number; type: string }>[]
}>

registerPublicPaginationTests(async (t, postgres, city) => {
  const { default: cityApp } = await import('../../src/index.ts')
  const { newSecret, sha256 } = await import('../../src/core.ts')
  const highestId = (await postgres.client.query<{ id: number }>(
    'SELECT max(id) AS id FROM residents',
  )).rows[0]!.id
  assert.equal((await postgres.client.query('SELECT id FROM residents WHERE id = 4')).rowCount, 0)

  const readerSecret = newSecret()
  await postgres.client.query('UPDATE residents SET secret_hash = $1 WHERE id = 6', [
    sha256(readerSecret),
  ])
  await postgres.client.query(`
    INSERT INTO resident_mutes (resident_id, target_type, target_id, choice)
    VALUES (6, 'resident', 3, 'mute')
  `)

  const readPage = async (
    view: string, cursor: number | null, limit = 3, signedIn = false,
  ): Promise<CensusPage> => {
    const query = new URLSearchParams({ limit: String(limit), hidden: 'outline' })
    if (view) query.set('view', view)
    if (cursor !== null) query.set('before_id', String(cursor))
    const response = await cityApp.request(`http://city.test/api/residents?${query}`, {
      headers: signedIn ? { Authorization: `Bearer ${readerSecret}` } : {},
    })
    assert.equal(response.status, 200)
    const body = await response.json() as CensusPage
    assert.equal(body.count, city.residentCount)
    assert.equal(body.total, city.residentCount)
    assert.equal(body.returned, body.residents.length)
    assert.equal(body.page_size, limit)
    return body
  }

  for (const view of ['', 'presence']) {
    await t.test(`${view || 'census'} starts a missing cursor at the nearest lower resident`, async () => {
      const missing = await readPage(view, 4)
      assert.deepEqual(missing.residents.map(row => row.id), [3, 2, 1])
      assert.equal(missing.has_more, false)
      assert.equal(missing.next_before_id, null)
      const existing = await readPage(view, 5)
      assert.deepEqual(missing, existing)

      const first = await readPage(view, 4, 2)
      assert.deepEqual(first.residents.map(row => row.id), [3, 2])
      assert.equal(first.has_more, true)
      assert.equal(first.next_before_id, 2)
      const last = await readPage(view, first.next_before_id, 2)
      assert.deepEqual(last.residents.map(row => row.id), [1])
      assert.equal(last.has_more, false)
      assert.equal(last.next_before_id, null)
    })

    await t.test(`${view || 'census'} returns the newest page below a cursor beyond every resident`, async () => {
      const newest = await readPage(view, null)
      assert.deepEqual(newest.residents.map(row => row.id), [highestId, highestId - 1, highestId - 2])
      assert.equal(newest.has_more, true)
      assert.equal(newest.next_before_id, highestId - 2)
      for (const cursor of [highestId + 1, 9999]) {
        assert.deepEqual(await readPage(view, cursor), newest)
      }
    })

    await t.test(`${view || 'census'} preserves existing and exhausted boundaries`, async () => {
      const older = await readPage(view, 3)
      assert.deepEqual(older.residents.map(row => row.id), [2, 1])
      assert.equal(older.has_more, false)
      assert.equal(older.next_before_id, null)
      const exhausted = await readPage(view, 1)
      assert.deepEqual(exhausted.residents, [])
      assert.equal(exhausted.has_more, false)
      assert.equal(exhausted.next_before_id, null)
    })
  }

  await postgres.client.query(`
    UPDATE residents SET joined_at = CASE id
      WHEN 3 THEN '2026-10-04T00:00:00Z'::timestamptz
      WHEN 5 THEN '2026-10-03T00:00:00Z'::timestamptz
      WHEN 2 THEN '2026-10-02T00:00:00Z'::timestamptz
      WHEN 1 THEN '2026-10-01T00:00:00Z'::timestamptz
      ELSE '2026-10-05T00:00:00Z'::timestamptz END
  `)
  for (const view of ['', 'presence']) {
    await t.test(`${view || 'census'} refills the missing cursor in arrival order after a mute`, async () => {
      const anonymous = await readPage(view, 4, 1)
      assert.deepEqual(anonymous.residents.map(row => row.id), [3])
      assert.equal(anonymous.has_more, true)
      assert.equal(anonymous.next_before_id, 3)
      const muted = await readPage(view, 4, 1, true)
      assert.deepEqual(muted.residents.map(row => row.id), [5])
      assert.equal(muted.hidden_by_your_mutes, 1)
      assert.deepEqual(muted.hidden_items?.map(row => [row.type, row.id]), [['resident', 3]])
      assert.equal(muted.has_more, true)
      assert.equal(muted.next_before_id, 5)
      const wider = await readPage(view, 4, 2, true)
      assert.deepEqual(wider.residents.map(row => row.id), [5, 2])
      assert.equal(wider.hidden_by_your_mutes, 1)
      assert.equal(wider.has_more, true)
      assert.equal(wider.next_before_id, 2)
    })

    for (const signedIn of [false, true]) {
      for (const limit of [1, 2, 3]) {
        await t.test(`${view || 'census'} walks a missing cursor in arrival order at limit ${limit}, signed in ${signedIn}`, async () => {
          const expected = signedIn ? [5, 2, 1] : [3, 5, 2, 1]
          let cursor = 4
          let visited: readonly number[] = []
          for (let offset = 0; offset < expected.length; offset += limit) {
            const page = await readPage(view, cursor, limit, signedIn)
            const ids = page.residents.map(row => row.id)
            assert.deepEqual(ids, expected.slice(offset, offset + limit))
            visited = [...visited, ...ids]
            const hasMore = offset + limit < expected.length
            assert.equal(page.has_more, hasMore)
            assert.equal(page.next_before_id, hasMore ? ids.at(-1) : null)
            if (signedIn) assert.equal(page.hidden_by_your_mutes, offset === 0 ? 1 : 0)
            if (page.next_before_id !== null) cursor = page.next_before_id
          }
          assert.deepEqual(visited, expected)
          assert.equal(new Set(visited).size, visited.length)
        })
      }
    }

    await t.test(`${view || 'census'} breaks arrival ties by id at a missing cursor`, async () => {
      await postgres.client.query("UPDATE residents SET joined_at = '2026-10-04T00:00:00Z' WHERE id = 5")
      try {
        const missing = await readPage(view, 4)
        assert.deepEqual(missing.residents.map(row => row.id), [3, 2, 1])
        assert.equal(missing.has_more, false)
        assert.equal(missing.next_before_id, null)
        assert.deepEqual((await readPage(view, 3)).residents.map(row => row.id), [2, 1])
      } finally {
        await postgres.client.query("UPDATE residents SET joined_at = '2026-10-03T00:00:00Z' WHERE id = 5")
      }
    })

    await t.test(`${view || 'census'} chooses the nearest lower id even when another lower id arrived later`, async () => {
      await postgres.client.query("UPDATE residents SET joined_at = '2026-10-05T00:00:00Z' WHERE id = 2")
      try {
        const missing = await readPage(view, 4)
        assert.deepEqual(missing.residents.map(row => row.id), [3, 5, 1])
        assert.equal(missing.has_more, false)
        assert.equal(missing.next_before_id, null)
      } finally {
        await postgres.client.query("UPDATE residents SET joined_at = '2026-10-02T00:00:00Z' WHERE id = 2")
      }
    })

    await t.test(`${view || 'census'} starts above every id at the highest id even if it arrived earlier`, async () => {
      await postgres.client.query("UPDATE residents SET joined_at = '2026-10-02T12:00:00Z' WHERE id = $1", [highestId])
      try {
        const missing = await readPage(view, highestId + 1)
        assert.deepEqual(missing.residents.map(row => row.id), [highestId, 2, 1])
        assert.equal(missing.has_more, false)
        assert.equal(missing.next_before_id, null)
        assert.deepEqual((await readPage(view, highestId)).residents.map(row => row.id), [2, 1])
      } finally {
        await postgres.client.query("UPDATE residents SET joined_at = '2026-10-05T00:00:00Z' WHERE id = $1", [highestId])
      }
    })
  }

  // Give the other catalogues both real rows and unused IDs to probe.
  await postgres.client.query(`
    INSERT INTO traits (id, name, description, coiner_id)
    SELECT id, 'cursor_trait_' || id, 'Cursor trait', 1 FROM unnest(ARRAY[1, 3, 5]) id;
    WITH inserted AS (
      INSERT INTO kinds (id, name, owner_id)
      SELECT id, 'cursor_kind_' || id, 1 FROM unnest(ARRAY[1, 3, 5]) id RETURNING id
    )
    INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
    SELECT id, 1, 'Cursor kind', ARRAY[]::text[], '[]'::jsonb FROM inserted;
    INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, reason)
    SELECT id, 'resident', 1, 'restore', 1, 'Cursor record' FROM unnest(ARRAY[1, 3, 5]) id;
  `)
  await postgres.client.query(`
    INSERT INTO room_lines (id, place_id, resident_id, body, body_bytes, request_id)
    SELECT id, $1, 1, 'Cursor line', 11, gen_random_uuid() FROM unnest(ARRAY[1, 3, 5]) id
  `, [city.targetPlaceId])

  const catalogues = [
    { path: '/api/kinds', key: 'kinds', gap: 4 },
    { path: '/api/traits', key: 'traits', gap: 4 },
    { path: '/api/moderation', key: 'moderation', gap: 4 },
    { path: '/api/agreements', key: 'agreements', gap: null },
    { path: '/api/events', key: 'events', gap: null },
    { path: '/api/window?collection=notes', key: 'notes', gap: null },
    { path: '/api/window?collection=things', key: 'things', gap: null },
    { path: '/api/window?collection=agreements', key: 'agreements', gap: null },
    { path: '/api/window?collection=lines', key: 'lines', gap: 4 },
  ] as const
  for (const catalogue of catalogues) {
    await t.test(`${catalogue.path} already accepts unused numeric boundaries`, async () => {
      const read = async (cursor: number | null) => {
        const url = new URL(catalogue.path, 'http://city.test')
        url.searchParams.set('limit', '1')
        if (cursor !== null) url.searchParams.set('before_id', String(cursor))
        const response = await cityApp.request(url.href)
        assert.equal(response.status, 200)
        const body = await response.json() as Record<string, unknown>
        return {
          ids: (body[catalogue.key] as { id: number }[]).map(row => Number(row.id)),
          hasMore: body.has_more,
          next: body.next_before_id,
        }
      }
      const newest = await read(null)
      assert.equal(newest.ids.length, 1, 'probe a populated catalogue')
      assert.equal(newest.hasMore, true)
      assert.equal(Number(newest.next), newest.ids[0])
      assert.deepEqual(await read(2_147_483_647), newest)
      if (catalogue.gap !== null) {
        const gap = await read(catalogue.gap)
        assert.deepEqual(gap.ids, [3])
        assert.equal(gap.hasMore, true)
        assert.equal(Number(gap.next), 3)
        const last = await read(3)
        assert.deepEqual(last.ids, [1])
        assert.equal(last.hasMore, false)
        assert.equal(last.next, null)
      }
    })
  }
})
