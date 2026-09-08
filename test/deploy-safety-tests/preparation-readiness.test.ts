import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { withoutInheritedGitEnvironment } from '../../scripts/child-process-environment.ts'
import { createPreparationFixture } from '../helpers/deploy-safety-fixtures/preparation-worktree.ts'

export function registerPreparationReadinessTests(): void {
  test('manual deploy invocation fails closed with GitHub-to-Vercel guidance', t => {
    const fixture = createPreparationFixture()
    t.after(() => fixture.cleanup())
    const result = spawnSync('bash', ['scripts/deploy.sh'], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: withoutInheritedGitEnvironment(),
    })

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /--prepare/)
    assert.match(`${result.stdout}\n${result.stderr}`, /merge[^\n]*main/i)
    assert.equal(existsSync(fixture.commandLog), false)
  })

  test('preparation requires provider-key and migration readiness before any release gate', t => {
    const fixture = createPreparationFixture()
    t.after(() => fixture.cleanup())

    const missingProvider = fixture.run({ CONFIRM_LATER_HOLDER_PROVIDER_KEY: '' })
    assert.notEqual(missingProvider.status, 0)
    assert.match(`${missingProvider.stdout}\n${missingProvider.stderr}`, /LATER_HOLDER_CURSOR_KEY.*Vercel/iu)
    assert.equal(existsSync(fixture.commandLog), false)

    const missingMigration = fixture.run({ CONFIRM_LATER_HOLDER_MIGRATION: '' })
    assert.notEqual(missingMigration.status, 0)
    assert.match(`${missingMigration.stdout}\n${missingMigration.stderr}`, /later-holder.*migration.*before.*rollout/iu)
    assert.equal(existsSync(fixture.commandLog), false)

    const missingMakerMigration = fixture.run({ CONFIRM_THING_MAKER_MIGRATION: '' })
    assert.notEqual(missingMakerMigration.status, 0)
    assert.match(
      `${missingMakerMigration.stdout}\n${missingMakerMigration.stderr}`,
      /thing-maker.*migration.*before.*later-holder/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingResumableRegistration = fixture.run({ CONFIRM_RESUMABLE_REGISTRATION_MIGRATION: '' })
    assert.notEqual(missingResumableRegistration.status, 0)
    assert.match(
      `${missingResumableRegistration.stdout}\n${missingResumableRegistration.stderr}`,
      /resumable-registration.*migration.*Preview and Production.*before.*rollout/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingPayPalCreditDisputes = fixture.run({ CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION: '' })
    assert.notEqual(missingPayPalCreditDisputes.status, 0)
    assert.match(
      `${missingPayPalCreditDisputes.stdout}\n${missingPayPalCreditDisputes.stderr}`,
      /paypal-credit-disputes.*migration.*Preview and Production.*before.*rollout/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingResidentRefusalState = fixture.run({ CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION: '' })
    assert.notEqual(missingResidentRefusalState.status, 0)
    assert.match(
      `${missingResidentRefusalState.stdout}\n${missingResidentRefusalState.stderr}`,
      /resident-refusal-state.*migration.*Preview and Production.*before.*rollout/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingResidentAwareness = fixture.run({ CONFIRM_RESIDENT_AWARENESS_MIGRATION: '' })
    assert.notEqual(missingResidentAwareness.status, 0)
    assert.match(
      `${missingResidentAwareness.stdout}\n${missingResidentAwareness.stderr}`,
      /resident-awareness.*migration.*Preview and Production.*before.*rollout/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingMePublicCheckpoint = fixture.run({ CONFIRM_ME_PUBLIC_CHECKPOINT_MIGRATION: '' })
    assert.notEqual(missingMePublicCheckpoint.status, 0)
    assert.match(
      `${missingMePublicCheckpoint.stdout}\n${missingMePublicCheckpoint.stderr}`,
      /me-public-checkpoint.*migration.*Preview and Production.*before.*rollout/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingGazette = fixture.run({ CONFIRM_GAZETTE_SCHEMA_MIGRATION: '' })
    assert.notEqual(missingGazette.status, 0)
    assert.match(
      `${missingGazette.stdout}\n${missingGazette.stderr}`,
      /Gazette schema.*was applied.*Preview and Production.*while room #454 was closed/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const wrongGazetteState = fixture.run({
      CONFIRM_GAZETTE_SCHEMA_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
    })
    assert.notEqual(wrongGazetteState.status, 0)
    assert.match(
      `${wrongGazetteState.stdout}\n${wrongGazetteState.stderr}`,
      /Gazette schema.*was applied.*Preview and Production.*while room #454 was closed/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingGazetteWithdrawal = fixture.run({
      CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION: '',
    })
    assert.notEqual(missingGazetteWithdrawal.status, 0)
    assert.match(
      `${missingGazetteWithdrawal.stdout}\n${missingGazetteWithdrawal.stderr}`,
      /Gazette withdrawal schema.*Production.*withdrawals remained closed.*real PostgreSQL.*before.*rollout/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const wrongGazetteWithdrawalState = fixture.run({
      CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION: 'APPLIED_TO_PRODUCTION',
    })
    assert.notEqual(wrongGazetteWithdrawalState.status, 0)
    assert.match(
      `${wrongGazetteWithdrawalState.stdout}\n${wrongGazetteWithdrawalState.stderr}`,
      /Gazette withdrawal schema.*Production.*withdrawals remained closed.*real PostgreSQL.*before.*rollout/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const missingDrawingRelease = fixture.run({ CONFIRM_PRODUCTION_DRAWING_RELEASE: '' })
    assert.notEqual(missingDrawingRelease.status, 0)
    assert.match(
      `${missingDrawingRelease.stdout}\n${missingDrawingRelease.stderr}`,
      /Production drawing-contract then world-root-drawing migrations ran in that order[\s\S]*drawing\/Gazette\/world postcondition checks were recorded[\s\S]*does not query Production/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)

    const wrongDrawingRelease = fixture.run({
      CONFIRM_PRODUCTION_DRAWING_RELEASE: 'yes',
    })
    assert.notEqual(wrongDrawingRelease.status, 0)
    assert.match(
      `${wrongDrawingRelease.stdout}\n${wrongDrawingRelease.stderr}`,
      /Production drawing-contract then world-root-drawing migrations ran in that order[\s\S]*drawing\/Gazette\/world postcondition checks were recorded[\s\S]*does not query Production/iu,
    )
    assert.equal(existsSync(fixture.commandLog), false)
  })
}
