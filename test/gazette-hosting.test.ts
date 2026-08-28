import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Vercel invokes the Gazette printer on Monday at 16:00 UTC', () => {
  const configuration = JSON.parse(read('../vercel.json')) as {
    crons?: Array<{ path: string; schedule: string }>
  }
  assert.deepEqual(configuration.crons?.find(cron => (
    cron.path === '/api/internal/gazette-print'
  )), {
    path: '/api/internal/gazette-print',
    schedule: '0 16 * * 1',
  })
})

test('release preparation acknowledges only the dormant Gazette schema', () => {
  const deploy = read('../scripts/deploy.sh')
  assert.match(
    deploy,
    /CONFIRM_GAZETTE_SCHEMA_MIGRATION[\s\S]*APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_ROOM_CLOSED/u,
  )
  assert.doesNotMatch(deploy, /CONFIRM_GAZETTE_ROOM_ACTIVATION/iu)
  assert.doesNotMatch(deploy, /CONFIRM_GAZETTE_MIGRATION/iu)
  assert.match(
    deploy,
    /Gazette schema.*Preview and Production.*room #454.*closed/isu,
  )
})

test('Gazette rollout opens Preview before review and Production only after merge', () => {
  const deployment = read('../docs/runbooks/DEPLOYMENT.md')
  const previewSchema = deployment.indexOf('npm run migrate:preview:gazette')
  const productionSchema = deployment.indexOf('npm run migrate:production:gazette')
  const previewActivation = deployment.indexOf(
    'npm run migrate:preview:gazette-room-activation',
  )
  const openPullRequest = deployment.indexOf('Open the Gazette pull request')
  const humanMerge = deployment.indexOf('After a human merges the pull request')
  const productionActivation = deployment.indexOf(
    'npm run migrate:production:gazette-room-activation',
  )

  assert.ok(previewSchema >= 0 && previewSchema < previewActivation)
  assert.ok(productionSchema >= 0 && productionSchema < previewActivation)
  assert.ok(previewActivation < openPullRequest)
  assert.ok(openPullRequest < humanMerge)
  assert.ok(humanMerge < productionActivation)
  assert.match(
    deployment,
    /GAZETTE_PREVIEW_ORIGIN=https:\/\/1f3d9-[a-z0-9]{9}-onetapstudiogames-projects\.vercel\.app[\s\S]*GAZETTE_DEPLOYMENT_COMMIT=<40-lowercase-hex-preview-commit>[\s\S]*migrate:preview:gazette-room-activation/u,
  )
  assert.match(
    deployment,
    /GET \/api\/official[\s\S]*deployment_commit[\s\S]*exact PR head commit/iu,
  )
  assert.match(
    deployment,
    /Keep\s+Production room #454 closed while the pull request is open/u,
  )
  assert.match(
    deployment,
    /GAZETTE_DEPLOYMENT_COMMIT=<40-lowercase-hex-production-commit>[\s\S]*migrate:production:gazette-room-activation/u,
  )
  assert.match(
    deployment,
    /safe to rerun[\s\S]*exactly one[^\n]*opening event/iu,
  )
  assert.match(
    deployment,
    /proves[^\n]*deployed commit[\s\S]*database target[\s\S]*proves[^\n]*deployed commit[^\n]*again[^\n]*immediately before[^\n]*activation/iu,
  )
  assert.match(
    deployment,
    /must not roll back[\s\S]*Gazette-capable\s+application/iu,
  )
})

test('Gazette rollout variables and two-phase ownership stay documented', () => {
  const environment = read('../docs/runbooks/ENVIRONMENT.md')
  const architecture = read('../docs/ARCHITECTURE.md')

  assert.match(environment, /CONFIRM_GAZETTE=INSTALL_GAZETTE_ARCHIVE_AND_SUBMISSION_LIMIT/u)
  assert.match(
    environment,
    /CONFIRM_GAZETTE_ROOM_ACTIVATION=OPEN_GAZETTE_ROOM_AFTER_MATCHING_APP_DEPLOYMENT/u,
  )
  assert.match(environment, /GAZETTE_DEPLOYMENT_COMMIT/u)
  assert.match(
    environment,
    /GAZETTE_PREVIEW_ORIGIN[\s\S]*9 lowercase alphanumeric[\s\S]*branch aliases and other Vercel projects are refused/iu,
  )
  assert.match(
    environment,
    /CONFIRM_GAZETTE_SCHEMA_MIGRATION=APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_ROOM_CLOSED/u,
  )

  assert.match(
    architecture,
    /gazette` migration[\s\S]*does not open room #454/iu,
  )
  assert.match(
    architecture,
    /gazette-room-activation[\s\S]*exact deployed\s+application commit/iu,
  )
  assert.match(architecture, /Production remains closed while the pull request is open/u)
})

test('protected room write refusals stay caller-worded at both execution boundaries', () => {
  const index = read('../src/index.ts')
  const engine = read('../src/engine.ts')
  assert.match(index, /gazetteRoomLifecycleRefusal\(error\)[\s\S]*err\(c, 409/iu)
  assert.match(engine, /gazetteRoomLifecycleRefusal\(error\)[\s\S]*EngineError\(409/iu)
})
