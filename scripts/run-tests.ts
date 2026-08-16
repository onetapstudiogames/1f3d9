import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_FILE_PATTERN = 'test/*.test.ts'
const TEMPORARY_DIRECTORY_PREFIX = '1f3d9-test-suite-'
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

type EnvironmentOptions = Readonly<{
  gitBashDirectory?: string
  platform?: NodeJS.Platform
}>

type IsolatedTestEnvironment = Readonly<{
  environment: NodeJS.ProcessEnv
  root: string
}>

type IsolatedTestOptions = EnvironmentOptions & Readonly<{
  baseEnvironment?: NodeJS.ProcessEnv
  tempParent?: string
}>

export function parseTestRunnerArguments(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return false
  if (arguments_.length === 1 && arguments_[0] === '--coverage') return true

  throw new Error('Usage: npm test OR npm run test:coverage')
}

export function buildNodeTestArguments(coverage: boolean): readonly string[] {
  return [
    '--test',
    '--experimental-strip-types',
    ...(coverage ? ['--experimental-test-coverage'] : []),
    TEST_FILE_PATTERN,
  ]
}

function findEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return Object.entries(environment).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1]
}

export function buildTestEnvironment(
  suiteRoot: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  options: EnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const replacedNames = new Set([
    'node_test_context',
    'temp',
    'tmp',
    'tmpdir',
    ...(platform === 'win32' ? ['path'] : []),
  ])
  const retainedEnvironment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(
      ([key]) => !replacedNames.has(key.toLowerCase()),
    ),
  )
  const redirectedEnvironment = {
    ...retainedEnvironment,
    TEMP: suiteRoot,
    TMP: suiteRoot,
    TMPDIR: suiteRoot,
  }

  if (platform !== 'win32') return redirectedEnvironment
  if (!options.gitBashDirectory) {
    throw new Error('Git Bash directory is required to run tests on Windows')
  }

  const existingPath = findEnvironmentValue(baseEnvironment, 'PATH')
  const path = existingPath
    ? `${options.gitBashDirectory}${delimiter}${existingPath}`
    : options.gitBashDirectory

  return { ...redirectedEnvironment, PATH: path }
}

function withoutGitHookEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')),
  )
}

function resolveGitBashDirectory(environment: NodeJS.ProcessEnv): string {
  const gitExecPath = execFileSync('git', ['--exec-path'], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: withoutGitHookEnvironment(environment),
  }).trim()
  const bashExecutable = resolve(gitExecPath, '..', '..', '..', 'bin', 'bash.exe')

  if (!existsSync(bashExecutable)) {
    throw new Error(`Git Bash was not found at ${bashExecutable}`)
  }

  return dirname(bashExecutable)
}

export function withIsolatedTestEnvironment<Result>(
  run: (isolated: IsolatedTestEnvironment) => Result,
  options: IsolatedTestOptions = {},
): Result {
  const root = mkdtempSync(join(
    options.tempParent ?? tmpdir(),
    TEMPORARY_DIRECTORY_PREFIX,
  ))

  try {
    const platform = options.platform ?? process.platform
    const baseEnvironment = options.baseEnvironment ?? process.env
    const gitBashDirectory = platform === 'win32'
      ? options.gitBashDirectory ?? resolveGitBashDirectory(baseEnvironment)
      : undefined
    const environmentOptions = gitBashDirectory
      ? { gitBashDirectory, platform }
      : { platform }
    const environment = buildTestEnvironment(root, baseEnvironment, environmentOptions)
    return run({ environment, root })
  } finally {
    rmSync(root, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    })
  }
}

export function runTestSuite(arguments_: readonly string[]): number {
  const coverage = parseTestRunnerArguments(arguments_)

  return withIsolatedTestEnvironment(({ environment }) => {
    const result = spawnSync(process.execPath, buildNodeTestArguments(coverage), {
      cwd: projectRoot,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    })

    if (result.error) {
      throw new Error(`Unable to start the Node test runner: ${result.error.message}`)
    }

    return result.status ?? 1
  })
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false

  const entryPath = resolve(process.argv[1])
  const modulePath = resolve(fileURLToPath(import.meta.url))
  return process.platform === 'win32'
    ? entryPath.toLowerCase() === modulePath.toLowerCase()
    : entryPath === modulePath
}

if (isMainModule()) {
  try {
    process.exitCode = runTestSuite(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
