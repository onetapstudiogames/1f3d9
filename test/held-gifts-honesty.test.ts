// Row #158 and every sentence that promises a mute is never told must match what the
// held-gift code actually sends (decisions #45, #156 and #158). The recipient's settings
// list its oldest waiting transfers, not only a count, and a giver whose gift is held
// learns from its own answer that the recipient muted it, so each "nobody is told"
// names that one exception.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PRIVACY_TEXT } from '../src/legal.ts'
import { PUBLIC_SNAPSHOT_CLASS_REGISTRY } from '../src/public-snapshot-format.ts'
import { listWaitingTransfers } from '../src/waiting-transfers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(ROOT + path, 'utf8')
const flat = (text: string): string => text.replace(/\s+/gu, ' ')

function row158(): string {
  const line = read('docs/DECISIONS.md').split(/\r?\n/u).find(entry => entry.startsWith('| 158 |'))
  assert.ok(line, 'docs/DECISIONS.md has row #158')
  return line
}

test('row #158 describes the list the recipient settings actually carry', async () => {
  const fakeDb = async () => [{
    id: 4, asset_type: 'place', asset_id: 5, giver_handle: 'seed-keeper',
    created_at: new Date('2026-10-18T00:00:00.000Z'), total: 1,
  }]
  const answer = await listWaitingTransfers(9, fakeDb as never)
  const oldest = answer.oldest as ReadonlyArray<Record<string, unknown>>
  assert.equal(answer.count, 1)
  assert.equal(oldest[0]!.from, 'seed-keeper')
  const row = row158()
  assert.doesNotMatch(row, /sees only a count/u)
  assert.match(row, /a count of its waiting transfers and its oldest ones \(who gave what, and when\)/u)
})

test('row #158 narrows #156 for the giver of a held transfer', () => {
  const row = row158()
  assert.match(row, /#156's "nobody is told"/u)
  assert.match(row, /this reworded row goes back to the owner before it merges/u)
})

test('every "nobody is told" about mutes names the held-gift exception', () => {
  const reference = flat(read('src/reference.txt'))
  const mutes = reference.slice(reference.indexOf('MUTES ~~~~~'), reference.indexOf('A mute covers an item'))
  assert.match(mutes, /nobody is told: not the resident you muted, and not anyone else, except/u)
  assert.match(mutes, /HELD GIFTS below/u)

  const privacy = flat(PRIVACY_TEXT)
  assert.match(privacy, /nobody else sees them or is told, except that a resident muted without letting its gifts through learns/u)

  const reason = PUBLIC_SNAPSHOT_CLASS_REGISTRY.find(entry => entry.class_name === 'reading_mutes')?.reason ?? ''
  assert.match(reason, /nobody is told, except that a resident muted without let_gifts_through learns its gift is held/u)
  const snapshotDoc = read('docs/PUBLIC_SNAPSHOTS.md').split(/\r?\n/u).find(line => line.startsWith('| `reading_mutes` |')) ?? ''
  assert.match(snapshotDoc, /nobody is told, except that a resident muted without `let_gifts_through` learns its gift is held/u)

  assert.match(flat(read('docs/features/READING_SETTINGS.md')), /Unlimited, private, and nobody is told, except that a resident muted without `let_transfers_through` learns its gift is held when it gives \(decision #158\)/u)
})
