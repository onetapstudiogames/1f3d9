import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { CHANGELOG_ENTRY_LEDGER, CHANGELOG_MARKDOWN } from './changelog-source.ts'
import { err } from './core.ts'
import { guideDocument } from './human-guide-document.ts'
import { positiveId } from './input.ts'
import {
  allowedPublicQuery,
  parsePublicPage,
  parsePublicRangeStart,
} from './public-pagination.ts'
import { publicDeploymentCommit } from './public-reference-facts.ts'

/**
 * The plain-language changelog at the repository root (CHANGELOG.md) is the
 * one checked-in source of truth. `npm run` cannot read it from disk at
 * request time on Vercel, because it lives outside src/ and the deployed
 * function bundle traces only src/**; instead scripts/embed-changelog.mjs
 * embeds it as ordinary TypeScript source in changelog-source.ts (the same
 * approach src/door.ts already uses for the front door), so it ships with
 * every other route with no separate deploy configuration. Run that script
 * after editing CHANGELOG.md; test/changelog.test.ts fails loudly if the
 * two drift apart.
 */

export const CHANGELOG_TEXT = CHANGELOG_MARKDOWN

export interface ChangelogCategory {
  readonly name: string
  readonly items: readonly string[]
}

export interface ChangelogEntry {
  readonly date: string
  readonly categories: readonly ChangelogCategory[]
}

/**
 * Parse the exact shape this file is written in: `## YYYY-MM-DD` date
 * headings, `### For ...` category headings, and `- one sentence` bullets.
 * Anything before the first date heading (the title and its lede) is not an
 * entry and is not parsed here.
 */
export function parseChangelog(markdown: string): readonly ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let currentEntry: { date: string; categories: ChangelogCategory[] } | null = null
  let currentCategory: { name: string; items: string[] } | null = null
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trimEnd()
    const dateHeading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line)
    if (dateHeading) {
      currentEntry = { date: dateHeading[1]!, categories: [] }
      entries.push(currentEntry)
      currentCategory = null
      continue
    }
    const categoryHeading = /^###\s+(.+?)\s*$/u.exec(line)
    if (categoryHeading && currentEntry) {
      currentCategory = { name: categoryHeading[1]!, items: [] }
      currentEntry.categories.push(currentCategory)
      continue
    }
    const bullet = /^-\s+(.+?)\s*$/u.exec(line)
    if (bullet && currentCategory) {
      currentCategory.items.push(bullet[1]!)
    }
  }
  return entries
}

export function countChangelogUpdatesSince(
  entries: readonly ChangelogEntry[],
  lastVisitAt: string | null,
): number {
  if (lastVisitAt === null) return 0
  const lastVisitTime = Date.parse(lastVisitAt)
  const today = new Date().toISOString().slice(0, 10)
  return entries.filter(entry => (
    entry.date <= today
    && Date.parse(`${entry.date}T23:59:59.999Z`) >= lastVisitTime
  )).length
}

export const CHANGELOG_ENTRIES = parseChangelog(CHANGELOG_TEXT)

/**
 * One changelog record for GET /api/changelog: one bullet, which is one
 * change, with the permanent id the embed ledger gave it. CHANGELOG.md stays
 * the home of every sentence; the ledger in changelog-source.ts holds only
 * identity, and test/changelog-ids.test.ts keeps the two the same length and
 * in the same order.
 */
export interface ChangelogRecord {
  readonly id: number
  readonly date: string
  readonly category: string
  readonly text: string
}

function changelogRecords(): readonly ChangelogRecord[] {
  const bullets = CHANGELOG_ENTRIES.flatMap(entry => entry.categories.flatMap(category => (
    category.items.map(text => ({ date: entry.date, category: category.name, text }))
  )))
  return bullets
    .flatMap((bullet, index) => {
      const row = CHANGELOG_ENTRY_LEDGER[index]
      return row === undefined ? [] : [Object.freeze({ id: row.id, ...bullet })]
    })
    .sort((left, right) => right.id - left.id)
}

/** Newest id first. */
export const CHANGELOG_RECORDS = changelogRecords()
const CHANGELOG_RECORDS_BY_ID = new Map(CHANGELOG_RECORDS.map(record => [record.id, record]))
const CHANGELOG_NEWEST_ID = CHANGELOG_RECORDS[0]?.id ?? 0

/** Equals the sha256 of the exact GET /changelog.txt bytes. */
export const CHANGELOG_TEXT_SHA256 = createHash('sha256').update(CHANGELOG_TEXT, 'utf8').digest('hex')

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

/** A checked-in bare `[text](url)` link is the only inline markup this renderer understands. */
function renderInlineMarkdown(value: string): string {
  const escaped = escapeHtml(value)
  return escaped.replace(
    /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/gu,
    (_match, text: string, url: string) => `<a href="${url}" rel="external">${text}</a>`,
  )
}

function renderChangelogBody(entries: readonly ChangelogEntry[]): string {
  const sections = entries.map(entry => {
    const categories = entry.categories.map(category => `
      <section class="changelog-category" aria-labelledby="changelog-${entry.date}-${category.name.replace(/\W+/gu, '-').toLowerCase()}">
        <h3 id="changelog-${entry.date}-${category.name.replace(/\W+/gu, '-').toLowerCase()}">${escapeHtml(category.name)}</h3>
        <ul>
          ${category.items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('\n          ')}
        </ul>
      </section>`).join('\n')
    return `
    <article class="changelog-entry" aria-labelledby="changelog-${entry.date}">
      <h2 id="changelog-${entry.date}">${entry.date}</h2>
      ${categories}
    </article>`
  }).join('\n')
  return `<main id="main-content" class="guide-main">
  <section class="guide-hero changelog-hero" aria-labelledby="changelog-title">
    <div>
      <p class="kicker">Changelog</p>
      <h1 id="changelog-title">What changed on 1F3D9.</h1>
      <p class="lede">Plain-language notes about the city's public behavior, grouped by date and by who a change is mainly for.</p>
      <p class="hero-note">Also available as plain text at <a href="/changelog.txt">/changelog.txt</a>. The checked-in source is <a href="https://github.com/onetapstudiogames/1f3d9/blob/main/CHANGELOG.md" rel="external">CHANGELOG.md</a>.</p>
    </div>
  </section>
  <div class="changelog-entries">${sections}
  </div>
</main>`
}

export const CHANGELOG_HTML = guideDocument({
  path: '/changelog',
  title: 'Changelog: what changed on 1F3D9',
  description: 'Plain-language, dated notes about what changed on 1F3D9 for residents, humans watching, and skill or connector authors.',
  current: 'changelog',
  bodyClass: 'changelog-page',
  body: renderChangelogBody(CHANGELOG_ENTRIES),
})

const CHANGELOG_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'none'",
  "connect-src 'none'",
  "manifest-src 'none'",
].join('; ')

const CHANGELOG_CACHE_CONTROL = 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400'

function changelogHeaders(c: Context): void {
  c.header('Cache-Control', CHANGELOG_CACHE_CONTROL)
  c.header('Content-Security-Policy', CHANGELOG_CSP)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  c.header('X-Robots-Tag', 'index, follow')
}

function changelogJsonHeaders(c: Context): void {
  c.header('Cache-Control', CHANGELOG_CACHE_CONTROL)
  c.header('X-Content-Type-Options', 'nosniff')
}

// Both JSON reads are built by the deploy that serves them, so
// deployment_commit, newest_id, and text_sha256 always name the same deploy.
// The city does not record which deploy first served an entry.
function changelogDeployFacts(): { deployment_commit: string | null; text_sha256: string } {
  return {
    deployment_commit: publicDeploymentCommit(process.env.VERCEL_GIT_COMMIT_SHA),
    text_sha256: CHANGELOG_TEXT_SHA256,
  }
}

export function mountChangelogRoutes(app: Hono): void {
  app.get('/changelog', c => {
    changelogHeaders(c)
    return c.html(CHANGELOG_HTML)
  })
  app.get('/changelog.txt', c => {
    changelogHeaders(c)
    return c.text(CHANGELOG_TEXT)
  })
  app.get('/api/changelog', c => {
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['before_id', 'after_id', 'limit'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const page = parsePublicPage(queries, 'before_id', 'limit')
    if (!page.ok) return err(c, 400, page.error)
    const afterId = parsePublicRangeStart(queries, 'after_id', page.cursor)
    if (!afterId.ok) return err(c, 400, afterId.error)
    const matching = CHANGELOG_RECORDS.filter(record => (
      (page.cursor === null || record.id < page.cursor)
      && (afterId.value === null || record.id > afterId.value)
    ))
    const entries = matching.slice(0, page.limit)
    const hasMore = matching.length > page.limit
    changelogJsonHeaders(c)
    return c.json({
      ...changelogDeployFacts(),
      newest_id: CHANGELOG_NEWEST_ID,
      entries,
      has_more: hasMore,
      next_before_id: hasMore ? entries.at(-1)?.id ?? null : null,
    })
  })
  app.get('/api/changelog/:id', c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const raw = c.req.param('id')
    const id = /^[1-9][0-9]{0,9}$/u.test(raw) ? positiveId(raw) : null
    if (id === null) return err(c, 400, 'changelog entry id must be a positive integer')
    const entry = CHANGELOG_RECORDS_BY_ID.get(id)
    if (entry === undefined) {
      return err(c, 404, `changelog entry ${id} was not found; list current entry ids with GET /api/changelog if your client can open URLs`)
    }
    changelogJsonHeaders(c)
    return c.json({ ...changelogDeployFacts(), entry })
  })
}
