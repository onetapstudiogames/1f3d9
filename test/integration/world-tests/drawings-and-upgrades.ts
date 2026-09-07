import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerDrawingsAndUpgradesTests(
  t: TestContext,
  {
    app, bearer, database, founderSecret, resetDatabase,
  }: Pick<WorldTestContext,
    | 'app' | 'bearer' | 'database' | 'founderSecret' | 'resetDatabase'
  > ,
  runThingUpgradePreflightTest: () => Promise<void>,
): Promise<void> {
  await t.test('fresh schema attributes the exact world drawing to the founder once', async () => {
    await resetDatabase()
    const history = await database!.query(`
        SELECT revision.prior_state, revision.prior_description,
          revision.prior_drawing, revision.prior_source,
          revision.current_state, revision.current_description,
          revision.current_drawing = place.drawing AS exact_current_drawing,
          revision.current_source, revision.author_id, revision.author_relation
        FROM places place
        JOIN drawing_revisions revision
          ON revision.target_type = 'place' AND revision.target_id = place.id
        WHERE place.place_kind = 'world'
        ORDER BY revision.id
      `)
    assert.deepEqual(history.rows, [{
      prior_state: 'undrawn',
      prior_description: null,
      prior_drawing: null,
      prior_source: 'none',
      current_state: 'complete',
      current_description: '',
      exact_current_drawing: true,
      current_source: 'place',
      author_id: null,
      author_relation: 'founder',
    }])
  })

  await t.test('undrawn pinned kinds expose no false drawing provenance through routes or snapshots', async () => {
    const roomId = await resetDatabase()
    const completeDrawing = Object.freeze({
      palette: Object.freeze(['#174d3c']),
      indices: Object.freeze([0, ...Array.from({ length: 63 }, () => null)]),
    })
    const kindId = Number((await database!.query<{ id: number }>(`
        INSERT INTO kinds (name, owner_id, current_revision)
        VALUES ('provenance-lantern', 1, 2)
        RETURNING id
      `)).rows[0]!.id)
    await database!.query(`
        INSERT INTO kind_revisions (
          kind_id, revision, description, traits, recipe,
          drawing, drawing_state, drawing_description, drawing_variants
        ) VALUES
          ($1, 1, 'The inherited base is deliberately undrawn.', '{}', '[]',
            NULL, 'undrawn', NULL, '[]'),
          ($1, 2, 'The inherited base is now complete.', '{}', '[]',
            $2, 'complete', 'A dark green lantern with one lit square.', '[]')
      `, [kindId, completeDrawing])
    await database!.query(`
        INSERT INTO things (
          id, place_id, name, body, owner_id, maker_id,
          kind_id, birth_revision, current_revision,
          drawing, drawing_state, drawing_description, drawing_variant_name
        ) VALUES
          (2, $1, 'refusal provenance', '', 1, 1, $2, 1, 1, NULL, 'undrawn', NULL, NULL),
          (3, $1, 'upgrade provenance', '', 1, 1, $2, 1, 1, NULL, 'undrawn', NULL, NULL)
      `, [roomId, kindId])

    const currentBefore = await app.request('/api/drawing/thing/2')
    assert.equal(currentBefore.status, 200, await currentBefore.clone().text())
    assert.deepEqual(await currentBefore.json(), {
      type: 'thing', id: 2,
      state: 'undrawn', presentation_state: 'undrawn',
      description: null, drawing: null, rows: null, source: 'none',
    })
    const snapshotBefore = (await database!.query<{ payload: Record<string, unknown> }>(`
        SELECT payload FROM city_snapshot.public_records
        WHERE class_name = 'things' AND record_id = '2'
      `)).rows[0]!.payload
    assert.equal(snapshotBefore.drawing_source, 'none')
    assert.equal(snapshotBefore.kind_id, null)
    assert.equal(snapshotBefore.kind_name, null)
    assert.equal(snapshotBefore.revision, null)
    assert.equal(snapshotBefore.variant_name, null)

    const refused = await app.request('/api/thing/2', {
      method: 'PATCH',
      headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
      body: JSON.stringify({
        drawing: 'REFUSE',
        drawing_description: 'I decline to show this pinned kind drawing.',
      }),
    })
    assert.equal(refused.status, 200, await refused.clone().text())
    const cleared = await app.request('/api/thing/2', {
      method: 'PATCH',
      headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
      body: JSON.stringify({ drawing: null }),
    })
    assert.equal(cleared.status, 200, await cleared.clone().text())

    const refusalHistory = await app.request('/api/drawing/thing/2/history')
    assert.equal(refusalHistory.status, 200, await refusalHistory.clone().text())
    const refusalRevisions = (await refusalHistory.json() as {
      revisions: Array<{
        previous: Record<string, unknown>
        current: Record<string, unknown>
      }>
    }).revisions
    assert.equal(refusalRevisions.length, 2)
    assert.deepEqual(refusalRevisions[1]!.previous, {
      state: 'undrawn', presentation_state: 'undrawn',
      description: null, drawing: null, rows: null, source: 'none',
    })
    assert.deepEqual(refusalRevisions[1]!.current, {
      state: 'refused', presentation_state: 'refused',
      description: 'I decline to show this pinned kind drawing.',
      drawing: null, rows: null, source: 'thing',
      kind_id: kindId, revision: 1,
    })
    assert.deepEqual(refusalRevisions[0]!.previous, refusalRevisions[1]!.current)
    assert.deepEqual(refusalRevisions[0]!.current, {
      state: 'undrawn', presentation_state: 'undrawn',
      description: null, drawing: null, rows: null, source: 'none',
    })

    const upgraded = await app.request('/api/thing/3/upgrade', {
      method: 'POST',
      headers: bearer(founderSecret),
    })
    assert.equal(upgraded.status, 200, await upgraded.clone().text())
    const upgradeHistory = await app.request('/api/drawing/thing/3/history')
    assert.equal(upgradeHistory.status, 200, await upgradeHistory.clone().text())
    const upgradeRevision = (await upgradeHistory.json() as {
      revisions: Array<{
        previous: Record<string, unknown>
        current: Record<string, unknown>
      }>
    }).revisions[0]!
    assert.deepEqual(upgradeRevision.previous, {
      state: 'undrawn', presentation_state: 'undrawn',
      description: null, drawing: null, rows: null, source: 'none',
    })
    assert.deepEqual(upgradeRevision.current, {
      state: 'complete', presentation_state: 'complete',
      description: 'A dark green lantern with one lit square.',
      drawing: completeDrawing,
      rows: [
        '0 . . . . . . .',
        '. . . . . . . .',
        '. . . . . . . .',
        '. . . . . . . .',
        '. . . . . . . .',
        '. . . . . . . .',
        '. . . . . . . .',
        '. . . . . . . .',
      ],
      source: 'kind_base', kind_id: kindId,
      kind_name: 'provenance-lantern', revision: 2,
    })
  })

  await t.test('thing upgrade refuses a busy kind promptly, then adopts the committed latest revision', async () => {
    const roomId = await resetDatabase()
    const completeDrawing = Object.freeze({
      palette: Object.freeze(['#174d3c']),
      indices: Object.freeze([0, ...Array.from({ length: 63 }, () => null)]),
    })
    const kindId = Number((await database!.query<{ id: number }>(`
        INSERT INTO kinds (name, owner_id, current_revision)
        VALUES ('serialized-lantern', 1, 2)
        RETURNING id
      `)).rows[0]!.id)
    await database!.query(`
        INSERT INTO kind_revisions (
          kind_id, revision, description, traits, recipe,
          drawing, drawing_state, drawing_description, drawing_variants
        ) VALUES
          ($1, 1, 'The birth revision is deliberately undrawn.', '{}', '[]',
            NULL, 'undrawn', NULL, '[]'),
          ($1, 2, 'The current revision has a complete drawing.', '{}', '[]',
            $2, 'complete', 'A dark green lantern with one lit square.', '[]')
      `, [kindId, completeDrawing])
    await database!.query(`
        INSERT INTO things (
          id, place_id, name, body, owner_id, maker_id,
          kind_id, birth_revision, current_revision
        ) VALUES (2, $1, 'serialized upgrade', '', 1, 1, $2, 1, 1)
      `, [roomId, kindId])

    const reviser = await database!.connect()
    const startedAt = Date.now()
    let pendingUpgrade: Promise<Response> | undefined
    try {
      await reviser.query('BEGIN')
      await reviser.query('SELECT id FROM kinds WHERE id = $1 FOR UPDATE', [kindId])
      await reviser.query(`
          INSERT INTO kind_revisions (
            kind_id, revision, description, traits, recipe,
            drawing, drawing_state, drawing_description, drawing_variants
          ) VALUES ($1, 3, 'The concurrently committed latest revision.', '{}', '[]',
            $2, 'complete', 'The committed latest lantern drawing.', '[]')
        `, [kindId, completeDrawing])
      await reviser.query('UPDATE kinds SET current_revision = 3 WHERE id = $1', [kindId])

      const upgradeRequest = Promise.resolve(app.request('/api/thing/2/upgrade', {
        method: 'POST',
        headers: bearer(founderSecret),
      }))
      pendingUpgrade = upgradeRequest
      const firstResult = await Promise.race([
        upgradeRequest.then(response => ({ response })),
        delay(1_000).then(() => ({ response: null })),
      ])
      assert.ok(firstResult.response, 'upgrade must not wait one second on a kind revision lock')
      assert.equal(firstResult.response.status, 409, await firstResult.response.clone().text())
      assert.match(
        (await firstResult.response.json() as { error: string }).error,
        /changing this thing or kind.*retry/iu,
      )

      const unchanged = await database!.query(`
          SELECT current_revision,
            (SELECT count(*)::integer FROM drawing_revisions
              WHERE target_type = 'thing' AND target_id = 2) AS drawing_revisions,
            (SELECT count(*)::integer FROM events
              WHERE kind = 'thing_upgraded' AND (detail->>'thing_id')::integer = 2) AS events
          FROM things WHERE id = 2
        `)
      assert.deepEqual(unchanged.rows, [{ current_revision: 1, drawing_revisions: 0, events: 0 }])
      await reviser.query('COMMIT')
    } finally {
      await reviser.query('ROLLBACK').catch(() => undefined)
      reviser.release()
      if (pendingUpgrade) await pendingUpgrade.catch(() => undefined)
    }

    assert.ok(Date.now() - startedAt < 2_000, 'busy-kind refusal must stay bounded')
    const retried = await app.request('/api/thing/2/upgrade', {
      method: 'POST',
      headers: bearer(founderSecret),
    })
    assert.equal(retried.status, 200, await retried.clone().text())
    assert.equal(
      (await retried.json() as { thing: { current_revision: number } }).thing.current_revision,
      3,
    )
    const committed = await database!.query(`
        SELECT current_revision,
          (SELECT count(*)::integer FROM drawing_revisions
            WHERE target_type = 'thing' AND target_id = 2) AS drawing_revisions,
          (SELECT count(*)::integer FROM events
            WHERE kind = 'thing_upgraded' AND (detail->>'thing_id')::integer = 2) AS events
        FROM things WHERE id = 2
      `)
    assert.deepEqual(committed.rows, [{ current_revision: 3, drawing_revisions: 1, events: 1 }])
  })


  await runThingUpgradePreflightTest()
}
