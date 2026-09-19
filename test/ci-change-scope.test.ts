import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyChanges, parseNullSeparatedChanges } from '../scripts/ci-change-scope.ts'

const modified = (path: string) => ({ status: 'M', path })

test('only the two internal process documents use focused CI', () => {
  assert.equal(classifyChanges([modified('AGENTS.md')]), 'internal-process')
  assert.equal(classifyChanges([modified('docs/TESTING.md')]), 'internal-process')
  assert.equal(
    classifyChanges([modified('AGENTS.md'), modified('docs/TESTING.md')]),
    'internal-process',
  )
})

test('empty, mixed, served, workflow, unknown, added, and deleted changes use the full gate', () => {
  for (const changes of [
    [],
    [modified('AGENTS.md'), modified('src/routes.ts')],
    [modified('docs/published/FRONTDOOR.md')],
    [modified('docs/DECISIONS.md')],
    [modified('.github/workflows/ci.yml')],
    [modified('docs/new-file.md')],
    [{ status: 'A', path: 'AGENTS.md' }],
    [{ status: 'D', path: 'docs/TESTING.md' }],
  ]) {
    assert.equal(classifyChanges(changes), 'full', JSON.stringify(changes))
  }
})

test('parses no-renames name-status output and fails malformed input closed', () => {
  assert.deepEqual(
    parseNullSeparatedChanges(Buffer.from('M\0AGENTS.md\0M\0docs/TESTING.md\0')),
    [modified('AGENTS.md'), modified('docs/TESTING.md')],
  )
  assert.equal(
    classifyChanges(parseNullSeparatedChanges(Buffer.from('M\0AGENTS.md\0broken'))),
    'full',
  )
})
