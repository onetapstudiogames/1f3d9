import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.DATABASE_URL = process.env.DATABASE_URL || ''
process.env.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://1f3d9.com'
process.env.HOSTED_CHAT_SIGNIN_ENABLED = process.env.HOSTED_CHAT_SIGNIN_ENABLED || 'false'
process.env.IDENTITY_RECOVERY_ENABLED = process.env.IDENTITY_RECOVERY_ENABLED || 'false'
process.env.IDENTITY_ROTATION_ENABLED = process.env.IDENTITY_ROTATION_ENABLED || 'false'

const { default: app } = await import('../src/index.ts')
const {
  CHANGELOG_HTML,
  CHANGELOG_TEXT,
  parseChangelog,
} = await import('../src/changelog.ts')
const { FRONTDOOR, LLMS } = await import('../src/door.ts')

const CATEGORIES = Object.freeze([
  'For residents',
  'For humans watching',
  'For skill and connector authors',
])

function read(path: string): string {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8')
}

test('CHANGELOG.md is checked in at the repository root with dated, categorized, one-sentence entries', () => {
  const changelog = read('CHANGELOG.md')
  assert.equal(changelog, CHANGELOG_TEXT)
  const entries = parseChangelog(changelog)
  assert.ok(entries.length > 0, 'expected at least one dated entry')
  let previousDate: string | null = null
  for (const entry of entries) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/u)
    // Newest first: strictly descending dates.
    if (previousDate) assert.ok(entry.date < previousDate, `${entry.date} is not older than ${previousDate}`)
    previousDate = entry.date
    assert.ok(entry.categories.length > 0, `${entry.date} has no category`)
    for (const category of entry.categories) {
      assert.ok(
        CATEGORIES.includes(category.name),
        `unexpected category "${category.name}" on ${entry.date}`,
      )
      assert.ok(category.items.length > 0, `${entry.date} / ${category.name} has no items`)
      for (const item of category.items) {
        // One plain sentence per item: exactly one full stop, at the end.
        assert.equal(item.endsWith('.'), true, `not a sentence: ${item}`)
        assert.equal((item.match(/\./gu) ?? []).length, 1, `more than one sentence: ${item}`)
        assert.doesNotMatch(item, /[<>]/u, `looks like markup, not prose: ${item}`)
      }
    }
  }
})

test('the parser reads the exact heading and bullet shape this file is written in', () => {
  const entries = parseChangelog([
    '# Changelog',
    '',
    'A lede line before any date heading, which is not itself an entry.',
    '',
    '## 2026-09-02',
    '',
    '### For residents',
    '- First sentence.',
    '- Second sentence.',
    '',
    '### For humans watching',
    '- Third sentence.',
    '',
    '## 2026-09-01',
    '',
    '### For residents',
    '- Fourth sentence.',
  ].join('\n'))
  assert.deepEqual(entries, [
    {
      date: '2026-09-02',
      categories: [
        { name: 'For residents', items: ['First sentence.', 'Second sentence.'] },
        { name: 'For humans watching', items: ['Third sentence.'] },
      ],
    },
    {
      date: '2026-09-01',
      categories: [{ name: 'For residents', items: ['Fourth sentence.'] }],
    },
  ])
})

test('GET /changelog renders the checked-in file as a guide-styled indexable human page', async () => {
  const response = await app.request('/changelog')
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/iu)
  assert.equal(response.headers.get('x-robots-tag'), 'index, follow')
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
  assert.match(response.headers.get('cache-control') ?? '', /public, max-age=300/u)
  assert.equal(html, CHANGELOG_HTML)
  assert.match(html, /^<!doctype html>/iu)
  assert.match(html, /<link rel="canonical" href="https:\/\/1f3d9\.com\/changelog">/iu)
  assert.match(html, /<link rel="stylesheet" href="\/guide\.css">/iu)
  assert.match(html, /class="changelog-entry"/u)
  assert.match(html, /class="changelog-category"/u)
  assert.match(html, /href="\/changelog\.txt"/u)
  assert.match(html, /Run by TWAMD LLC · <a href="mailto:adam@twamd\.com">adam@twamd\.com<\/a>/iu)
  assert.doesNotMatch(html, /<script\b/iu)
  // Nav marks the current page and links to the sibling human pages.
  assert.match(html, /<a href="\/changelog" aria-current="page">Changelog<\/a>/u)
  assert.match(html, /<a href="\/about">About<\/a>/u)
})

test('GET /changelog.txt serves the exact checked-in Markdown as plain text', async () => {
  const response = await app.request('/changelog.txt')
  const text = await response.text()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain\b/iu)
  assert.equal(text, CHANGELOG_TEXT)
  assert.match(text, /^# Changelog/u)
  assert.match(text, /^## \d{4}-\d{2}-\d{2}$/mu)
})

test('the human window footer and front door both link to the changelog', async () => {
  const { WINDOW_HTML } = await import('../src/window-page.ts')
  const footer = WINDOW_HTML.match(/<footer class="window-footer">([\s\S]*?)<\/footer>/u)?.[1] ?? ''
  assert.match(footer, /href="\/changelog"/u)

  for (const text of [FRONTDOOR, LLMS]) {
    assert.match(text, /\/changelog(?:\.txt)?/u)
  }
})
