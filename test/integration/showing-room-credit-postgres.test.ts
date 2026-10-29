import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import type { CityCreditDatabase } from '../../src/city-credit.ts'
import type { ShowingRoomAwardContest } from '../../src/showing-room-awards.ts'
import { countShowingRoom, type ShowingRoomNote } from '../../src/showing-room-count.ts'
import { schemaDdl, startPostgres } from '../helpers/gazette-fixtures/postgres.ts'
import { accountAndLedger, insertCreditAttempt, spendCredit } from '../helpers/city-credit-postgres-fixtures/ledger.ts'

const showingRoomDdl = await readFile(new URL('../../db/migrations/20261027_showing_room.sql', import.meta.url), 'utf8')

const contest: ShowingRoomAwardContest = {
  state: 'open', question_number: 11, vote_closes_at: '2026-11-09T15:00:00.000Z',
}
const rules = {
  rule_version: 'showing-room-v1' as const, rules_note_id: 100,
  opens_at: '2026-11-02T15:00:00.000Z', entries_close_at: '2026-11-07T15:00:00.000Z',
  votes_close_at: contest.vote_closes_at,
}
const entry = (id: number, author_id: number): ShowingRoomNote => ({
  id, author_id, author: `resident-${author_id}`, place_id: 438,
  body: `ENTRY Title ${id}\nA synthetic notice.`, created_at: '2026-11-03T12:00:00.000Z',
  walk_to_read: false, removed: false,
})
const entries = [entry(101, 11), entry(102, 12), entry(103, 13)]
const ballot: ShowingRoomNote = { ...entry(104, 14), body: 'VOTE 101 102 103',
  created_at: '2026-11-08T12:00:00.000Z' }
const tied = countShowingRoom(rules, [...entries, ballot])

function adapter(client: Pool | PoolClient): CityCreditDatabase {
  return { query: async (text, values = []) => (await client.query(text, [...values])).rows }
}

async function inTransaction<T>(database: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '5s'")
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function reset(database: Pool): Promise<void> {
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(showingRoomDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash) VALUES
      (1, 'founder', 'showing-room-awards-test', repeat('1',64)),
      (2, 'second-founder', 'showing-room-awards-test', repeat('2',64)),
      (11, 'resident-11', 'showing-room-awards-test', repeat('3',64)),
      (12, 'resident-12', 'showing-room-awards-test', repeat('4',64)),
      (13, 'resident-13', 'showing-room-awards-test', repeat('5',64)),
      (14, 'resident-14', 'showing-room-awards-test', repeat('6',64))
  `)
}

async function ledger(database: Pool) {
  return (await database.query(`SELECT id::text, resident_id, entry_kind, amount_units::text,
    founder_id, source_key, reason FROM city_credit_entries ORDER BY id`)).rows
}

test('showing room awards reuse the real fixed-credit ledger in one transaction', { timeout: 120_000 }, async t => {
  const { issueShowingRoomAwards, ShowingRoomAwardError } = await import('../../src/showing-room-awards.ts')
  const { issueCityFeeCredit } = await import('../../src/city-credit.ts')
  const { database, containerName } = await startPostgres()
  try {
    await t.test('a three-way tie issues one full unit per winner with fixed source keys and receipt IDs', async () => {
      await reset(database)
      const receipts = await inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest,
        { ...tied, winners: [...tied.winners].reverse() }))
      assert.deepEqual(receipts.map(receipt => [receipt.resident_id, receipt.entry_note_id,
        receipt.source_key, receipt.amount_units]), [
        [11, 101, 'showing-room-q11-2026-11-09-r11', '1000000'],
        [12, 102, 'showing-room-q11-2026-11-09-r12', '1000000'],
        [13, 103, 'showing-room-q11-2026-11-09-r13', '1000000'],
      ])
      const records = await ledger(database)
      assert.equal(records.length, 3)
      assert.deepEqual(receipts.map(receipt => receipt.credit_entry_id), records.map(record => record.id))
      for (const record of records) {
        assert.equal(record.founder_id, 1)
        assert.equal(record.entry_kind, 'founder_issue')
        assert.equal(record.amount_units, '1000000')
        assert.match(String(record.reason), /question 11.*entry #10[123]/u)
      }
      for (const residentId of [11, 12, 13]) assert.deepEqual(await accountAndLedger(database, residentId), {
        balance_units: '1000000', ledger_units: '1000000',
      })
    })

    await t.test('zero entries or zero valid ballots issue no credit', async () => {
      await reset(database)
      for (const count of [countShowingRoom(rules, []), countShowingRoom(rules, entries)]) {
        assert.deepEqual(await inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, count)), [])
      }
      assert.equal((await ledger(database)).length, 0)
    })

    await t.test('the last supported contest close still credits its winners once', async () => {
      await reset(database)
      const lastRules = { ...rules, opens_at: '9999-12-20T15:00:00.000Z',
        entries_close_at: '9999-12-25T15:00:00.000Z', votes_close_at: '9999-12-27T15:00:00.000Z' }
      const lastCount = countShowingRoom(lastRules, [
        ...entries.map(item => ({ ...item, created_at: '9999-12-21T12:00:00.000Z' })),
        { ...ballot, created_at: '9999-12-26T12:00:00.000Z' },
      ])
      const lastContest = { ...contest, vote_closes_at: lastRules.votes_close_at }
      const first = await inTransaction(database, client => issueShowingRoomAwards(adapter(client), lastContest, lastCount))
      const replay = await inTransaction(database, client => issueShowingRoomAwards(adapter(client), lastContest, lastCount))
      assert.deepEqual(first.map(item => item.source_key), [
        'showing-room-q11-9999-12-27-r11', 'showing-room-q11-9999-12-27-r12', 'showing-room-q11-9999-12-27-r13',
      ])
      assert.deepEqual(replay, first)
      assert.equal((await ledger(database)).length, 3)
    })

    for (const position of [1, 2, 3]) await t.test(`failure after award ${position} rolls back every ledger and account row`, async () => {
      await reset(database)
      let completedAwards = 0
      await assert.rejects(inTransaction(database, async client => {
        const failingDatabase: CityCreditDatabase = { query: async (text, values = []) => {
          const result = await adapter(client).query(text, values)
          if (text.includes('city-credit:issue-balance') && ++completedAwards === position) {
            throw new Error(`synthetic failure after award ${position}`)
          }
          return result
        } }
        return issueShowingRoomAwards(failingDatabase, contest, tied)
      }), new RegExp(`synthetic failure after award ${position}`, 'u'))
      assert.equal(completedAwards, position)
      assert.equal((await ledger(database)).length, 0)
      assert.equal((await database.query('SELECT count(*)::integer AS total FROM city_credit_accounts')).rows[0]?.total, 0)
    })

    await t.test('two concurrent identical award attempts return the same three immutable receipts', async () => {
      await reset(database)
      const results = await Promise.all([
        inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, tied)),
        inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, tied)),
      ])
      assert.equal(results[0].length, 3)
      assert.deepEqual(results[1], results[0])
      assert.equal((await ledger(database)).length, 3)
    })

    await t.test('a lost response after commit replays the original receipt IDs without new credit', async () => {
      await reset(database)
      const first = await inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, tied))
      // The caller lost the response; a fresh connection has only the stable contest terms.
      const replay = await inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, tied))
      assert.equal(first.length, 3)
      assert.deepEqual(replay, first)
      assert.equal((await ledger(database)).length, 3)
    })

    await t.test('an existing source key with another recipient or reason stops without inventing a new key', async () => {
      for (const residentId of [11, 14]) {
        await reset(database)
        await issueCityFeeCredit(adapter(database), { founderId: 1, residentId,
          sourceKey: 'showing-room-q11-2026-11-09-r11', reason: 'Different original award terms.' })
        const before = await ledger(database)
        await assert.rejects(inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, tied)), error => {
          assert.ok(error instanceof ShowingRoomAwardError)
          assert.equal(error.code, 'award_review')
          assert.match(error.message, /ask the founder to review this contest/u)
          assert.doesNotMatch(error.message, /new source key|INSERT|SELECT/u)
          assert.ok(error.cause instanceof Error)
          return true
        })
        assert.deepEqual(await ledger(database), before)
      }
    })

    await t.test('manual legacy contests and historical replay cannot issue automatic credits', async () => {
      await reset(database)
      await assert.rejects(inTransaction(database, client => issueShowingRoomAwards(adapter(client),
        { ...contest, state: 'manual-legacy' }, tied)), error => {
        assert.ok(error instanceof ShowingRoomAwardError)
        assert.equal(error.code, 'manual_contest')
        assert.match(error.message, /manual|managed/u)
        return true
      })
      await assert.rejects(inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest,
        { ...tied, rule_version: 'q9-replay-v1' })), /manual|managed/u)
      assert.equal((await ledger(database)).length, 0)
    })

    await t.test('a concurrent ordinary spend and repeated award leave account and ledger in agreement', async () => {
      await reset(database)
      await issueCityFeeCredit(adapter(database), { founderId: 1, residentId: 11,
        sourceKey: 'showing-room-test-initial-credit', reason: 'Synthetic initial credit for a concurrent spend.' })
      await insertCreditAttempt(database, 'showing_room_spend_00000001', 11, 'frontier', 'frontier:showing-room-test')
      const results = await Promise.all([
        inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, tied)),
        inTransaction(database, client => issueShowingRoomAwards(adapter(client), contest, tied)),
        spendCredit(database, 11, 'showing_room_spend_00000001', 'showing-room-spend-test-request'),
      ])
      assert.equal(results[0].length, 3)
      assert.deepEqual(results[0], results[1])
      assert.deepEqual(await accountAndLedger(database, 11), { balance_units: '1000000', ledger_units: '1000000' })
      assert.equal((await ledger(database)).length, 5)
    })
  } finally {
    await database.end()
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8', windowsHide: true })
  }
})
