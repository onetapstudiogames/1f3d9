import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowModule from '../../src/window.ts'
import { WINDOW_JS } from '../../src/window-client.ts'
import { PUBLIC_CREDENTIAL_REDACTION } from '../../src/credential-safety.ts'
import { normalizeWindowResidentLooking } from '../../src/window-client/resident-looking.ts'

export function registerWindowSnapshotShapersTests(): void {
  test('resident looking accepts only a bounded signal for the resident current room', () => {
    const valid = normalizeWindowResidentLooking({
      place_id: 2,
      started_at: '2026-09-09T12:00:00.000Z',
      expires_at: '2026-09-09T12:00:30.000Z',
    }, 2)
    assert.deepEqual(valid, {
      place_id: 2,
      started_at: new Date('2026-09-09T12:00:00.000Z'),
      expires_at: new Date('2026-09-09T12:00:30.000Z'),
    })

    for (const [value, currentPlaceId] of [
      [{ place_id: 3, started_at: '2026-09-09T12:00:00.000Z', expires_at: '2026-09-09T12:00:30.000Z' }, 2],
      [{ place_id: 2, started_at: 'invalid', expires_at: '2026-09-09T12:00:30.000Z' }, 2],
      [{ place_id: 2, started_at: '2026-09-09T12:00:30.000Z', expires_at: '2026-09-09T12:00:00.000Z' }, 2],
      [{ place_id: 2, started_at: '2026-09-09T12:00:00.000Z', expires_at: 'invalid' }, 2],
      [{ place_id: 2, started_at: '2026-09-09T12:00:00.000Z', expires_at: '2026-09-09T12:00:30.000Z' }, null],
    ] as const) assert.equal(normalizeWindowResidentLooking(value, currentPlaceId), null)
  })

  test('snapshot row shapers reject malformed public data', () => {
    const exports = windowModule as unknown as Record<string, unknown>
    assert.equal(typeof exports.publicWindowResidents, 'function')
    assert.equal(typeof exports.publicWindowNotes, 'function')
    assert.equal(typeof exports.publicWindowThings, 'function')
    assert.equal(typeof exports.publicWindowAgreements, 'function')

    const residents = (exports.publicWindowResidents as (rows: unknown[]) => unknown[])([
      { id: 7, handle: 'tiny-lantern', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z' },
      { id: 8, handle: '<script>', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z' },
      { id: 9, handle: 'long-gone', current_place_id: 195, joined_at: '2026-07-01T00:00:00Z', asleep: true },
      { id: 10, handle: 'odd-flag', current_place_id: 2, joined_at: '2026-08-11T00:00:00Z', asleep: 'yes' },
    ])
    assert.deepEqual(residents, [{
      id: 7,
      handle: 'tiny-lantern',
      current_place_id: 2,
      joined_at: '2026-08-11T00:00:00.000Z',
      asleep: false,
      has_drawing: false,
      looking: null,
    }, {
      id: 9,
      handle: 'long-gone',
      current_place_id: 195,
      joined_at: '2026-07-01T00:00:00.000Z',
      asleep: true,
      has_drawing: false,
      looking: null,
    }, {
      id: 10,
      handle: 'odd-flag',
      current_place_id: 2,
      joined_at: '2026-08-11T00:00:00.000Z',
      asleep: false,
      has_drawing: false,
      looking: null,
    }])

    const notes = (exports.publicWindowNotes as (rows: unknown[]) => unknown[])([
      { id: 1, place_id: 2, author: 'tiny-lantern', body: 'hello\ncity', created_at: '2026-08-11T00:00:00Z' },
      { id: 2, place_id: 2, author: 'tiny-lantern', body: 'bad\u202Etext', created_at: '2026-08-11T00:00:00Z' },
      { id: 3, place_id: 2, author: 'tiny-lantern', body: 'the inn\u00E2\u20AC\u2122s ledger', created_at: '2026-08-11T00:00:00Z' },
    ])
    assert.deepEqual(notes, [{
      id: 1,
      place_id: 2,
      author: 'tiny-lantern',
      body: 'hello\ncity',
      created_at: '2026-08-11T00:00:00.000Z',
      moderated: false,
    }])

    const things = (exports.publicWindowThings as (rows: unknown[]) => unknown[])([{
      id: 41,
      place_id: 2,
      name: 'porch lantern',
      body: 'warm light',
      maker_id: 6,
      made_by: 'old-maker',
      owner_id: 7,
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner: 'tiny-lantern',
      open_to_use: true,
      kind: 'lantern',
      traits: ['glowing', '<script>'],
      created_at: '2026-08-11T00:00:00Z',
    }, {
      id: 42,
      place_id: 2,
      name: 'bad provenance',
      body: 'must not enter the window',
      maker_id: 6,
      made_by: '<script>',
      owner_id: 7,
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner: 'tiny-lantern',
      open_to_use: false,
      kind: null,
      traits: [],
      created_at: '2026-08-11T00:00:00Z',
    }, {
      id: 43,
      place_id: 2,
      name: 'mismatched owner aliases',
      body: 'must not enter the window',
      maker_id: 6,
      made_by: 'old-maker',
      owner_id: 8,
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner: 'tiny-lantern',
      open_to_use: false,
      kind: null,
      traits: [],
      created_at: '2026-08-11T00:00:00Z',
    }])
    assert.deepEqual(things, [{
      id: 41,
      place_id: 2,
      name: 'porch lantern',
      body: 'warm light',
      maker_id: 6,
      made_by: 'old-maker',
      owner_id: 7,
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner: 'tiny-lantern',
      open_to_use: true,
      kind: 'lantern',
      traits: ['glowing'],
      created_at: '2026-08-11T00:00:00.000Z',
      moderated: false,
      kind_moderated: false,
      has_drawing: false,
    }])

    const agreements = (exports.publicWindowAgreements as (rows: unknown[]) => unknown[])([{
      id: 61,
      body: 'we keep the square open',
      created_by: 'tiny-lantern',
      parties: ['tiny-lantern', 'neighbor'],
      acceded: ['neighbor', 'never-a-party', '<script>'],
      signatures: ['tiny-lantern', '<script>'],
      open: true,
      accession_open: true,
      created_at: '2026-08-11T00:00:00Z',
    }])
    assert.deepEqual(agreements, [{
      id: 61,
      body: 'we keep the square open',
      created_by: 'tiny-lantern',
      parties: ['tiny-lantern', 'neighbor'],
      acceded: ['neighbor'],
      signatures: ['tiny-lantern'],
      open: true,
      accession_open: true,
      created_at: '2026-08-11T00:00:00.000Z',
      moderated: false,
    }])

    assert.match(WINDOW_JS, /Closed to later signers/)
    assert.match(WINDOW_JS, /Open to later signers/)
  })

  test('historical credential text is redacted without hiding window records', () => {
    const credentials = [
      `1f3d9_sk_${'a1'.repeat(24)}`,
      `1f3d9_at_${'b2'.repeat(32)}`,
      `1f3d9_rt_${'c3'.repeat(32)}`,
      `1f3d9_ac_${'d4'.repeat(32)}`,
    ]

    for (const [index, credential] of credentials.entries()) {
      const [note] = windowModule.publicWindowNotes([{
        id: 71 + index,
        place_id: 2,
        author: 'tiny-lantern',
        body: `historical note ${credential}`,
        created_at: '2026-08-11T00:00:00Z',
      }])
      const [thing] = windowModule.publicWindowThings([{
        id: 81 + index,
        place_id: 2,
        name: credential,
        body: credential,
        maker_id: 6,
        made_by: 'old-maker',
        owner_id: 7,
        current_owner_id: 7,
        current_owner: 'tiny-lantern',
        owner: 'tiny-lantern',
        open_to_use: false,
        kind: credential,
        traits: [credential],
        created_at: '2026-08-11T00:00:00Z',
      }])

      assert.equal(note?.id, 71 + index)
      assert.equal(note?.body, PUBLIC_CREDENTIAL_REDACTION)
      assert.equal(thing?.id, 81 + index)
      assert.equal(thing?.name, PUBLIC_CREDENTIAL_REDACTION)
      assert.equal(thing?.body, PUBLIC_CREDENTIAL_REDACTION)
      assert.equal(thing?.kind, PUBLIC_CREDENTIAL_REDACTION)
      assert.deepEqual(thing?.traits, [PUBLIC_CREDENTIAL_REDACTION])
    }
  })

  test('agreement party previews declare when later signers are not shown', () => {
    const parties = Array.from({ length: 35 }, (_, index) => `member-${String(index).padStart(2, '0')}`)
    const acceded = parties.slice(30)
    const [agreement] = windowModule.publicWindowAgreements([{
      id: 62,
      body: 'the whole city may sign in time',
      created_by: 'tiny-lantern',
      parties,
      party_count: parties.length,
      acceded,
      signatures: acceded,
      open: true,
      accession_open: true,
      created_at: '2026-08-11T00:00:00Z',
    }])

    assert.equal(agreement?.parties.length, 32)
    assert.equal(agreement?.party_count, 35)
    assert.equal(agreement?.parties_truncated, true)
    assert.deepEqual(agreement?.acceded, ['member-30', 'member-31'])
    assert.match(WINDOW_JS, /more not shown here/)
    assert.match(WINDOW_JS, /agreement\.parties_truncated/)
    assert.match(WINDOW_JS, /Party preview is incomplete/)
  })
}
