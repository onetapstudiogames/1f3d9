import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const candidate = '1111111111111111111111111111111111111111'

function checkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    name: 'checks',
    head_sha: candidate,
    status: 'completed',
    conclusion: 'success',
    app: { id: 15368 },
    ...overrides,
  }
}

function verify(response: unknown) {
  return spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/verify-required-check.mjs', import.meta.url)),
    candidate,
  ], {
    encoding: 'utf8',
    input: JSON.stringify(response),
  })
}

test('accepts the newest successful required check for the exact candidate', () => {
  const result = verify({ check_runs: [
    checkRun({ id: 9, conclusion: 'failure' }),
    checkRun({ id: 10 }),
  ] })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /required checks run 10 passed/iu)
})

test('rejects missing, stale, pending, cancelled, failed, and unrelated evidence', () => {
  const cases = [
    { label: 'missing', response: { check_runs: [] } },
    { label: 'stale', response: { check_runs: [checkRun({ head_sha: '2'.repeat(40) })] } },
    { label: 'pending', response: { check_runs: [checkRun({ status: 'in_progress', conclusion: null })] } },
    { label: 'cancelled', response: { check_runs: [checkRun({ conclusion: 'cancelled' })] } },
    { label: 'failed', response: { check_runs: [checkRun({ conclusion: 'failure' })] } },
    { label: 'skipped', response: { check_runs: [checkRun({ conclusion: 'skipped' })] } },
    { label: 'neutral', response: { check_runs: [checkRun({ conclusion: 'neutral' })] } },
    { label: 'timed out', response: { check_runs: [checkRun({ conclusion: 'timed_out' })] } },
    { label: 'action required', response: { check_runs: [checkRun({ conclusion: 'action_required' })] } },
    { label: 'wrong name', response: { check_runs: [checkRun({ name: 'other' })] } },
    { label: 'wrong app', response: { check_runs: [checkRun({ app: { id: 1 } })] } },
    { label: 'malformed', response: { nope: [] } },
  ]

  for (const { label, response } of cases) {
    const result = verify(response)
    assert.notEqual(result.status, 0, label)
  }
})

test('a newer unsuccessful run cannot reuse an older success', () => {
  const result = verify({ check_runs: [
    checkRun({ id: 10 }),
    checkRun({ id: 11, conclusion: 'cancelled' }),
  ] })

  assert.notEqual(result.status, 0)
})
