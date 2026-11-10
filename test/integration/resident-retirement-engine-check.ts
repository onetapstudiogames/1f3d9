import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { recordRoomEnds } from '../../src/engine-end-try.ts'
import { resolveDueEffects } from '../../src/engine-effects.ts'
import { setEngineTransactionRunnerForTests, type TaggedSql } from '../../src/engine.ts'

export async function checkRetirementEngine(pool: Pool): Promise<void> {
  const client = await pool.connect()
  const db = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.reduce((sql, part, index) => sql + part + (index < values.length ? `$${index + 1}` : ''), '')
    return (await client.query(text, values)).rows
  }) as TaggedSql
  db.query = async (text, values = []) => (await client.query(text, [...values])).rows
  setEngineTransactionRunnerForTests(async (_db, work) => {
    await client.query('BEGIN')
    try { const value = await work(db, true); await client.query('COMMIT'); return value }
    catch (error) { await client.query('ROLLBACK'); throw error }
  })
  try {
    await client.query(`INSERT INTO residents(id,handle,model,secret_hash) VALUES
      (81,'frozen-engine','test',repeat('8',64)), (82,'active-engine','test',repeat('9',64))`)
    await client.query(`INSERT INTO places(id,parent_id,place_kind,name,description,owner_id)
      SELECT 801,id,'continent','engine-room','room',82 FROM places WHERE place_kind='world'`)
    await client.query(`INSERT INTO places(id,parent_id,place_kind,name,description,owner_id)
      VALUES(802,801,'place','frozen-land','room',81)`)
    await client.query(`INSERT INTO kinds(id,name,owner_id) VALUES(811,'frozen-kind',81)`)
    await client.query(`INSERT INTO things(id,name,body,owner_id,maker_id,place_id)
      VALUES(8100,'frozen-timer-source','unchanged',81,81,801)`)
    await client.query(`INSERT INTO things(id,name,body,owner_id,maker_id,place_id)
      SELECT 8000+id, 'engine-'||id, 'unchanged', CASE WHEN id<=65 THEN 81 ELSE 82 END,
        CASE WHEN id<=65 THEN 81 ELSE 82 END,801 FROM generate_series(1,66) id`)
    await client.query(`UPDATE things SET ending_rule=jsonb_build_object('any',jsonb_build_array(jsonb_build_object('at',now()-interval '1 hour'))),
      ending_grant='{"kindless":true,"allowed":["at"],"limits":{"max_seconds":31622400,"max_uses":10000,"labels":null},"city_limits_version":1}'::jsonb,
      ending_set_by=owner_id,ending_set_at=now()-interval '2 hours',ending_deadline=now()-interval '1 hour'
      WHERE id BETWEEN 8001 AND 8066`)
    await client.query(`INSERT INTO pending_effects(place_id,actor_id,payload,due_at,created_at)
      VALUES(801,81,'{"effects":[]}'::jsonb,now()-interval '1 minute',now()-interval '2 minutes')`)
    await client.query(`INSERT INTO pending_effects(place_id,actor_id,source_thing_id,payload,due_at,created_at)
      VALUES(801,82,8100,'{"effects":[]}'::jsonb,now()-interval '1 minute',now()-interval '2 minutes')`)
    await client.query(`INSERT INTO pending_effects(place_id,actor_id,target_type,target_id,payload,due_at,created_at)
      SELECT 801,82,type,id,'{"effects":[]}'::jsonb,now()-interval '1 minute',now()-interval '2 minutes'
      FROM (VALUES('resident',81),('thing',8100),('place',802),('kind',811)) target(type,id)`)
    await client.query(`UPDATE residents SET retirement_state='retiring',retirement_requested_at=now() WHERE id=81`)
    const ends = await recordRoomEnds(801, db)
    assert.deepEqual(ends.recorded, [8066], 'frozen owners must not consume the bounded end batch')
    assert.equal(ends.moreDue, false)
    assert.deepEqual(await resolveDueEffects(801, db), { resolved: 0, failed: 0, capped: false })
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM effect_resolutions resolution
      JOIN pending_effects pending ON pending.id=resolution.pending_effect_id WHERE pending.place_id=801`)).rows[0].count, 0)
    await client.query(`UPDATE residents SET retirement_state='active',retirement_requested_at=NULL WHERE id=81`)
    const resumed = await recordRoomEnds(801, db)
    assert.equal(resumed.recorded.length, 64)
    assert.equal(resumed.moreDue, true)
    assert.deepEqual(await resolveDueEffects(801, db), { resolved: 6, failed: 0, capped: false })
  } finally {
    setEngineTransactionRunnerForTests(null)
    client.release()
  }
}
