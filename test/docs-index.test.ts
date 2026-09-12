import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = resolve(ROOT, 'docs')
const GENERATED_DIRECTORIES = new Set([
  '.agents', '.git', '.github', 'node_modules', 'test-results', 'playwright-report', 'coverage', '.vercel',
])

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    if (entry.isDirectory() && GENERATED_DIRECTORIES.has(entry.name)) return []
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  }))
  return nested.flat().sort()
}

test('the documentation map indexes every project Markdown document exactly once', async () => {
  const index = await readFile(resolve(DOCS, 'README.md'), 'utf8')
  const rows = [...index.matchAll(
    /^\| \[([^\]]+)\]\(([^)]+\.md)\) \| (current|historical|archived)(?:, (\d{4}-\d{2}-\d{2}))? \|$/gmu,
  )]
  const indexed = new Map(rows.map(match => [resolve(DOCS, match[2]!), {
    status: match[3]!, date: match[4],
  }]))
  assert.equal(indexed.size, rows.length, 'the documentation map contains a duplicate path')

  const documents = await markdownFiles(ROOT)
  assert.deepEqual(
    [...indexed.keys()].sort().map(path => relative(ROOT, path).replaceAll('\\', '/')),
    documents.map(path => relative(ROOT, path).replaceAll('\\', '/')),
  )

  for (const document of documents) {
    const opening = (await readFile(document, 'utf8')).split(/\r?\n/u).slice(0, 40).join('\n')
    const record = indexed.get(document)
    assert.ok(record, relative(ROOT, document))
    const expected = record.status === 'current'
      ? 'Status: current.'
      : `Status: ${record.status} as of ${record.date}.`
    assert.match(opening, new RegExp(`^${expected.replaceAll('.', '\\.')}\\s*$`, 'mu'), relative(ROOT, document))
    if (record.status !== 'current') {
      assert.match(relative(ROOT, document).replaceAll('\\', '/'), /^docs\/archive\//u)
      assert.ok(record.date, `${relative(ROOT, document)} needs a historical date`)
    }
  }
})

test('workflow templates and generated artifact folders are outside the project-doc set', async () => {
  const documents = (await markdownFiles(ROOT)).map(path => relative(ROOT, path).replaceAll('\\', '/'))
  assert.equal(documents.some(path => /^(?:\.agents|\.github|test-results|playwright-report|coverage|\.vercel)\//u.test(path)), false)
})
