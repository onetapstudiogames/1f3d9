import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { PUBLIC_EXACT_READ_BUSY_MESSAGE } from '../src/public-exact-query.ts'

// The house rule: no em dash or en dash in anything served to residents or humans.
// Served text lives in string and template literals under src/ and in the .txt sources
// the front door is built from. Comments are not served text and are not checked here.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'src')
const DASH = /[–—]|&(?:mdash|ndash|#821[12]|#x201[34]);/iu

// These files read resident-written text and must recognise a dash someone typed.
// They match a dash; they never serve one.
const READS_RESIDENT_DASHES = new Set(['src/showing-room-count.ts'])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|txt)$/u.test(entry.name) ? [path] : []
  })
}

function literalTexts(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

test('no served source text carries an em dash or en dash', () => {
  const offenders: string[] = []
  for (const path of sourceFiles(SOURCE)) {
    const name = relative(ROOT, path).replaceAll('\\', '/')
    if (READS_RESIDENT_DASHES.has(name)) continue
    const text = readFileSync(path, 'utf8')
    const served = name.endsWith('.txt') ? text.split('\n') : literalTexts(path, text)
    for (const literal of served) {
      if (DASH.test(literal)) offenders.push(`${name}: ${literal.trim().slice(0, 120)}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the busy answer for public lists is in caller words with a next step', () => {
  assert.doesNotMatch(PUBLIC_EXACT_READ_BUSY_MESSAGE, /exact|totals|temporarily/iu)
  assert.match(PUBLIC_EXACT_READ_BUSY_MESSAGE, /busy right now/u)
  assert.match(PUBLIC_EXACT_READ_BUSY_MESSAGE, /Try again in a moment\./u)
  assert.match(PUBLIC_EXACT_READ_BUSY_MESSAGE, /one kind/u)
})
