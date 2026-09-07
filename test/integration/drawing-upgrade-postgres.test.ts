import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { Client } from 'pg'
import { registerCompletedContractRerunTests } from './drawing-upgrade-tests/completed-contract-rerun.ts'
import { registerGazetteCutoverTests } from './drawing-upgrade-tests/gazette-cutover.ts'
import { registerLegacyBridgeTests } from './drawing-upgrade-tests/legacy-bridge.ts'
import { registerReleaseOrderTests } from './drawing-upgrade-tests/release-order.ts'

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'drawing_upgrade_integration'
const PRE_DRAWING_SCHEMA_COMMIT = '98594c0081a9001d7e8653cd08ffb140c291f127'
const PRE_DRAWING_SCHEMA_SHA256 =
  '8117fe2c3f69a9a6f21c71f97a24584010883bb4167b4919acfea6ffb57af81f'
const preDrawingSchemaDdl = gunzipSync(Buffer.from((await readFile(
  new URL('../fixtures/production-pre-drawing-schema-98594c0.sql.gz.base64', import.meta.url),
  'utf8',
)).replace(/\s/gu, ''), 'base64')).toString('utf8')
const drawingContractMigrationDdl = await readFile(
  new URL('../../db/migrations/20260828_drawing_contract.sql', import.meta.url),
  'utf8',
)
const legacyDrawingsMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_drawings.sql', import.meta.url),
  'utf8',
)
const worldRootDrawingMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_world_root_drawing.sql', import.meta.url),
  'utf8',
)
const gazetteMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_gazette.sql', import.meta.url),
  'utf8',
)
const gazetteActivationDdl = await readFile(
  new URL('../../db/migrations/20260827_gazette_room_activation.sql', import.meta.url),
  'utf8',
)
function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() ||
      `exit ${result.status ?? 'unknown'}`
    throw new Error(`Docker drawing-upgrade fixture failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function connect(config: ConstructorParameters<typeof Client>[0]): Promise<Client> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    const client = new Client(config)
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => undefined)
      await delay(200)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
}

async function startPostgres(t: TestContext, purpose: string): Promise<Client> {
  const runId = `${process.pid}-${randomBytes(5).toString('hex')}`
  const container = `1f3d9-${purpose}-${runId}`
  const password = randomBytes(24).toString('hex')
  let client: Client | undefined
  t.after(async () => {
    await client?.end().catch(() => undefined)
    docker(['rm', '--force', container], true)
  })
  docker([
    'run', '--detach', '--name', container,
    '--label', `com.1f3d9.test=${runId}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  const port = Number(docker(['port', container, '5432/tcp']).match(/:(\d+)\s*$/u)?.[1])
  assert.ok(Number.isSafeInteger(port) && port > 0)
  client = await connect({
    host: '127.0.0.1', port, user: 'postgres', password,
    database: POSTGRES_DATABASE, ssl: false,
  })
  return client
}

async function snapshotExportPrivileges(client: Client): Promise<Readonly<{
  public_records: boolean
  public_records_v2: boolean
}>> {
  const privileges = (await client.query<{
    public_records: boolean
    public_records_v2: boolean
  }>(`
    SELECT
      has_table_privilege(
        'city_snapshot_export', to_regclass('city_snapshot.public_records'), 'SELECT'
      ) AS public_records,
      coalesce(has_table_privilege(
        'city_snapshot_export', to_regclass('city_snapshot.public_records_v2'), 'SELECT'
      ), FALSE) AS public_records_v2
  `)).rows[0]!
  return Object.freeze(privileges)
}

test('real PostgreSQL upgrades the exact pre-drawing production schema in release order', async t => {
  assert.equal(
    createHash('sha256').update(preDrawingSchemaDdl).digest('hex'),
    PRE_DRAWING_SCHEMA_SHA256,
    `fixture must remain the exact db/schema.sql from ${PRE_DRAWING_SCHEMA_COMMIT}`,
  )
  assert.doesNotMatch(
    preDrawingSchemaDdl,
    /drawing_state|drawing_revisions|valid_city_drawing/u,
    'the production baseline must not silently inherit current drawing objects',
  )

  const client = await startPostgres(t, 'drawing-upgrade')
  await registerReleaseOrderTests(
    client,
    preDrawingSchemaDdl,
    gazetteMigrationDdl,
    drawingContractMigrationDdl,
    worldRootDrawingMigrationDdl,
    snapshotExportPrivileges,
  )
})

test('drawing upgrade preserves an activated Gazette v2-only export cutover on rerun', async t => {
  const client = await startPostgres(t, 'drawing-gazette-activated')
  await registerGazetteCutoverTests(
    client,
    preDrawingSchemaDdl,
    gazetteMigrationDdl,
    gazetteActivationDdl,
    drawingContractMigrationDdl,
    snapshotExportPrivileges,
  )
})

test('a completed contract rerun cannot relabel later authored drawings as legacy', async t => {
  const client = await startPostgres(t, 'drawing-late-rerun')
  await registerCompletedContractRerunTests(
    client,
    preDrawingSchemaDdl,
    drawingContractMigrationDdl,
    snapshotExportPrivileges,
  )
})

test('legacy drawings bridge into one stable history row per source before the founder world write', async t => {
  const client = await startPostgres(t, 'drawing-legacy-upgrade')
  await registerLegacyBridgeTests(
    client,
    preDrawingSchemaDdl,
    legacyDrawingsMigrationDdl,
    worldRootDrawingMigrationDdl,
    drawingContractMigrationDdl,
  )
})
