// Create one transactionally consistent PostgreSQL custom archive and integrity manifest.
// Usage: node --experimental-strip-types scripts/backup.ts --target local --database city
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  describeDatabaseUrl,
  requireDatabaseName,
  requireLoopbackPostgresUrl,
  requiredIdentifier,
  verifyNeonDatabaseTarget,
  type DatabaseIdentity,
  type DatabaseTargetMode,
} from './database-target.ts'

export const POSTGRES_TOOL_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_KEEP = 30
const BACKUP_PATTERN = /^1f3d9-(?:local|preview|production)-[A-Za-z0-9_-]+-.*\.dump$/
const ACKNOWLEDGEMENTS = Object.freeze({
  local: 'CREATE_1F3D9_LOCAL_RECOVERY_ARCHIVE',
  preview: 'CREATE_1F3D9_PREVIEW_RECOVERY_ARCHIVE',
  production: 'CREATE_1F3D9_PRODUCTION_RECOVERY_ARCHIVE',
})

type BackupEnvironment = Readonly<Record<string, string | undefined>>

export type BackupOptions = Readonly<{
  target: DatabaseTargetMode
  expectedDatabase: string
  out: string | undefined
  keep: number
}>

type BackupTarget = Readonly<{
  mode: DatabaseTargetMode
  identity: DatabaseIdentity
  projectId?: string
  branchId?: string
  productionBranchId?: string
}>

type DumpResult = Readonly<{ pgDumpVersion: string }>
type InspectionResult = Readonly<{ pgRestoreVersion: string; tocEntries: number }>

type WindowsAclEvidence = Readonly<{
  current_user_sid: string
  owner_sid: string
  access_rules_protected: boolean
  rules: readonly Readonly<{ sid: string; type: 'Allow' | 'Deny' }>[]
}>

type DumpArchive = (options: Readonly<{
  databaseUrl: string
  outputPath: string
  toolImage: string
}>) => Promise<DumpResult>

type InspectArchive = (options: Readonly<{
  archivePath: string
  toolImage: string
}>) => Promise<InspectionResult>

export type BackupResult = Readonly<{
  archivePath: string
  manifestPath: string
  sha256: string
  bytes: number
  retention: Readonly<{
    kept: number
    pruned: number
    skipped: boolean
    warning?: 'cleanup-failed'
  }>
}>

function argumentValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
}

export function parseBackupArgs(args: readonly string[]): BackupOptions {
  let target: DatabaseTargetMode | undefined
  let expectedDatabase: string | undefined
  let out: string | undefined
  let keep = DEFAULT_KEEP
  const seen = new Set<string>()

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (!['--target', '--database', '--out', '--keep'].includes(flag)) {
      throw new Error(`unknown backup argument: ${JSON.stringify(flag)}`)
    }
    if (seen.has(flag)) throw new Error(`duplicate backup argument: ${flag}`)
    seen.add(flag)
    const value = argumentValue(args, index, flag)
    index += 1

    if (flag === '--target') {
      if (!['local', 'preview', 'production'].includes(value)) {
        throw new Error('backup requires --target local|preview|production')
      }
      target = value as DatabaseTargetMode
    } else if (flag === '--database') {
      expectedDatabase = requireDatabaseName(value, '--database')
    } else if (flag === '--out') {
      out = value
    } else {
      if (!/^[1-9]\d*$/.test(value)) throw new Error('--keep needs a positive integer')
      keep = Number(value)
      if (!Number.isSafeInteger(keep)) throw new Error('--keep needs a positive integer')
    }
  }

  if (!target) throw new Error('backup requires --target local|preview|production')
  if (!expectedDatabase) throw new Error('backup requires --database <expected-name>')
  if (target !== 'local' && !out) {
    throw new Error(`${target} backup requires an explicit owner-private --out path`)
  }
  return Object.freeze({ target, expectedDatabase, out, keep })
}

function requiredAcknowledgement(
  target: DatabaseTargetMode,
  environment: BackupEnvironment,
): void {
  const variableName = `CONFIRM_${target.toUpperCase()}_BACKUP`
  if (environment[variableName] !== ACKNOWLEDGEMENTS[target]) {
    throw new Error(`${target} backup requires ${variableName}=${ACKNOWLEDGEMENTS[target]}`)
  }
}

function resolveBackupTarget(
  options: BackupOptions,
  environment: BackupEnvironment,
): BackupTarget {
  requiredAcknowledgement(options.target, environment)
  const variableName = `${options.target.toUpperCase()}_DATABASE_URL_UNPOOLED`
  const identity = describeDatabaseUrl(environment[variableName] ?? '', variableName)
  if (identity.databaseName !== options.expectedDatabase) {
    throw new Error(
      `${variableName} names database ${JSON.stringify(identity.databaseName)}, ` +
      `not expected database ${JSON.stringify(options.expectedDatabase)}`,
    )
  }

  if (options.target === 'local') {
    requireLoopbackPostgresUrl(identity.databaseUrl, 'local backup')
    return Object.freeze({ mode: options.target, identity })
  }

  const parsedRemoteUrl = new URL(identity.databaseUrl)
  const sslMode = parsedRemoteUrl.searchParams.get('sslmode')
  if (!['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')) {
    throw new Error(
      `${variableName} must use TLS with sslmode=require, verify-ca, or verify-full`,
    )
  }
  if (identity.port !== '5432') {
    throw new Error(`${variableName} must use the proven Neon endpoint port 5432`)
  }

  const projectId = requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID')
  const productionBranchId = requiredIdentifier(
    environment.NEON_PRODUCTION_BRANCH_ID,
    'NEON_PRODUCTION_BRANCH_ID',
  )
  const branchVariable = options.target === 'preview'
    ? 'NEON_PREVIEW_BRANCH_ID'
    : 'NEON_PRODUCTION_BRANCH_ID'
  const branchId = requiredIdentifier(environment[branchVariable], branchVariable)
  if (options.target === 'preview' && branchId === productionBranchId) {
    throw new Error('preview branch must not be the production branch')
  }
  if (!environment.NEON_API_KEY?.trim()) {
    throw new Error(`${options.target} backup requires NEON_API_KEY`)
  }
  return Object.freeze({
    mode: options.target,
    identity,
    projectId,
    branchId,
    productionBranchId,
  })
}

function fullTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-')
}

export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted database URL]')
    .replace(/(?:password|NEON_API_KEY)\s*[=:]\s*[^\s]+/gi, 'credential=[redacted]')
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    allowFailure?: boolean
    maxOutput?: number
    environment?: NodeJS.ProcessEnv
    sensitiveOutput?: boolean
  }> = {},
): Promise<Readonly<{ stdout: string; stderr: string; code: number }>> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.environment ?? process.env,
    })
    const maxOutput = options.maxOutput ?? 4 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let exceeded = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (stdout.length + stderr.length > maxOutput) {
        exceeded = true
        child.kill()
      }
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
      if (stdout.length + stderr.length > maxOutput) {
        exceeded = true
        child.kill()
      }
    })
    child.once('error', rejectCommand)
    child.once('close', code => {
      const exitCode = code ?? 1
      if (exceeded) {
        rejectCommand(new Error(`${executable} output exceeded the safety limit`))
      } else if (exitCode !== 0 && !options.allowFailure) {
        rejectCommand(new Error(options.sensitiveOutput
          ? `${executable} failed with exit code ${exitCode}; sensitive output withheld`
          : `${executable} failed: ${safeError(stderr || stdout)}`))
      } else {
        resolveCommand(Object.freeze({ stdout, stderr, code: exitCode }))
      }
    })
  })
}

const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:ONEF3D9_BACKUP_DIRECTORY
$rules = @($acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
) | ForEach-Object {
  @{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
  }
})
@{
  current_user_sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  owner_sid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  access_rules_protected = $acl.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`

function parseWindowsAclEvidence(value: unknown): WindowsAclEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Windows access control evidence')
  }
  const record = value as Record<string, unknown>
  const sidPattern = /^S-\d+(?:-\d+)+$/
  if (
    typeof record.current_user_sid !== 'string' ||
    !sidPattern.test(record.current_user_sid) ||
    typeof record.owner_sid !== 'string' ||
    !sidPattern.test(record.owner_sid) ||
    typeof record.access_rules_protected !== 'boolean' ||
    !Array.isArray(record.rules)
  ) {
    throw new Error('invalid Windows access control evidence')
  }
  const rules = record.rules.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error('invalid Windows access control evidence')
    }
    const access = rule as Record<string, unknown>
    if (
      typeof access.sid !== 'string' || !sidPattern.test(access.sid) ||
      !['Allow', 'Deny'].includes(String(access.type))
    ) {
      throw new Error('invalid Windows access control evidence')
    }
    return Object.freeze({
      sid: access.sid,
      type: access.type as 'Allow' | 'Deny',
    })
  })
  return Object.freeze({
    current_user_sid: record.current_user_sid,
    owner_sid: record.owner_sid,
    access_rules_protected: record.access_rules_protected,
    rules: Object.freeze(rules),
  })
}

async function inspectWindowsAcl(directory: string): Promise<WindowsAclEvidence> {
  // A PowerShell 7 parent exports its own PSModulePath, which breaks module
  // autoloading (Get-Acl) inside the Windows PowerShell 5.1 child. Let the
  // child rebuild its default module path instead of inheriting a wrong one.
  const { PSModulePath: _ignoredModulePath, ...inheritedEnvironment } = process.env
  const result = await runCommand('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_SCRIPT,
  ], {
    maxOutput: 64 * 1024,
    environment: {
      ...inheritedEnvironment,
      ONEF3D9_BACKUP_DIRECTORY: directory,
    },
  })
  return parseWindowsAclEvidence(JSON.parse(result.stdout))
}

export async function assertPrivateBackupDirectory(
  directory: string,
  options: Readonly<{
    platform?: NodeJS.Platform
    inspectWindowsAcl?: (directory: string) => Promise<unknown>
  }> = {},
): Promise<string> {
  let canonicalDirectory: string
  let directoryStat
  try {
    canonicalDirectory = await realpath(directory)
    directoryStat = await stat(canonicalDirectory)
  } catch {
    throw new Error(
      'remote backup output directory must already exist and be owner-private',
    )
  }
  if (!directoryStat.isDirectory()) {
    throw new Error('remote backup output directory must be an owner-private directory')
  }

  if ((options.platform ?? process.platform) !== 'win32') {
    const wrongOwner = typeof process.getuid === 'function' &&
      directoryStat.uid !== process.getuid()
    if (wrongOwner || (directoryStat.mode & 0o077) !== 0) {
      throw new Error('remote backup output directory is not owner-private (mode 0700 required)')
    }
    return canonicalDirectory
  }

  let acl: WindowsAclEvidence
  try {
    const inspected = await (options.inspectWindowsAcl ?? inspectWindowsAcl)(canonicalDirectory)
    acl = parseWindowsAclEvidence(inspected)
  } catch {
    throw new Error('could not prove owner-private output directory access control')
  }
  const allowedSids = new Set([
    acl.current_user_sid,
    'S-1-5-18',
    'S-1-5-32-544',
    'S-1-3-0',
  ])
  const ownerSids = new Set([acl.current_user_sid, 'S-1-5-18', 'S-1-5-32-544'])
  const currentUserCanAccess = acl.rules.some(
    rule => rule.type === 'Allow' && rule.sid === acl.current_user_sid,
  )
  const broadAllow = acl.rules.some(
    rule => rule.type === 'Allow' && !allowedSids.has(rule.sid),
  )
  if (
    !acl.access_rules_protected ||
    !ownerSids.has(acl.owner_sid) ||
    !currentUserCanAccess ||
    broadAllow
  ) {
    throw new Error('remote backup output directory access control is not owner-private')
  }
  return canonicalDirectory
}

function decodedUrlPart(value: string, label: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`database URL contains an invalid ${label}`)
  }
  if (!decoded || /[\r\n\0]/.test(decoded)) {
    throw new Error(`database URL contains an invalid ${label}`)
  }
  return decoded
}

export function dockerDatabaseRoutePlan(
  databaseUrl: string,
  platform: NodeJS.Platform = process.platform,
): Readonly<{
  candidates: readonly Readonly<{
    hostname: string
    runArguments: readonly string[]
  }>[]
  defaultSslMode: 'disable' | 'require'
  loopback: boolean
}> {
  const hostname = new URL(databaseUrl).hostname.toLowerCase()
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  const defaultSslMode = loopback || hostname === 'host.docker.internal'
    ? 'disable'
    : 'require'
  const gatewayRoute = Object.freeze({
    hostname: loopback ? 'host.docker.internal' : hostname,
    runArguments: Object.freeze(['--add-host', 'host.docker.internal:host-gateway']),
  })
  const candidates = platform === 'linux' && loopback
    ? Object.freeze([
        gatewayRoute,
        Object.freeze({
          hostname: hostname === '[::1]' ? '::1' : hostname,
          runArguments: Object.freeze(['--network', 'host']),
        }),
      ])
    : Object.freeze([gatewayRoute])
  return Object.freeze({
    candidates,
    defaultSslMode,
    loopback,
  })
}

export async function selectDockerDatabaseRoute(
  plan: ReturnType<typeof dockerDatabaseRoutePlan>,
  probe: (candidate: (typeof plan.candidates)[number]) => Promise<boolean>,
): Promise<(typeof plan.candidates)[number]> {
  if (!plan.loopback) return plan.candidates[0]!
  for (const candidate of plan.candidates) {
    if (await probe(candidate)) return candidate
  }
  throw new Error('Docker could not reach the validated local PostgreSQL endpoint')
}

function connectionEnvironment(
  databaseUrl: string,
  defaultSslMode: 'disable' | 'require',
  route: Readonly<{ hostname: string; runArguments: readonly string[] }>,
): Readonly<{
  environment: NodeJS.ProcessEnv
  keys: readonly string[]
  runArguments: readonly string[]
}> {
  const parsed = new URL(databaseUrl)
  const sslMode = parsed.searchParams.get('sslmode') ?? defaultSslMode
  if (!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error('database URL contains an unsupported sslmode')
  }
  const channelBinding = parsed.searchParams.get('channel_binding')
  if (channelBinding && !['disable', 'prefer', 'require'].includes(channelBinding)) {
    throw new Error('database URL contains an unsupported channel_binding mode')
  }

  const variables: NodeJS.ProcessEnv = {
    PGHOST: route.hostname,
    PGPORT: parsed.port || '5432',
    PGDATABASE: decodedUrlPart(parsed.pathname.slice(1), 'database name'),
    PGUSER: decodedUrlPart(parsed.username, 'role'),
    PGSSLMODE: sslMode,
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'pg_dump',
    PGOPTIONS: '-c statement_timeout=900000',
    ...(parsed.password ? { PGPASSWORD: decodedUrlPart(parsed.password, 'password') } : {}),
    ...(channelBinding ? { PGCHANNELBINDING: channelBinding } : {}),
  }
  return Object.freeze({
    environment: Object.freeze({ ...process.env, ...variables }),
    keys: Object.freeze(Object.keys(variables)),
    runArguments: route.runArguments,
  })
}

export function dockerBindMount(source: string, target: string, readonly = false): string {
  if (source.includes(',')) throw new Error('Docker bind-mount paths cannot contain commas')
  return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`
}

async function dumpWithDocker(options: Readonly<{
  databaseUrl: string
  outputPath: string
  toolImage: string
}>): Promise<DumpResult> {
  const plan = dockerDatabaseRoutePlan(options.databaseUrl)
  const containerName = `1f3d9-pg-dump-${process.pid}-${randomBytes(6).toString('hex')}`
  const outputDirectory = dirname(options.outputPath)
  const outputName = basename(options.outputPath)
  try {
    const version = await runCommand('docker', ['run', '--rm', options.toolImage, 'pg_dump', '--version'])
    const route = await selectDockerDatabaseRoute(plan, async candidate => {
      const candidateConnection = connectionEnvironment(
        options.databaseUrl,
        plan.defaultSslMode,
        candidate,
      )
      try {
        const probe = await runCommand('docker', [
          'run', '--rm',
          ...candidate.runArguments,
          ...candidateConnection.keys.flatMap(key => ['--env', key]),
          options.toolImage,
          'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-Atqc', 'SELECT current_database()',
        ], {
          allowFailure: true,
          maxOutput: 64 * 1024,
          environment: candidateConnection.environment,
          sensitiveOutput: true,
        })
        return probe.code === 0 &&
          probe.stdout.trim() === candidateConnection.environment.PGDATABASE
      } catch {
        return false
      }
    })
    const connection = connectionEnvironment(options.databaseUrl, plan.defaultSslMode, route)
    await runCommand('docker', [
      'run', '--rm', '--name', containerName,
      '--label', 'com.1f3d9.role=backup',
      '--label', `com.1f3d9.expires=${new Date(Date.now() + 60 * 60_000).toISOString()}`,
      ...connection.runArguments,
      ...connection.keys.flatMap(key => ['--env', key]),
      '--mount', dockerBindMount(outputDirectory, '/backup'),
      options.toolImage,
      'pg_dump', '--format=custom', '--compress=6', '--no-owner', '--no-privileges',
      '--lock-wait-timeout=10s', `--file=/backup/${outputName}`,
    ], {
      maxOutput: 1024 * 1024,
      environment: connection.environment,
      sensitiveOutput: true,
    })
    return Object.freeze({ pgDumpVersion: version.stdout.trim() })
  } finally {
    await runCommand('docker', ['rm', '--force', containerName], { allowFailure: true })
  }
}

async function inspectWithDocker(options: Readonly<{
  archivePath: string
  toolImage: string
}>): Promise<InspectionResult> {
  const containerName = `1f3d9-pg-inspect-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    const version = await runCommand('docker', ['run', '--rm', options.toolImage, 'pg_restore', '--version'])
    const listed = await runCommand('docker', [
      'run', '--rm', '--name', containerName,
      '--label', 'com.1f3d9.role=backup-inspection',
      '--mount', dockerBindMount(dirname(options.archivePath), '/backup', true),
      options.toolImage,
      'pg_restore', '--list', `/backup/${basename(options.archivePath)}`,
    ])
    const entries = listed.stdout.split(/\r?\n/).filter(line => /^\d+;/.test(line.trim()))
    if (entries.length === 0) throw new Error('pg_restore found no archive entries')
    for (const table of ['residents', 'places', 'events', 'notes']) {
      if (!entries.some(line => new RegExp(`\\bTABLE public ${table}\\b`).test(line))) {
        throw new Error(`archive is missing required table ${table}`)
      }
    }
    return Object.freeze({
      pgRestoreVersion: version.stdout.trim(),
      tocEntries: entries.length,
    })
  } finally {
    await runCommand('docker', ['rm', '--force', containerName], { allowFailure: true })
  }
}

export async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function writePrivateFile(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  let completed = false
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    completed = true
  } finally {
    if (!completed) {
      await handle.close().catch(() => {})
      await unlink(path).catch(() => {})
    }
  }
}

async function publishExclusive(tempPath: string, finalPath: string): Promise<void> {
  await chmod(tempPath, 0o600).catch(error => {
    if (!['EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error
    }
  })
  await link(tempPath, finalPath)
  try {
    await unlink(tempPath)
  } catch (error) {
    await unlink(finalPath).catch(() => {})
    throw error
  }
}

function pathIsInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
}

async function pruneBackups(directory: string, keep: number): Promise<{ kept: number; pruned: number }> {
  const entries = await readdir(directory, { withFileTypes: true })
  const archives = entries
    .filter(entry => entry.isFile() && BACKUP_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()
  const stale = archives.slice(0, Math.max(0, archives.length - keep))
  for (const archive of stale) {
    const archivePath = join(directory, archive)
    const manifestPath = `${archivePath}.manifest.json`
    await readFile(manifestPath, 'utf8')
    await unlink(manifestPath)
    await unlink(archivePath)
  }
  return { kept: archives.length - stale.length, pruned: stale.length }
}

export async function runBackup(options: Readonly<{
  argv?: readonly string[]
  root?: string
  cwd?: string
  environment?: BackupEnvironment
  fetcher?: typeof fetch
  now?: () => Date
  nonce?: () => string
  log?: (line: string) => void
  dumpArchive?: DumpArchive
  inspectArchive?: InspectArchive
  verifyPrivateDirectory?: (directory: string) => Promise<string>
}> = {}): Promise<BackupResult> {
  const args = parseBackupArgs(options.argv ?? process.argv.slice(2))
  const root = resolve(options.root ?? ROOT)
  const cwd = resolve(options.cwd ?? process.cwd())
  const environment = options.environment ?? process.env
  const target = resolveBackupTarget(args, environment)
  if (target.mode !== 'local') {
    await verifyNeonDatabaseTarget(
      { projectId: target.projectId!, branchId: target.branchId! },
      target.identity.databaseUrl,
      environment.NEON_API_KEY!,
      target.mode,
      options.fetcher ?? fetch,
    )
  }

  const takenAt = (options.now ?? (() => new Date()))()
  const requestedOutputDirectory = args.out
    ? dirname(resolve(cwd, args.out))
    : join(root, 'backups')
  const requestedArchivePath = args.out
    ? resolve(cwd, args.out)
    : join(
      requestedOutputDirectory,
      `1f3d9-${target.mode}-${target.identity.databaseName}-${fullTimestamp(takenAt)}.dump`,
    )
  if (!requestedArchivePath.toLowerCase().endsWith('.dump')) {
    throw new Error('backup --out must end in .dump')
  }
  const managedDirectory = join(root, 'backups')
  if (
    pathIsInside(root, requestedArchivePath) &&
    !pathIsInside(managedDirectory, requestedArchivePath)
  ) {
    throw new Error('backup output inside the repository must stay under ignored backups/')
  }
  let outputDirectory = requestedOutputDirectory
  let archivePath = requestedArchivePath
  if (target.mode === 'local') {
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  } else {
    outputDirectory = resolve(
      await (options.verifyPrivateDirectory ?? assertPrivateBackupDirectory)(outputDirectory),
    )
    archivePath = join(outputDirectory, basename(requestedArchivePath))
    if (pathIsInside(root, archivePath) && !pathIsInside(managedDirectory, archivePath)) {
      throw new Error('backup output inside the repository must stay under ignored backups/')
    }
  }
  const manifestPath = `${archivePath}.manifest.json`
  const nonce = (options.nonce ?? (() => randomBytes(8).toString('hex')))()
  const tempArchive = join(outputDirectory, `.${basename(archivePath)}.${nonce}.tmp`)
  const tempManifest = join(outputDirectory, `.${basename(manifestPath)}.${nonce}.tmp`)
  const dumpArchive = options.dumpArchive ?? dumpWithDocker
  const inspectArchive = options.inspectArchive ?? inspectWithDocker
  let archivePublished = false
  let manifestPublished = false
  let tempArchiveCreated = false
  let tempManifestCreated = false

  try {
    await writePrivateFile(tempArchive, '')
    tempArchiveCreated = true
    const dumped = await dumpArchive({
      databaseUrl: target.identity.databaseUrl,
      outputPath: tempArchive,
      toolImage: POSTGRES_TOOL_IMAGE,
    })
    const archiveStat = await stat(tempArchive)
    if (!archiveStat.isFile() || archiveStat.size === 0) {
      throw new Error('pg_dump did not create a non-empty archive')
    }
    const inspection = await inspectArchive({
      archivePath: tempArchive,
      toolImage: POSTGRES_TOOL_IMAGE,
    })
    const sha256 = await sha256File(tempArchive)
    const targetEvidence = target.mode === 'local'
      ? {
          mode: target.mode,
          database: target.identity.databaseName,
          endpoint_fingerprint: target.identity.endpointFingerprint,
        }
      : {
          mode: target.mode,
          database: target.identity.databaseName,
          project_id: target.projectId,
          branch_id: target.branchId,
          endpoint_fingerprint: target.identity.endpointFingerprint,
        }
    const manifest = {
      schema_version: 1,
      site: '1f3d9.com',
      artifact: 'postgresql-custom-archive',
      taken_at: takenAt.toISOString(),
      target: targetEvidence,
      archive: {
        file: basename(archivePath),
        format: 'custom',
        bytes: archiveStat.size,
        sha256,
        toc_entries: inspection.tocEntries,
      },
      tools: {
        image: POSTGRES_TOOL_IMAGE,
        pg_dump: dumped.pgDumpVersion,
        pg_restore: inspection.pgRestoreVersion,
      },
    }
    await writePrivateFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`)
    tempManifestCreated = true
    await publishExclusive(tempArchive, archivePath)
    archivePublished = true
    await publishExclusive(tempManifest, manifestPath)
    manifestPublished = true

    let retention: BackupResult['retention']
    if (args.out) {
      retention = Object.freeze({ kept: 0, pruned: 0, skipped: true })
    } else {
      try {
        retention = Object.freeze({
          ...await pruneBackups(outputDirectory, args.keep),
          skipped: false,
        })
      } catch (error) {
        ;(options.log ?? console.log)(
          `backup verified; retention cleanup failed: ${safeError(error)}`,
        )
        retention = Object.freeze({
          kept: 0,
          pruned: 0,
          skipped: false,
          warning: 'cleanup-failed',
        })
      }
    }
    ;(options.log ?? console.log)(
      `backup verified: ${JSON.stringify(basename(archivePath))} ` +
      `(${archiveStat.size} bytes, sha256 ${sha256})`,
    )
    return Object.freeze({
      archivePath,
      manifestPath,
      sha256,
      bytes: archiveStat.size,
      retention: Object.freeze(retention),
    })
  } catch (error) {
    if (!(archivePublished && manifestPublished)) {
      if (archivePublished) await unlink(archivePath).catch(() => {})
      if (manifestPublished) await unlink(manifestPath).catch(() => {})
    }
    throw error
  } finally {
    if (tempArchiveCreated) await unlink(tempArchive).catch(() => {})
    if (tempManifestCreated) await unlink(tempManifest).catch(() => {})
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) &&
    pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url
}

if (isMainModule()) {
  void runBackup().catch(error => {
    console.error(`backup failed: ${safeError(error)}`)
    process.exitCode = 1
  })
}
