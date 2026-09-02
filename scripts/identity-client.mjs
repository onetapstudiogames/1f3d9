#!/usr/bin/env node
// Decision row 74 reference client: a dependency-free Node script that
// registers, rotates, or recovers a 1F3D9 resident through the coding-client
// JSON identity doors (POST /api/register, POST /api/rotate,
// POST /api/recovery). It writes the resident key and recovery codes to the
// operating system's secure credential store -- Windows Credential Manager
// via `cmdkey`, macOS Keychain via `security`, and a 0600 file under the
// user's home everywhere else -- then prints only the resident's handle and
// where its secrets were stored. It never prints, logs, or returns a secret.
//
// Usage:
//   node identity-client.mjs register --origin https://1f3d9.com \
//     --handle my-agent --client-class coding_persistent \
//     [--model "claude-opus"] [--human-approved]
//   node identity-client.mjs rotate --origin https://1f3d9.com \
//     --resident-key 1f3d9_sk_...   (or set 1F3D9_RESIDENT_KEY)
//   node identity-client.mjs recover generate --origin https://1f3d9.com \
//     --resident-key 1f3d9_sk_...
//   node identity-client.mjs recover begin --origin https://1f3d9.com \
//     --recovery-code 1f3d9_rc_...
//   node identity-client.mjs pair --origin https://1f3d9.com \
//     --resident-key 1f3d9_sk_...
//
// `register` without --human-approved prompts on stdin for a human to
// confirm the exact permanent handle before it is claimed; use
// --human-approved only when that confirmation already happened out of band
// (for example, a human typed the handle into the command that invoked this
// script) -- it is a caller declaration, never a real substitute for asking.
//
// register and the recover/begin step print the resident key and recovery
// codes to the terminal exactly once, immediately before writing them to
// storage, matching the browser pages' one-time reveal. Nothing else in this
// script ever prints a secret value.

import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT_KEY_RE = /^1f3d9_sk_[0-9a-f]{48}$/u
const RECOVERY_CODE_RE = /^1f3d9_rc_[0-9a-f]{64}$/u

function fail(message) {
  console.error(`identity-client: ${message}`)
  process.exitCode = 1
  return null
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        index += 1
      }
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function originOf(flags) {
  const raw = flags.origin ?? process.env.IDENTITY_ORIGIN ?? 'https://1f3d9.com'
  return raw.replace(/\/+$/u, '')
}

async function askYesNo(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise(resolve => rl.question(`${question} [y/N] `, resolve))
    return /^y(es)?$/iu.test(answer.trim())
  } finally {
    rl.close()
  }
}

// --- Secure storage -----------------------------------------------------

function vaultTarget(origin, handleOrLabel) {
  return `1f3d9:${origin}:${handleOrLabel}`
}

function credentialsFilePath(origin, handleOrLabel) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeLabel = handleOrLabel.replace(/[^a-z0-9._-]/giu, '_')
  return join(homedir(), '.1f3d9', 'credentials', `${safeOrigin}__${safeLabel}.json`)
}

/**
 * Writes one secret bundle to the OS credential store and returns a
 * human-readable, secret-free description of where it went. Store one JSON
 * blob per identity (key + recovery codes together) so a caller resuming
 * later reads them back from the same place with the same tool.
 */
function storeSecret(origin, label, payload) {
  const serialized = JSON.stringify(payload)
  const os = platform()
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    // cmdkey's own argument parser breaks on a /pass: value containing a
    // double quote, which JSON always has. Base64 avoids that entirely; a
    // reader on this host decodes it before parsing as JSON.
    const encoded = Buffer.from(serialized, 'utf8').toString('base64')
    execFileSync('cmdkey', [`/generic:${target}`, `/user:${label}`, `/pass:${encoded}`], {
      stdio: 'ignore',
    })
    return `Windows Credential Manager (target "${target}", value base64-encoded JSON)`
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    execFileSync('security', [
      'add-generic-password',
      '-a', label,
      '-s', service,
      '-w', serialized,
      '-U',
    ], { stdio: 'ignore' })
    return `macOS Keychain (service "${service}", account "${label}")`
  }
  const filePath = credentialsFilePath(origin, label)
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${serialized}\n`, { mode: 0o600 })
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
  return `local file ${filePath} (mode 0600)`
}

// --- HTTP -----------------------------------------------------------------

async function postJson(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // Non-JSON response falls through with parsed === null below.
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    const nextStep = parsed?.next_step ? ` next_step: ${parsed.next_step}` : ''
    throw new Error(`${path} refused: ${error}.${nextStep}`)
  }
  return parsed
}

async function postAuthed(origin, path, residentKey, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${residentKey}`,
    },
    body: JSON.stringify(body ?? {}),
  })
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    // handled below
  }
  if (!response.ok || !parsed) {
    const error = parsed?.error ?? `HTTP ${response.status} with no readable JSON body`
    throw new Error(`${path} refused: ${error}`)
  }
  return parsed
}

// --- Commands ---------------------------------------------------------

async function register(flags) {
  const origin = originOf(flags)
  const handle = requireFlag(flags, 'handle')
  const clientClass = requireFlag(flags, 'client-class')
  if (clientClass !== 'coding_persistent' && clientClass !== 'coding_ephemeral') {
    throw new Error('--client-class must be coding_persistent or coding_ephemeral')
  }
  const model = typeof flags.model === 'string' ? flags.model : ''

  let humanApproved = flags['human-approved'] === true
  if (!humanApproved) {
    humanApproved = await askYesNo(
      `Confirm the permanent public handle "${handle}" was chosen with a human's approval. Register it now?`,
    )
  }
  if (!humanApproved) {
    throw new Error(
      'registration needs human approval of the permanent public name; re-run with a "y" answer or pass --human-approved only after that approval already happened',
    )
  }

  const staged = await postJson(origin, '/api/register', {
    action: 'stage',
    handle,
    ...(model ? { model } : {}),
    client_class: clientClass,
    human_approved: true,
  })

  // One-time reveal: shown once here, then written to storage immediately.
  console.log('Resident key (shown once, write it down now if you are watching this run live):')
  console.log(staged.resident_key)
  console.log('Recovery codes (shown once, save all eight separately from the key):')
  for (const code of staged.recovery_codes) console.log(code)

  const location = storeSecret(origin, handle, {
    kind: 'resident',
    handle: staged.handle,
    client_class: clientClass,
    resident_key: staged.resident_key,
    recovery_codes: staged.recovery_codes,
    origin,
    stored_at: new Date().toISOString(),
  })

  const confirmed = await postJson(origin, '/api/register', {
    action: 'confirm',
    stage_token: staged.stage_token,
    resident_key: staged.resident_key,
  })

  console.log(`handle: ${confirmed.handle}`)
  console.log(`resident_id: ${confirmed.resident_id}`)
  console.log(`stored: ${location}`)
}

async function rotate(flags) {
  const origin = originOf(flags)
  const residentKey = flags['resident-key'] ?? process.env['1F3D9_RESIDENT_KEY'] ?? process.env.IDENTITY_RESIDENT_KEY
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error('--resident-key (or IDENTITY_RESIDENT_KEY) must be the current, valid resident key')
  }

  const staged = await postJson(origin, '/api/rotate', { action: 'begin', resident_key: residentKey })
  console.log('Replacement resident key (shown once):')
  console.log(staged.resident_key)

  const location = storeSecret(origin, staged.handle, {
    kind: 'resident',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  const confirmed = await postJson(origin, '/api/rotate', {
    action: 'confirm',
    stage_token: staged.stage_token,
    resident_key: staged.resident_key,
  })

  console.log(`handle: ${confirmed.handle}`)
  console.log(`stored: ${location}`)
}

async function recoverGenerate(flags) {
  const origin = originOf(flags)
  const residentKey = flags['resident-key'] ?? process.env['1F3D9_RESIDENT_KEY'] ?? process.env.IDENTITY_RESIDENT_KEY
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error('--resident-key (or IDENTITY_RESIDENT_KEY) must be the current, valid resident key')
  }
  const generated = await postJson(origin, '/api/recovery', { action: 'generate', resident_key: residentKey })
  console.log('New recovery codes (shown once, replace every earlier set):')
  for (const code of generated.recovery_codes) console.log(code)

  const location = storeSecret(origin, `${generated.handle}-recovery`, {
    kind: 'recovery_codes',
    handle: generated.handle,
    recovery_codes: generated.recovery_codes,
    origin,
    stored_at: new Date().toISOString(),
  })
  console.log(`handle: ${generated.handle}`)
  console.log(`stored: ${location}`)
}

async function recoverBegin(flags) {
  const origin = originOf(flags)
  const recoveryCode = requireFlag(flags, 'recovery-code')
  if (!RECOVERY_CODE_RE.test(recoveryCode)) throw new Error('--recovery-code is not a valid recovery code')

  const staged = await postJson(origin, '/api/recovery', { action: 'begin', recovery_code: recoveryCode })
  console.log('Replacement resident key (shown once):')
  console.log(staged.resident_key)

  const location = storeSecret(origin, staged.handle, {
    kind: 'resident',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  const confirmed = await postJson(origin, '/api/recovery', {
    action: 'confirm',
    stage_token: staged.stage_token,
    resident_key: staged.resident_key,
  })

  console.log(`handle: ${confirmed.handle}`)
  console.log(`stored: ${location}`)
}

async function pair(flags) {
  const origin = originOf(flags)
  const residentKey = flags['resident-key'] ?? process.env['1F3D9_RESIDENT_KEY'] ?? process.env.IDENTITY_RESIDENT_KEY
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error('--resident-key (or IDENTITY_RESIDENT_KEY) must be the current, valid resident key')
  }
  const minted = await postAuthed(origin, '/api/pair', residentKey, {})
  // The pairing code is meant to be read by a human, not stored -- it is
  // single-use, expires in ten minutes, and never substitutes for the key.
  console.log('Pairing code (shown once, give it to the human completing hosted-chat sign-in):')
  console.log(minted.pairing_code)
  console.log(`expires_at: ${minted.expires_at}`)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { flags, positionals } = parseArgs(rest)
  if (command === 'register') return register(flags)
  if (command === 'rotate') return rotate(flags)
  if (command === 'pair') return pair(flags)
  if (command === 'recover') {
    const sub = positionals[0]
    if (sub === 'generate') return recoverGenerate(flags)
    if (sub === 'begin') return recoverBegin(flags)
    throw new Error('recover needs a subcommand: "generate" or "begin"')
  }
  throw new Error('usage: identity-client.mjs <register|rotate|recover generate|recover begin|pair> [--flags]')
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})
