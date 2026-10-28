import assert from 'node:assert/strict'
import test from 'node:test'

test('invalidation preparation uses dynamic scope only when installed and locks residents before places', async () => {
  const { lockPublicActivityInvalidation } = await import('../src/public-activity-locks.ts')
  for (const installed of [false, true]) {
    const statements: string[] = []
    await lockPublicActivityInvalidation(async statement => {
      statements.push(statement)
      return statements.length === 1 ? [{ installed }] : [{ resident_ids: [1], place_ids: [2] }]
    }, 1, 'place', 2)
    assert.match(statements[0]!, /to_regprocedure/u)
    assert.match(statements[1]!, /ORDER BY resident.id FOR NO KEY UPDATE OF resident/u)
    assert.match(statements[1]!, /ORDER BY planned.depth,place.id FOR NO KEY UPDATE OF place/u)
    assert.doesNotMatch(statements[2]!, /FOR NO KEY UPDATE/u)
    for (const statement of statements.slice(1)) {
      assert.equal(statement.includes('public_activity_invalidation_scope('), installed)
    }
  }
})

test('a fresh source set restarts the whole transaction before mutation and bounds retries', async () => {
  const { lockPublicActivityInvalidation, withPublicActivityInvalidationRetry } = await import('../src/public-activity-locks.ts')
  let transactions = 0
  let mutations = 0
  await withPublicActivityInvalidationRetry(async () => {
    transactions += 1
    await lockPublicActivityInvalidation(async statement => {
      if (statement.includes('to_regprocedure')) return { rows: [{ installed: true }] }
      const resident_ids = transactions === 1 && statement.includes('validate') ? [1, 2] : [1]
      return { rows: [{ resident_ids, place_ids: [2] }] }
    }, 1, 'place', 2)
    mutations += 1
  })
  assert.equal(transactions, 2)
  assert.equal(mutations, 1)
  let attempts = 0
  await assert.rejects(withPublicActivityInvalidationRetry(async () => {
    attempts += 1
    await lockPublicActivityInvalidation(async statement => {
      if (statement.includes('to_regprocedure')) return [{ installed: true }]
      return [{ resident_ids: statement.includes('validate') ? [1, 2] : [1], place_ids: [2] }]
    }, 1, 'place', 2)
  }), { code: '40001' })
  assert.equal(attempts, 3)
})
