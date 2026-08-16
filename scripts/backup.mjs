// Create a complete JSON snapshot of every public table.
//
//   node scripts/backup.mjs
//   node scripts/backup.mjs --out C:\safe\manual-copy.json
//   node scripts/backup.mjs --keep 60
//
// A custom --out is never pruned. Managed backups are written under backups/
// and pruning happens only after the replacement file is safely in place.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_KEEP = 30
const SNAPSHOT_PATTERN = /^1f3d9-.*\.json$/

export function parseBackupArgs(argv) {
  let out
  let keep = DEFAULT_KEEP
  const seen = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--out' && flag !== '--keep') {
      throw new Error(`unknown argument: ${safeDisplay(flag)}`)
    }
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`)
    seen.add(flag)

    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`)
    }
    index += 1

    if (flag === '--out') {
      out = value
      continue
    }
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error('--keep needs a positive integer')
    }
    keep = Number(value)
    if (!Number.isSafeInteger(keep)) {
      throw new Error('--keep needs a positive integer')
    }
  }

  return { out, keep }
}

export function quoteSqlIdentifier(identifier) {
  if (typeof identifier !== 'string' || identifier.includes('\0')) {
    throw new Error('invalid SQL identifier')
  }
  return `"${identifier.replaceAll('"', '""')}"`
}

export function shouldPruneBackups(options) {
  return options.out === undefined
}

export function fullTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function safeDisplay(value) {
  return JSON.stringify(String(value))
}

export function parseEnvText(text) {
  const values = Object.create(null)
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim()
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    values[key] = rawValue.replace(/^(["'])(.*)\1$/, '$2')
  }
  return values
}

export function resolveDatabaseUrl(root = ROOT, environment = process.env) {
  if (environment.DATABASE_URL) return environment.DATABASE_URL
  for (const name of ['.env.local', '.env.deploy', 'env.txt']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const value = parseEnvText(readFileSync(path, 'utf8')).DATABASE_URL
    if (value) return value
  }
  throw new Error(
    'DATABASE_URL not found in the environment, .env.local, .env.deploy, or env.txt',
  )
}

function randomHex(byteCount = 8) {
  return randomBytes(byteCount).toString('hex')
}

function tempPathFor(outputPath, nonce = randomHex()) {
  return join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${nonce}.tmp`)
}

async function setPrivateMode(fileHandle) {
  try {
    await fileHandle.chmod(0o600)
  } catch (error) {
    if (!['EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error
  }
}

export async function writeJsonAtomic(outputPath, json, dependencies = {}) {
  const makeTempPath = dependencies.makeTempPath ?? tempPathFor
  const tempPath = makeTempPath(outputPath)
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })

  let fileHandle
  let created = false
  try {
    fileHandle = await open(tempPath, 'wx', 0o600)
    created = true
    await setPrivateMode(fileHandle)
    await fileHandle.writeFile(json, { encoding: 'utf8' })
    await fileHandle.sync()
    await fileHandle.close()
    fileHandle = undefined
    await rename(tempPath, outputPath)
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {})
    if (created) await unlink(tempPath).catch(() => {})
    throw error
  }
}

function rowsFrom(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  throw new Error('database returned an unexpected result')
}

async function pruneManagedBackups(directory, keep) {
  const entries = await readdir(directory, { withFileTypes: true })
  const snapshots = entries
    .filter(entry => entry.isFile() && SNAPSHOT_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - keep))
  for (const name of stale) await unlink(join(directory, name))
  return { kept: snapshots.length - stale.length, pruned: stale.length }
}

async function defaultConnect(databaseUrl) {
  const { neon } = await import('@neondatabase/serverless')
  return neon(databaseUrl)
}

export async function runBackup({
  options,
  root = ROOT,
  cwd = process.cwd(),
  environment = process.env,
  connect = defaultConnect,
  now = () => new Date(),
  log = console.log,
}) {
  const databaseUrl = resolveDatabaseUrl(root, environment)
  const database = await connect(databaseUrl)
  const tableRows = rowsFrom(await database.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `))
  const tables = tableRows.map(row => row.table_name)
  if (tables.length === 0) {
    throw new Error('no public tables found; refusing to write an empty backup')
  }

  const data = Object.create(null)
  const counts = Object.create(null)
  for (const table of tables) {
    const rows = rowsFrom(await database.query(`SELECT * FROM ${quoteSqlIdentifier(table)}`))
    data[table] = rows
    counts[table] = rows.length
  }

  const takenAt = now()
  const managedDirectory = join(root, 'backups')
  const outputPath = options.out === undefined
    ? join(managedDirectory, `1f3d9-${fullTimestamp(takenAt)}.json`)
    : resolve(cwd, options.out)
  const json = JSON.stringify({
    site: '1f3d9.com',
    taken_at: takenAt.toISOString(),
    tables: counts,
    data,
  }, null, 2)

  await writeJsonAtomic(outputPath, json)

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  log(`${tables.length} tables, ${total} rows -> ${safeDisplay(outputPath)}`)
  for (const table of tables) log(`  ${String(counts[table]).padStart(6)}  ${safeDisplay(table)}`)

  let retention = { kept: 0, pruned: 0, skipped: true }
  if (shouldPruneBackups(options)) {
    retention = {
      ...await pruneManagedBackups(managedDirectory, options.keep),
      skipped: false,
    }
    log(
      `${retention.kept} snapshots kept` +
      (retention.pruned ? `, ${retention.pruned} pruned` : ''),
    )
  } else {
    log('custom output selected; managed-snapshot pruning skipped')
  }

  return { outputPath, tables: tables.length, rows: total, retention }
}

export async function backupMain(argv = process.argv.slice(2), dependencies = {}) {
  return runBackup({ options: parseBackupArgs(argv), ...dependencies })
}

function isMainModule() {
  if (!process.argv[1]) return false
  const modulePath = resolve(fileURLToPath(import.meta.url))
  const invokedPath = resolve(process.argv[1])
  return process.platform === 'win32'
    ? modulePath.toLowerCase() === invokedPath.toLowerCase()
    : modulePath === invokedPath
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted database URL]')
    .replace(/DATABASE_URL\s*=\s*[^\s]+/gi, 'DATABASE_URL=[redacted]')
}

if (isMainModule()) {
  void backupMain().catch(error => {
    console.error(`backup failed: ${safeErrorMessage(error)}`)
    process.exitCode = 1
  })
}
