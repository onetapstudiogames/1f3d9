import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readRepositoryEventWriterSources,
  scanEventDetailWriters,
} from './helpers/public-event-detail-writer-scan.ts'

// Revision 3, current-main baseline: 35 sources and 64 sites. The independent
// wake try carrier adds one site in an existing source, giving 65 candidate sites.
const WRITER_SITES = Object.freeze({
  'src/actions.ts': 1,
  'src/agreement-action.ts': 3,
  'src/crafting.ts': 2,
  'src/drawings.ts': 1,
  'src/engine-chance.ts': 1,
  'src/engine-convert.ts': 1,
  'src/engine-copy.ts': 2,
  'src/engine-effects.ts': 9,
  'src/engine-reach.ts': 1,
  'src/engine-settle.ts': 2,
  'src/engine-state.ts': 2,
  'src/engine-timer-store.ts': 1,
  'src/engine.ts': 3,
  'src/gazette.ts': 1,
  'src/identity-store.ts': 3,
  'src/index.ts': 1,
  'src/laws.ts': 1,
  'src/moderation-review.ts': 1,
  'src/moderation-store.ts': 1,
  'src/note-action.ts': 1,
  'src/oauth-store.ts': 1,
  'src/payment-sale-operation-sql.ts': 2,
  'src/payment-treasury-operations.ts': 1,
  'src/place-lifecycle-operation.ts': 1,
  'src/room-line-store.ts': 1,
  'src/room-ping-store.ts': 2,
  'src/society.ts': 4,
  'src/thing-making.ts': 1,
  'src/withdrawal.ts': 1,
  'src/world-market.ts': 2,
  'src/world.ts': 6,
  'scripts/bob-payment-repair-apply.ts': 2,
  'db/migrations/20260827_paypal_credit_disputes.sql': 1,
  'db/migrations/20260827_gazette_room_activation.sql': 1,
  'db/migrations/20260901_gazette_withdrawal_activation.sql': 1,
})

test('every event writer and insert site has an explicit activity review', async () => {
  const sources = await readRepositoryEventWriterSources(new URL('../', import.meta.url))
  const counts = Object.fromEntries(sources
    // The schema mirrors the one live SQL writer from its dated migration.
    .filter(source => source.path !== 'db/schema.sql')
    .map(source => [source.path, scanEventDetailWriters([source]).writerCount] as const)
    .filter(([, count]) => count > 0))
  assert.deepEqual(counts, WRITER_SITES)
  assert.equal(Object.keys(counts).length, 35)
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 65)
  const mirror = sources.find(source => source.path === 'db/schema.sql')
  assert.ok(mirror)
  assert.equal(scanEventDetailWriters([mirror]).writerCount, 1)
})
