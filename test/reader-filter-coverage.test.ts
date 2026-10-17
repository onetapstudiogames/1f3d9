// The coverage scan for mutes (decision #156, step 2 plan risk 2): a read path that never
// asks the reader's mutes would leak what a resident muted. Every source file that reads
// moderation_actions or calls a moderation overlay, and every GET route, is listed here as
// shaped by the reader's mutes or as exempt with its reason. A new file or GET route fails
// this test until it is placed, and a shaped one must import the one filter.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [relative(root, path).split(sep).join('/')] : []
  })
}

const FILES = sourceFiles(join(root, 'src'))
const text = (file: string) => readFileSync(join(root, file), 'utf8')
const FILTER_IMPORT = /from '\.\/(?:reader-filter|resident-mutes)\.ts'/u

// Files that read moderation_actions or call an overlay helper, and what each does for mutes.
const MODERATION_READERS: Readonly<Record<string, string>> = Object.freeze({
  'src/drawings.ts': 'shaped: drawing and drawing_history send an outline for a muted record',
  'src/gazette-delivery.ts': 'shaped in src/index.ts: me drops the headlines of muted notes after this builds them',
  'src/gazette-happenings.ts': 'exempt: the founder-written Gazette happenings column, printed for everyone',
  'src/gazette-store.ts': 'shaped in src/gazette-routes.ts: an issue read drops the entries of muted notes',
  'src/index.ts': 'shaped: search, changes, events, residents and me',
  'src/later-holder.ts': 'exempt: later_holder_items lists only your own things',
  'src/me-around-you.ts': 'shaped: around_you leaves muted notes and things out in its own SQL and counts them',
  'src/moderation-review.ts': 'exempt: review requests are moderation records about you, which always show',
  'src/moderation-store.ts': 'exempt: the moderation overlay itself; mutes run right after it',
  'src/pending-ping-summary.ts': 'shaped: the summary leaves pings from muted residents out',
  'src/public-directory.ts': 'exempt: the names directory feeds the front door and the human window, one shared text',
  'src/public-drawing-presence.ts': 'exempt: has_drawing SQL fragments inside reads that are themselves shaped',
  'src/public-map.ts': 'shaped in src/world.ts: the map marks muted place rows',
  'src/public-records.ts': 'shaped in src/world.ts and src/society.ts: one thing or note by id sends its outline',
  'src/public-replay.ts': 'exempt: the replay file is a bulk public file for archives and humans; no tool reads it',
  'src/public-search.ts': 'shaped in src/index.ts: search drops muted notes and things',
  'src/public-snapshot-format.ts': 'exempt: the snapshot registry; resident_mutes is not_public',
  'src/read-here.ts': 'shaped in src/society.ts: read_here sends the outline of a muted note',
  'src/resident-hold.ts': 'exempt: holds are moderation records about you, which always show',
  'src/room-orientation.ts': 'shaped in src/world.ts: front matter drops muted things and is empty for a muted place',
  'src/room-talk-routes.ts': 'shaped: lines, one ping by id, and wait_here before it decides to return',
  'src/society.ts': 'shaped: one note, read_here and agreements',
  'src/window.ts': 'exempt: the human window, which uses browser mutes',
  'src/world-market.ts': 'exempt: world-aisle sale terms are money and ownership facts, which always show',
  'src/world.ts': 'shaped: map, place reads, one thing, kinds and traits',
  'src/engine.ts': 'exempt: world mechanics; a mute never changes what the world does',
  'src/engine-reach.ts': 'exempt: world mechanics; a mute never changes what the world does',
  'src/engine-settle.ts': 'exempt: world mechanics; a mute never changes what the world does',
  'src/place-hinges.ts': 'exempt: world mechanics; a mute never changes what the world does',
  'src/talk-event-targets.ts': 'exempt: world mechanics; a mute never changes what the world does',
})

const SHAPED_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "src/world.ts '/api/map'": 'muted place rows marked; a keyed answer is private',
  "src/world.ts '/api/place/:id'": 'notes, things, lines and presence dropped and counted; places marked',
  "src/world.ts '/api/thing/:id'": 'outline only',
  "src/world.ts '/api/kinds'": 'dropped and counted',
  "src/world.ts '/api/traits'": 'dropped and counted',
  "src/society.ts '/api/note/:id'": 'outline only',
  "src/society.ts '/api/note/:id/here'": 'outline only',
  "src/society.ts '/api/agreements'": 'dropped and counted unless you are a party',
  "src/room-talk-routes.ts '/api/line/:id'": 'outline only',
  "src/room-talk-routes.ts '/api/ping/:id'": 'outline only',
  "src/room-talk-routes.ts '/api/place/:id/lines'": 'dropped and counted',
  "src/index.ts '/api/search'": 'dropped and counted; places marked',
  "src/index.ts '/api/changes'": 'dropped and counted',
  "src/index.ts '/api/events'": 'dropped and counted; moderation always shows',
  "src/index.ts '/api/residents'": 'dropped and counted; one muted handle sends its outline',
  "src/index.ts '/api/me'": 'pings counted and marked seen; Gazette headlines and around_you counted',
  "src/gazette-routes.ts '/api/gazette/:issue_number'": 'entries dropped and counted',
  "src/drawings.ts '/api/drawing/:type/:id'": 'outline for a muted record',
  "src/drawings.ts '/api/drawing/:type/:id/history'": 'outlines for a muted record',
})

const HUMAN = 'human page or asset: human views use browser mutes'
const SHARED = 'one shared text for everyone, with no resident-written content to shape'
const MONEY = 'money and ownership facts, which always show'
const PRIVATE = 'the caller\'s own private record or a founder-only queue'
const EXEMPT_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "src/drawings.ts '/api/drawing/:type/:id/thumb.png'": 'a public cached image for humans',
  "src/gazette-routes.ts '/api/gazette'": 'the issue list carries issue numbers and dates, never an entry',
  "src/gazette-routes.ts '/api/internal/gazette-print'": 'the internal printer',
  "src/gazette-reading.ts '/gazette/:issue_number'": HUMAN,
  "src/gazette-reading.ts '/gazette/:issue_number/card.png'": HUMAN,
  "src/room-talk-routes.ts '/api/talk/now'": HUMAN,
  "src/index.ts '/api/window'": HUMAN,
  "src/index.ts '/window'": HUMAN,
  "src/index.ts '/window/:view'": HUMAN,
  "src/index.ts '/window/:kind/:id'": HUMAN,
  "src/index.ts '/window.css'": HUMAN,
  "src/index.ts '/window.js'": HUMAN,
  "src/index.ts '/share/view.png'": HUMAN,
  "src/index.ts '/share/place.png'": HUMAN,
  "src/index.ts '/share/thing.png'": HUMAN,
  "src/index.ts '/share/note.png'": HUMAN,
  "src/index.ts '/'": 'the front door: one shared, edge-cached text whose recent activity carries no body',
  "src/index.ts '/llms.txt'": SHARED,
  "src/index.ts '/reference.txt'": SHARED,
  "src/index.ts '/reference/:section'": SHARED,
  "src/index.ts '/robots.txt'": SHARED,
  "src/index.ts '/humans.txt'": SHARED,
  "src/index.ts '/.well-known/openai-apps-challenge'": SHARED,
  "src/index.ts '/api/replay'": 'a bulk public file for archives and humans; no tool reads it',
  "src/index.ts '/api/moderation'": 'moderation records always show',
  "src/index.ts '/api/official'": SHARED,
  "src/index.ts '/api/physics'": SHARED,
  "src/index.ts '/api/treasury'": MONEY,
  "src/index.ts '/treasury'": MONEY,
  "src/index.ts '/api/city-credit/preflight'": MONEY,
  "src/index.ts '/buy'": HUMAN,
  "src/index.ts '/buy.css'": HUMAN,
  "src/index.ts '/buy.js'": HUMAN,
  "src/index.ts '/gift-redirect'": HUMAN,
  "src/index.ts '/gift-redirect.css'": HUMAN,
  "src/index.ts '/gift-redirect.js'": HUMAN,
  "src/index.ts '/api/founder/city-credit/:handle'": PRIVATE,
  "src/index.ts '/api/founder/community-tool-submissions'": PRIVATE,
  "src/index.ts '/api/founder/flags'": PRIVATE,
  "src/index.ts '/mcp'": 'door discovery; every tool forwards to the shaped routes',
  "src/index.ts '/mcp/connect'": 'door discovery; every tool forwards to the shaped routes',
  "src/index.ts APP_DOOR_PATH": 'door discovery; every tool forwards to the shaped routes',
  "src/resident-settings.ts '/api/me/settings'": 'the settings store itself, read only by its owner',
  "src/world-market.ts '/api/world/resident/:handle'": MONEY,
  "src/world-market.ts '/api/world/offer/:offerId'": MONEY,
  "src/changelog.ts '/api/changelog'": SHARED,
  "src/changelog.ts '/api/changelog/:id'": SHARED,
  "src/changelog.ts '/changelog'": SHARED,
  "src/changelog.ts '/changelog.txt'": SHARED,
  "src/city-facts.ts FULL_TOOL_CATALOG_PATH": SHARED,
  "src/city-help.ts '/api/help'": SHARED,
  "src/human-pages.ts '/about'": HUMAN,
  "src/human-pages.ts '/market'": HUMAN,
  "src/human-pages.ts '/tools'": HUMAN,
  "src/human-pages.ts '/help'": HUMAN,
  "src/human-pages.ts '/setup'": HUMAN,
  "src/human-pages.ts '/guide.css'": HUMAN,
  "src/human-pages.ts '/tools.js'": HUMAN,
  "src/human-pages.ts '/favicon.svg'": HUMAN,
  "src/human-pages.ts '/favicon.ico'": HUMAN,
  "src/human-pages.ts '/favicon-32x32.png'": HUMAN,
  "src/human-pages.ts '/apple-touch-icon.png'": HUMAN,
  "src/human-pages.ts '/og-image.png'": HUMAN,
  "src/identity-browser.ts '/join'": 'sign-in page',
  "src/identity-browser.ts '/rotate'": 'sign-in page',
  "src/identity-browser.ts '/recovery'": 'sign-in page',
  "src/legal.ts '/terms'": SHARED,
  "src/legal.ts '/privacy'": SHARED,
  "src/legal.ts '/support'": SHARED,
  "src/mcp-call-log-routes.ts '/api/founder/mcp-calls'": PRIVATE,
  "src/oauth.ts '/.well-known/oauth-protected-resource'": 'sign-in discovery',
  "src/oauth.ts '/.well-known/oauth-protected-resource/mcp/connect'": 'sign-in discovery',
  "src/oauth.ts '/.well-known/oauth-protected-resource/mcp/app'": 'sign-in discovery',
  "src/oauth.ts '/.well-known/oauth-authorization-server'": 'sign-in discovery',
  "src/oauth.ts '/oauth/authorize'": 'sign-in page',
  "src/payment-recovery-routes.ts '/api/payment-attempt/:id'": MONEY,
  "src/payment-recovery-routes.ts '/api/internal/payment-recovery'": PRIVATE,
  "src/paypal-credit-routes.ts `${PAYPAL_ROUTE_PATH}/residents/:number`": MONEY,
  "src/prepaid-credit-routes.ts '/api/city-credit/gifts/residents/:number'": MONEY,
  "src/season/routes.ts '/api/season'": 'city-written season styles, no resident content',
  "src/season/routes.ts '/season/:file'": 'city-written season styles, no resident content',
  "src/season/routes.ts '/season/icon/:file'": 'city-written season styles, no resident content',
  "src/season/routes.ts '/season/word/:file'": 'city-written season styles, no resident content',
})

test('every file that reads moderation records is placed as shaped by mutes or exempt with its reason', () => {
  const readers = FILES.filter(file => (
    /moderation_actions|moderatePublicRows|moderatePublicEvents|moderatePlaceDetails|moderatePendingPingRows|moderatePublicKinds/u
      .test(text(file))
  )).sort()
  assert.deepEqual(readers, Object.keys(MODERATION_READERS).sort(), 'a new reader of moderation records needs a place in this list')
  for (const [file, reason] of Object.entries(MODERATION_READERS)) {
    assert.match(reason, /^(?:shaped|exempt)/u, file)
    if (/^shaped:/u.test(reason)) assert.match(text(file), FILTER_IMPORT, `${file} is shaped, so it must use the one filter`)
  }
})

test('every GET route is placed as shaped by mutes or exempt with its reason', () => {
  const routes = FILES.flatMap(file => [...text(file).matchAll(/app\.get\(\s*([^,]+?)\s*,/gu)].map(match => `${file} ${match[1]}`)).sort()
  const placed = [...Object.keys(SHAPED_ROUTES), ...Object.keys(EXEMPT_ROUTES)].sort()
  assert.deepEqual(routes, placed, 'a new GET route needs a place in this list')
  for (const route of Object.keys(SHAPED_ROUTES)) {
    const file = route.split(' ')[0]!
    assert.match(text(file), FILTER_IMPORT, `${route} is shaped, so its file must use the one filter`)
  }
  for (const [route, reason] of Object.entries(EXEMPT_ROUTES)) assert.ok(reason.length > 10, route)
})
