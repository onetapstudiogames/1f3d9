import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assignChangelogIds, type ChangelogLedgerRow } from '../scripts/changelog-ids.mjs'
import { CHANGELOG_ENTRY_LEDGER, CHANGELOG_LAST_ID } from '../src/changelog-source.ts'
import { CHANGELOG_TEXT, parseChangelog } from '../src/changelog.ts'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function markdown(groups: ReadonlyArray<readonly [string, string, readonly string[]]>): string {
  const lines = ['# Changelog', '', 'Status: current.', '']
  let lastDate = ''
  for (const [date, category, bullets] of groups) {
    if (date !== lastDate) lines.push(`## ${date}`, '')
    lastDate = date
    lines.push(`### ${category}`, ...bullets.map(bullet => `- ${bullet}`), '')
  }
  return lines.join('\n')
}

function ids(result: { readonly ledger: readonly ChangelogLedgerRow[] }): number[] {
  return result.ledger.map(row => row.id)
}

test('the checked-in changelog id ledger is current, so running the embed again changes nothing', () => {
  assert.equal(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), CHANGELOG_TEXT)
  const result = assignChangelogIds(CHANGELOG_ENTRY_LEDGER, CHANGELOG_LAST_ID, CHANGELOG_TEXT)
  assert.deepEqual(result.ledger, CHANGELOG_ENTRY_LEDGER,
    'CHANGELOG.md changed without node scripts/embed-changelog.mjs; run it and commit src/changelog-source.ts')
  assert.equal(result.lastId, CHANGELOG_LAST_ID)
})

test('the ledger has one row per changelog bullet, in file order, with unique permanent ids', () => {
  const bullets = parseChangelog(CHANGELOG_TEXT).flatMap(entry => entry.categories.flatMap(category => (
    category.items.map(text => ({ date: entry.date, category: category.name, text }))
  )))
  assert.equal(CHANGELOG_ENTRY_LEDGER.length, bullets.length)
  const seen = new Set<number>()
  CHANGELOG_ENTRY_LEDGER.forEach((row, index) => {
    const bullet = bullets[index]!
    assert.ok(Number.isSafeInteger(row.id) && row.id > 0 && row.id <= CHANGELOG_LAST_ID, `row ${index}`)
    assert.ok(!seen.has(row.id), `id ${row.id} is used twice`)
    seen.add(row.id)
    assert.equal(row.date, bullet.date)
    assert.equal(row.category, bullet.category)
    assert.equal(row.sha256, sha256(bullet.text))
  })
})

test('a first run with an empty ledger numbers bullets from the bottom of the file up', () => {
  const text = markdown([
    ['2026-10-02', 'For residents', ['Newest change.', 'Second change.']],
    ['2026-10-01', 'For humans watching', ['Oldest change.']],
  ])
  const result = assignChangelogIds([], 0, text)
  assert.deepEqual(ids(result), [3, 2, 1])
  assert.equal(result.lastId, 3)
})

test('unchanged text keeps its id and a new bullet gets the next id', () => {
  const before = assignChangelogIds([], 0, markdown([
    ['2026-10-01', 'For residents', ['First change.', 'Second change.']],
  ]))
  const after = assignChangelogIds(before.ledger, before.lastId, markdown([
    ['2026-10-02', 'For residents', ['Brand new change.']],
    ['2026-10-01', 'For residents', ['First change.', 'Second change.']],
  ]))
  assert.deepEqual(ids(after), [3, 2, 1])
  assert.equal(after.lastId, 3)
})

test('a redated bullet with identical text keeps its id', () => {
  const before = assignChangelogIds([], 0, markdown([
    ['2026-10-01', 'For residents', ['Moved change.', 'Staying change.']],
  ]))
  const after = assignChangelogIds(before.ledger, before.lastId, markdown([
    ['2026-10-02', 'For humans watching', ['Moved change.']],
    ['2026-10-01', 'For residents', ['Staying change.']],
  ]))
  assert.deepEqual(ids(after), ids(before))
  assert.equal(after.ledger[0]?.date, '2026-10-02')
  assert.equal(after.ledger[0]?.category, 'For humans watching')
})

test('a sole edit in one date and category keeps its id', () => {
  const before = assignChangelogIds([], 0, markdown([
    ['2026-10-01', 'For residents', ['Kept change.', 'Old wording.']],
  ]))
  const after = assignChangelogIds(before.ledger, before.lastId, markdown([
    ['2026-10-01', 'For residents', ['Kept change.', 'New wording, same change.']],
  ]))
  assert.deepEqual(ids(after), ids(before))
  assert.equal(after.ledger[1]?.sha256, sha256('New wording, same change.'))
  assert.equal(after.lastId, before.lastId)
})

test('two edits plus an addition in one group pair nothing, and retired ids are never reused', () => {
  const before = assignChangelogIds([], 0, markdown([
    ['2026-10-01', 'For residents', ['Alpha.', 'Beta.', 'Gamma.']],
  ]))
  assert.deepEqual(ids(before), [3, 2, 1])
  const after = assignChangelogIds(before.ledger, before.lastId, markdown([
    ['2026-10-01', 'For residents', ['Alpha edited.', 'Beta edited.', 'Delta.', 'Gamma.']],
  ]))
  assert.equal(after.ledger[3]?.id, 1, 'unchanged text keeps its id')
  assert.deepEqual(ids(after).slice(0, 3), [6, 5, 4], 'unpaired bullets get new ids from the bottom up')
  assert.equal(after.lastId, 6)

  const removed = assignChangelogIds(after.ledger, after.lastId, markdown([
    ['2026-10-01', 'For residents', ['Gamma.']],
  ]))
  const readded = assignChangelogIds(removed.ledger, removed.lastId, markdown([
    ['2026-10-02', 'For residents', ['Epsilon.']],
    ['2026-10-01', 'For residents', ['Gamma.']],
  ]))
  assert.deepEqual(ids(readded), [7, 1], 'a dropped id is never handed out again')
})

test('a rewording beside an addition in the same group gets a new id and retires the old one', () => {
  const before = assignChangelogIds([], 0, markdown([
    ['2026-10-06', 'For residents', ['First change.', 'Second change.']],
  ]))
  assert.deepEqual(ids(before), [2, 1])
  const after = assignChangelogIds(before.ledger, before.lastId, markdown([
    ['2026-10-06', 'For residents', ['Added change.', 'First change.', 'Second change, reworded.']],
  ]))
  assert.equal(after.ledger[1]?.id, 2, 'unchanged text keeps its id')
  assert.equal(after.ledger[2]?.id, 3, 'the reworded entry gets a new id')
  assert.equal(after.ledger[0]?.id, 4)
  assert.ok(!ids(after).includes(1), 'the old id is retired')
})

test('a bullet that is both reworded and redated gets a new id', () => {
  const before = assignChangelogIds([], 0, markdown([
    ['2026-10-01', 'For residents', ['Old wording.']],
  ]))
  const after = assignChangelogIds(before.ledger, before.lastId, markdown([
    ['2026-10-02', 'For residents', ['New wording.']],
  ]))
  assert.deepEqual(ids(after), [2])
})

test('one bullet removed and one added in the same group count as a rewording', () => {
  const before = assignChangelogIds([], 0, markdown([
    ['2026-10-01', 'For residents', ['Kept.', 'Removed change.']],
  ]))
  const after = assignChangelogIds(before.ledger, before.lastId, markdown([
    ['2026-10-01', 'For residents', ['Kept.', 'Unrelated new change.']],
  ]))
  assert.deepEqual(ids(after), ids(before))
  assert.equal(after.lastId, before.lastId)
})
