import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withoutInheritedGitEnvironment } from '../../../scripts/child-process-environment.ts'

export function finalNonEmptyLine(output: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
    .at(-1)
}

function waitMilliseconds(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function removeDirectoryWithRetries(path: string): void {
  let lastError: unknown
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(path, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 50,
      })
      return
    } catch (error) {
      lastError = error
      waitMilliseconds(50 * (attempt + 1))
    }
  }
  throw lastError
}

const preparationFixtureRoots = new Set<string>()

function createPreparationFixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  preparationFixtureRoots.add(root)
  return root
}

function cleanupPreparationFixtureRoot(root: string): void {
  removeDirectoryWithRetries(root)
  preparationFixtureRoots.delete(root)
}

export function cleanupRegisteredPreparationFixtureRoots(): void {
  for (const root of [...preparationFixtureRoots].reverse()) {
    cleanupPreparationFixtureRoot(root)
  }
}

type PreparationFixture = Readonly<{
  root: string
  commandLog: string
  git: (...args: string[]) => Buffer
  run: (overrides?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>
  cleanup: () => void
}>

const laterHolderReleaseReady = Object.freeze({
  CONFIRM_LATER_HOLDER_PROVIDER_KEY: 'VERIFIED_IN_VERCEL_PREVIEW_AND_PRODUCTION',
  CONFIRM_LATER_HOLDER_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_PRODUCTION_DRAWING_RELEASE:
    'DRAWING_CONTRACT_THEN_WORLD_ROOT_DRAWING_APPLIED_WITH_DOCUMENTED_DRAWING_GAZETTE_WORLD_POSTCONDITIONS_RECORDED',
  CONFIRM_GAZETTE_SCHEMA_MIGRATION:
    'APPLIED_TO_PREVIEW_AND_PRODUCTION_WITH_ROOM_CLOSED',
  CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION:
    'APPLIED_TO_PRODUCTION_WITH_WITHDRAWALS_CLOSED_AND_REAL_POSTGRES_PROVEN',
  CONFIRM_RESUMABLE_REGISTRATION_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_THING_MAKER_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
  CONFIRM_RESIDENT_AWARENESS_MIGRATION: 'APPLIED_TO_PREVIEW_AND_PRODUCTION',
})

export function createPreparationFixture(): PreparationFixture {
  const root = createPreparationFixtureRoot('1f3d9-deploy-prepare-')
  const remoteRoot = createPreparationFixtureRoot('1f3d9-deploy-remote-')
  const remote = join(remoteRoot, 'origin.git')
  const hooks = createPreparationFixtureRoot('1f3d9-deploy-hooks-')
  const bin = createPreparationFixtureRoot('1f3d9-deploy-bin-')
  const commandLog = join(bin, 'npm.log')
  const gitEnvironment = {
    ...withoutInheritedGitEnvironment(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
  }
  const git = (...args: string[]) => execFileSync(
    'git',
    ['-c', `core.hooksPath=${hooks}`, '-C', root, ...args],
    { cwd: tmpdir(), stdio: 'pipe', env: gitEnvironment },
  )

  execFileSync('git', ['-c', `core.hooksPath=${hooks}`, 'init', '--bare', '-q', remote], {
    cwd: tmpdir(),
    stdio: 'pipe',
    env: gitEnvironment,
  })
  const bashRemoteRoot = spawnSync('bash', ['-lc', 'pwd'], {
    cwd: remoteRoot,
    encoding: 'utf8',
    env: withoutInheritedGitEnvironment(),
  }).stdout.trim()
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'node_modules'))
  copyFileSync(new URL('../../../scripts/deploy.sh', import.meta.url), join(root, 'scripts', 'deploy.sh'))
  writeFileSync(join(root, 'README.md'), 'release fixture\n')
  git('init', '-q', '--initial-branch=agent/release-test')
  git('config', '--local', 'user.email', 'release-test@example.invalid')
  git('config', '--local', 'user.name', 'Release Test')
  git('add', 'README.md', 'scripts/deploy.sh')
  git('commit', '-q', '-m', 'test release')
  git('remote', 'add', 'origin', remote)
  git('push', '-q', '-u', 'origin', 'HEAD')
  git('remote', 'set-url', 'origin', `${bashRemoteRoot}/origin.git`)

  const npmStub = join(bin, 'npm')
  writeFileSync(npmStub, [
    '#!/usr/bin/env bash',
    'printf "npm %s\\n" "$*" >> "$TEST_COMMAND_LOG"',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(npmStub, 0o755)
  const bashBin = spawnSync('bash', ['-lc', 'pwd'], {
    cwd: bin,
    encoding: 'utf8',
    env: withoutInheritedGitEnvironment(),
  }).stdout.trim()
  const bashRoot = spawnSync('bash', ['-lc', 'pwd'], {
    cwd: root,
    encoding: 'utf8',
    env: withoutInheritedGitEnvironment(),
  }).stdout.trim()
  const wrapper = join(bin, 'run-prepare.sh')
  writeFileSync(wrapper, [
    '#!/usr/bin/env bash',
    `PATH=${JSON.stringify(bashBin)}:$PATH`,
    'export PATH',
    `TEST_COMMAND_LOG=${JSON.stringify(`${bashBin}/npm.log`)}`,
    'export TEST_COMMAND_LOG',
    'CONFIRM_LATER_HOLDER_PROVIDER_KEY="${1-}"',
    'export CONFIRM_LATER_HOLDER_PROVIDER_KEY',
    'CONFIRM_LATER_HOLDER_MIGRATION="${2-}"',
    'export CONFIRM_LATER_HOLDER_MIGRATION',
    'CONFIRM_THING_MAKER_MIGRATION="${3-}"',
    'export CONFIRM_THING_MAKER_MIGRATION',
    'CONFIRM_RESUMABLE_REGISTRATION_MIGRATION="${4-}"',
    'export CONFIRM_RESUMABLE_REGISTRATION_MIGRATION',
    'CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION="${5-}"',
    'export CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION',
    'CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION="${6-}"',
    'export CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION',
    'CONFIRM_RESIDENT_AWARENESS_MIGRATION="${7-}"',
    'export CONFIRM_RESIDENT_AWARENESS_MIGRATION',
    'CONFIRM_GAZETTE_SCHEMA_MIGRATION="${8-}"',
    'export CONFIRM_GAZETTE_SCHEMA_MIGRATION',
    'CONFIRM_PRODUCTION_DRAWING_RELEASE="${9-}"',
    'export CONFIRM_PRODUCTION_DRAWING_RELEASE',
    'CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION="${10-}"',
    'export CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION',
    `cd ${JSON.stringify(bashRoot)}`,
    'bash scripts/deploy.sh --prepare',
    '',
  ].join('\n'))
  chmodSync(wrapper, 0o755)

  return {
    root,
    commandLog,
    git,
    run: (overrides = {}) => {
      const readiness = { ...laterHolderReleaseReady, ...overrides }
      return spawnSync('bash', [
        `${bashBin}/run-prepare.sh`,
        readiness.CONFIRM_LATER_HOLDER_PROVIDER_KEY ?? '',
        readiness.CONFIRM_LATER_HOLDER_MIGRATION ?? '',
        readiness.CONFIRM_THING_MAKER_MIGRATION ?? '',
        readiness.CONFIRM_RESUMABLE_REGISTRATION_MIGRATION ?? '',
        readiness.CONFIRM_PAYPAL_CREDIT_DISPUTES_MIGRATION ?? '',
        readiness.CONFIRM_RESIDENT_REFUSAL_STATE_MIGRATION ?? '',
        readiness.CONFIRM_RESIDENT_AWARENESS_MIGRATION ?? '',
        readiness.CONFIRM_GAZETTE_SCHEMA_MIGRATION ?? '',
        readiness.CONFIRM_PRODUCTION_DRAWING_RELEASE ?? '',
        readiness.CONFIRM_GAZETTE_WITHDRAWAL_SCHEMA_MIGRATION ?? '',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: withoutInheritedGitEnvironment(),
      })
    },
    cleanup: () => {
      for (const path of [bin, hooks, remoteRoot, root]) {
        cleanupPreparationFixtureRoot(path)
      }
    },
  }
}
