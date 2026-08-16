import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildNodeTestArguments,
  buildTestEnvironment,
  parseTestRunnerArguments,
  withIsolatedTestEnvironment,
} from '../scripts/run-tests.ts'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }

const deploySafetyTestPath = fileURLToPath(
  new URL('./deploy-safety.test.ts', import.meta.url),
)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function directTestEnvironment(
  tempRoot: string,
  pathOverride?: string,
): NodeJS.ProcessEnv {
  const replacedNames = new Set([
    'node_test_context',
    'temp',
    'tmp',
    'tmpdir',
    ...(pathOverride === undefined ? [] : ['path']),
  ])
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !replacedNames.has(name.toLowerCase()),
    ),
  )

  return {
    ...environment,
    ...(pathOverride === undefined ? {} : { PATH: pathOverride }),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
  }
}

test('package test commands always use the isolated test runner', () => {
  assert.equal(
    packageJson.scripts.test,
    'node --experimental-strip-types scripts/run-tests.ts',
  )
  assert.equal(
    packageJson.scripts['test:coverage'],
    'node --experimental-strip-types scripts/run-tests.ts --coverage',
  )
})

test('test runner accepts only the optional coverage mode', () => {
  assert.equal(parseTestRunnerArguments([]), false)
  assert.equal(parseTestRunnerArguments(['--coverage']), true)
  assert.throws(
    () => parseTestRunnerArguments(['--watch']),
    /Usage: npm (?:test|run test:coverage)/,
  )
})

test('test runner builds the complete Node test command', () => {
  assert.deepEqual(buildNodeTestArguments(false), [
    '--test',
    '--experimental-strip-types',
    'test/*.test.ts',
  ])
  assert.deepEqual(buildNodeTestArguments(true), [
    '--test',
    '--experimental-strip-types',
    '--experimental-test-coverage',
    'test/*.test.ts',
  ])
})

test('isolated environment redirects every temp variable and prefers Git Bash on Windows', () => {
  const environment = buildTestEnvironment(
    'C:\\suite-temp',
    {
      KEEP_ME: 'yes',
      NODE_TEST_CONTEXT: 'child-v8',
      Path: 'C:\\Windows\\System32',
      TEMP: 'C:\\old-temp',
      tmp: 'C:\\old-tmp',
      TmpDir: 'C:\\old-tmpdir',
    },
    {
      platform: 'win32',
      gitBashDirectory: 'C:\\Program Files\\Git\\bin',
    },
  )

  assert.equal(environment.TEMP, 'C:\\suite-temp')
  assert.equal(environment.TMP, 'C:\\suite-temp')
  assert.equal(environment.TMPDIR, 'C:\\suite-temp')
  assert.equal(
    environment.PATH,
    `C:\\Program Files\\Git\\bin${delimiter}C:\\Windows\\System32`,
  )
  assert.equal(environment.Path, undefined)
  assert.equal(environment.NODE_TEST_CONTEXT, undefined)
  assert.equal(environment.KEEP_ME, 'yes')
})

function runOldDeployFixture(shouldFail: boolean): Readonly<{
  root: string
  status: number
}> {
  let suiteRoot = ''

  const status = withIsolatedTestEnvironment(({ environment, root }) => {
    suiteRoot = root
    assert.equal(environment.TEMP, root)
    assert.equal(environment.TMP, root)
    assert.equal(environment.TMPDIR, root)
    const fixturePath = join(root, 'old-deploy-fixture.test.cjs')
    writeFileSync(fixturePath, [
      "const test = require('node:test')",
      "const assert = require('node:assert/strict')",
      "const { spawnSync } = require('node:child_process')",
      "const { mkdtempSync } = require('node:fs')",
      "const { tmpdir } = require('node:os')",
      "const { join } = require('node:path')",
      "test('old deploy fixture behavior', () => {",
      "  for (const prefix of ['prepare', 'remote', 'hooks', 'bin']) {",
      "    mkdtempSync(join(tmpdir(), `1f3d9-deploy-${prefix}-`))",
      '  }',
      "  const bash = spawnSync('bash', ['-lc', 'exit 0'], { encoding: 'utf8' })",
      "  assert.equal(bash.status, 0, bash.error?.message ?? bash.stderr)",
      ...(shouldFail ? ["  assert.fail('simulated old fixture failure')"] : []),
      '})',
      '',
    ].join('\n'))
    const child = spawnSync(process.execPath, ['--test', fixturePath], {
      encoding: 'utf8',
      env: environment,
    })
    assert.equal(child.status, shouldFail ? 1 : 0, child.stderr || child.stdout)
    const leakedFixtures = readdirSync(root, { withFileTypes: true }).filter(
      entry => entry.isDirectory() && entry.name.startsWith('1f3d9-deploy-'),
    )
    assert.equal(leakedFixtures.length, 4)
    return child.status ?? 1
  })

  return { root: suiteRoot, status }
}

test('real Node test process contains and removes old deploy fixture behavior', () => {
  const result = runOldDeployFixture(false)

  assert.equal(result.status, 0)
  assert.equal(existsSync(result.root), false)
})

test('real failing Node test process still removes old deploy fixture behavior', () => {
  const result = runOldDeployFixture(true)

  assert.equal(result.status, 1)
  assert.equal(existsSync(result.root), false)
})

test('direct deploy-safety runs clean their exact TEMP subtree, including setup failure', () => {
  withIsolatedTestEnvironment(({ root }) => {
    const runDirectTest = (
      name: string,
      pathOverride?: string,
    ): Readonly<{ entries: string[]; status: number }> => {
      const exactTempRoot = join(root, name)
      mkdirSync(exactTempRoot)
      const child = spawnSync(process.execPath, [
        '--test',
        '--experimental-strip-types',
        '--test-name-pattern',
        '^manual deploy invocation fails closed',
        deploySafetyTestPath,
      ], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: directTestEnvironment(exactTempRoot, pathOverride),
        windowsHide: true,
      })

      assert.equal(child.error, undefined, child.error?.message)
      return {
        entries: readdirSync(exactTempRoot),
        status: child.status ?? 1,
      }
    }

    const successfulRun = runDirectTest('successful-run')
    assert.equal(successfulRun.status, 0)
    assert.deepEqual(successfulRun.entries, [])

    const noToolsDirectory = join(root, 'no-tools')
    mkdirSync(noToolsDirectory)
    const setupFailure = runDirectTest('setup-failure', noToolsDirectory)
    assert.equal(setupFailure.status, 1)
    assert.deepEqual(setupFailure.entries, [])
  }, {
    baseEnvironment: {},
    platform: 'linux',
    tempParent: tmpdir(),
  })
})

test('suite-owned temp directory is removed after a failed run', () => {
  let suiteRoot = ''

  assert.throws(
    () => withIsolatedTestEnvironment(({ root }) => {
      suiteRoot = root
      mkdirSync(join(root, '1f3d9-deploy-remote-left-behind'))
      throw new Error('simulated test failure')
    }, {
      baseEnvironment: {},
      platform: 'linux',
      tempParent: tmpdir(),
    }),
    /simulated test failure/,
  )

  assert.equal(existsSync(suiteRoot), false)
})
