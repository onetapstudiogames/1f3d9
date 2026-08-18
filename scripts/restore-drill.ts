// Verify and restore a 1F3D9 archive into an owned, disposable PostgreSQL container.
// Usage: node --experimental-strip-types scripts/restore-drill.ts --archive <file.dump>
import { createHash, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  POSTGRES_TOOL_IMAGE,
  dockerBindMount,
  runCommand,
  safeError,
  sha256File,
} from './backup.ts'
import { isSafeIdentifier } from './database-target.ts'

type ArchiveManifest = Readonly<{
  schema_version: 1
  artifact: 'postgresql-custom-archive'
  taken_at: string
  target: Readonly<{
    mode: 'local' | 'preview' | 'production'
    database: string
    endpoint_fingerprint: string
    project_id?: string
    branch_id?: string
  }>
  archive: Readonly<{
    file: string
    format: 'custom'
    bytes: number
    sha256: string
    toc_entries: number
  }>
}>

export type RestoreChecks = Readonly<{
  publicTables: number
  unvalidatedConstraints: number
  invalidIndexes: number
  userTriggers: number
  residents: number
  places: number
  events: number
  notes: number
  writeSmoke: 'passed'
}>

type RestoredContext = Readonly<{
  containerName: string
  databaseName: string
  query: (sql: string) => Promise<string>
}>

type PerformDrill = (options: Readonly<{
  archivePath: string
  toolImage: string
  onContainerCreated?: (containerName: string) => void
  onRestored?: (context: RestoredContext) => Promise<void>
}>) => Promise<Readonly<{ checks: RestoreChecks }>>

export type RestoreDrillResult = Readonly<{
  archivePath: string
  source: ArchiveManifest['target']
  checks: RestoreChecks
}>

export function parseRestoreDrillArgs(args: readonly string[]): Readonly<{
  archive: string
  manifest: string | undefined
}> {
  let archive: string | undefined
  let manifest: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (!['--archive', '--manifest'].includes(flag)) {
      throw new Error(`unknown restore-drill argument: ${JSON.stringify(flag)}`)
    }
    if (seen.has(flag)) throw new Error(`duplicate restore-drill argument: ${flag}`)
    seen.add(flag)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    index += 1
    if (flag === '--archive') archive = value
    else manifest = value
  }
  if (!archive) throw new Error('restore drill requires --archive <file.dump>')
  return Object.freeze({ archive, manifest })
}

function manifestRecord(value: unknown): ArchiveManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('backup manifest is not an object')
  }
  const record = value as Record<string, unknown>
  const target = record.target as Record<string, unknown> | undefined
  const archive = record.archive as Record<string, unknown> | undefined
  if (
    record.schema_version !== 1 ||
    record.artifact !== 'postgresql-custom-archive' ||
    typeof record.taken_at !== 'string' || Number.isNaN(Date.parse(record.taken_at)) ||
    !target || !['local', 'preview', 'production'].includes(String(target.mode)) ||
    typeof target.database !== 'string' || !target.database ||
    typeof target.endpoint_fingerprint !== 'string' ||
    !/^[a-f0-9]{16}$/.test(target.endpoint_fingerprint) ||
    !archive || archive.format !== 'custom' ||
    typeof archive.file !== 'string' || basename(archive.file) !== archive.file ||
    !Number.isSafeInteger(archive.bytes) || Number(archive.bytes) <= 0 ||
    typeof archive.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archive.sha256) ||
    !Number.isSafeInteger(archive.toc_entries) || Number(archive.toc_entries) <= 0
  ) {
    throw new Error('backup manifest has an invalid recovery contract')
  }
  if (
    target.mode !== 'local' &&
    (!isSafeIdentifier(target.project_id) || !isSafeIdentifier(target.branch_id))
  ) {
    throw new Error(
      'remote backup manifest is missing safe project and branch target identity',
    )
  }
  return value as ArchiveManifest
}

function numberResult(value: string, label: string): number {
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`restore drill returned an invalid ${label}`)
  }
  return parsed
}

function postgresEnvironment(password: string, databaseName: string): Readonly<{
  environment: NodeJS.ProcessEnv
  keys: readonly string[]
}> {
  const variables = Object.freeze({
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: databaseName,
  })
  return Object.freeze({
    environment: Object.freeze({ ...process.env, ...variables }),
    keys: Object.freeze(Object.keys(variables)),
  })
}

export async function removeRestoreContainer(
  containerName: string,
  runner: typeof runCommand = runCommand,
): Promise<void> {
  if (!/^1f3d9-restore-drill-\d+-[a-f0-9]{16}$/.test(containerName)) {
    throw new Error('refusing to remove an invalid restore-drill container name')
  }
  try {
    await runner('docker', ['rm', '--force', containerName], {
      maxOutput: 64 * 1024,
      sensitiveOutput: true,
    })
  } catch {
    throw new Error('restore drill could not remove its owned container')
  }
}

export function combineRestoreCleanupErrors(
  restoreFailure: unknown,
  cleanupFailure: unknown,
): AggregateError {
  return new AggregateError(
    [restoreFailure, cleanupFailure],
    `restore drill failed: ${safeError(restoreFailure)}; ` +
    `cleanup also failed: ${safeError(cleanupFailure)}`,
  )
}

async function dockerRestoreDrill(options: Readonly<{
  archivePath: string
  toolImage: string
  onContainerCreated?: (containerName: string) => void
  onRestored?: (context: RestoredContext) => Promise<void>
}>): Promise<Readonly<{ checks: RestoreChecks }>> {
  const nonce = randomBytes(8).toString('hex')
  const containerName = `1f3d9-restore-drill-${process.pid}-${nonce}`
  const databaseName = 'city_restore_drill'
  const password = randomBytes(24).toString('hex')
  const environment = postgresEnvironment(password, databaseName)
  let created = false
  let restoreFailed = false
  let restoreFailure: unknown

  const query = async (sql: string): Promise<string> => {
    if (sql.includes('\0')) throw new Error('restore verification SQL contains a null byte')
    const result = await runCommand('docker', [
      'exec', containerName,
      'psql', '-X', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
      '--username', 'postgres', '--dbname', databaseName,
      '--tuples-only', '--no-align', '--field-separator=|',
      '--command', sql,
    ], { sensitiveOutput: true })
    return result.stdout.trim()
  }

  try {
    await runCommand('docker', [
      'run', '--detach', '--name', containerName,
      '--label', 'com.1f3d9.role=restore-drill',
      '--label', `com.1f3d9.run=${nonce}`,
      '--label', `com.1f3d9.expires=${new Date(Date.now() + 60 * 60_000).toISOString()}`,
      ...environment.keys.flatMap(key => ['--env', key]),
      '--mount', dockerBindMount(options.archivePath, '/backup/source.dump', true),
      options.toolImage,
    ], { environment: environment.environment, sensitiveOutput: true })
    created = true
    options.onContainerCreated?.(containerName)

    let initializationComplete = false
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const logs = await runCommand('docker', ['logs', containerName], {
        allowFailure: true,
        maxOutput: 256 * 1024,
      })
      if (`${logs.stdout}\n${logs.stderr}`.includes(
        'PostgreSQL init process complete; ready for start up.',
      )) {
        initializationComplete = true
        break
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
    }
    if (!initializationComplete) {
      throw new Error('restore drill database initialization did not finish in 30 seconds')
    }

    let ready = false
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const status = await runCommand('docker', [
        'exec', containerName,
        'pg_isready', '--username', 'postgres', '--dbname', databaseName,
      ], { allowFailure: true, maxOutput: 64 * 1024 })
      if (status.code === 0) {
        ready = true
        break
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
    }
    if (!ready) throw new Error('restore drill database did not become ready in 30 seconds')

    await runCommand('docker', [
      'exec', containerName,
      'pg_restore', '--single-transaction', '--exit-on-error',
      '--no-owner', '--no-privileges',
      '--username', 'postgres', '--dbname', databaseName,
      '/backup/source.dump',
    ], { maxOutput: 2 * 1024 * 1024, sensitiveOutput: true })

    const publicTables = numberResult(await query(`
      SELECT count(*)
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `), 'public table count')
    const missingCoreTables = numberResult(await query(`
      SELECT count(*)
      FROM unnest(ARRAY['residents', 'places', 'events', 'notes']) AS required(name)
      WHERE to_regclass('public.' || required.name) IS NULL
    `), 'required table count')
    if (missingCoreTables !== 0) throw new Error('restore drill is missing a required city table')

    const unvalidatedConstraints = numberResult(await query(
      'SELECT count(*) FROM pg_constraint WHERE NOT convalidated',
    ), 'unvalidated constraint count')
    const invalidIndexes = numberResult(await query(`
      SELECT count(*)
      FROM pg_index AS index_state
      JOIN pg_class AS relation ON relation.oid = index_state.indexrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND NOT index_state.indisvalid
    `), 'invalid index count')
    if (unvalidatedConstraints !== 0 || invalidIndexes !== 0) {
      throw new Error('restore drill found invalid constraints or indexes')
    }
    const userTriggers = numberResult(await query(`
      SELECT count(*)
      FROM pg_trigger AS trigger_state
      JOIN pg_class AS relation ON relation.oid = trigger_state.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND NOT trigger_state.tgisinternal
    `), 'user trigger count')
    if (userTriggers === 0) throw new Error('restore drill found no city triggers')

    const counts = (await query(`
      SELECT
        (SELECT count(*) FROM residents),
        (SELECT count(*) FROM places),
        (SELECT count(*) FROM events),
        (SELECT count(*) FROM notes)
    `)).split('|').map((value, index) => numberResult(value, `core count ${index + 1}`))
    if (counts.length !== 4) throw new Error('restore drill returned incomplete core counts')

    const allocatorBefore = numberResult(
      await query('SELECT last_id FROM resident_id_allocator WHERE singleton'),
      'resident allocator value',
    )
    const probeHandle = `restore-drill-${nonce}`
    const probeHash = createHash('sha256').update(probeHandle).digest('hex')
    const smokeOutput = await query(`
      BEGIN;
      WITH allocated_resident_id AS (
        UPDATE resident_id_allocator
        SET last_id = CASE WHEN last_id = 3 THEN 5 ELSE last_id + 1 END
        WHERE singleton
        RETURNING last_id AS id
      )
      INSERT INTO residents (id, handle, model, secret_hash)
      SELECT id, '${probeHandle}', 'restore-drill', '${probeHash}'
      FROM allocated_resident_id
      RETURNING id;
      ROLLBACK;
    `)
    const insertedResident = smokeOutput
      .split(/\r?\n/)
      .map(line => Number(line.trim()))
      .find(value => Number.isSafeInteger(value))
    if (!insertedResident || insertedResident <= allocatorBefore || insertedResident === 4) {
      throw new Error('restore drill resident allocator did not advance safely')
    }
    const probeRows = numberResult(
      await query(`SELECT count(*) FROM residents WHERE handle = '${probeHandle}'`),
      'write rollback count',
    )
    if (probeRows !== 0) throw new Error('restore drill write smoke did not roll back')

    const checks = Object.freeze({
      publicTables,
      unvalidatedConstraints,
      invalidIndexes,
      userTriggers,
      residents: counts[0]!,
      places: counts[1]!,
      events: counts[2]!,
      notes: counts[3]!,
      writeSmoke: 'passed' as const,
    })
    await options.onRestored?.(Object.freeze({ containerName, databaseName, query }))
    return Object.freeze({ checks })
  } catch (error) {
    restoreFailed = true
    restoreFailure = error
    throw error
  } finally {
    if (created) {
      try {
        await removeRestoreContainer(containerName)
      } catch (cleanupFailure) {
        if (restoreFailed) {
          throw combineRestoreCleanupErrors(restoreFailure, cleanupFailure)
        }
        throw cleanupFailure
      }
    }
  }
}

export async function runRestoreDrill(options: Readonly<{
  argv?: readonly string[]
  cwd?: string
  performDrill?: PerformDrill
  onContainerCreated?: (containerName: string) => void
  onRestored?: (context: RestoredContext) => Promise<void>
  log?: (line: string) => void
}> = {}): Promise<RestoreDrillResult> {
  const args = parseRestoreDrillArgs(options.argv ?? process.argv.slice(2))
  const cwd = resolve(options.cwd ?? process.cwd())
  const archivePath = resolve(cwd, args.archive)
  const manifestPath = resolve(cwd, args.manifest ?? `${archivePath}.manifest.json`)
  const manifest = manifestRecord(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (manifest.archive.file !== basename(archivePath)) {
    throw new Error('backup manifest names a different archive')
  }
  const archiveStat = await stat(archivePath)
  if (!archiveStat.isFile() || archiveStat.size !== manifest.archive.bytes) {
    throw new Error('backup archive size does not match its manifest')
  }
  const sha256 = await sha256File(archivePath)
  if (sha256 !== manifest.archive.sha256) {
    throw new Error('backup archive checksum does not match its manifest')
  }

  const callbacks = {
    archivePath,
    toolImage: POSTGRES_TOOL_IMAGE,
    ...(options.onContainerCreated ? { onContainerCreated: options.onContainerCreated } : {}),
    ...(options.onRestored ? { onRestored: options.onRestored } : {}),
  }
  const drilled = await (options.performDrill ?? dockerRestoreDrill)(callbacks)
  ;(options.log ?? console.log)(
    `restore drill passed: ${JSON.stringify(basename(archivePath))}, ` +
    `${drilled.checks.publicTables} public tables, ` +
    `${drilled.checks.unvalidatedConstraints} unvalidated constraints`,
  )
  return Object.freeze({ archivePath, source: manifest.target, checks: drilled.checks })
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) &&
    pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url
}

if (isMainModule()) {
  void runRestoreDrill().catch(error => {
    console.error(`restore drill failed: ${safeError(error)}`)
    process.exitCode = 1
  })
}
