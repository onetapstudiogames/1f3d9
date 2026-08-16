import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import test from 'node:test'

import {
  fullTimestamp,
  parseBackupArgs,
  quoteSqlIdentifier,
  shouldPruneBackups,
} from '../scripts/backup.mjs'
import {
  buildKeyFilePath,
  parseRestoreArgs,
  restoreResidentKey,
  sanitizeHandleForFilename,
  writeSecretFileExclusive,
} from '../scripts/restore-key.mjs'

type QueryCall = {
  text: string
  values: unknown[]
}

test('backup arguments accept only --out and a positive-integer --keep', () => {
  assert.deepEqual(parseBackupArgs([]), { out: undefined, keep: 30 })
  assert.deepEqual(parseBackupArgs(['--keep', '7', '--out', 'copy.json']), {
    out: 'copy.json',
    keep: 7,
  })

  for (const args of [
    ['--wat'],
    ['loose.json'],
    ['--out'],
    ['--out', '--keep'],
    ['--out', 'a', '--out', 'b'],
    ['--keep'],
    ['--keep', '--out'],
    ['--keep', '0'],
    ['--keep', '-2'],
    ['--keep', '1.5'],
    ['--keep', '2', '--keep', '3'],
  ]) {
    assert.throws(() => parseBackupArgs(args), /argument|--out|--keep|unknown/i)
  }
})

test('backup SQL identifiers are safely double quoted', () => {
  assert.equal(quoteSqlIdentifier('residents'), '"residents"')
  assert.equal(quoteSqlIdentifier('odd"table'), '"odd""table"')
  assert.equal(quoteSqlIdentifier('a.b'), '"a.b"')
})

test('custom backup output disables pruning and timestamps keep full precision', () => {
  assert.equal(shouldPruneBackups(parseBackupArgs([])), true)
  assert.equal(shouldPruneBackups(parseBackupArgs(['--out', 'manual.json'])), false)
  assert.equal(
    fullTimestamp(new Date('2026-08-15T12:34:56.789Z')),
    '2026-08-15T12-34-56-789Z',
  )
})

test('restore arguments accept exactly one handle and one optional --confirm', () => {
  assert.deepEqual(parseRestoreArgs(['keeps-the-maybe']), {
    handle: 'keeps-the-maybe',
    confirmed: false,
  })
  assert.deepEqual(parseRestoreArgs(['--confirm', 'keeps-the-maybe']), {
    handle: 'keeps-the-maybe',
    confirmed: true,
  })

  for (const args of [
    [],
    ['--confirm'],
    ['--unknown', 'resident'],
    ['resident', '--confirm', '--confirm'],
    ['one', 'two'],
    [''],
  ]) {
    assert.throws(() => parseRestoreArgs(args), /argument|handle|--confirm|usage|unknown/i)
  }
})

test('resident handles become contained, non-traversing key paths', () => {
  const backupsDir = resolve('C:/operator/backups')
  const hostileHandle = '../../Alice\n\u001b[2J/..\\secrets'
  const safeHandle = sanitizeHandleForFilename(hostileHandle)
  const first = buildKeyFilePath({
    backupsDir,
    handle: hostileHandle,
    now: new Date('2026-08-15T12:34:56.789Z'),
    nonce: '001122aabbcc',
  })
  const second = buildKeyFilePath({
    backupsDir,
    handle: hostileHandle,
    now: new Date('2026-08-15T12:34:56.789Z'),
    nonce: 'ffeeddccbbaa',
  })

  assert.match(safeHandle, /^[a-z0-9-]+$/)
  assert.ok(!safeHandle.includes('..'))
  assert.equal(relative(backupsDir, first).startsWith('..'), false)
  assert.equal(resolve(first), first)
  assert.equal(basename(first), relative(backupsDir, first))
  assert.notEqual(first, second)
})

test('secret files use exclusive creation and do not overwrite an existing key', async t => {
  const directory = await mkdtemp(join(tmpdir(), '1f3d9-secret-exclusive-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true, force: true })
  })
  const keyPath = join(directory, 'key-resident-fixed.txt')

  await writeSecretFileExclusive(keyPath, 'first-secret')
  await assert.rejects(
    writeSecretFileExclusive(keyPath, 'replacement-secret'),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST'),
  )
  assert.equal(await readFile(keyPath, 'utf8'), 'first-secret\n')
  if (process.platform !== 'win32') {
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600)
  }
})

test('a failed injected database rotation deletes the replacement key file', async t => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-rotation-failure-'))
  const backupsDir = join(root, 'backups')
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const calls: QueryCall[] = []
  const database = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values })
      if (calls.length === 1) {
        return [{
          id: 17,
          handle: 'unsafe\nhandle',
          model: 'test-model',
          joined_at: '2026-01-01T00:00:00.000Z',
          secret_hash: 'original-hash',
        }]
      }
      if (calls.length === 2) return [{ places: 1, things: 2, notes: 3 }]
      throw new Error('injected concurrent failure')
    },
  }
  const logs: string[] = []

  await assert.rejects(
    restoreResidentKey({
      handle: 'unsafe\nhandle',
      confirmed: true,
      database,
      backupsDir,
      makeSecret: () => '1f3d9_sk_test-only-secret',
      makeNonce: () => '001122aabbcc',
      now: () => new Date('2026-08-15T12:34:56.789Z'),
      log: (line: string) => logs.push(line),
    }),
    /injected concurrent failure/,
  )

  assert.deepEqual(await readdir(backupsDir), [])
  assert.deepEqual(calls[0]!.values, ['unsafe\nhandle'])
  assert.deepEqual(calls[1]!.values, [17])
  assert.match(calls[2]!.text, /secret_hash\s+IS\s+NOT\s+DISTINCT\s+FROM\s+\$3/i)
  assert.equal(calls[2]!.values[2], 'original-hash')
  assert.equal(logs.some(line => line.includes('1f3d9_sk_test-only-secret')), false)
  assert.equal(logs.some(line => line.includes('unsafe\nhandle')), false)
  assert.equal(logs.some(line => line.includes('unsafe\\nhandle')), true)
})

test('a no-row concurrent rotation also deletes the replacement key file', async t => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-rotation-race-'))
  const backupsDir = join(root, 'backups')
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const responses: unknown[][] = [
    [{ id: 2, handle: 'resident', model: 'model', joined_at: 'now', secret_hash: 'old' }],
    [{ places: 0, things: 0, notes: 0 }],
    [],
  ]

  await assert.rejects(
    restoreResidentKey({
      handle: 'resident',
      confirmed: true,
      database: { query: async () => responses.shift() ?? [] },
      backupsDir,
      makeSecret: () => '1f3d9_sk_test-only-secret',
      makeNonce: () => '001122aabbcc',
      now: () => new Date('2026-08-15T12:34:56.789Z'),
      log: () => {},
    }),
    /changed before the rotation could finish/i,
  )
  assert.deepEqual(await readdir(backupsDir), [])
})

test('an exclusive key write leaves a pre-existing path untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), '1f3d9-existing-key-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(root, { recursive: true })
  const path = join(root, 'existing.txt')
  await writeFile(path, 'sentinel\n', 'utf8')
  await assert.rejects(writeSecretFileExclusive(path, 'new-secret'), { code: 'EEXIST' })
  assert.equal(await readFile(path, 'utf8'), 'sentinel\n')
})
