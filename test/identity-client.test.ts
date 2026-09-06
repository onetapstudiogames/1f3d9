// Decision row 74 security fix: storeSecret must never let a secret reach
// the process argument list (visible in `ps` / Task Manager for as long as
// the child runs) or a thrown error's own message. These tests force the
// injected `execFileSync` to fail exactly the way a real OS credential tool
// can -- with the secret payload echoed back in the failure's message,
// stdout, and stderr -- and assert none of that ever escapes storeSecret.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promoteReplacementKey, readSecret, SecretReadFailure, storeSecret } from '../scripts/identity-client.mjs'
import type { StoreSecretDeps } from '../scripts/identity-client.mjs'

const SECRET_MARKER = '1f3d9_sk_secret_marker_should_never_leak_aaaaaaaaaaaaaaaa'

interface ResidentBundle {
  resident_key: string
  client_class?: string
  recovery_codes?: string[]
}

function tempHomeDir(): string {
  return mkdtempSync(join(tmpdir(), '1f3d9-identity-client-test-'))
}

/**
 * A fake `execFileSync` that plays the role of the real Win32 CredWrite/
 * CredRead API pair storeSecret/readSecret shell out to on Windows. It
 * distinguishes the write invocation from the read invocation the same way
 * the real PowerShell scripts differ (one defines CredWrite, the other
 * CredRead), and it stores exactly the base64 blob storeSecret sends over
 * stdin -- so this test exercises the real encode/decode contract between
 * storeSecret and readSecret, not just a trivial passthrough.
 */
function fakeWindowsCredentialStore(store = new Map<string, string>()) {
  return (command: string, args: readonly string[], options: Record<string, unknown>): string => {
    if (command === 'cmdkey' && args[0]?.startsWith('/delete:')) {
      store.delete(args[0].slice('/delete:'.length))
      return ''
    }
    assert.equal(command, 'powershell.exe')
    const script = String(args[3])
    // Match the actual invocation call sites, not just the substring
    // "CredWrite"/"CredRead" -- readSecret's script also mentions "CredWrite"
    // in an explanatory comment, so a loose substring check would misfile it
    // as a write call.
    if (script.includes('::CredWrite(')) {
      const payload = JSON.parse(String(options.input)) as { target: string; blob: string }
      store.set(payload.target, payload.blob)
      return ''
    }
    if (script.includes('::CredRead(')) {
      const target = script.match(/CredRead\('([^']*)'/u)?.[1]?.replaceAll("''", "'")
      if (!target || !store.has(target)) {
        const error = new Error('target not found') as Error & { status: number }
        error.status = 1
        throw error
      }
      return store.get(target)!
    }
    throw new Error(`unrecognized PowerShell script: ${script}`)
  }
}

// NTFS cannot enforce the POSIX file backend's owner-only mode. Keep the
// behavioral cases running through the existing Windows command fake there;
// Linux/macOS still use real files under a fresh temporary home directory.
function temporaryTestVault(homeDir: string) {
  const entries = new Map<string, string>()
  const windows = process.platform === 'win32'
  const deps: StoreSecretDeps = windows
    ? { platform: 'win32', execFileSync: fakeWindowsCredentialStore(entries) }
    : { platform: 'linux', homeDir }
  const target = (label: string) => `1f3d9:https://1f3d9.com:${label}`
  const filePath = (label: string) => {
    const dir = join(homeDir, '.1f3d9', 'credentials')
    const name = readdirSync(dir).find(name => name.endsWith(`__${label}.json`))
    assert.ok(name, `temporary credentials file for ${label} must exist`)
    return join(dir, name)
  }
  return {
    deps,
    corrupt(label: string, content: string) {
      if (windows) entries.set(target(label), content)
      else writeFileSync(filePath(label), content)
    },
    raw(label: string) {
      return windows ? entries.get(target(label)) : readFileSync(filePath(label), 'utf8')
    },
  }
}

/**
 * A fake `execFileSync` playing the role of the real macOS `security` CLI
 * storeSecret/readSecret shell out to, parsing the same quoted subcommand
 * script and argv shape the real calls use so this exercises the real
 * encode/decode contract, not a trivial passthrough.
 */
function fakeMacKeychainStore() {
  const store = new Map<string, string>()
  const key = (account: string, service: string) => JSON.stringify([account, service])
  return (command: string, args: readonly string[], options: Record<string, unknown>): string => {
    assert.equal(command, 'security')
    if (args[0] === '-i') {
      // shellQuoteForSecurityInteractive wraps each value in single quotes
      // with '\'' for any embedded quote; none of these test values contain
      // one, so a plain non-quote match is enough to recover them here.
      const script = String(options.input)
      const account = script.match(/-a\s+'([^']*)'/u)?.[1]
      const service = script.match(/-s\s+'([^']*)'/u)?.[1]
      const blob = script.match(/-w\s+'([^']*)'/u)?.[1]
      assert.ok(account && service && blob, 'write script must carry account, service, and blob')
      store.set(key(account!, service!), blob!)
      return ''
    }
    if (args[0] === 'find-generic-password') {
      const account = args[args.indexOf('-a') + 1]!
      const service = args[args.indexOf('-s') + 1]!
      const found = store.get(key(account, service))
      if (found === undefined) {
        const error = new Error('security: item not found') as Error & { status: number }
        error.status = 44
        throw error
      }
      return `${found}\n`
    }
    throw new Error(`unrecognized security invocation: ${args.join(' ')}`)
  }
}

function poisonedFailure(capturedArgs: unknown[]) {
  return (command: string, args: readonly string[], options: Record<string, unknown>) => {
    capturedArgs.push({ command, args, options })
    // Simulates the worst case: the underlying tool (or a naive wrapper)
    // echoes the secret payload it was given back into its own failure.
    const error = new Error(
      `Command failed: ${command} ${args.join(' ')}\n${String(options.input ?? '')}`,
    ) as Error & { stdout?: string; stderr?: string; status?: number }
    error.status = 1
    error.stdout = String(options.input ?? '')
    error.stderr = `stderr also carries ${String(options.input ?? '')}`
    throw error
  }
}

test('a failed Windows credential write never leaks the secret in argv or in the thrown error', () => {
  const capturedArgs: unknown[] = []
  const execFileSync = poisonedFailure(capturedArgs)

  assert.throws(
    () => storeSecret('https://1f3d9.com', 'resident-1', { resident_key: SECRET_MARKER }, {
      platform: 'win32',
      execFileSync,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, new RegExp(SECRET_MARKER, 'u'))
      return true
    },
  )

  assert.equal(capturedArgs.length, 1)
  const call = capturedArgs[0] as { command: string; args: readonly string[] }
  assert.equal(call.command, 'powershell.exe')
  for (const arg of call.args) {
    assert.doesNotMatch(arg, new RegExp(SECRET_MARKER, 'u'))
  }
})

test('a failed macOS Keychain write never leaks the secret in argv or in the thrown error', () => {
  const capturedArgs: unknown[] = []
  const execFileSync = poisonedFailure(capturedArgs)

  assert.throws(
    () => storeSecret('https://1f3d9.com', 'resident-1', { resident_key: SECRET_MARKER }, {
      platform: 'darwin',
      execFileSync,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, new RegExp(SECRET_MARKER, 'u'))
      return true
    },
  )

  assert.equal(capturedArgs.length, 1)
  const call = capturedArgs[0] as { command: string; args: readonly string[] }
  assert.equal(call.command, 'security')
  for (const arg of call.args) {
    assert.doesNotMatch(arg, new RegExp(SECRET_MARKER, 'u'))
  }
})

test('the secret bundle travels over stdin, not argv, on both platforms', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const seen: { args: readonly string[]; input: string }[] = []
    const execFileSync = (command: string, args: readonly string[], options: Record<string, unknown>) => {
      seen.push({ args, input: String(options.input ?? '') })
      return ''
    }
    storeSecret('https://1f3d9.com', 'resident-1', { resident_key: SECRET_MARKER }, {
      platform,
      execFileSync,
    })
    assert.equal(seen.length, 1, platform)
    for (const arg of seen[0]!.args) {
      assert.doesNotMatch(arg, new RegExp(SECRET_MARKER, 'u'), platform)
    }
    // The base64 encoding of the secret is expected to reach the tool --
    // just only through stdin, never as a command argument.
    const encoded = Buffer.from(JSON.stringify({ resident_key: SECRET_MARKER }), 'utf8').toString('base64')
    assert.ok(seen[0]!.input.includes(encoded), platform)
  }
})

test('a successful write returns a secret-free location description', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const execFileSync = () => ''
    const location = storeSecret('https://1f3d9.com', 'resident-1', { resident_key: SECRET_MARKER }, {
      platform,
      execFileSync,
    })
    assert.doesNotMatch(location, new RegExp(SECRET_MARKER, 'u'), platform)
  }
})

// --- Round-trip contract: a write followed by a read must return exactly
// what was written. A prior version of this script broke this on both
// Windows (the CredRead shim decoded the stored bytes as UTF-16LE, but
// storeSecret's CredWrite shim had stored raw UTF-8 bytes) and macOS
// (readSecret parsed the retrieved keychain password directly as JSON, but
// storeSecret had stored it base64-encoded) -- so readSecret always returned
// null after a real write, and rotation/recovery then promoted a replacement
// key over the live vault entry without the fields (recovery codes,
// client_class) that entry was supposed to carry forward. ------------------

test('a write followed by a read returns exactly what was written, on Windows and macOS credential stores', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const execFileSync = platform === 'win32' ? fakeWindowsCredentialStore() : fakeMacKeychainStore()
    const payload = {
      kind: 'resident',
      handle: 'agent-1',
      client_class: 'coding_persistent',
      resident_key: SECRET_MARKER,
      recovery_codes: ['code-a', 'code-b'],
    }
    storeSecret('https://1f3d9.com', 'agent-1', payload, { platform, execFileSync })
    const result = readSecret('https://1f3d9.com', 'agent-1', { platform, execFileSync })
    assert.deepEqual(result, { found: true, value: payload }, platform)
  }
})

test('reading a label nothing was ever stored under reports not-found, not an error, on Windows and macOS', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const execFileSync = platform === 'win32' ? fakeWindowsCredentialStore() : fakeMacKeychainStore()
    const result = readSecret('https://1f3d9.com', 'nobody-registered-this-label', { platform, execFileSync })
    assert.deepEqual(result, { found: false, value: null }, platform)
  }
})

test('a write followed by a read returns exactly what was written, against the temporary test backend (real files on Linux CI)', () => {
  const homeDir = tempHomeDir()
  const { deps } = temporaryTestVault(homeDir)
  try {
    const payload = {
      kind: 'resident',
      handle: 'agent-1',
      resident_key: SECRET_MARKER,
      recovery_codes: ['code-a', 'code-b'],
    }
    storeSecret('https://1f3d9.com', 'agent-1', payload, deps)
    const result = readSecret('https://1f3d9.com', 'agent-1', deps)
    assert.deepEqual(result, { found: true, value: payload })

    const missing = readSecret('https://1f3d9.com', 'nobody-registered-this-label', deps)
    assert.deepEqual(missing, { found: false, value: null })
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a stored entry that cannot be decoded throws SecretReadFailure instead of silently reporting not-found', () => {
  const homeDir = tempHomeDir()
  const vault = temporaryTestVault(homeDir)
  try {
    storeSecret('https://1f3d9.com', 'agent-1', { resident_key: SECRET_MARKER }, vault.deps)
    vault.corrupt('agent-1', 'not valid json{{{')

    assert.throws(
      () => readSecret('https://1f3d9.com', 'agent-1', vault.deps),
      SecretReadFailure,
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- promoteReplacementKey: the staged-then-promote rotation/recovery
// discipline must refuse to promote when the read-back of the live entry
// fails, and must never destroy the already-confirmed replacement key when
// it does refuse. ------------------------------------------------------

test('promoteReplacementKey merges the previous entry\'s fields into the promoted entry and deletes the staging copy', () => {
  const homeDir = tempHomeDir()
  const { deps } = temporaryTestVault(homeDir)
  try {
    const handle = 'agent-1'
    const stagingLabel = `${handle}--pending-rotation`
    storeSecret('https://1f3d9.com', handle, {
      kind: 'resident',
      handle,
      client_class: 'coding_persistent',
      resident_key: 'old-key-marker',
      recovery_codes: ['code-a', 'code-b'],
      origin: 'https://1f3d9.com',
      stored_at: '2026-01-01T00:00:00.000Z',
    }, deps)
    storeSecret('https://1f3d9.com', stagingLabel, { resident_key: SECRET_MARKER }, deps)

    promoteReplacementKey(
      'https://1f3d9.com', handle, stagingLabel, SECRET_MARKER,
      previous => ({
        ...(previous?.client_class ? { client_class: previous.client_class } : {}),
        ...(previous?.recovery_codes ? { recovery_codes: previous.recovery_codes } : {}),
      }),
      deps,
    )

    const promoted = readSecret<ResidentBundle>('https://1f3d9.com', handle, deps)
    assert.equal(promoted.found, true)
    assert.equal(promoted.value?.resident_key, SECRET_MARKER)
    assert.equal(promoted.value?.client_class, 'coding_persistent')
    assert.deepEqual(promoted.value?.recovery_codes, ['code-a', 'code-b'])

    const staging = readSecret('https://1f3d9.com', stagingLabel, deps)
    assert.equal(staging.found, false, 'the staging copy must be deleted once promotion succeeds')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('promoteReplacementKey refuses to overwrite a live entry it cannot read back, and leaves the staged replacement key in place', () => {
  const homeDir = tempHomeDir()
  const vault = temporaryTestVault(homeDir)
  try {
    const handle = 'agent-1'
    const stagingLabel = `${handle}--pending-rotation`
    storeSecret('https://1f3d9.com', handle, { resident_key: 'old-key-marker' }, vault.deps)
    const corruptContent = 'not valid json{{{'
    vault.corrupt(handle, corruptContent)

    storeSecret('https://1f3d9.com', stagingLabel, { resident_key: SECRET_MARKER }, vault.deps)

    assert.throws(
      () => promoteReplacementKey(
        'https://1f3d9.com', handle, stagingLabel, SECRET_MARKER, () => ({}),
        vault.deps,
      ),
      /refusing to overwrite the existing vault entry/u,
    )

    // The corrupted live entry was never overwritten by the promotion attempt.
    assert.equal(vault.raw(handle), corruptContent)
    // The already-confirmed replacement key is still readable from staging.
    const staged = readSecret<ResidentBundle>('https://1f3d9.com', stagingLabel, vault.deps)
    assert.equal(staged.found, true)
    assert.equal(staged.value?.resident_key, SECRET_MARKER)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('the file backend creates mode 0600 and narrows an existing mode 0644 file', {
  skip: process.platform === 'win32' && 'NTFS does not enforce POSIX permission bits; Linux/macOS and Ubuntu CI run real chmod/stat checks',
}, () => {
  const homeDir = tempHomeDir()
  const deps: StoreSecretDeps = { platform: 'linux', homeDir }
  try {
    storeSecret('https://1f3d9.com', 'agent-1', { resident_key: 'old-key-marker' }, deps)
    const dir = join(homeDir, '.1f3d9', 'credentials')
    const [name] = readdirSync(dir)
    assert.ok(name, 'the newly stored credentials file must exist')
    const filePath = join(dir, name)
    assert.equal(statSync(filePath).mode & 0o777, 0o600, 'new file mode must be 0600')
    chmodSync(filePath, 0o644)
    assert.equal(statSync(filePath).mode & 0o777, 0o644, 'fixture must begin with mode 0644')
    storeSecret('https://1f3d9.com', 'agent-1', { resident_key: SECRET_MARKER }, deps)
    assert.equal(statSync(filePath).mode & 0o777, 0o600, 'rewritten file mode must narrow to 0600')
    assert.deepEqual(readSecret('https://1f3d9.com', 'agent-1', deps), {
      found: true, value: { resident_key: SECRET_MARKER },
    })
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})
