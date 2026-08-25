import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createAgreementAction,
  openAgreementAccessionAction,
  signAgreementAction,
} from '../src/agreement-action.ts'
import type { TaggedSql } from '../src/engine.ts'

type Call = Readonly<{ text: string; values: readonly unknown[] }>
type Responder = (call: Call) => readonly Record<string, unknown>[]

const resident = Object.freeze({
  id: 7,
  handle: 'tiny-lantern',
  agreement_actions_today: 0,
})

function fakeSql(responder: Responder): { database: TaggedSql; calls: Call[] } {
  const calls: Call[] = []
  const database = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = {
      text: strings.join('?').replace(/\s+/gu, ' ').trim(),
      values,
    }
    calls.push(call)
    return [...responder(call)]
  }) as TaggedSql
  return { database, calls }
}

test('agreement creation checks parties before one shared quota gate', async () => {
  const missing = fakeSql(({ text }) => text.includes('FROM residents WHERE handle = ANY')
    ? [{ id: 8, handle: 'neighbor' }]
    : [])
  assert.deepEqual(await createAgreementAction({
    resident: { ...resident, agreement_actions_today: 5 },
    parties: ['neighbor', 'absent'],
    text: 'we keep the square open',
    accessionOpen: false,
  }, missing.database), {
    ok: false,
    status: 404,
    error: 'unknown agreement party: absent',
  })
  assert.equal(missing.calls.some(call => call.text.includes('UPDATE residents SET agreement_actions_today')), false)

  const exhausted = fakeSql(({ text }) => text.includes('FROM residents WHERE handle = ANY')
    ? [{ id: 8, handle: 'neighbor' }]
    : [])
  assert.deepEqual(await createAgreementAction({
    resident: { ...resident, agreement_actions_today: 5 },
    parties: ['neighbor'],
    text: 'we keep the square open',
    accessionOpen: false,
  }, exhausted.database), {
    ok: false,
    status: 429,
    error: '5 agreement actions per UTC day',
  })
  assert.equal(exhausted.calls.some(call => call.text.includes('UPDATE residents SET agreement_actions_today')), false)
})

test('agreement creation keeps its quota spend and public writes in one statement', async () => {
  const fake = fakeSql(({ text }) => {
    if (text.includes('FROM residents WHERE handle = ANY')) return [{ id: 8, handle: 'neighbor' }]
    if (text.includes('UPDATE residents SET agreement_actions_today')) {
      return [{
        id: 61,
        body: 'we keep the square open',
        accession_open: true,
        created_at: '2026-08-11T00:00:00.000Z',
      }]
    }
    return []
  })

  const result = await createAgreementAction({
    resident,
    parties: ['neighbor'],
    text: 'we keep the square open',
    accessionOpen: true,
  }, fake.database)

  assert.equal(result.ok, true)
  assert.equal(fake.calls.filter(call => call.text.includes('UPDATE residents SET agreement_actions_today')).length, 1)
  const mutation = fake.calls.find(call => call.text.includes('UPDATE residents SET agreement_actions_today'))
  assert.match(mutation?.text ?? '', /INSERT INTO agreements[\s\S]*INSERT INTO agreement_parties[\s\S]*INSERT INTO agreement_accession_openings[\s\S]*INSERT INTO events/u)
})

test('opening accession replays before quota and spends only for a new opening', async () => {
  const replay = fakeSql(({ text }) => text.includes('LEFT JOIN agreement_accession_openings')
    ? [{ id: 61, created_by_id: 7, opened_at: '2026-08-10T23:59:00.000Z' }]
    : [])
  assert.deepEqual(await openAgreementAccessionAction({
    resident: { ...resident, agreement_actions_today: 5 },
    agreementId: 61,
  }, replay.database), {
    ok: true,
    agreement: {
      id: 61,
      accession_open: true,
      opened_at: '2026-08-10T23:59:00.000Z',
    },
    created: false,
  })
  assert.equal(replay.calls.some(call => call.text.includes('UPDATE residents SET agreement_actions_today')), false)

  const created = fakeSql(({ text }) => {
    if (text.includes('LEFT JOIN agreement_accession_openings')) {
      return [{ id: 61, created_by_id: 7, opened_at: null }]
    }
    if (text.includes('UPDATE residents SET agreement_actions_today')) {
      return [{ agreement_id: 61, opened_at: '2026-08-11T00:00:00.000Z' }]
    }
    return []
  })
  const result = await openAgreementAccessionAction({ resident, agreementId: 61 }, created.database)
  if (!result.ok) assert.fail(result.error)
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
})

test('signing preserves closed-accession denial and signature replay before quota', async () => {
  const closed = fakeSql(({ text }) => text.includes('FROM agreements a WHERE a.id')
    ? [{ id: 61, accession_open: false, parties: ['neighbor'], already_signed: false }]
    : [])
  assert.deepEqual(await signAgreementAction({ resident, agreementId: 61 }, closed.database), {
    ok: false,
    status: 403,
    error: 'this agreement is closed to later signers',
  })

  const replay = fakeSql(({ text }) => text.includes('FROM agreements a WHERE a.id')
    ? [{
        id: 61,
        accession_open: true,
        parties: ['tiny-lantern'],
        already_signed: true,
        signed_at: '2026-08-10T23:59:00.000Z',
        signature_acceded: false,
      }]
    : [])
  assert.deepEqual(await signAgreementAction({
    resident: { ...resident, agreement_actions_today: 5 },
    agreementId: 61,
  }, replay.database), {
    ok: true,
    signature: {
      agreement_id: 61,
      handle: 'tiny-lantern',
      acceded: false,
      signed_at: '2026-08-10T23:59:00.000Z',
    },
  })
  assert.equal(replay.calls.some(call => call.text.includes('UPDATE residents SET agreement_actions_today')), false)
})
