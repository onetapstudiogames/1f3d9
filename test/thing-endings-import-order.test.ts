import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Each module is imported first, in its own fresh process, so an import cycle that reads a
// constant before it is initialized fails here instead of in a later module that happens to
// import it first.
const FIRST_IMPORTS = [
  'src/thing-endings.ts',
  'src/thing-ending-read.ts',
  'src/thing-ending-record.ts',
] as const

for (const file of FIRST_IMPORTS) {
  test(`${file} loads when it is the first import in a fresh process`, () => {
    const url = pathToFileURL(join(root, file)).href
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    )
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `${file} failed to load first:\n${result.stderr}`)
  })
}
