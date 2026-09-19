import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finalNonEmptyLine, createPreparationFixture } from '../helpers/deploy-safety-fixtures/preparation-worktree.ts'

export function registerBranchPreparationTests(): void {
  test('preparation proves a clean pushed branch and release prerequisites without repeating CI', t => {
    const fixture = createPreparationFixture()
    t.after(() => fixture.cleanup())
    const result = fixture.run()

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(
      finalNonEmptyLine(result.stdout),
      `GATE_EXIT=${result.status}`,
      'the final non-empty stdout line must report the captured process status',
    )
    assert.match(result.stdout, /did not deploy/i)
    assert.match(result.stdout, /merge[^\n]*main/i)
    assert.equal(existsSync(fixture.commandLog), false)
  })

  test('dirty or not-pushed work stops before any preparation gate', t => {
    const dirty = createPreparationFixture()
    t.after(() => dirty.cleanup())
    writeFileSync(join(dirty.root, 'untracked.txt'), 'not reviewed\n')
    const dirtyResult = dirty.run()
    assert.notEqual(dirtyResult.status, 0)
    assert.equal(
      finalNonEmptyLine(dirtyResult.stdout),
      `GATE_EXIT=${dirtyResult.status}`,
      'the final non-empty stdout line must report the captured dirty-worktree status',
    )
    assert.match(`${dirtyResult.stdout}\n${dirtyResult.stderr}`, /worktree.*clean/i)
    assert.equal(existsSync(dirty.commandLog), false)

    const unpushed = createPreparationFixture()
    t.after(() => unpushed.cleanup())
    writeFileSync(join(unpushed.root, 'README.md'), 'new unpushed commit\n')
    unpushed.git('add', 'README.md')
    unpushed.git('commit', '-q', '-m', 'unpushed')
    const unpushedResult = unpushed.run()
    assert.notEqual(unpushedResult.status, 0)
    assert.equal(
      finalNonEmptyLine(unpushedResult.stdout),
      `GATE_EXIT=${unpushedResult.status}`,
      'the final non-empty stdout line must report the captured unpushed-branch status',
    )
    assert.match(`${unpushedResult.stdout}\n${unpushedResult.stderr}`, /pushed.*origin/i)
    assert.equal(existsSync(unpushed.commandLog), false)
  })

  test('missing, stale, pending, cancelled, failed, or unrelated required CI stops preparation', t => {
    const cases = [
      ['missing', { TEST_REQUIRED_CHECK_MODE: 'missing' }],
      ['stale', { TEST_REQUIRED_CHECK_HEAD_SHA: '2'.repeat(40) }],
      ['pending', {
        TEST_REQUIRED_CHECK_STATUS: 'in_progress',
        TEST_REQUIRED_CHECK_CONCLUSION: 'null',
      }],
      ['cancelled', { TEST_REQUIRED_CHECK_CONCLUSION: 'cancelled' }],
      ['failed', { TEST_REQUIRED_CHECK_CONCLUSION: 'failure' }],
      ['skipped', { TEST_REQUIRED_CHECK_CONCLUSION: 'skipped' }],
      ['neutral', { TEST_REQUIRED_CHECK_CONCLUSION: 'neutral' }],
      ['timed out', { TEST_REQUIRED_CHECK_CONCLUSION: 'timed_out' }],
      ['action required', { TEST_REQUIRED_CHECK_CONCLUSION: 'action_required' }],
      ['unrelated name', { TEST_REQUIRED_CHECK_NAME: 'other' }],
      ['unrelated app', { TEST_REQUIRED_CHECK_APP_ID: '1' }],
      ['API failure', { TEST_REQUIRED_CHECK_MODE: 'api-failure' }],
    ] as const

    for (const [label, environment] of cases) {
      const fixture = createPreparationFixture()
      t.after(() => fixture.cleanup())
      const result = fixture.run(environment)
      assert.notEqual(result.status, 0, label)
      assert.match(`${result.stdout}\n${result.stderr}`, /required.*checks.*candidate/iu, label)
      assert.equal(existsSync(fixture.commandLog), false, label)
    }
  })
}
