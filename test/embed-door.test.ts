import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withoutInheritedGitEnvironment } from '../scripts/child-process-environment.ts'

const generatorPath = fileURLToPath(new URL('../scripts/embed-door.mjs', import.meta.url))
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

const createFixture = (
  frontdoorDocument: string,
  frontdoor = 'NEW FRONT DOOR\n',
) => {
  const root = mkdtempSync(join(tmpdir(), '1f3d9-embed-door-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'docs', 'published'), { recursive: true })
  writeFileSync(join(root, 'src', 'frontdoor.txt'), frontdoor)
  writeFileSync(join(root, 'src', 'llms.txt'), 'COMPACT MAP\n')
  writeFileSync(join(root, 'docs', 'published', 'FRONTDOOR.md'), frontdoorDocument)
  return root
}

const runGenerator = (
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
) => spawnSync(process.execPath, [generatorPath], {
  cwd: root,
  encoding: 'utf8',
  env: withoutInheritedGitEnvironment(environment),
  windowsHide: true,
})

const runDoorCheck = (
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const command = process.platform === 'win32'
    ? process.env.ComSpec ?? 'cmd.exe'
    : 'npm'
  const arguments_ = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run door:check']
    : ['run', 'door:check']

  return spawnSync(command, arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: withoutInheritedGitEnvironment(environment),
    windowsHide: true,
  })
}

const runGit = (
  root: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
) => spawnSync('git', [...arguments_], {
  cwd: root,
  encoding: 'utf8',
  env: withoutInheritedGitEnvironment(environment),
  windowsHide: true,
})

test('embed-door regenerates the fenced published mirror without changing its wrapper', () => {
  const original = '# Wrapper\n\nKeep before.\n\n```\nSTALE COPY\n```\n\nKeep after.\n'
  const root = createFixture(original)

  try {
    const result = runGenerator(root)
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.equal(
      readFileSync(join(root, 'docs', 'published', 'FRONTDOOR.md'), 'utf8'),
      '# Wrapper\n\nKeep before.\n\n```\nNEW FRONT DOOR\n```\n\nKeep after.\n',
    )
    const generatedDoor = readFileSync(join(root, 'src', 'door.ts'), 'utf8')
    assert.match(generatedDoor, /export const FRONTDOOR = `NEW FRONT DOOR\n`/u)
    assert.match(generatedDoor, /export const LLMS = `COMPACT MAP\n`/u)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('embed-door refuses invalid published mirror fences before writing outputs', () => {
  const invalidDocuments = [
    ['missing opening fence', '# Wrapper\n\nThe canonical fence is absent.\n'],
    ['missing closing fence', '# Wrapper\n\n```\nThe canonical fence never closes.\n'],
  ] as const

  for (const [name, original] of invalidDocuments) {
    const root = createFixture(original)

    try {
      const result = runGenerator(root)
      assert.notEqual(result.status, 0, name)
      assert.match(
        `${result.stdout}${result.stderr}`,
        /FRONTDOOR\.md canonical fence is missing/iu,
        name,
      )
      assert.equal(
        readFileSync(join(root, 'docs', 'published', 'FRONTDOOR.md'), 'utf8'),
        original,
        name,
      )
      assert.equal(existsSync(join(root, 'src', 'door.ts')), false, name)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  }
})

test('door:check isolates nested Git from a poisoned parent while checking mirrors', () => {
  const original = '# Wrapper\n\n```\nOLD FRONT DOOR\n```\n'
  const root = createFixture(original, 'OLD FRONT DOOR\n')
  const victimRoot = mkdtempSync(join(tmpdir(), '1f3d9-git-env-victim-'))

  try {
    // The canary setup stays independent of the sanitizer under test, so a
    // regression can target only this disposable repository.
    const fixtureBaseEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)),
    )
    const victimGitDirectory = join(victimRoot, '.git')
    mkdirSync(victimGitDirectory)
    writeFileSync(join(victimGitDirectory, 'HEAD'), 'ref: refs/heads/main\n')
    const victimConfig = join(victimGitDirectory, 'config')
    writeFileSync(victimConfig, [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tbare = false',
      '[test]',
      '\tguard = untouched',
      '',
    ].join('\n'))
    const victimConfigBefore = readFileSync(victimConfig, 'utf8')
    const projectGitDirectory = runGit(projectRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    assert.equal(projectGitDirectory.status, 0, projectGitDirectory.stderr)
    const projectConfig = join(projectGitDirectory.stdout.trim(), 'config')
    const projectConfigBefore = readFileSync(projectConfig, 'utf8')
    const poisonedEnvironment = {
      ...fixtureBaseEnvironment,
      GIT_DIR: victimGitDirectory,
      GIT_WORK_TREE: victimRoot,
    }

    mkdirSync(join(root, 'scripts'))
    copyFileSync(generatorPath, join(root, 'scripts', 'embed-door.mjs'))
    copyFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      join(root, 'package.json'),
    )
    const initialGeneration = runGenerator(root, poisonedEnvironment)
    assert.equal(initialGeneration.status, 0, initialGeneration.stderr)
    assert.equal(runGit(root, ['init', '--quiet'], poisonedEnvironment).status, 0)
    assert.equal(runGit(root, ['add', '.'], poisonedEnvironment).status, 0)
    assert.equal(existsSync(join(root, '.git')), true)
    const fixtureTopLevel = runGit(root, ['rev-parse', '--show-toplevel'], poisonedEnvironment)
    assert.equal(fixtureTopLevel.status, 0, fixtureTopLevel.stderr)
    assert.equal(resolve(fixtureTopLevel.stdout.trim()), resolve(root))

    writeFileSync(join(root, 'src', 'frontdoor.txt'), 'NEW FRONT DOOR\n')
    const staleCheck = runDoorCheck(root, poisonedEnvironment)
    assert.notEqual(staleCheck.status, 0)
    assert.match(
      `${staleCheck.stdout}${staleCheck.stderr}`,
      /Front-door mirrors were stale and have been regenerated/iu,
    )

    assert.equal(
      runGit(root, [
        'add',
        'src/frontdoor.txt',
        'src/door.ts',
        'docs/published/FRONTDOOR.md',
      ], poisonedEnvironment).status,
      0,
    )
    const synchronizedCheck = runDoorCheck(root, poisonedEnvironment)
    assert.equal(
      synchronizedCheck.status,
      0,
      `${synchronizedCheck.stdout}${synchronizedCheck.stderr}`,
    )
    assert.equal(readFileSync(victimConfig, 'utf8'), victimConfigBefore)
    assert.equal(readFileSync(projectConfig, 'utf8'), projectConfigBefore)
  } finally {
    rmSync(root, { force: true, recursive: true })
    rmSync(victimRoot, { force: true, recursive: true })
  }
})
