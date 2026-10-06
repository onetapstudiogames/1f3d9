// Permanent ids for changelog entries (one entry = one bullet in CHANGELOG.md).
//
// CHANGELOG.md stays the one source of every sentence; this ledger only holds
// identity. scripts/embed-changelog.mjs reads the previous ledger out of
// src/changelog-source.ts, calls assignChangelogIds, and writes the result
// back. The rules, in order:
//   (a) a bullet whose exact text matches an unused ledger row takes that
//       row's id, whatever its date or category now is (a redated entry
//       keeps its id);
//   (b) within one date and category, when the unmatched old rows and the
//       unmatched new bullets are equal in number, they pair in file order
//       as edits and keep their ids; otherwise none of them pair;
//   (c) every bullet still without an id gets lastId + 1 upward, counted from
//       the bottom of the file up, so newer bullets get higher ids;
//   (d) an id that is dropped is never handed out again, because lastId only
//       ever grows.
// The parse below matches parseChangelog in src/changelog.ts;
// test/changelog-ids.test.ts checks the two agree bullet for bullet.
import { createHash } from 'node:crypto'

export function parseChangelogBullets(markdown) {
  const bullets = []
  let date = null
  let category = null
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trimEnd()
    const dateHeading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line)
    if (dateHeading) {
      date = dateHeading[1]
      category = null
      continue
    }
    const categoryHeading = /^###\s+(.+?)\s*$/u.exec(line)
    if (categoryHeading && date !== null) {
      category = categoryHeading[1]
      continue
    }
    const bullet = /^-\s+(.+?)\s*$/u.exec(line)
    if (bullet && date !== null && category !== null) {
      bullets.push({ date, category, text: bullet[1] })
    }
  }
  return bullets
}

export function changelogBulletSha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const groupKey = (date, category) => `${date}\n${category}`

export function assignChangelogIds(previousLedger, lastId, markdown) {
  const bullets = parseChangelogBullets(markdown).map(bullet => ({
    ...bullet,
    sha256: changelogBulletSha256(bullet.text),
  }))
  const assigned = new Array(bullets.length).fill(null)
  const used = new Set()

  // (a) exact text, any date or category.
  const rowsBySha = new Map()
  for (const row of previousLedger) {
    const queue = rowsBySha.get(row.sha256) ?? []
    queue.push(row)
    rowsBySha.set(row.sha256, queue)
  }
  bullets.forEach((bullet, index) => {
    const queue = rowsBySha.get(bullet.sha256)
    const row = queue?.find(candidate => !used.has(candidate.id))
    if (row === undefined) return
    used.add(row.id)
    assigned[index] = row.id
  })

  // (b) edits: equal counts of leftovers in one date and category pair in order.
  const oldLeftovers = new Map()
  for (const row of previousLedger) {
    if (used.has(row.id)) continue
    const key = groupKey(row.date, row.category)
    oldLeftovers.set(key, [...(oldLeftovers.get(key) ?? []), row])
  }
  const newLeftovers = new Map()
  bullets.forEach((bullet, index) => {
    if (assigned[index] !== null) return
    const key = groupKey(bullet.date, bullet.category)
    newLeftovers.set(key, [...(newLeftovers.get(key) ?? []), index])
  })
  for (const [key, indexes] of newLeftovers) {
    const rows = oldLeftovers.get(key) ?? []
    if (rows.length !== indexes.length) continue
    indexes.forEach((bulletIndex, position) => {
      const row = rows[position]
      used.add(row.id)
      assigned[bulletIndex] = row.id
    })
  }

  // (c) and (d): new ids from the bottom of the file up, never below a used id.
  let nextLastId = Math.max(lastId, ...previousLedger.map(row => row.id), 0)
  for (let index = bullets.length - 1; index >= 0; index -= 1) {
    if (assigned[index] !== null) continue
    nextLastId += 1
    assigned[index] = nextLastId
  }

  return {
    ledger: bullets.map((bullet, index) => ({
      id: assigned[index],
      date: bullet.date,
      category: bullet.category,
      sha256: bullet.sha256,
    })),
    lastId: nextLastId,
  }
}
