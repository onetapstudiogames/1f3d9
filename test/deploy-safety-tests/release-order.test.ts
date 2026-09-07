import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deploymentRunbook, environmentRunbook, assertPostgresTestDiscovered } from '../helpers/deploy-safety-fixtures/release-documents.ts'

export function registerReleaseOrderTests(): void {
  test('release instructions require maker provenance before later-holder marks in each database', () => {
    const previewMaker = deploymentRunbook.indexOf('npm run migrate:preview:thing-maker')
    const previewMarks = deploymentRunbook.indexOf('npm run migrate:preview:later-holder-marks')
    const productionMaker = deploymentRunbook.indexOf('npm run migrate:production:thing-maker')
    const productionMarks = deploymentRunbook.indexOf('npm run migrate:production:later-holder-marks')

    assert.ok(previewMaker >= 0 && previewMaker < previewMarks)
    assert.ok(productionMaker >= 0 && productionMaker < productionMarks)
    assert.match(
      deploymentRunbook,
      /CONFIRM_THING_MAKER_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
    )
  })

  test('Gazette withdrawal release instructions keep schema dormant until exact-commit activation', () => {
    const previewDormant = deploymentRunbook.indexOf(
      'npm run migrate:preview:gazette-withdrawal',
    )
    const previewActivation = deploymentRunbook.indexOf(
      'npm run migrate:preview:gazette-withdrawal-activation',
    )
    const productionDormant = deploymentRunbook.indexOf(
      'npm run migrate:production:gazette-withdrawal',
    )
    const productionActivation = deploymentRunbook.indexOf(
      'npm run migrate:production:gazette-withdrawal-activation',
    )

    assert.ok(previewDormant >= 0 && previewDormant < previewActivation)
    assert.ok(productionDormant >= 0 && productionDormant < productionActivation)
    assert.match(
      deploymentRunbook,
      /CONFIRM_GAZETTE_WITHDRAWAL=INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER/u,
    )
    assert.match(
      deploymentRunbook,
      /CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION=OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT/u,
    )
    assert.match(
      deploymentRunbook,
      /withdrawals_open[\s\S]*false[\s\S]*exact[ -]commit[\s\S]*\/api\/official[\s\S]*withdrawals_open[\s\S]*true/iu,
    )
    assert.match(
      deploymentRunbook,
      /Preview database lacks the Gazette base schema[\s\S]*500[\s\S]*not[\s\S]*withdrawal rollout/iu,
    )
    assert.match(
      deploymentRunbook,
      /while[\s\S]{0,180}withdrawals_open[\s\S]{0,80}false[\s\S]{0,320}intercepts? no[\s\S]{0,100}(?:Room #454 )?bod/iu,
    )
    assert.match(
      deploymentRunbook,
      /WITHDRAW #<digits>[\s\S]{0,260}WITHDRAW #12x[\s\S]{0,260}WITHDRAW my nomination for mayor, a poem[\s\S]{0,260}ordinary submissions/iu,
    )
    assert.match(
      deploymentRunbook,
      /ordinary submissions[\s\S]{0,320}(?:use|spend)[\s\S]{0,120}weekly[\s\S]{0,80}slot[\s\S]{0,260}(?:can|may|eligible to) print[\s\S]{0,260}no withdrawal ledger[\s\S]{0,200}no withdrawal refusal/iu,
    )
    assert.match(
      deploymentRunbook,
      /withdrawals_open[\s\S]{0,80}true[\s\S]{0,180}exact uppercase[\s\S]{0,80}WITHDRAW[\s\S]{0,100}optional whitespace[\s\S]{0,80}#/iu,
    )
    assert.match(deploymentRunbook, /command-shaped near-miss[\s\S]{0,120}refus/iu)
    assert.match(deploymentRunbook, /all six[\s\S]{0,80}refusal statuses and messages/iu)
    assert.match(
      deploymentRunbook,
      /withdrawals[\s\S]{0,40}(?:are|remain) closed[\s\S]{0,180}reserved-opening shapes[\s\S]{0,160}(?:replay normally|normal same-body replay)/iu,
    )
    assert.match(
      deploymentRunbook,
      /after[\s\S]{0,40}activation[\s\S]{0,160}unledgered reserved opening[\s\S]{0,180}active rule[\s\S]{0,220}ordinary prose[\s\S]{0,180}ledgered withdrawal[\s\S]{0,40}commands[\s\S]{0,140}normal replay/iu,
    )
    assert.match(
      environmentRunbook,
      /CONFIRM_GAZETTE_WITHDRAWAL[\s\S]*INSTALL_DORMANT_GAZETTE_WITHDRAWAL_LEDGER[\s\S]*CONFIRM_GAZETTE_WITHDRAWAL_ACTIVATION[\s\S]*OPEN_GAZETTE_WITHDRAWALS_AFTER_MATCHING_APP_DEPLOYMENT/iu,
    )
    assert.match(
      environmentRunbook,
      /GAZETTE_DEPLOYMENT_COMMIT[\s\S]*room and withdrawal activations/iu,
    )
  })

  test('production drawing migrations have one guarded order and rollback boundary', () => {
    const drawingContract = deploymentRunbook.indexOf(
      'npm run migrate:production:drawing-contract',
    )
    const worldRootDrawing = deploymentRunbook.indexOf(
      'npm run migrate:production:world-root-drawing',
    )

    assert.ok(drawingContract >= 0 && drawingContract < worldRootDrawing)
    assert.match(
      deploymentRunbook,
      /CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION/u,
    )
    assert.match(
      deploymentRunbook,
      /fresh[^\n]*PRODUCTION_SNAPSHOT_NAME[^\n]*each production drawing command/iu,
    )
    for (const postcondition of [
      'drawing_revisions',
      'residents_drawing_contract',
      'places_drawing_contract',
      'kind_revisions_drawing_contract',
      'things_drawing_contract',
      'places_world_shape',
      'places_world_drawing_exact',
      'places_protect_topology_write',
      'public_records_v2',
      'public_records_without_drawing_contract',
      'resident_edited',
      'gazette_issues',
      'gazette_issue_entries',
      'has_table_privilege',
    ]) assert.match(deploymentRunbook, new RegExp(postcondition, 'u'))
    assert.match(deploymentRunbook, /pg_get_viewdef/iu)
    assert.match(
      deploymentRunbook,
      /pg_get_viewdef\(\s*to_regclass\('city_snapshot\.public_records_v2'\)/u,
    )
    assert.doesNotMatch(
      deploymentRunbook,
      /pg_get_viewdef\(\s*'city_snapshot\.public_records_v2'::regclass/u,
    )
    assert.match(deploymentRunbook, /\{detail,error\}/u)
    assert.match(deploymentRunbook, /no_gazette[\s\S]*true[\s\S]*false/iu)
    assert.match(deploymentRunbook, /dormant[\s\S]*true[\s\S]*true/iu)
    assert.match(deploymentRunbook, /activated[\s\S]*false[\s\S]*true/iu)
    assert.match(deploymentRunbook, /application rollback[^\n]*does not revert database changes/iu)
    assert.match(deploymentRunbook, /destructive down migration[^\n]*not[^\n]*incident/iu)
    assert.match(
      deploymentRunbook,
      /CONFIRM_PRODUCTION_DRAWING_RELEASE=DRAWING_CONTRACT_THEN_WORLD_ROOT_DRAWING_APPLIED_WITH_DOCUMENTED_DRAWING_GAZETTE_WORLD_POSTCONDITIONS_RECORDED/u,
    )
    assert.match(
      environmentRunbook,
      /CONFIRM_PRODUCTION_DRAWING_RELEASE[\s\S]*operator attestation[\s\S]*does not query Production/iu,
    )
  })

  test('PostgreSQL gate upgrades the checked-in pre-drawing production schema in release order', () => {
    const fileName = 'drawing-upgrade-postgres.test.ts'
    assertPostgresTestDiscovered(fileName)
    const entrySource = readFileSync(
      new URL(`../../test/integration/${fileName}`, import.meta.url),
      'utf8',
    )
    assert.match(entrySource, /import \{ registerReleaseOrderTests \} from '\.\/drawing-upgrade-tests\/release-order\.ts'/u)
    assert.match(entrySource, /await registerReleaseOrderTests\(/u)
    const source = [
      entrySource,
      readFileSync(
        new URL('../integration/drawing-upgrade-tests/release-order.ts', import.meta.url),
        'utf8',
      ),
    ].join('\n')
    const drawingContract = source.indexOf('await client.query(drawingContractMigrationDdl)')
    const worldRootDrawing = source.indexOf('await client.query(worldRootDrawingMigrationDdl)')

    assert.match(source, /production-pre-drawing-schema-98594c0\.sql\.gz\.base64/u)
    assert.ok(drawingContract >= 0 && drawingContract < worldRootDrawing)
    assert.match(source, /places_world_drawing_exact/u)
    assert.match(source, /places_protect_topology_write/u)
    assert.match(source, /drawing_revisions_append_only/u)
    assert.match(source, /gazetteMigrationDdl/u)
    assert.match(source, /gazetteActivationDdl/u)
    assert.match(source, /public_records_v2/u)
    assert.match(source, /public_records_without_drawing_contract/u)
    assert.match(source, /resident_edited/u)
    assert.match(source, /drawing_upgrade_private_fixture/u)
    assert.match(source, /gazette_issues/u)
    assert.match(source, /snapshotExportPrivileges/u)
  })

  test('release preparation requires the resumable-registration schema in Preview and Production', () => {
    assert.match(deploymentRunbook, /npm run migrate:preview:resumable-registration/u)
    assert.match(deploymentRunbook, /npm run migrate:production:resumable-registration/u)
    assert.match(
      deploymentRunbook,
      /CONFIRM_RESUMABLE_REGISTRATION_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
    )
  })

  test('release preparation requires the PayPal credit disputes schema in Preview and Production', () => {
    assert.match(deploymentRunbook, /npm run migrate:preview:paypal-credit-disputes/u)
    assert.match(deploymentRunbook, /npm run migrate:production:paypal-credit-disputes/u)
    assert.match(
      deploymentRunbook,
      /CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
    )
  })

  test('release preparation requires the resident refusal state schema in Preview and Production', () => {
    assert.match(deploymentRunbook, /npm run migrate:preview:resident-refusal-state/u)
    assert.match(deploymentRunbook, /npm run migrate:production:resident-refusal-state/u)
    assert.match(
      deploymentRunbook,
      /CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
    )
    assert.match(environmentRunbook, /CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION/u)
  })

  test('release preparation requires the resident awareness schema in Preview and Production', () => {
    assert.match(deploymentRunbook, /npm run migrate:preview:resident-awareness/u)
    assert.match(deploymentRunbook, /npm run migrate:production:resident-awareness/u)
    assert.match(
      deploymentRunbook,
      /CONFIRM_RESIDENT_AWARENESS_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION/u,
    )
    assert.match(environmentRunbook, /CONFIRM_RESIDENT_AWARENESS_MIGRATION/u)
  })
}
