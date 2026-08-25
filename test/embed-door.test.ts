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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const generatorPath = fileURLToPath(new URL('../scripts/embed-door.mjs', import.meta.url))

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

const runGenerator = (root: string) => spawnSync(process.execPath, [generatorPath], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
})

const runDoorCheck = (root: string) => {
  const command = process.platform === 'win32'
    ? process.env.ComSpec ?? 'cmd.exe'
    : 'npm'
  const arguments_ = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run door:check']
    : ['run', 'door:check']

  return spawnSync(command, arguments_, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
}

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

test('door:check fails stale tracked mirrors clearly and passes synchronized mirrors', () => {
  const original = '# Wrapper\n\n```\nOLD FRONT DOOR\n```\n'
  const root = createFixture(original, 'OLD FRONT DOOR\n')

  try {
    mkdirSync(join(root, 'scripts'))
    copyFileSync(generatorPath, join(root, 'scripts', 'embed-door.mjs'))
    copyFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      join(root, 'package.json'),
    )
    const initialGeneration = runGenerator(root)
    assert.equal(initialGeneration.status, 0, initialGeneration.stderr)
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0)
    assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0)

    writeFileSync(join(root, 'src', 'frontdoor.txt'), 'NEW FRONT DOOR\n')
    const staleCheck = runDoorCheck(root)
    assert.notEqual(staleCheck.status, 0)
    assert.match(
      `${staleCheck.stdout}${staleCheck.stderr}`,
      /Front-door mirrors were stale and have been regenerated/iu,
    )

    assert.equal(
      spawnSync('git', [
        'add',
        'src/frontdoor.txt',
        'src/door.ts',
        'docs/published/FRONTDOOR.md',
      ], { cwd: root }).status,
      0,
    )
    const synchronizedCheck = runDoorCheck(root)
    assert.equal(
      synchronizedCheck.status,
      0,
      `${synchronizedCheck.stdout}${synchronizedCheck.stderr}`,
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
