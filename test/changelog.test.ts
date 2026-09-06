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
  countChangelogUpdatesSince,
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
        // Timestamp decimal points are not sentence-ending full stops.
        const prose = item.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/gu, '[UTC timestamp]')
        assert.equal(item.endsWith('.'), true, `not a sentence: ${item}`)
        assert.equal((prose.match(/\./gu) ?? []).length, 1, `more than one sentence: ${item}`)
        assert.doesNotMatch(item, /[<>]/u, `looks like markup, not prose: ${item}`)
      }
    }
  }
})

test('the Gazette-owner residents line names every malformed-edit 400 it disclaims, including an ineligible front_matter_thing_ids', () => {
  const changelog = read('CHANGELOG.md')
  const line = changelog
    .split('\n')
    .find(entry => entry.startsWith('- When the Gazette room\'s owner tries to change'))
  assert.ok(line, 'the Gazette-owner residents line was not found')
  // The room's protection refusal is the headline; the sentence's own contrast
  // needs to name every malformed edit that answers a plain 400 instead,
  // including front matter this room cannot hold (src/world.ts:1042-1043) --
  // not just an empty body or an invalid value.
  assert.match(line!, /empty body/iu, 'must keep naming the empty-body 400')
  assert.match(line!, /invalid value/iu, 'must keep naming the invalid-value 400')
  assert.match(
    line!,
    /front matter (?:this room cannot hold|it cannot hold)/iu,
    'must name the ineligible front_matter_thing_ids 400',
  )
  assert.doesNotMatch(line!, /\balways\b/iu, 'must not overclaim with "always"')
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

const UPDATE_COUNT_FIXTURE = parseChangelog([
  '## 2026-09-03',
  '### For residents',
  '- Third update.',
  '## 2026-09-02',
  '### For residents',
  '- First update.',
  '- Second update.',
  '## 2026-09-01',
  '### For residents',
  '- Old update.',
].join('\n'))

test('a first visit reports zero changelog updates', () => {
  assert.equal(countChangelogUpdatesSince(UPDATE_COUNT_FIXTURE, null), 0)
})

test('an entry whose UTC day ends at the visit remains included with later entries', () => {
  assert.equal(
    countChangelogUpdatesSince(UPDATE_COUNT_FIXTURE, '2026-09-02T23:59:59.999Z'),
    2,
  )
})

test('city updates count dated changelog groups, not their bullets', () => {
  assert.equal(
    countChangelogUpdatesSince(UPDATE_COUNT_FIXTURE, '2026-08-31T23:59:59.999Z'),
    3,
  )
})

test('a same-day changelog entry appears on the next read, repeats that day, and clears tomorrow', () => {
  const entries = parseChangelog([
    '## 2026-09-02',
    '### For residents',
    '- Same-day update.',
  ].join('\n'))

  assert.equal(countChangelogUpdatesSince(entries, '2026-09-02T08:00:00.000Z'), 1)
  assert.equal(countChangelogUpdatesSince(entries, '2026-09-02T20:00:00.000Z'), 1)
  assert.equal(countChangelogUpdatesSince(entries, '2026-09-03T00:00:00.000Z'), 0)
})

test('future-dated changelog entries do not count as city updates', () => {
  const entries = parseChangelog([
    '## 9999-12-31',
    '### For residents',
    '- Future update.',
    '## 2026-09-03',
    '### For residents',
    '- Landed update.',
  ].join('\n'))

  assert.equal(
    countChangelogUpdatesSince(entries, '2026-08-31T23:59:59.999Z'),
    1,
  )
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

test('the served doors state the exact since-last-visit and note clock-seam contracts', async () => {
  const sentence = '`GET /api/me` includes `since_last_visit` with the prior visit time, a count and link for changelog entries, exact accepted-gift and settled-purchase credit amounts, and the current pending-acceptance gift count with links to their private records; a changelog entry counts when its UTC day ends at or after the previous visit and is not in the future, so an entry dated today is reported again on every read today and clears tomorrow; on the first visit the prior time is null and the changelog count and credit amounts are zero while pending gifts still show, and reading `me` still counts as one visit.'
  const noteClockContract = [
    "A newly written note's created_at is its write time.",
    'Its paired public event row stores that exact timestamp in its at field.',
    'The clock-seam window is bracketed by note 8925, the last matching row before it',
    '(both timestamps 2026-08-29T05:21:20.883Z), and note 10590, the first matching row after it',
    '(both timestamps 2026-09-01T17:52:37.469Z).',
    'These matching rows bound the observed window, not the exact instants the behavior switched.',
    "Every one of the 1,662 notes strictly between them has created_at later than its paired event's at, never earlier or equal:",
    'the delay is at least 29 ms and at most 1,377 ms, with a median of 43 ms and 95 in 100 within 67 ms.',
    'Thing rows never differed.',
    "To align a note with history, read its paired event's at or GET /api/changes, which reports the event clock under created_at;",
    'do not apply a fixed correction.',
    'Historical rows stay exactly as written.',
  ].join(' ')
  const responses = await Promise.all([app.request('/'), app.request('/llms.txt')])
  const [frontDoor, compactMap] = await Promise.all([
    responses[0]!.text(),
    responses[1]!.text(),
  ])
  for (const [name, value] of [
    ['front door source', read('src/frontdoor.txt')],
    ['compact map source', read('src/llms.txt')],
    ['embedded front door', FRONTDOOR],
    ['embedded compact map', LLMS],
    ['served front door', frontDoor],
    ['served compact map', compactMap],
  ] as const) {
    assert.ok(value.includes(sentence), `${name}: since-last-visit contract`)
    assert.equal(
      value.replace(/\s+/gu, ' ').match(/A newly written note's created_at .*?Historical rows stay exactly as written\./u)?.[0],
      noteClockContract,
      `${name}: exact note clock-seam window and event-clock field contract`,
    )
  }
})
