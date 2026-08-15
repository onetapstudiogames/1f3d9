// Inspect a resident, then optionally issue a replacement bearer secret.
// Dry-run is the default; --confirm is required for any database mutation.
//
//   node scripts/restore-key.mjs keeps-the-maybe
//   node scripts/restore-key.mjs keeps-the-maybe --confirm
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  fullTimestamp,
  resolveDatabaseUrl,
  safeDisplay,
} from './backup.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SECRET_PREFIX = '1f3d9_sk_'

export function parseRestoreArgs(argv) {
  let handle
  let confirmed = false

  for (const argument of argv) {
    if (argument === '--confirm') {
      if (confirmed) throw new Error('duplicate argument: --confirm')
      confirmed = true
      continue
    }
    if (argument.startsWith('--')) {
      throw new Error(`unknown argument: ${safeDisplay(argument)}`)
    }
    if (argument === '') throw new Error('handle cannot be empty')
    if (handle !== undefined) throw new Error('exactly one resident handle is required')
    handle = argument
  }

  if (handle === undefined) {
    throw new Error('usage: node scripts/restore-key.mjs <handle> [--confirm]')
  }
  return { handle, confirmed }
}

export function sanitizeHandleForFilename(handle) {
  const slug = String(handle)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  const digest = createHash('sha256').update(String(handle), 'utf8').digest('hex').slice(0, 12)
  return `${slug || 'resident'}-${digest}`
}

function assertContained(baseDirectory, candidatePath) {
  const contained = relative(baseDirectory, candidatePath)
  if (
    contained === '' ||
    isAbsolute(contained) ||
    contained === '..' ||
    contained.startsWith(`..${sep}`)
  ) {
    throw new Error('refusing to create a key outside the backups directory')
  }
}

export function buildKeyFilePath({ backupsDir, handle, now, nonce }) {
  if (!/^[a-z0-9]+$/i.test(nonce)) throw new Error('invalid key-file nonce')
  const baseDirectory = resolve(backupsDir)
  const filename = [
    'key',
    sanitizeHandleForFilename(handle),
    fullTimestamp(now).toLowerCase(),
    nonce.toLowerCase(),
  ].join('-') + '.txt'
  const candidatePath = resolve(baseDirectory, filename)
  assertContained(baseDirectory, candidatePath)
  return candidatePath
}

async function setPrivateMode(fileHandle) {
  try {
    await fileHandle.chmod(0o600)
  } catch (error) {
    if (!['EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error
  }
}

export async function writeSecretFileExclusive(path, secret) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  let fileHandle
  let created = false
  try {
    fileHandle = await open(path, 'wx', 0o600)
    created = true
    await setPrivateMode(fileHandle)
    await fileHandle.writeFile(`${secret}\n`, { encoding: 'utf8' })
    await fileHandle.sync()
    await fileHandle.close()
    fileHandle = undefined
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {})
    if (created) await unlink(path).catch(() => {})
    throw error
  }
}

function rowsFrom(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  throw new Error('database returned an unexpected result')
}

function makeDefaultSecret() {
  return SECRET_PREFIX + randomBytes(24).toString('hex')
}

function makeDefaultNonce() {
  return randomBytes(6).toString('hex')
}

async function createUniqueSecretFile({
  backupsDir,
  handle,
  secret,
  now,
  makeNonce,
}) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const path = buildKeyFilePath({
      backupsDir,
      handle,
      now,
      nonce: makeNonce(attempt),
    })
    try {
      await writeSecretFileExclusive(path, secret)
      return path
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not allocate a unique replacement-key file')
}

async function removeFailedReplacement(path, rotationError) {
  try {
    await unlink(path)
  } catch (cleanupError) {
    if (cleanupError?.code !== 'ENOENT') {
      throw new AggregateError(
        [rotationError, cleanupError],
        `key rotation failed and the replacement file could not be removed: ${safeDisplay(path)}`,
      )
    }
  }
}

export async function restoreResidentKey({
  handle,
  confirmed = false,
  database,
  backupsDir,
  makeSecret = makeDefaultSecret,
  makeNonce = makeDefaultNonce,
  now = () => new Date(),
  log = console.log,
}) {
  const residentRows = rowsFrom(await database.query(`
    SELECT id, handle, model, joined_at, secret_hash
    FROM residents
    WHERE handle = $1
  `, [handle]))
  const resident = residentRows[0]
  if (!resident) throw new Error(`no resident with handle ${safeDisplay(handle)}`)

  const ownershipRows = rowsFrom(await database.query(`
    SELECT
      (SELECT count(*) FROM places WHERE owner_id = $1) AS places,
      (SELECT count(*) FROM things WHERE owner_id = $1) AS things,
      (SELECT count(*) FROM notes WHERE author_id = $1) AS notes
  `, [resident.id]))
  const ownership = ownershipRows[0]
  if (!ownership) throw new Error('database did not return resident ownership totals')

  log(
    `resident ${safeDisplay(`#${resident.id}`)} ${safeDisplay(resident.handle)}` +
    ` (${safeDisplay(resident.model)})`,
  )
  log(`joined ${safeDisplay(resident.joined_at)}`)
  log(
    `owns ${safeDisplay(ownership.places)} places, ` +
    `${safeDisplay(ownership.things)} things, wrote ${safeDisplay(ownership.notes)} notes`,
  )

  if (!confirmed) {
    log('dry run. re-run with --confirm to issue a new secret.')
    return { rotated: false, residentId: resident.id }
  }

  const secret = makeSecret()
  const replacementHash = createHash('sha256').update(secret, 'utf8').digest('hex')
  const keyPath = await createUniqueSecretFile({
    backupsDir,
    handle: resident.handle,
    secret,
    now: now(),
    makeNonce,
  })

  let updatedRows
  try {
    updatedRows = rowsFrom(await database.query(`
      UPDATE residents
      SET secret_hash = $1
      WHERE id = $2
        AND secret_hash IS NOT DISTINCT FROM $3
      RETURNING id
    `, [replacementHash, resident.id, resident.secret_hash]))
  } catch (error) {
    await removeFailedReplacement(keyPath, error)
    throw error
  }

  if (updatedRows.length !== 1) {
    const error = new Error('resident secret changed before the rotation could finish')
    await removeFailedReplacement(keyPath, error)
    throw error
  }

  log(`new secret written to ${safeDisplay(keyPath)}`)
  log('open it, paste it into a one-time secret link, send the link, then delete the file.')
  log('tell the operator to POST /api/rotate as soon as the agent connects.')
  return { rotated: true, residentId: resident.id, keyPath }
}

async function defaultConnect(databaseUrl) {
  const { neon } = await import('@neondatabase/serverless')
  return neon(databaseUrl)
}

export async function restoreKeyMain(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseRestoreArgs(argv)
  const root = dependencies.root ?? ROOT
  const databaseUrl = resolveDatabaseUrl(root, dependencies.environment ?? process.env)
  const connect = dependencies.connect ?? defaultConnect
  const database = await connect(databaseUrl)
  return restoreResidentKey({
    ...options,
    database,
    backupsDir: join(root, 'backups'),
    ...dependencies.rotation,
  })
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
  void restoreKeyMain().catch(error => {
    console.error(`restore-key failed: ${safeErrorMessage(error)}`)
    process.exitCode = 1
  })
}
