// Decision row 74 security fix: storeSecret must never let a secret reach
// the process argument list (visible in `ps` / Task Manager for as long as
// the child runs) or a thrown error's own message. These tests force the
// injected `execFileSync` to fail exactly the way a real OS credential tool
// can -- with the secret payload echoed back in the failure's message,
// stdout, and stderr -- and assert none of that ever escapes storeSecret.
import assert from 'node:assert/strict'
import test from 'node:test'
import { storeSecret } from '../scripts/identity-client.mjs'

const SECRET_MARKER = '1f3d9_sk_secret_marker_should_never_leak_aaaaaaaaaaaaaaaa'

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
