// Every write route either checks the founder's hold or is listed as always allowed
// under one, with the reason (decisions #149, #150 and #151). A new write route fails
// here until it is placed on one list. A second scan keeps every daily counter on the
// limit the hold module computes, never on a bare city cap.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOLD_CALL = /\b(?:activeHold|dailyLimit|holdStopping|holdStoppingPlace)\(/u

function sourceFiles(): string[] {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
  return walk(join(ROOT, 'src'))
    .map(file => relative(ROOT, file).split(sep).join('/'))
    .filter(file => file.endsWith('.ts') && file !== 'src/door.ts' && !file.startsWith('src/window-client/'))
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

type Registration = Readonly<{ key: string; file: string; handler: string }>

function writeRoutes(): Registration[] {
  return sourceFiles().flatMap(file => {
    const text = read(file)
    const matches = [...text.matchAll(/\bapp\.(post|patch|put|delete)\(\s*([^,]+?),/gu)]
    return matches.map((match, index) => {
      const next = matches[index + 1]?.index ?? text.length
      return Object.freeze({
        key: `${match[1]!.toUpperCase()} ${match[2]} ${file}`,
        file,
        handler: text.slice(match.index, next),
      })
    })
  })
}

// Each of these refuses past a hold. The value names where the hold is read: the
// handler itself, or the store module the handler writes through.
const CHECKS_THE_HOLD: Readonly<Record<string, string>> = Object.freeze({
  "POST '/api/note' src/society.ts": 'handler and src/note-action.ts',
  "POST '/api/line' src/room-talk-routes.ts": 'src/room-line-store.ts',
  "POST '/api/ping' src/room-talk-routes.ts": 'src/room-ping-store.ts',
  "POST '/api/agreement' src/society.ts": 'src/agreement-action.ts',
  "POST '/api/agreement/:id/open-accession' src/society.ts": 'src/agreement-action.ts',
  "POST '/api/agreement/:id/sign' src/society.ts": 'src/agreement-action.ts',
  "POST '/api/thing' src/world.ts": 'src/thing-making.ts',
  "POST '/api/place' src/world.ts": 'handler',
  "POST '/api/kind' src/world.ts": 'handler',
  "POST '/api/kind/:id/revise' src/world.ts": 'handler',
  "POST '/api/trait' src/world.ts": 'handler',
})

// Always allowed under a hold, each with its reason.
const ALWAYS_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  "POST '/api/action' src/actions.ts": 'moving, going home, using, consuming and giving; copies stay bounded by the place (#112)',
  "POST '/api/go-home' src/actions.ts": 'going home can never be blocked',
  "POST '/api/thing/:id/use' src/actions.ts": 'using a thing adds no new words; its copies stay bounded by the place (#112)',
  "POST '/api/thing/:id/consume' src/actions.ts": 'consuming your own thing removes, never adds',
  "POST '/api/me/home' src/actions.ts": 'choosing your own home is part of going home',
  "POST '/api/city-credit/purchase/x402' src/city-credit-purchase.ts": 'a hold never touches fee credit',
  "PATCH '/api/me/drawing' src/drawings.ts": 'your own portrait is editing your own',
  "POST '/tools' src/human-pages.ts": 'a human form, not a resident write',
  'POST path src/identity-api.ts': 'identity door; a hold never touches your key',
  "POST '/api/register' src/identity-api.ts": 'identity door',
  "POST '/api/rotate' src/identity-api.ts": 'identity door; rotating your own key',
  "POST '/api/recovery' src/identity-api.ts": 'identity door; recovering your own key',
  "POST '/join' src/identity-browser.ts": 'identity door',
  "POST '/rotate' src/identity-browser.ts": 'identity door',
  "POST '/recovery' src/identity-browser.ts": 'identity door',
  "POST '/api/register' src/index.ts": 'identity door',
  "POST '/api/rotate' src/index.ts": 'identity door',
  "POST '/api/recovery' src/index.ts": 'identity door',
  "POST '/api/pair' src/index.ts": 'pairing your own chat client',
  "POST '/api/me' src/index.ts": 'reading your own later-holder notices',
  "POST '/api/thing/:id/mark' src/index.ts": 'a private mark on a thing you hold adds no public words',
  "POST '/api/founder/city-credit' src/index.ts": 'founder only',
  "POST '/api/founder/city-credit/disputes/:disputeId/resolve' src/index.ts": 'founder only',
  "POST '/api/founder/community-tool-submissions/:id/review' src/index.ts": 'founder only',
  "POST '/api/founder/flags/:id/handle' src/index.ts": 'founder only',
  "POST '/api/flag' src/index.ts": 'flags always work',
  "POST '/api/moderation' src/index.ts": 'founder only; this is where a hold is set',
  "POST '/api/internal/mcp-looking' src/index.ts": 'a passive looking cue, never a write of words',
  "POST '/mcp' src/index.ts": 'the MCP door forwards each tool to the routes on these two lists',
  "POST '/mcp/connect' src/index.ts": 'the MCP door forwards each tool to the routes on these two lists',
  'POST APP_DOOR_PATH src/index.ts': 'the MCP door forwards each tool to the routes on these two lists',
  "POST '/api/internal/log-drain' src/log-drain-routes.ts": 'platform logs, not a resident write',
  "POST '/oauth/register' src/oauth.ts": 'sign-in door',
  "POST '/oauth/authorize' src/oauth.ts": 'sign-in door',
  "POST '/oauth/token' src/oauth.ts": 'sign-in door',
  "POST '/oauth/revoke' src/oauth.ts": 'sign-in door',
  'POST PAIR_DOOR_PATH src/pair.ts': 'pairing your own chat client',
  "POST '/api/payment-attempt/:id/recheck' src/payment-recovery-routes.ts": 'rechecking a payment already made; a hold never touches money',
  'POST `${PAYPAL_ROUTE_PATH}/orders` src/paypal-credit-routes.ts': 'a hold never touches fee credit',
  'POST `${PAYPAL_ROUTE_PATH}/orders/:purchaseId/capture` src/paypal-credit-routes.ts': 'a hold never touches fee credit',
  'POST `${PAYPAL_ROUTE_PATH}/allowances` src/paypal-credit-routes.ts': 'a hold never touches fee credit',
  'POST `${PAYPAL_ROUTE_PATH}/webhook` src/paypal-credit-routes.ts': 'a hold never touches fee credit',
  'POST `/api/city-credit/gifts/:giftId/${action}` src/prepaid-credit-routes.ts': 'a hold never touches fee credit',
  "POST '/api/city-credit/gifts/:giftId/redirect' src/prepaid-credit-routes.ts": 'a hold never touches fee credit',
  "POST '/api/ping/:id/answer' src/room-talk-routes.ts": 'answering a ping is one fixed word, never new text',
  "POST '/api/ping/:id/dismiss' src/room-talk-routes.ts": 'dismissing your own receipt',
  "POST '/api/wait-here' src/room-talk-routes.ts": 'waits always work',
  "POST '/api/transfer' src/society.ts": 'giving always works',
  "POST '/api/transfer/offer' src/society.ts": 'offering your own property always works',
  "POST '/api/transfer/:offerId/claim' src/society.ts": 'claiming an offer moves property, never words',
  "POST '/api/transfer/:offerId/cancel' src/society.ts": 'cancelling your own offer',
  "POST '/api/world/listing' src/world-market.ts": 'a hold never touches a market listing',
  "POST '/api/world/offer/:offerId/claim' src/world-market.ts": 'a hold never touches a market sale',
  "POST '/api/world/offer/:offerId/reconcile' src/world-market.ts": 'a hold never touches a market sale',
  "POST '/api/world/offer/:offerId/cancel' src/world-market.ts": 'a hold never touches a market listing',
  "PATCH '/api/place/:id' src/world.ts": 'editing your own place always works',
  "PUT '/api/place/:id/laws' src/world.ts": 'setting your own place laws is editing your own land',
  "PATCH '/api/thing/:id' src/world.ts": 'editing your own thing always works',
  "POST '/api/thing/:id/upgrade' src/world.ts": 'upgrading your own thing to its kind\'s current revision',
  "POST '/api/thing/:id/withdraw' src/world.ts": 'withdrawing your own thing removes, never adds',
})

test('every write route checks the hold or is always allowed with a reason', () => {
  const routes = writeRoutes()
  const listed = new Set([...Object.keys(CHECKS_THE_HOLD), ...Object.keys(ALWAYS_ALLOWED)])
  assert.equal(Object.keys(CHECKS_THE_HOLD).some(key => Object.hasOwn(ALWAYS_ALLOWED, key)), false)
  const unlisted = [...new Set(routes.map(route => route.key))].filter(key => !listed.has(key))
  assert.deepEqual(unlisted, [], 'place each new write route on one of the two hold lists')
  const stale = [...listed].filter(key => !routes.some(route => route.key === key))
  assert.deepEqual(stale, [], 'a listed write route no longer exists')
  assert.equal(routes.length, 72, 'the city has 72 write route registrations; a new one needs a list entry')
  for (const reason of Object.values(ALWAYS_ALLOWED)) assert.ok(reason.length > 0)

  for (const [key, where] of Object.entries(CHECKS_THE_HOLD)) {
    const route = routes.find(entry => entry.key === key)!
    for (const place of where.split(' and ')) {
      if (place === 'handler') {
        assert.match(route.handler, HOLD_CALL, `${key} reads the hold in its handler`)
      } else {
        const source = read(place)
        assert.match(source, /from '\.\/resident-hold\.ts'/u, `${place} imports the hold module`)
        assert.match(source, HOLD_CALL, `${place} reads the hold`)
      }
    }
  }
})

test('the building doors read the hold before any fee is asked', () => {
  const routes = writeRoutes()
  for (const key of [
    "POST '/api/place' src/world.ts",
    "POST '/api/kind' src/world.ts",
    "POST '/api/kind/:id/revise' src/world.ts",
  ]) {
    const handler = routes.find(route => route.key === key)!.handler
    const holdAt = handler.search(HOLD_CALL)
    const feeAt = handler.indexOf('treasuryFee(')
    assert.ok(holdAt > 0, `${key} reads the hold`)
    assert.ok(feeAt === -1 || holdAt < feeAt, `${key} reads the hold before treasuryFee`)
  }
})

test('every daily counter compares against the limit the hold module computes', () => {
  const comparison = /\b(notes_today|things_today|agreement_actions_today|day_used)\s*(?:<|>=)\s*(\$\{)?\s*([\w.]+)/gu
  const found: string[] = []
  for (const file of sourceFiles()) {
    for (const match of read(file).matchAll(comparison)) {
      const limit = match[3]!
      found.push(`${file}: ${match[1]} against ${limit}`)
      assert.match(limit, /^(?:\w+\.limit|dailyThingLimit)$/u, `${file} compares ${match[1]} with ${limit}`)
    }
  }
  assert.ok(found.length >= 10, found.join('\n'))
  // Crafting takes its limit from the one caller, which reads the hold.
  assert.match(read('src/thing-making.ts'), /\{ dailyThingLimit: things\.limit \}/u)
  for (const file of sourceFiles()) {
    assert.doesNotMatch(
      read(file),
      /(?:<|>=)\s*\$?\{?\s*(?:QUOTAS\.(?:notes|things|agreements)|LINES_PER_UTC_DAY)\b/u,
      `${file} compares a counter with a bare city cap`,
    )
  }
})

test('every reader of moderation_actions names its target_type, so a hold never reads as a removal', () => {
  // A hold lives on target_type 'hold' (decision #151). Every query that works out a
  // record's latest moderation filters by target_type, so a hold or its restore can
  // never read as a removal or restore of a resident or of content. The public log
  // is the one reader that lists every row on purpose.
  const listsEveryRow = /JOIN residents actor ON actor\.id = action\.actor_id\s+WHERE \(\$1::integer IS NULL OR action\.id < \$1::integer\)/u
  const unfiltered: string[] = []
  for (const file of sourceFiles()) {
    const text = read(file)
    for (const match of text.matchAll(/(?:FROM|JOIN)\s+(?:public\.)?moderation_actions\b/gu)) {
      const window = text.slice(match.index, match.index + 200)
      if (/target_type/u.test(window) || listsEveryRow.test(window)) continue
      unfiltered.push(`${file}: ${window.slice(0, 80)}`)
    }
  }
  assert.deepEqual(unfiltered, [])
})
