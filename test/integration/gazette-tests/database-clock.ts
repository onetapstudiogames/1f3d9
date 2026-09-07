import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'

export async function registerDatabaseClockTests(
  t: TestContext,
  database: Pool,
): Promise<void> {
  await t.test('the database clock defeats explicit past and future quota timestamps', async () => {
    const before = (await database.query<{ current_time: Date }>(
      'SELECT clock_timestamp() AS current_time',
    )).rows[0]!.current_time
    const suppliedTimes = [
      '1900-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
      '1950-01-01T00:00:00.000Z',
    ]
    const storedIds: number[] = []
    for (const [index, suppliedTime] of suppliedTimes.entries()) {
      const stored = (await database.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 10, $1, $2::timestamptz)
        RETURNING id
      `, [`clock-owned ${index + 1}`, suppliedTime])).rows[0]!
      storedIds.push(stored.id)
    }
    const after = (await database.query<{ current_time: Date }>(
      'SELECT clock_timestamp() AS current_time',
    )).rows[0]!.current_time
    const storedTimes = (await database.query<{ created_at: Date }>(`
      SELECT created_at
      FROM notes
      WHERE id = ANY($1::integer[])
      ORDER BY id
    `, [storedIds])).rows.map(row => row.created_at)
    assert.equal(storedTimes.length, 3)
    for (const [index, storedTime] of storedTimes.entries()) {
      assert.ok(storedTime >= before && storedTime <= after)
      assert.notEqual(storedTime.toISOString(), suppliedTimes[index])
    }

    await assert.rejects(
      database.query(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 10, 'clock-owned fourth', TIMESTAMPTZ '2200-01-01 00:00:00+00')
      `),
      (error: unknown) => {
        assert.equal(
          (error as { constraint?: string }).constraint,
          'gazette_submission_weekly_limit',
        )
        return true
      },
    )
  })
}
