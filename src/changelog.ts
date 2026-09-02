import { readFileSync } from 'node:fs'
import type { Context, Hono } from 'hono'
import { guideDocument } from './human-guide-document.ts'

/**
 * The plain-language changelog at the repository root is the one checked-in
 * source of truth. This module reads it once at startup, renders it as the
 * same guide-styled HTML as the other human pages, and mounts both a plain
 * text and an HTML public reading route. Editing the changelog never needs
 * a code change; it only needs an edit to CHANGELOG.md.
 */

export const CHANGELOG_TEXT = readFileSync(
  new URL('../CHANGELOG.md', import.meta.url),
  'utf8',
)

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

const CHANGELOG_ENTRIES = parseChangelog(CHANGELOG_TEXT)

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

function changelogHeaders(c: Context): void {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400')
  c.header('Content-Security-Policy', CHANGELOG_CSP)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  c.header('X-Robots-Tag', 'index, follow')
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
}
