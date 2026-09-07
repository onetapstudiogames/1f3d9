import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerWriterMeterTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('the writer meter matches stored and ordinary first-read room bytes', async () => {
    const { readingCostMeter } = await import('../../../src/reading-cost.ts')
    const meter = await readingCostMeter(city.targetPlaceId, 'new body 🏙')
    const expected = (await postgres.client.query<{
      stored_text_bytes: string
      first_read_text_bytes: string
    }>(`
        SELECT
          octet_length(place.description)
            + (SELECT coalesce(sum(octet_length(description)), 0) FROM places WHERE parent_id = place.id)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM things WHERE place_id = place.id AND withdrawn_at IS NULL)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM notes WHERE place_id = place.id)
            AS stored_text_bytes,
          octet_length(place.description)
            + (SELECT coalesce(sum(octet_length(description)), 0) FROM (
                SELECT description FROM places WHERE parent_id = place.id ORDER BY id DESC LIMIT 10
              ) subplace_page)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM (
                SELECT body FROM things WHERE place_id = place.id AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 10
              ) thing_page)
            + (SELECT coalesce(sum(octet_length(body)), 0) FROM (
                SELECT body FROM notes WHERE place_id = place.id ORDER BY id DESC LIMIT 10
              ) note_page)
            AS first_read_text_bytes
        FROM places place WHERE place.id = $1
      `, [city.targetPlaceId])).rows[0]!
    assert.equal(meter.new_item_text_bytes, Buffer.byteLength('new body 🏙', 'utf8'))
    assert.equal(meter.room_stored_text_bytes, Number(expected.stored_text_bytes))
    assert.equal(meter.current_first_read_text_bytes, Number(expected.first_read_text_bytes))
  })

  await t.test('a timed-out writer meter leaves no PostgreSQL work running', async () => {
    const { safeReadingCostMeter } = await import('../../../src/reading-cost.ts')
    const blocker = await postgres.client.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE place_reading_totals IN ACCESS EXCLUSIVE MODE')
      const startedAt = Date.now()

      const meter = await safeReadingCostMeter(city.targetPlaceId, 'already committed', {
        timeoutMs: 250,
      })

      assert.equal(meter.available, false)
      assert.ok(Date.now() - startedAt < 1_000, 'the informational meter must stay bounded')
      const active = await postgres.client.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'active'
            AND query LIKE '%public:reading_cost%'
        `)
      assert.equal(active.rows[0]?.count, '0', 'the timed-out meter query must be canceled')
      assert.equal(meter.reason, 'measurement_timeout')
      assert.equal(meter.measurement_timeout_ms, 250)
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
  })

}
