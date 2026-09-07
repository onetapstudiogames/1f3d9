import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finalNonEmptyLine, createPreparationFixture } from '../helpers/deploy-safety-fixtures/preparation-worktree.ts'

export function registerBranchPreparationTests(): void {
  test('preparation proves a clean GitHub branch and runs every local gate without deploying', t => {
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
    const commands = readFileSync(fixture.commandLog, 'utf8')
    for (const command of ['npm test', 'npm run typecheck', 'npm run test:postgres', 'npm run test:e2e']) {
      assert.match(commands, new RegExp(`^${command}$`, 'm'))
    }
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
}
