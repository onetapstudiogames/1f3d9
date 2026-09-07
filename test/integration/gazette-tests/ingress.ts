import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'

export async function registerIngressTests(
  t: TestContext,
  database: Pool,
): Promise<void> {
  async function assertGazetteDependencyWriteRejected(
    database: Pool,
    text: string,
    constraint: 'gazette_submission_room_laws'
      | 'gazette_submission_room_children'
      | 'gazette_submission_room_things',
  ): Promise<void> {
    await assert.rejects(
      database.query(text),
      (error: unknown) => {
        assert.equal((error as { constraint?: string }).constraint, constraint)
        return true
      },
    )
  }

  await t.test('the database rejects every law, child-place, and thing ingress path', async () => {
    await database.query(`
      WITH marker AS (
        INSERT INTO traits (name, description, coiner_id)
        VALUES ('gazette-guard-marker', 'Protected-room dependency guard fixture.', 1)
        RETURNING id
      )
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      SELECT 2, id, 1, 'add', 0 FROM marker;

      INSERT INTO places (
        id, parent_id, place_kind, name, description, owner_id,
        open_to_building, open_to_things, open_to_notes
      ) VALUES (
        6000, 2, 'place', 'gazette guard child fixture', '', 1,
        FALSE, FALSE, FALSE
      );

      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES (2, 'gazette guard thing fixture', '', 1, 1);
    `)

    await assertGazetteDependencyWriteRejected(database, `
      INSERT INTO place_law_changes (place_id, trait_id, actor_id, change_type, position)
      SELECT 454, id, 1, 'add', 0 FROM traits WHERE name = 'gazette-guard-marker'
    `, 'gazette_submission_room_laws')
    await assertGazetteDependencyWriteRejected(database, `
      UPDATE place_law_changes SET place_id = 454
      WHERE trait_id = (SELECT id FROM traits WHERE name = 'gazette-guard-marker')
    `, 'gazette_submission_room_laws')

    await assertGazetteDependencyWriteRejected(database, `
      INSERT INTO places (
        id, parent_id, place_kind, name, description, owner_id,
        open_to_building, open_to_things, open_to_notes
      ) VALUES (6001, 454, 'place', 'forbidden Gazette child', '', 1, FALSE, FALSE, FALSE)
    `, 'gazette_submission_room_children')
    await assertGazetteDependencyWriteRejected(database, `
      UPDATE places SET parent_id = 454 WHERE name = 'gazette guard child fixture'
    `, 'gazette_submission_room_children')

    await assertGazetteDependencyWriteRejected(database, `
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      VALUES (454, 'forbidden Gazette thing', '', 1, 1)
    `, 'gazette_submission_room_things')
    await assertGazetteDependencyWriteRejected(database, `
      UPDATE things SET place_id = 454 WHERE name = 'gazette guard thing fixture'
    `, 'gazette_submission_room_things')

    assert.deepEqual((await database.query(`
      SELECT
        (SELECT count(*)::integer FROM place_law_changes WHERE place_id = 454) AS laws,
        (SELECT count(*)::integer FROM places WHERE parent_id = 454) AS children,
        (SELECT count(*)::integer FROM things WHERE place_id = 454) AS things,
        gazette_submission_room_is_open() AS submissions_open
    `)).rows[0], { laws: 0, children: 0, things: 0, submissions_open: true })
  })

}
