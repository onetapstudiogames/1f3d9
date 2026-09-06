import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { redirectStub, refusedConnectionOrigin } from './helpers/identity-network-stub.ts'
import type { NetworkFailure } from './helpers/identity-network-stub.ts'

const script = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))
const preload = new URL('./helpers/identity-network-stub.ts', import.meta.url).href
const key = `1f3d9_sk_${'a'.repeat(48)}`
const code = `1f3d9_rc_${'b'.repeat(64)}`
const stage = { handle: 'network-test', resident_key: key, stage_token: 'fake-stage', recovery_codes: ['fake-code'] }
const confirmed = { handle: 'network-test', resident_id: 123 }
const paths = [
  { name: 'register stage', args: ['register', '--handle', 'network-test', '--client-class', 'coding_persistent', '--human-approved'], path: '/api/register', actions: ['stage', 'confirm'], failAt: 1, result: 'nothing was created', uncertain: 'registration could not be confirmed', input: '', responses: [stage, confirmed] },
  { name: 'register confirm', args: ['register', '--handle', 'network-test', '--client-class', 'coding_persistent', '--human-approved'], path: '/api/register', actions: ['stage', 'confirm'], failAt: 2, result: 'no resident was created; a staged credential entry was written locally and remains stored', uncertain: 'registration could not be confirmed', input: '', responses: [stage, confirmed] },
  { name: 'rotate begin', args: ['rotate', '--resident-key-file', '-'], path: '/api/rotate', actions: ['begin', 'confirm'], failAt: 1, result: 'the key was not rotated', uncertain: 'key rotation could not be confirmed', input: key, responses: [stage, confirmed] },
  { name: 'rotate confirm', args: ['rotate', '--resident-key-file', '-'], path: '/api/rotate', actions: ['begin', 'confirm'], failAt: 2, result: 'the key was not rotated', uncertain: 'key rotation could not be confirmed', input: key, responses: [stage, confirmed] },
  { name: 'recovery generate', args: ['recover', 'generate', '--resident-key-file', '-'], path: '/api/recovery', actions: ['generate'], failAt: 1, result: 'no recovery was performed', uncertain: 'recovery could not be confirmed', input: key, responses: [stage] },
  { name: 'recovery begin', args: ['recover', 'begin', '--recovery-code-file', '-'], path: '/api/recovery', actions: ['begin', 'confirm'], failAt: 1, result: 'no recovery was performed', uncertain: 'recovery could not be confirmed', input: code, responses: [stage, confirmed] },
  { name: 'recovery confirm', args: ['recover', 'begin', '--recovery-code-file', '-'], path: '/api/recovery', actions: ['begin', 'confirm'], failAt: 2, result: 'no recovery was performed', uncertain: 'recovery could not be confirmed', input: code, responses: [stage, confirmed] },
  { name: 'pair', args: ['pair', '--resident-key-file', '-'], path: '/api/pair', actions: ['pair'], failAt: 1, result: 'no pairing code was created', uncertain: 'pairing code creation could not be confirmed', input: key, responses: [{ pairing_code: 'fake-pairing-code', expires_at: '2026-09-06T00:10:00Z' }] },
]

type ClientPath = Omit<typeof paths[number], 'responses'> & { responses: Record<string, unknown>[] }

async function runClient(path: ClientPath, origin: string, failure: NetworkFailure, failAt = path.failAt) {
  const inheritedNames = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'ecc_skip_git_hooks'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => inheritedNames.has(name.toLowerCase())))
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', preload, script, ...path.args, '--origin', origin], {
    timeout: 10_000,
    windowsHide: true,
    env: {
      ...environment,
      AGENT_1F3D9_STUB_ONLY: '1', AGENT_1F3EA_STUB_ONLY: '1',
      IDENTITY_RESIDENT_KEY: '', '1F3D9_RESIDENT_KEY': '',
      IDENTITY_NETWORK_CASE: JSON.stringify({ ...path, origin, failure, failAt }),
    },
  })
  child.stdin.end(path.input)
  let stdout = ''
  let stderr = ''
  let error: Error | undefined
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.once('error', failure => { error = failure })
  return await new Promise<{ status: number | null; stdout: string; stderr: string; error: Error | undefined }>(resolve => {
    child.once('close', status => resolve({ status, stdout, stderr, error }))
  })
}

for (const path of paths) {
  for (const failure of ['refused', 'dns', 'interrupted'] as const) {
    test(`${path.name}: ${failure} explains the address, action, cause, and next step without engine words`, async () => {
      const origin = failure === 'refused' ? await refusedConnectionOrigin() : 'https://identity-test.invalid'
      const result = await runClient(path, origin, failure)
      assert.equal(result.error, undefined, `${path.name}: child error ${String(result.error)}`)
      assert.equal(result.status, 1, `${path.name}: expected failure, stderr=${result.stderr}`)
      const detail = failure === 'refused' ? 'connection refused'
        : failure === 'dns' ? 'the server address could not be found' : 'the connection ended before a response arrived'
      const outcome = failure === 'interrupted' ? path.uncertain : path.result
      const nextStep = failure === 'interrupted' ? 'check whether the action completed before retrying'
        : 'check the address and your connection, then retry'
      assert.equal(result.stderr.trim(), `identity-client: could not reach ${origin}${path.path} (network error: ${detail}); ${outcome}; ${nextStep}`)
      assert.equal(result.stdout, '', `${path.name}: failure must not print successful output`)
      for (const secret of [key, code, 'fake-stage', 'do-not-print-this-marker']) {
        assert.ok(!result.stderr.includes(secret), `${path.name}: diagnostic must omit ${secret}`)
      }
    })
  }
}

test('a nested timeout names the cause without claiming the key was not rotated', async () => {
  const path = paths.find(path => path.name === 'rotate confirm')!
  const result = await runClient(path, 'https://identity-test.invalid', 'timeout')
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr.trim(), 'identity-client: could not reach https://identity-test.invalid/api/rotate (network error: the connection timed out); key rotation could not be confirmed; check whether the action completed before retrying')
})

test('network diagnostics omit URL credentials and query values', async () => {
  const result = await runClient(paths[0]!, 'https://private-user:private-password@identity-test.invalid/?private=query-marker', 'dns')
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr.trim(), 'identity-client: could not reach https://identity-test.invalid/api/register (network error: the server address could not be found); nothing was created; check the address and your connection, then retry')
})

for (const sameOrigin of [false, true]) {
  for (const [status, command] of [[301, 'register stage'], [302, 'pair'], [303, 'recovery generate'], [307, 'recovery begin'], [308, 'rotate confirm']] as const) {
    test(`${command}: ${status} to ${sameOrigin ? 'the same origin' : 'another host'} is reported without forwarding the credential`, async () => {
      const stub = await redirectStub(sameOrigin, status)
      const path = paths.find(path => path.name === command)!
      try {
        const result = await runClient(path, stub.origin, 'redirect')
        assert.equal(result.status, 1, result.stderr)
        assert.equal(result.stderr.trim(), `identity-client: ${stub.origin}${path.path}: the city answered with a redirect to ${new URL(stub.destination).origin}; the key was not sent on; check the city address and whether the action completed before retrying`)
        assert.deepEqual(stub.visits, [path.path], 'only the original identity door may receive a request')
        assert.equal(result.stdout, '', 'a redirect must not print successful output')
      } finally {
        await stub.close()
      }
    })
  }
}

for (const [name, location, expected] of [
  ['relative', '/relative-destination', 'same origin'],
  ['missing', null, 'an unspecified address'],
  ['malformed', 'http://[broken', 'an unreadable address'],
  ['opaque', `javascript:${key}`, 'an unreadable address'],
  ['private path and query', `https://private-user:private-password@other.invalid/${key}/${code}/fake-stage?secret=${key}#fake-stage`, 'https://other.invalid'],
  ['private host', `https://${key}.invalid/destination`, 'an address containing a private value'],
  ['private stage host', 'https://fake-stage.invalid/destination', 'an address containing a private value'],
] as const) {
  test(`redirect destinations: ${name} is reported without exposing private values`, async () => {
    const stub = await redirectStub(true, 302, location)
    const path = paths.find(path => path.name === 'rotate confirm')!
    try {
      const result = await runClient(path, stub.origin, 'redirect')
      const destination = expected === 'same origin' ? stub.origin : expected
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stderr.trim(), `identity-client: ${stub.origin}${path.path}: the city answered with a redirect to ${destination}; the key was not sent on; check the city address and whether the action completed before retrying`)
      assert.deepEqual(stub.visits, [path.path], 'no redirect destination may receive a request')
      for (const secret of [key, code, 'fake-stage', 'private-user', 'private-password']) {
        assert.ok(!result.stderr.includes(secret), `redirect diagnostic must omit ${secret}`)
      }
    } finally { await stub.close() }
  })
}

for (const [site, command] of [['postJson', 'register stage'], ['postAuthed', 'pair']] as const) {
  const path = paths.find(path => path.name === command)!
  for (const [name, value] of [
    ['control character', 'unsafe\u001b[2J\u001b[Hprose'],
    ['over-length value', 'x'.repeat(301)],
    ['line separator', 'unsafe\u2028prose'],
    ['paragraph separator', 'unsafe\u2029prose'],
    ['empty value', '   '],
    ['non-string value', { message: 'unsafe prose' }],
  ] as const) {
    for (const field of ['error', 'next_step'] as const) {
      test(`${site}: ${field} rejects ${name} while preserving safe companion prose`, async () => {
        const response = { error: '  Request refused  ', next_step: '  Check the city address  ', [field]: value }
        const result = await runClient({ ...path, responses: [response] }, 'https://identity-test.invalid', 'prose')
        const error = field === 'error' ? 'HTTP 401 with no usable message' : 'Request refused'
        const nextStep = field === 'next_step' ? '' : ' next_step: Check the city address'
        assert.equal(result.error, undefined, `${site}: child error ${String(result.error)}`)
        assert.equal(result.status, 1, `${site}: expected failure, stderr=${JSON.stringify(result.stderr)}`)
        assert.equal(result.stderr.trim(), `identity-client: ${path.path} refused: ${error}.${nextStep}`)
        assert.equal(result.stdout, '', `${site}: failure must not print successful output`)
      })
    }
  }
  test(`${site}: trims server prose and accepts the 300-character boundary`, async () => {
    const error = 'e'.repeat(300)
    const nextStep = 'n'.repeat(300)
    const result = await runClient({ ...path, responses: [{ error: `  ${error}  `, next_step: `  ${nextStep}  ` }] }, 'https://identity-test.invalid', 'prose')
    assert.equal(result.error, undefined, `${site}: child error ${String(result.error)}`)
    assert.equal(result.status, 1, `${site}: expected failure, stderr=${JSON.stringify(result.stderr)}`)
    assert.equal(result.stderr.trim(), `identity-client: ${path.path} refused: ${error}. next_step: ${nextStep}`)
    assert.equal(result.stdout, '', `${site}: failure must not print successful output`)
  })
}

const hidden = (label: string) => `${label}: not printed to the terminal (pass --reveal at an interactive TTY to see it once); read it back from storage instead.\n`
const origin = 'https://identity-test.invalid'
const stored = (label: string) => `stored: Windows Credential Manager (target "1f3d9:${origin}:${label}", value base64-encoded JSON)\n`
const successOutputs: Record<string, string> = {
  'register stage': hidden('Resident key') + hidden('Recovery codes (all eight)') + 'handle: network-test\nresident_id: 123\n' + stored('network-test'),
  'rotate begin': hidden('Replacement resident key') + 'handle: network-test\n' + stored('network-test'),
  'recovery generate': hidden('New recovery codes (replace every earlier set)') + 'handle: network-test\n' + stored('network-test-recovery'),
  'recovery begin': hidden('Replacement resident key') + 'handle: network-test\n' + stored('network-test'),
  pair: 'Pairing code (shown once, give it to the human completing hosted-chat sign-in):\nfake-pairing-code\nexpires_at: 2026-09-06T00:10:00Z\n',
}
for (const path of paths.filter(path => path.name in successOutputs)) {
  test(`${path.name}: successful CLI output stays unchanged`, async () => {
    const result = await runClient(path, origin, 'dns', 0)
    assert.equal(result.status, 0, `${path.name}: expected success, stderr=${result.stderr}`)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, successOutputs[path.name])
  })
}
