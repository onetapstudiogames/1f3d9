import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// Postgres refuses to prepare a statement whose parameter it cannot type
// (error 42P18), and a placeholder that the SQL never references has no type.
// The fake database in the unit tests never notices; production did, on the
// first real world-aisle claim (2026-09-04). This scans every static
// query(`...`, [...]) pair in src and requires every $1..$n to be referenced.
// Statements built from interpolated fragments are skipped: their placeholders
// live in the fragments.
const SRC = join(process.cwd(), 'src')
const files = readdirSync(SRC).filter(name => name.endsWith('.ts'))
const pairs = /query\(\s*`([^`]*)`\s*,\s*\[([^\]]*)\]/gsu

test('every static SQL statement references every parameter it is given', () => {
  const problems: string[] = []
  let checked = 0
  for (const name of files) {
    const source = readFileSync(join(SRC, name), 'utf8')
    for (const match of source.matchAll(pairs)) {
      const sql = match[1] ?? ''
      const params = match[2] ?? ''
      if (sql.includes('${')) continue
      const count = params.split(',').map(part => part.trim()).filter(part => part && !part.startsWith('//')).length
      if (count === 0) continue
      checked += 1
      const used = new Set([...sql.matchAll(/\$(\d+)/gu)].map(hit => Number(hit[1])))
      const line = source.slice(0, match.index).split(/\r?\n/u).length
      for (let index = 1; index <= count; index += 1) {
        if (!used.has(index)) problems.push(`${name}:${line} never references $${index} of ${count}`)
      }
      for (const index of used) {
        if (index > count) problems.push(`${name}:${line} references $${index} but is given ${count}`)
      }
    }
  }
  assert.ok(checked > 20, `expected to check many statements, checked ${checked}`)
  assert.deepEqual(problems, [])
})
