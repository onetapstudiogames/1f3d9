import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildCoverageRunnerArguments,
} from '../scripts/run-tests.ts'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }

test('coverage mode enforces every production metric at 80 percent', () => {
  const arguments_ = buildCoverageRunnerArguments('C:\\isolated-suite')

  assert.equal(packageJson.devDependencies?.c8, '^12.0.0')
  assert.deepEqual(arguments_.slice(1, 13), [
    '--all',
    '--check-coverage',
    '--lines', '80',
    '--branches', '80',
    '--functions', '80',
    '--statements', '80',
    '--include', 'src/**/*.ts',
  ])
  assert.equal(arguments_.includes('scripts/**/*.ts'), true)
  assert.equal(arguments_.includes('--exclude'), false)
})
