import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client } from 'pg'

import { POSTGRES_TOOL_IMAGE, runBackup } from '../../scripts/backup.ts'
import { runRestoreDrill } from '../../scripts/restore-drill.ts'

const SOURCE_DATABASE = 'city'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ''} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

async function waitForPostgres(port: number, password: string): Promise<Client> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: SOURCE_DATABASE,
      ssl: false,
    })
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => {})
      await delay(200)
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${String(lastError)}`)
}

test('a custom archive stays coherent across a concurrent commit and restores twice', async t => {
  const runId = `${process.pid}-${randomBytes(6).toString('hex')}`
  const sourceContainer = `1f3d9-backup-source-${runId}`
  const password = randomBytes(24).toString('hex')
  const root = await mkdtemp(join(tmpdir(), '1f3d9-backup-roundtrip-'))
  const drillContainers: string[] = []
  let source: Client | undefined
  let locker: Client | undefined

  t.after(async () => {
    await locker?.end().catch(() => {})
    await source?.end().catch(() => {})
    docker(['rm', '--force', sourceContainer], true)
    for (const container of drillContainers) {
      docker(['rm', '--force', container], true)
    }
    await rm(root, { recursive: true, force: true })
  })

  docker([
    'run', '--detach', '--name', sourceContainer,
    '--label', `com.1f3d9.test=${runId}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${SOURCE_DATABASE}`,
    POSTGRES_TOOL_IMAGE,
  ])
  const portText = docker(['port', sourceContainer, '5432/tcp'])
  const port = Number(portText.match(/:(\d+)\s*$/)?.[1])
  assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port: ${portText}`)

  source = await waitForPostgres(port, password)
  await source.query(schemaDdl)
  await source.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES (20, 'backup-room-owner', 'backup-test', repeat('a', 64))
  `)
  const worldId = Number((await source.query<{ id: number }>(`
    SELECT id FROM places WHERE place_kind = 'world'
  `)).rows[0]!.id)
  const continentId = Number((await source.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Backup orientation continent', 'backup parent', 20)
    RETURNING id
  `, [worldId])).rows[0]!.id)
  const orientationRoomId = Number((await source.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'place', 'Backup orientation room', 'description survives too', 20)
    RETURNING id
  `, [continentId])).rows[0]!.id)
  const orientationThingId = Number((await source.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, maker_id, owner_id)
    VALUES ($1, 'Backup heading', 'body stays behind its heading', 20, 20)
    RETURNING id
  `, [orientationRoomId])).rows[0]!.id)
  await source.query(`
    UPDATE places
    SET purpose = 'Backup preserves owner-set orientation.',
      front_matter_thing_ids = ARRAY[$2]::integer[]
    WHERE id = $1
  `, [orientationRoomId, orientationThingId])
  await source.query(`
    CREATE TABLE backup_probe_before (id integer PRIMARY KEY, version integer NOT NULL);
    CREATE TABLE backup_probe_gate (id integer PRIMARY KEY, version integer NOT NULL);
    CREATE TABLE backup_probe_after (id integer PRIMARY KEY, version integer NOT NULL);
    INSERT INTO backup_probe_before VALUES (1, 0);
    INSERT INTO backup_probe_gate VALUES (1, 0);
    INSERT INTO backup_probe_after VALUES (1, 0);
  `)

  locker = await waitForPostgres(port, password)
  await locker.query('BEGIN')
  await locker.query('LOCK TABLE backup_probe_gate IN ACCESS EXCLUSIVE MODE')

  const databaseUrl =
    `postgres://postgres:${password}@127.0.0.1:${port}/${SOURCE_DATABASE}`
  const backupPromise = runBackup({
    argv: ['--target', 'local', '--database', SOURCE_DATABASE],
    root,
    environment: {
      CONFIRM_LOCAL_BACKUP: 'CREATE_1F3D9_LOCAL_RECOVERY_ARCHIVE',
      LOCAL_DATABASE_URL_UNPOOLED: databaseUrl,
    },
    log: () => {},
  })

  const waitDeadline = Date.now() + 60_000
  let dumpIsWaiting = false
  while (Date.now() < waitDeadline) {
    const waiting = await source.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'pg_dump'
          AND wait_event_type = 'Lock'
      ) AS waiting
    `)
    if (waiting.rows[0]?.waiting) {
      dumpIsWaiting = true
      break
    }
    await delay(100)
  }
  assert.equal(dumpIsWaiting, true, 'pg_dump never reached the controlled lock gate')

  await source.query(`
    BEGIN;
    UPDATE backup_probe_before SET version = 1 WHERE id = 1;
    UPDATE backup_probe_after SET version = 1 WHERE id = 1;
    COMMIT;
  `)
  await locker.query('COMMIT')
  const backup = await backupPromise
  if (process.platform !== 'win32') {
    const archiveStat = await stat(backup.archivePath)
    const hostUid = process.getuid?.()
    assert.equal(archiveStat.mode & 0o777, 0o600)
    assert.equal(Number.isInteger(hostUid), true)
    assert.equal(archiveStat.uid, hostUid)
  }

  const sourceVersions = await source.query<{ before: number; after: number }>(`
    SELECT
      (SELECT version FROM backup_probe_before WHERE id = 1) AS before,
      (SELECT version FROM backup_probe_after WHERE id = 1) AS after
  `)
  assert.deepEqual(sourceVersions.rows, [{ before: 1, after: 1 }])

  const restoredVersions: Array<{ before: number; after: number }> = []
  const reports = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const report = await runRestoreDrill({
      argv: ['--archive', backup.archivePath],
      onContainerCreated: containerName => drillContainers.push(containerName),
      onRestored: async ({ query }) => {
        const output = await query(`
          SELECT
            (SELECT version FROM backup_probe_before WHERE id = 1),
            (SELECT version FROM backup_probe_after WHERE id = 1)
        `)
        const [before, after] = output.split('|').map(Number)
        assert.equal(Number.isSafeInteger(before), true)
        assert.equal(Number.isSafeInteger(after), true)
        restoredVersions.push({ before: before!, after: after! })
        const orientation = await query(`
          SELECT place.purpose, cardinality(place.front_matter_thing_ids), thing.name
          FROM places place
          JOIN things thing ON thing.id = place.front_matter_thing_ids[1]
          WHERE place.name = 'Backup orientation room'
        `)
        assert.equal(
          orientation,
          'Backup preserves owner-set orientation.|1|Backup heading',
        )
      },
      log: () => {},
    })
    reports.push(report)
  }

  assert.deepEqual(restoredVersions, [
    { before: 0, after: 0 },
    { before: 0, after: 0 },
  ])
  assert.deepEqual(reports[0]?.checks, reports[1]?.checks)
  assert.ok((reports[0]?.checks.publicTables ?? 0) >= 36)
  assert.equal(reports[0]?.checks.unvalidatedConstraints, 0)
  assert.ok((reports[0]?.checks.userTriggers ?? 0) > 0)
  assert.equal(reports[0]?.checks.writeSmoke, 'passed')

  for (const container of drillContainers) {
    const inspect = spawnSync('docker', ['inspect', container], { encoding: 'utf8' })
    assert.notEqual(inspect.status, 0, `restore drill container still exists: ${container}`)
  }

  let failedContainer = ''
  await assert.rejects(
    runRestoreDrill({
      argv: ['--archive', backup.archivePath],
      onContainerCreated: containerName => {
        failedContainer = containerName
        drillContainers.push(containerName)
      },
      onRestored: async () => {
        throw new Error('injected post-restore verification failure')
      },
      log: () => {},
    }),
    /injected post-restore verification failure/,
  )
  assert.ok(failedContainer)
  const failedInspect = spawnSync('docker', ['inspect', failedContainer], { encoding: 'utf8' })
  assert.notEqual(failedInspect.status, 0, 'failed restore drill container was not removed')
})
