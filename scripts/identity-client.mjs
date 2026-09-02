#!/usr/bin/env node
// Decision row 74 reference client: a dependency-free Node script that
// registers, rotates, or recovers a 1F3D9 resident through the coding-client
// JSON identity doors (POST /api/register, POST /api/rotate,
// POST /api/recovery). It writes the resident key and recovery codes to the
// operating system's secure credential store -- Windows Credential Manager
// via the Win32 CredWrite/CredRead API (reached through a small PowerShell
// shim; `cmdkey` itself is used only to delete, which needs no secret),
// macOS Keychain via `security -i` interactive mode, and a 0600 file under
// the user's home everywhere else -- then prints only the resident's handle
// and where its secrets were stored. Every secret bundle reaches these tools
// over stdin, never as a process argument, so it never sits in a process
// listing (`ps`, Task Manager) or in a failed command's own error message. A
// secret value reaches the terminal only when the caller passes --reveal at
// an interactive TTY; by default this script never prints, logs, or returns
// one. The one deliberate exception is the pairing code from `pair`: it is
// single-use, expires in ten minutes, is never written to storage, and
// printing it once is the entire point of that command, so it is not gated
// behind --reveal.
//
// Usage:
//   node identity-client.mjs register --origin https://1f3d9.com \
//     --handle my-agent --client-class coding_persistent \
//     [--model "claude-opus"] [--human-approved] [--reveal]
//   node identity-client.mjs rotate --origin https://1f3d9.com \
//     --resident-key-file /path/to/key   (or - for stdin, or set 1F3D9_RESIDENT_KEY) [--reveal]
//   node identity-client.mjs recover generate --origin https://1f3d9.com \
//     --resident-key-file /path/to/key [--reveal]
//   node identity-client.mjs recover begin --origin https://1f3d9.com \
//     --recovery-code-file /path/to/code [--reveal]
//   node identity-client.mjs pair --origin https://1f3d9.com \
//     --resident-key-file /path/to/key
//
// `register` without --human-approved prompts on stdin for a human to
// confirm the exact permanent handle before it is claimed; use
// --human-approved only when that confirmation already happened out of band
// (for example, a human typed the handle into the command that invoked this
// script) -- it is a caller declaration, never a real substitute for asking.
//
// --resident-key and --recovery-code are refused as BARE argv flags: a bare
// flag value lands in shell history and in any process listing (`ps`, Task
// Manager) for as long as the process runs. Use --resident-key-file or
// --recovery-code-file <path> instead, pointing at a file this script reads
// and never echoes -- or pass `-` as that file's path to read the one value
// from stdin.

import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

// --- Secret input: argv is refused, a file path or stdin is required ------

// argv-flag name -> the -file flag that must supply it instead. Both values
// here can authenticate a request or consume a one-use credential, so
// neither may ever be a bare argv flag.
const SECRET_ARGV_FLAGS = {
  'resident-key': 'resident-key-file',
  'recovery-code': 'recovery-code-file',
}

async function readStdinText() {
  process.stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function readSecretFromPathOrStdin(source) {
  const raw = source === '-' ? await readStdinText() : readFileSync(source, 'utf8')
  const value = raw.trim()
  if (!value) throw new Error(`no value read from ${source === '-' ? 'stdin' : source}`)
  return value
}

/**
 * Refuses --resident-key or --recovery-code as a bare flag and resolves the
 * matching --*-file flag (a path, or `-` for stdin) into the plain secret
 * value the caller below expects. Falls back to the given environment
 * variables only when neither argv form is present -- an environment
 * variable is not visible in a process listing the way argv is, so it stays
 * allowed as before.
 */
async function resolveSecretArg(flags, bareName, envNames = []) {
  const fileName = SECRET_ARGV_FLAGS[bareName]
  if (bareName in flags) {
    throw new Error(
      `--${bareName} is refused as a bare flag: it would land in shell history and process ` +
      `listings. Use --${fileName} <path> (or --${fileName} - to read one value from stdin) ` +
      'instead.',
    )
  }
  if (fileName in flags) {
    const source = flags[fileName]
    if (typeof source !== 'string') throw new Error(`--${fileName} requires a path or -`)
    return readSecretFromPathOrStdin(source)
  }
  for (const envName of envNames) {
    if (process.env[envName]) return process.env[envName]
  }
  return null
}

// --- Secret output: hidden unless the caller opts in at a real TTY --------

/**
 * Prints `values` only when the caller passed --reveal AND stdout is an
 * interactive TTY (never a pipe, redirect, or captured subprocess output --
 * exactly where a secret could land in a log or another program's memory).
 * Otherwise prints only a pointer to where the value already went.
 */
function revealOrHide(flags, label, values) {
  if (flags.reveal === true && process.stdout.isTTY) {
    console.log(`${label} (shown once):`)
    for (const value of values) console.log(value)
    return
  }
  console.log(
    `${label}: not printed to the terminal (pass --reveal at an interactive TTY to see it ` +
    'once); read it back from storage instead.',
  )
}

// --- Secure storage -----------------------------------------------------

function vaultTarget(origin, handleOrLabel) {
  return `1f3d9:${origin}:${handleOrLabel}`
}

// homeDir is injectable (defaults to the real home directory) so tests can
// round-trip storeSecret/readSecret against a temp directory instead of the
// caller's real ~/.1f3d9/credentials.
function credentialsFilePath(origin, handleOrLabel, homeDir = homedir()) {
  const safeOrigin = origin.replace(/[^a-z0-9.-]/giu, '_')
  const safeLabel = handleOrLabel.replace(/[^a-z0-9._-]/giu, '_')
  return join(homeDir, '.1f3d9', 'credentials', `${safeOrigin}__${safeLabel}.json`)
}

/** The staging label a replacement credential is written under before it is confirmed. */
function pendingLabel(handle, kind) {
  return `${handle}--pending-${kind}`
}

/**
 * The PowerShell/.NET shim that writes one credential through the real
 * Win32 CredWrite API. The secret bundle travels to this process over
 * stdin, as base64-encoded JSON -- never as a command-line argument, so it
 * is never visible in a process listing (`ps`, Task Manager) and never
 * appears in this command's own failure message. Mirrors the CredRead shim
 * in readSecret below.
 */
const WINDOWS_CRED_WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CredW1F3D9 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
}
'@
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$blobBytes = [Convert]::FromBase64String($payload.blob)
$targetPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($payload.target)
$userPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($payload.username)
$blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($blobBytes.Length, 1))
if ($blobBytes.Length -gt 0) {
  [Runtime.InteropServices.Marshal]::Copy($blobBytes, 0, $blobPtr, $blobBytes.Length)
}
$cred = New-Object CredW1F3D9+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1
$cred.TargetName = $targetPtr
$cred.Comment = [IntPtr]::Zero
$cred.CredentialBlobSize = $blobBytes.Length
$cred.CredentialBlob = $blobPtr
$cred.Persist = 2
$cred.AttributeCount = 0
$cred.Attributes = [IntPtr]::Zero
$cred.TargetAlias = [IntPtr]::Zero
$cred.UserName = $userPtr
$ok = [CredW1F3D9]::CredWrite([ref]$cred, 0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($targetPtr)
[Runtime.InteropServices.Marshal]::FreeHGlobal($userPtr)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
if (-not $ok) { exit 1 }
`

/** Never include the caught error's own message/output: it may echo stdin back. */
function secretFreeStorageError(where, target) {
  return new Error(`could not write to ${where} (target "${target}"); no secret was included in this error`)
}

function writeWindowsCredential(execImpl, target, username, base64Blob) {
  const payload = JSON.stringify({ target, username, blob: base64Blob })
  try {
    execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CRED_WRITE_SCRIPT], {
      input: payload,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
  } catch {
    throw secretFreeStorageError('Windows Credential Manager', target)
  }
}

function shellQuoteForSecurityInteractive(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

function writeMacKeychainCredential(execImpl, service, account, base64Blob) {
  const script = [
    `add-generic-password -a ${shellQuoteForSecurityInteractive(account)}`,
    `-s ${shellQuoteForSecurityInteractive(service)}`,
    `-w ${shellQuoteForSecurityInteractive(base64Blob)} -U`,
    'quit',
    '',
  ].join('\n')
  try {
    // Interactive mode (`-i`) reads its subcommands from stdin, so the
    // password never becomes a `security` process argument the way a direct
    // `add-generic-password -w <value>` invocation would.
    execImpl('security', ['-i'], { input: script, stdio: ['pipe', 'ignore', 'pipe'] })
  } catch {
    throw secretFreeStorageError('macOS Keychain', service)
  }
}

/**
 * Writes one secret bundle to the OS credential store and returns a
 * human-readable, secret-free description of where it went. Store one JSON
 * blob per identity (key + recovery codes together) so a caller resuming
 * later reads them back from the same place with the same tool. The secret
 * bundle is always base64-encoded JSON delivered over stdin to whichever
 * tool writes it, never a process argument -- see writeWindowsCredential and
 * writeMacKeychainCredential above.
 */
function storeSecret(origin, label, payload, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  const serialized = JSON.stringify(payload)
  const encoded = Buffer.from(serialized, 'utf8').toString('base64')
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    writeWindowsCredential(execImpl, target, label, encoded)
    return `Windows Credential Manager (target "${target}", value base64-encoded JSON)`
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    writeMacKeychainCredential(execImpl, service, label, encoded)
    return `macOS Keychain (service "${service}", account "${label}")`
  }
  const filePath = credentialsFilePath(origin, label, deps.homeDir)
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${serialized}\n`, { mode: 0o600 })
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
  return `local file ${filePath} (mode 0600)`
}

/**
 * Raised by readSecret when the vault reports a target/service/file exists
 * but its content could not be decoded back into the JSON bundle storeSecret
 * writes. Kept distinct from "nothing is stored there" (readSecret returns
 * `{ found: false }` for that case) so a caller can tell "there was never a
 * prior entry" -- fine, nothing to carry forward -- apart from "a prior
 * entry exists but this read cannot recover it" -- never safe to silently
 * treat as empty, because doing so is exactly how rotation and recovery used
 * to overwrite a live vault entry and drop the recovery codes and
 * client_class it carried.
 */
class SecretReadFailure extends Error {}

/**
 * The counterpart to storeSecret: reads back the JSON bundle this script
 * wrote for `label`. Returns `{ found: false, value: null }` when nothing is
 * stored there. Returns `{ found: true, value }` when the stored entry was
 * read and decoded successfully -- a write followed by a read must return
 * exactly what was written, on every supported platform. Throws
 * SecretReadFailure when the vault reports an entry exists but this read
 * could not decode it, so a caller can refuse to promote over it rather than
 * silently treating "could not read" the same as "nothing there". Used by
 * rotate/recoverBegin below to carry forward fields -- recovery codes,
 * client_class -- that the replacement key alone does not carry.
 */
function readSecret(origin, label, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    const target = vaultTarget(origin, label)
    const escapedTarget = target.replaceAll("'", "''")
    // cmdkey itself has no way to print a stored password back out -- by
    // design it only lists the account name. Reading it back needs the real
    // Win32 Credential Manager API (CredRead), reached here through a small
    // inline PowerShell/.NET shim.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Cred1F3D9 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credential);
}
'@
$ptr = [IntPtr]::Zero
$ok = [Cred1F3D9]::CredRead('${escapedTarget}', 1, 0, [ref]$ptr)
if (-not $ok) { exit 1 }
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Cred1F3D9+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[Cred1F3D9]::CredFree($ptr)
# writeWindowsCredential above stores the exact raw bytes CredWrite was given
# (the UTF-8 bytes of the JSON payload, decoded from the base64 wire form
# sent over stdin) -- never UTF-16. Re-encode those same raw bytes back to
# base64 here so the Node side's Buffer.from(encoded, 'base64') below
# recovers the exact original bytes, with no text-encoding step in between
# that could corrupt them. (A prior version of this script decoded the
# CredentialBlob as UTF-16LE here, which does not match how it was written
# and made every read return null after a successful write.)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`
    // A non-zero exit here means CredRead found nothing at this target (the
    // `if (-not $ok) { exit 1 }` above) -- that is "not found", not a read
    // failure, so it maps to { found: false }, not a thrown error.
    let encoded
    try {
      encoded = execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8' },
      )
    } catch {
      return { found: false, value: null }
    }
    if (!encoded) return { found: false, value: null }
    // Past this point CredRead reported an entry and returned bytes: any
    // decode failure here is a corrupt or unrecoverable entry, not a missing
    // one, so it throws instead of returning { found: false }.
    try {
      return { found: true, value: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) }
    } catch {
      throw new SecretReadFailure(
        `the Windows Credential Manager entry for "${label}" exists but could not be decoded back into ` +
        'the expected JSON bundle',
      )
    }
  }
  if (os === 'darwin') {
    const service = vaultTarget(origin, label)
    // A non-zero exit here means `security` found no matching keychain item
    // -- "not found", not a read failure.
    let serialized
    try {
      serialized = execImpl(
        'security',
        ['find-generic-password', '-a', label, '-s', service, '-w'],
        { encoding: 'utf8' },
      )
    } catch {
      return { found: false, value: null }
    }
    // writeMacKeychainCredential above stores the base64-encoded JSON
    // payload as the keychain password (`-w base64Blob`), matching what it
    // sends -- so this must decode that same base64 back before parsing.
    // (A prior version of this script parsed the raw retrieved text as JSON
    // directly, without ever base64-decoding it, so it never matched what
    // was actually stored and every read failed.)
    try {
      return { found: true, value: JSON.parse(Buffer.from(serialized.trim(), 'base64').toString('utf8')) }
    } catch {
      throw new SecretReadFailure(
        `the macOS Keychain entry for "${label}" exists but could not be decoded back into the expected ` +
        'JSON bundle',
      )
    }
  }
  const filePath = credentialsFilePath(origin, label, deps.homeDir)
  let raw
  try {
    raw = (deps.readFileSync ?? readFileSync)(filePath, 'utf8')
  } catch {
    return { found: false, value: null }
  }
  try {
    return { found: true, value: JSON.parse(raw) }
  } catch {
    throw new SecretReadFailure(`the credentials file "${filePath}" exists but could not be parsed as JSON`)
  }
}

/**
 * Shared by rotate()/recoverBegin() after their server-side confirm has
 * already succeeded (so the replacement resident_key is already the live
 * one on the server -- only where it lives in the local vault is still being
 * settled here). Reads back the live entry to carry forward fields the
 * replacement key alone does not carry (via `mergeFields`), then overwrites
 * that live entry and deletes the staging copy.
 *
 * If the read-back reports the live entry exists but cannot be decoded
 * (SecretReadFailure), this refuses to promote: the live entry is left
 * completely untouched, and -- critically -- the staging copy is also left
 * in place rather than deleted, because it is the only place the already-
 * confirmed replacement key currently lives. The caller sees exactly where
 * to recover it and what to fix before retrying.
 */
function promoteReplacementKey(origin, handle, stagingLabel, residentKey, mergeFields, deps = {}) {
  let previous
  try {
    previous = readSecret(origin, handle, deps)
  } catch (error) {
    throw new Error(
      `refusing to overwrite the existing vault entry for "${handle}": ${error.message}. ` +
      'The already-confirmed replacement key was NOT lost -- it is still stored under the ' +
      `staging label "${stagingLabel}". Resolve the unreadable entry, read the replacement key back ` +
      `from "${stagingLabel}", then store it under "${handle}" yourself.`,
    )
  }
  const location = storeSecret(origin, handle, {
    kind: 'resident',
    handle,
    ...mergeFields(previous.found ? previous.value : null),
    resident_key: residentKey,
    origin,
    stored_at: new Date().toISOString(),
  }, deps)
  deleteSecret(origin, stagingLabel, deps)
  return location
}

/** Removes a stored secret bundle. Best effort: a missing entry is not an error. */
function deleteSecret(origin, label, deps = {}) {
  const execImpl = deps.execFileSync ?? execFileSync
  const os = deps.platform ?? platform()
  if (os === 'win32') {
    try {
      execImpl('cmdkey', [`/delete:${vaultTarget(origin, label)}`], { stdio: 'ignore' })
    } catch {
      // Best effort: nothing to delete, or cmdkey already reports failure loudly enough elsewhere.
    }
    return
  }
  if (os === 'darwin') {
    try {
      execImpl(
        'security',
        ['delete-generic-password', '-a', label, '-s', vaultTarget(origin, label)],
        { stdio: 'ignore' },
      )
    } catch {
      // Best effort, same as above.
    }
    return
  }
  try {
    rmSync(credentialsFilePath(origin, label, deps.homeDir), { force: true })
  } catch {
    // Best effort, same as above.
  }
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

  revealOrHide(flags, 'Resident key', [staged.resident_key])
  revealOrHide(flags, 'Recovery codes (all eight)', staged.recovery_codes)
  console.log(`handle: ${confirmed.handle}`)
  console.log(`resident_id: ${confirmed.resident_id}`)
  console.log(`stored: ${location}`)
}

async function rotate(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', ['1F3D9_RESIDENT_KEY', 'IDENTITY_RESIDENT_KEY'],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error('--resident-key-file (or IDENTITY_RESIDENT_KEY) must point to the current, valid resident key')
  }

  const staged = await postJson(origin, '/api/rotate', { action: 'begin', resident_key: residentKey })

  // Stage the replacement under a DISTINCT vault target first -- never
  // overwrite the live entry before confirm succeeds. If confirm below
  // fails for any reason, the live entry (still the OLD, still-valid key)
  // is never touched; only this staging copy exists, and it is deleted.
  const stagingLabel = pendingLabel(staged.handle, 'rotation')
  storeSecret(origin, stagingLabel, {
    kind: 'resident',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/rotate', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    throw error
  }

  // Promote: merge the now-confirmed replacement key with whatever the live
  // entry already held (recovery codes, client_class), so rotation never
  // silently drops fields that only the pre-rotation entry carried. Only
  // now does the live entry change; the staging copy is then deleted --
  // unless the read-back of the live entry fails, in which case
  // promoteReplacementKey refuses to overwrite it and leaves the staging
  // copy in place. See promoteReplacementKey's own doc comment above.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.resident_key, previous => ({
    ...(previous?.client_class ? { client_class: previous.client_class } : {}),
    ...(previous?.recovery_codes ? { recovery_codes: previous.recovery_codes } : {}),
  }))

  revealOrHide(flags, 'Replacement resident key', [staged.resident_key])
  console.log(`handle: ${confirmed.handle}`)
  console.log(`stored: ${location}`)
}

async function recoverGenerate(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', ['1F3D9_RESIDENT_KEY', 'IDENTITY_RESIDENT_KEY'],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error('--resident-key-file (or IDENTITY_RESIDENT_KEY) must point to the current, valid resident key')
  }
  const generated = await postJson(origin, '/api/recovery', { action: 'generate', resident_key: residentKey })

  const location = storeSecret(origin, `${generated.handle}-recovery`, {
    kind: 'recovery_codes',
    handle: generated.handle,
    recovery_codes: generated.recovery_codes,
    origin,
    stored_at: new Date().toISOString(),
  })
  revealOrHide(flags, 'New recovery codes (replace every earlier set)', generated.recovery_codes)
  console.log(`handle: ${generated.handle}`)
  console.log(`stored: ${location}`)
}

async function recoverBegin(flags) {
  const origin = originOf(flags)
  const recoveryCode = await resolveSecretArg(flags, 'recovery-code')
  if (!recoveryCode || !RECOVERY_CODE_RE.test(recoveryCode)) {
    throw new Error('--recovery-code-file must point to a valid, unused recovery code')
  }

  const staged = await postJson(origin, '/api/recovery', { action: 'begin', recovery_code: recoveryCode })

  // Same staging discipline as rotate() above, and for the same reason: the
  // old key still works until confirm below actually succeeds, so the live
  // vault entry must not be touched before that.
  const stagingLabel = pendingLabel(staged.handle, 'recovery')
  storeSecret(origin, stagingLabel, {
    kind: 'resident',
    handle: staged.handle,
    resident_key: staged.resident_key,
    origin,
    stored_at: new Date().toISOString(),
  })

  let confirmed
  try {
    confirmed = await postJson(origin, '/api/recovery', {
      action: 'confirm',
      stage_token: staged.stage_token,
      resident_key: staged.resident_key,
    })
  } catch (error) {
    deleteSecret(origin, stagingLabel)
    throw error
  }

  // Same promote-or-refuse discipline as rotate() above -- see
  // promoteReplacementKey's doc comment.
  const location = promoteReplacementKey(origin, staged.handle, stagingLabel, staged.resident_key, previous => ({
    ...(previous?.client_class ? { client_class: previous.client_class } : {}),
  }))

  revealOrHide(flags, 'Replacement resident key', [staged.resident_key])
  console.log(`handle: ${confirmed.handle}`)
  console.log(`stored: ${location}`)
}

async function pair(flags) {
  const origin = originOf(flags)
  const residentKey = await resolveSecretArg(
    flags, 'resident-key', ['1F3D9_RESIDENT_KEY', 'IDENTITY_RESIDENT_KEY'],
  )
  if (!residentKey || !ROOT_KEY_RE.test(residentKey)) {
    throw new Error('--resident-key-file (or IDENTITY_RESIDENT_KEY) must point to the current, valid resident key')
  }
  const minted = await postAuthed(origin, '/api/pair', residentKey, {})
  // The pairing code is meant to be read by a human, not stored -- it is
  // single-use, expires in ten minutes, and never substitutes for the key.
  // Printing it is the entire point of this command, so it is not gated
  // behind --reveal the way the resident key and recovery codes are above.
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

const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  main().catch(error => {
    fail(error instanceof Error ? error.message : String(error))
  })
}

// Exported for test/identity-client.test.ts only; the CLI above never uses
// this import path, so importing this module for tests never runs main().
export { storeSecret, readSecret, promoteReplacementKey, SecretReadFailure }
