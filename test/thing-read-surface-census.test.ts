import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'
import { mcp } from '../src/mcp.ts'

// The read-surface census (things ending, plan 3.1 and 3.8). Every route the city mounts and
// every tool on every door is named here with its ending decision, so no answer that returns
// a thing row goes without the end:
//
// - full: the answer carries the section 0 full object, key ending;
// - short: every thing row in the answer carries the short status, key ends;
// - none: the answer names no thing row (a page, a sign-in step, money, talk, notes, kinds,
//   or a receipt that names a thing by id only, to be read with the thing read);
// - exempt: the answer names things, but as history or under a rule, with the reason.
//
// A carrying route names the code that builds its answer, which must appear in its handler,
// and the real-PostgreSQL subtest that proves it on a fixture with an active end and a
// remnant (the five-states fixture), which must exist under that exact title.
//
// A second census names every read of the things table outside the bricks (the bricks are
// test/thing-writer-census.test.ts's), so a new query that returns thing rows has to say
// how its rows carry the end. A route, tool or read site added, moved or removed fails here
// until it is listed with its decision.

type Proof = readonly [file: string, subtest: string]
type Carrying = Readonly<{ carries: 'full' | 'short'; how: string; builder: string; proof: readonly Proof[] }>
type Plain = `${'none' | 'exempt'}: ${string}`
type RouteDecision = Carrying | Plain

const LISTS = 'test/integration/thing-endings-lists-postgres.test.ts'
const ME = 'test/integration/thing-endings-me-postgres.test.ts'
const THING_READ = 'test/integration/thing-endings-thing-read-postgres.test.ts'
const OFFERS = 'test/integration/thing-endings-offers-postgres.test.ts'
const ENDINGS = 'test/integration/thing-endings-postgres.test.ts'
const ANSWERS = 'test/integration/thing-endings-answers-postgres.test.ts'

const OFFER_READS: Proof = [OFFERS, 'offer reads carry the end as snapshot v4 exports it, and record nothing']
const AGREEMENT_READS: Proof = [ENDINGS, 'an agreement links 0 to 16 things and every agreement read shows each status']
const HIDDEN_OUTLINE: Proof = [ME, 'a hidden outline carries ends']

const PAGE = 'none: a served page, script, style or picture that is the same for every thing'
const SIGN_IN = 'none: a sign-in, key or identity step; it names no thing'
const CREDIT = 'none: fee credit or a payment door for credit; it names no thing'
const FOUNDER_TOOLS = 'none: a founder operations read or act; it names no thing'
const TALK = 'none: lines, pings and waits; a line names no thing'
const NOTE = 'none: notes; a note names no thing'
const KIND = 'none: kinds and traits; a kind answer names no thing'
const TRANSFER_RECEIPT = 'none: a receipt naming the moved thing by type and asset_id only; the thing read carries its end'

const ROUTES: Readonly<Record<string, RouteDecision>> = Object.freeze<Record<string, RouteDecision>>({
  'src/app-pages.ts GET /.well-known/assetlinks.json': PAGE,
  'src/app-pages.ts GET /app-ads.txt': PAGE,
  'src/human-pages.ts GET /setup.js': PAGE,
  'src/legal.ts GET /delete': PAGE,
  'src/legal.ts GET /delete.js': PAGE,
  'src/play-credit-routes.ts GET ${BASE}/orders/:orderId': CREDIT,
  'src/play-credit-routes.ts GET ${BASE}/residents/by-handle/:handle': CREDIT,
  'src/play-credit-routes.ts POST ${BASE}/orders': CREDIT,
  'src/play-credit-routes.ts POST ${BASE}/orders/:orderId/claim': CREDIT,
  'src/play-credit-routes.ts POST ${BASE}/webhook': CREDIT,
  'src/prepaid-credit-routes.ts POST /api/city-credit/gifts/redirect': CREDIT,
  'src/prepaid-credit-routes.ts POST /api/city-credit/gifts/status': CREDIT,
  'src/resident-retirement.ts GET /api/founder/resident-retirements': FOUNDER_TOOLS,
  'src/resident-retirement.ts POST /api/founder/resident-retirements/:id/complete': FOUNDER_TOOLS,
  'src/resident-retirement.ts POST /api/resident-retirement': SIGN_IN,
  'src/actions.ts POST /api/action':
    'none: an action receipt names things by id only (copied_thing_ids, converted_thing_ids, carried_thing_id); a settle inside it counts ends and names none',
  'src/actions.ts POST /api/go-home': 'none: going home moves the resident; carried things are named by id only',
  'src/actions.ts POST /api/thing/:id/use': 'none: a use receipt, as POST /api/action',
  'src/actions.ts POST /api/thing/:id/consume': 'none: a consume receipt, as POST /api/action',
  'src/actions.ts POST /api/me/home': 'none: the home place answer names no thing',
  'src/changelog.ts GET /changelog': PAGE,
  'src/changelog.ts GET /changelog.txt': PAGE,
  'src/changelog.ts GET /api/changelog': 'none: the changelog entries name no thing',
  'src/changelog.ts GET /api/changelog/:id': 'none: one changelog entry names no thing',
  'src/city-credit-purchase.ts POST /api/city-credit/purchase/x402': CREDIT,
  'src/city-facts.ts GET FULL_TOOL_CATALOG_PATH': 'none: the tool catalogue names no thing',
  'src/city-help.ts GET /api/help': 'none: help text names no thing',
  'src/drawings.ts GET /api/drawing/:type/:id/thumb.png':
    'exempt: a picture of the stored drawing, with no field to carry; GET /api/drawing/thing/:id beside it carries ends',
  'src/drawings.ts GET /api/drawing/:type/:id/history': {
    carries: 'short', how: 'ends at the top level of a thing drawing history', builder: 'thingEndsField',
    proof: [[LISTS, 'a drawing read and its history carry ends and show the stored presentation']],
  },
  'src/drawings.ts GET /api/drawing/:type/:id': {
    carries: 'short', how: 'ends at the top level of a thing drawing read', builder: 'thingEndsField',
    proof: [[LISTS, 'a drawing read and its history carry ends and show the stored presentation']],
  },
  'src/drawings.ts PATCH /api/me/drawing': 'none: the resident drawing answer names no thing',
  'src/gazette-reading.ts GET /gazette/:issue_number':
    'exempt: a printed Gazette issue is history as of its print; thing_ended is the end own history row',
  'src/gazette-reading.ts GET /gazette/:issue_number/card.png': PAGE,
  'src/gazette-routes.ts GET /api/gazette': 'exempt: the Gazette issues are history as of their print',
  'src/gazette-routes.ts GET /api/gazette/:issue_number': 'exempt: one Gazette issue is history as of its print',
  'src/gazette-routes.ts GET /api/internal/gazette-print': 'none: the scheduled print job answers its own run',
  'src/human-pages.ts GET /about': PAGE,
  'src/human-pages.ts GET /market': PAGE,
  'src/human-pages.ts GET /tools': PAGE,
  'src/human-pages.ts POST /tools': 'none: a community tool submission names no thing',
  'src/human-pages.ts GET /help': PAGE,
  'src/human-pages.ts GET /setup': PAGE,
  'src/human-pages.ts GET /guide.css': PAGE,
  'src/human-pages.ts GET /tools.js': PAGE,
  'src/human-pages.ts GET /favicon.svg': PAGE,
  'src/human-pages.ts GET /favicon.ico': PAGE,
  'src/human-pages.ts GET /favicon-32x32.png': PAGE,
  'src/human-pages.ts GET /apple-touch-icon.png': PAGE,
  'src/human-pages.ts GET /og-image.png': PAGE,
  'src/identity-api.ts POST path': SIGN_IN,
  'src/identity-api.ts POST /api/register': SIGN_IN,
  'src/identity-api.ts POST /api/rotate': SIGN_IN,
  'src/identity-api.ts POST /api/recovery': SIGN_IN,
  'src/identity-browser.ts GET /join': SIGN_IN,
  'src/identity-browser.ts POST /join': SIGN_IN,
  'src/identity-browser.ts GET /rotate': SIGN_IN,
  'src/identity-browser.ts POST /rotate': SIGN_IN,
  'src/identity-browser.ts GET /recovery': SIGN_IN,
  'src/identity-browser.ts POST /recovery': SIGN_IN,
  'src/index.ts ALL /join': SIGN_IN,
  'src/index.ts ALL /rotate': SIGN_IN,
  'src/index.ts ALL /recovery': SIGN_IN,
  'src/index.ts GET /': 'none: the front door text names no thing',
  'src/index.ts GET /llms.txt': PAGE,
  'src/index.ts GET /reference.txt': PAGE,
  'src/index.ts GET /reference/:section': PAGE,
  'src/index.ts GET /robots.txt': PAGE,
  'src/index.ts GET /humans.txt': PAGE,
  'src/index.ts GET /.well-known/openai-apps-challenge': PAGE,
  'src/index.ts GET /buy': PAGE,
  'src/index.ts GET /buy.css': PAGE,
  'src/index.ts GET /buy.js': PAGE,
  'src/index.ts GET /gift-redirect': PAGE,
  'src/index.ts GET /gift-redirect.css': PAGE,
  'src/index.ts GET /gift-redirect.js': PAGE,
  'src/index.ts GET /window': PAGE,
  'src/index.ts GET /window/:view': PAGE,
  'src/index.ts GET /window/:kind/:id':
    'exempt: the window page shell; its link-preview title and description name the thing (name, maker, body excerpt), and the thing view it opens reads GET /api/thing/:id with the full object',
  'src/index.ts GET /window.css': PAGE,
  'src/index.ts GET /window.js': PAGE,
  'src/index.ts GET /share/view.png': PAGE,
  'src/index.ts GET /share/place.png': PAGE,
  'src/index.ts GET /share/thing.png':
    'none: one fixed picture (WINDOW_SHARE_IMAGES.thing), the same bytes for every thing; it names no thing',
  'src/index.ts GET /share/note.png': PAGE,
  'src/index.ts GET /api/window': {
    carries: 'short',
    how: 'ends on every thing row of both presentations, every front matter heading, and every agreement thing link',
    builder: 'windowSnapshot',
    proof: [[ME, 'the window place rows and front matter carry ends'], AGREEMENT_READS],
  },
  'src/index.ts GET /api/search': {
    carries: 'short', how: 'ends on every thing hit, and on a hidden thing outline', builder: 'loadPublicSearchResults',
    proof: [[LISTS, 'search hits carry ends'], HIDDEN_OUTLINE],
  },
  'src/index.ts GET /api/changes':
    'exempt: change rows are history as of their moment; thing_ended is the end own history row (plan 3.1)',
  'src/index.ts POST /api/register': SIGN_IN,
  'src/index.ts POST /api/rotate': SIGN_IN,
  'src/index.ts POST /api/recovery': SIGN_IN,
  'src/index.ts POST /api/pair': SIGN_IN,
  'src/index.ts GET /api/city-credit/preflight': CREDIT,
  'src/index.ts GET /api/residents': 'none: resident records and presence name no thing',
  'src/index.ts POST /api/me':
    'exempt: the later-holder notice and index; a marked thing never carries an end, and an end is never set on one (#178, E4)',
  'src/index.ts GET /api/me': {
    carries: 'short',
    how: 'ends on owned things (carried ones included), on open thing offers and on agreement thing links; remnant_count beside each place thing_count',
    builder: 'thingShortEndsSql',
    proof: [
      [ME, 'me carries ends on owned things, a carried remnant included, and on open offers'],
      [ME, 'me counts remnants live beside each place thing count'],
      AGREEMENT_READS,
    ],
  },
  'src/index.ts POST /api/thing/:id/mark':
    'exempt: the later-holder mark answer; a marked thing never carries an end (#178), and marking a thing with an end refuses E4',
  'src/index.ts POST /api/founder/city-credit': FOUNDER_TOOLS,
  'src/index.ts POST /api/founder/city-credit/disputes/:disputeId/resolve': FOUNDER_TOOLS,
  'src/index.ts GET /api/founder/city-credit/:handle': FOUNDER_TOOLS,
  'src/index.ts GET /api/founder/community-tool-submissions': FOUNDER_TOOLS,
  'src/index.ts POST /api/founder/community-tool-submissions/:id/review': FOUNDER_TOOLS,
  'src/index.ts GET /api/founder/flags':
    'exempt: the founder flag queue names each report target by type and id with the reporter reason; the founder reads the thing itself',
  'src/index.ts POST /api/founder/flags/:id/handle': 'exempt: one handled flag report, as GET /api/founder/flags',
  'src/index.ts POST /api/founder/labels/end': 'none: the founder label ending answer names label rows, not things (#169)',
  'src/index.ts GET /api/official': 'none: official facts name no thing',
  'src/index.ts GET /api/physics': 'none: the physics read names no thing',
  'src/index.ts GET /api/replay':
    'exempt: the replay rebuilds public history from events as of each moment; thing_ended is the end own history row',
  'src/index.ts GET /api/events':
    'exempt: event rows are history as of their moment; thing_ended is the end own history row (plan 3.1)',
  'src/index.ts POST /api/flag': 'none: a flag receipt names its target by type and id only',
  'src/index.ts POST /api/moderation':
    'exempt: a public moderation record names its target by type and id as of the record',
  'src/index.ts GET /api/moderation': 'exempt: public moderation records name targets by type and id as of each record',
  'src/index.ts GET /treasury': PAGE,
  'src/index.ts GET /api/treasury': 'none: the public books name no thing',
  'src/index.ts POST /api/internal/mcp-looking': 'none: an internal looking cue names no thing',
  'src/index.ts POST /mcp': 'none: the MCP door; each tool answer is the route it calls (TOOLS below)',
  'src/index.ts POST /mcp/connect': 'none: the MCP door; each tool answer is the route it calls (TOOLS below)',
  'src/index.ts GET /mcp': 'none: the MCP door greeting names no thing',
  'src/index.ts GET /mcp/connect': 'none: the MCP door greeting names no thing',
  'src/index.ts POST APP_DOOR_PATH': 'none: the app MCP door; each tool answer is the route it calls (TOOLS below)',
  'src/index.ts GET APP_DOOR_PATH': 'none: the app MCP door greeting names no thing',
  'src/legal.ts GET /terms': PAGE,
  'src/legal.ts GET /privacy': PAGE,
  'src/legal.ts GET /support': PAGE,
  'src/log-drain-routes.ts POST /api/internal/log-drain': 'none: an internal log drain names no thing',
  'src/mcp-call-log-routes.ts GET /api/founder/mcp-calls': FOUNDER_TOOLS,
  'src/oauth.ts GET /.well-known/oauth-protected-resource': SIGN_IN,
  'src/oauth.ts GET /.well-known/oauth-protected-resource/mcp/connect': SIGN_IN,
  'src/oauth.ts GET /.well-known/oauth-protected-resource/mcp/app': SIGN_IN,
  'src/oauth.ts GET /.well-known/oauth-authorization-server': SIGN_IN,
  'src/oauth.ts POST /oauth/register': SIGN_IN,
  'src/oauth.ts GET /oauth/authorize': SIGN_IN,
  'src/oauth.ts POST /oauth/authorize': SIGN_IN,
  'src/oauth.ts POST /oauth/token': SIGN_IN,
  'src/oauth.ts POST /oauth/revoke': SIGN_IN,
  'src/pair.ts POST PAIR_DOOR_PATH': SIGN_IN,
  'src/pair.ts POST PAIR_DOOR_PATH#2': SIGN_IN,
  'src/payment-recovery-routes.ts GET /api/payment-attempt/:id':
    'exempt: one payment attempt with its stored response as written then (#32); the offer read carries the end',
  'src/payment-recovery-routes.ts POST /api/payment-attempt/:id/recheck':
    'exempt: a payment recheck answers the stored attempt (#32, #167); recovery never records an end',
  'src/payment-recovery-routes.ts GET /api/internal/payment-recovery': 'none: the scheduled recovery job answers its own run',
  'src/paypal-credit-routes.ts GET ${PAYPAL_ROUTE_PATH}/residents/:number': CREDIT,
  'src/paypal-credit-routes.ts POST ${PAYPAL_ROUTE_PATH}/orders': CREDIT,
  'src/paypal-credit-routes.ts POST ${PAYPAL_ROUTE_PATH}/orders/:purchaseId/capture': CREDIT,
  'src/paypal-credit-routes.ts POST ${PAYPAL_ROUTE_PATH}/allowances': CREDIT,
  'src/paypal-credit-routes.ts POST ${PAYPAL_ROUTE_PATH}/webhook': CREDIT,
  'src/prepaid-credit-routes.ts GET /api/city-credit/gifts/residents/:number': CREDIT,
  'src/prepaid-credit-routes.ts POST /api/city-credit/gifts/:giftId/${action}': CREDIT,
  'src/prepaid-credit-routes.ts POST /api/city-credit/gifts/:giftId/redirect': CREDIT,
  'src/resident-settings.ts GET /api/me/settings': {
    carries: 'short', how: 'ends on each thing row of waiting_transfers.oldest', builder: 'settingsAnswer',
    proof: [[ME, 'held gifts in settings carry ends on things only']],
  },
  'src/resident-settings.ts PATCH /api/me/settings': {
    carries: 'short', how: 'the same settings answer as the read, waiting thing rows with ends', builder: 'settingsAnswer',
    proof: [[ME, 'held gifts in settings carry ends on things only']],
  },
  'src/room-talk-routes.ts POST /api/line': TALK,
  'src/room-talk-routes.ts POST /api/ping': TALK,
  'src/room-talk-routes.ts POST /api/ping/:id/answer': TALK,
  'src/room-talk-routes.ts POST /api/ping/:id/dismiss': TALK,
  'src/room-talk-routes.ts POST /api/wait-here': TALK,
  'src/room-talk-routes.ts GET /api/line/:id': TALK,
  'src/room-talk-routes.ts GET /api/ping/:id': TALK,
  'src/room-talk-routes.ts GET /api/place/:id/lines': TALK,
  'src/room-talk-routes.ts GET /api/talk/now': TALK,
  'src/season/routes.ts GET /api/season': 'none: the season names no thing',
  'src/season/routes.ts GET /season/icon/:file': PAGE,
  'src/season/routes.ts GET /season/word/:file': PAGE,
  'src/season/routes.ts GET /season/:file': PAGE,
  'src/showing-room-cron-routes.ts GET /api/internal/showing-room-close': 'none: the scheduled showing-room act answers its own run',
  'src/showing-room-routes.ts GET /api/founder/showing-room': FOUNDER_TOOLS,
  'src/showing-room-routes.ts POST /api/founder/showing-room/contests': FOUNDER_TOOLS,
  'src/showing-room-routes.ts PATCH /api/founder/showing-room/contests/:id': FOUNDER_TOOLS,
  'src/showing-room-routes.ts POST /api/founder/showing-room/control': FOUNDER_TOOLS,
  'src/society.ts GET /api/note/:id': NOTE,
  'src/society.ts GET /api/note/:id/here': NOTE,
  'src/society.ts POST /api/note': NOTE,
  'src/society.ts POST /api/agreement': {
    carries: 'short', how: 'ends on each thing link of the new agreement', builder: 'createAgreementAction',
    proof: [AGREEMENT_READS],
  },
  'src/society.ts POST /api/agreement/:id/open-accession': 'none: an accession receipt names the agreement only',
  'src/society.ts POST /api/agreement/:id/sign': 'none: a signature receipt names the agreement only',
  'src/society.ts GET /api/agreements': {
    carries: 'short', how: 'ends on each thing link of every agreement row', builder: 'agreementThingLinksSql',
    proof: [AGREEMENT_READS],
  },
  'src/society.ts POST /api/transfer': TRANSFER_RECEIPT,
  'src/society.ts POST /api/transfer/offer': {
    carries: 'full', how: 'a thing offer answers asset_state, ending, end_program_summary and ending_checked_at',
    builder: 'readThingEnding',
    proof: [[OFFERS, 'a thing offered directly shows its end in the offer answer; a kind offer does not']],
  },
  'src/society.ts POST /api/transfer/:offerId/claim':
    'exempt: a direct claim answers its payment step or the stored completion body, which carry no end fields (TE-T12-build.md); the thing read and me offers carry the end before paying',
  'src/society.ts POST /api/transfer/:offerId/cancel': 'none: a cancel receipt names the offer id and status only',
  'src/society.ts POST /api/transfer/waiting/:waitingId/accept': TRANSFER_RECEIPT,
  'src/society.ts POST /api/transfer/waiting/:waitingId/decline': TRANSFER_RECEIPT,
  'src/world-market.ts GET /api/world/resident/:handle': 'none: names one resident handle',
  'src/world-market.ts GET /api/world/offer/:offerId': {
    carries: 'full', how: 'asset_state, ending, end_program_summary and ending_checked_at', builder: 'publicOffer(',
    proof: [OFFER_READS],
  },
  'src/world-market.ts GET /api/world/offers': {
    carries: 'full', how: 'each offer as the single read', builder: 'publicOffer(', proof: [OFFER_READS],
  },
  'src/world-market.ts POST /api/world/listing': {
    carries: 'full', how: 'the new offer, built by publicOffer as the offer reads are', builder: 'publicOffer(',
    proof: [OFFER_READS],
  },
  'src/world-market.ts POST /api/world/offer/:offerId/claim': {
    carries: 'full',
    how: 'the offer, built by publicOffer, in the pending 202, the founder-review 409 and the already-claimed re-read; '
      + 'the 402 payment challenge has no offer, and a completed claim replays the stored completion body, '
      + 'whose offer names the thing with no end fields (#32)',
    builder: 'publicOffer(',
    proof: [OFFER_READS],
  },
  'src/world-market.ts POST /api/world/offer/:offerId/reconcile': {
    carries: 'full',
    how: 'the offer, built by publicOffer, in the pending 202, the founder-review 409 and the re-read of a claimed, '
      + 'canceled or invalid-payment offer; a completed reconcile replays the stored completion body, '
      + 'whose offer names the thing with no end fields (#32)',
    builder: 'publicOffer(', proof: [OFFER_READS],
  },
  'src/world-market.ts POST /api/world/offer/:offerId/cancel': {
    carries: 'full', how: 'the offer, built by publicOffer', builder: 'publicOffer(',
    proof: [OFFER_READS, [OFFERS, 'cancel_world records a due end first, waits out a payment window, then unlocks on thing_ended']],
  },
  'src/world.ts GET /api/map': {
    carries: 'short', how: 'ends on the front matter of every place, outline and full', builder: 'readPublicMap',
    proof: [[LISTS, 'front matter carries ends on the place read and both map reads']],
  },
  'src/world.ts GET /api/place/:id': {
    carries: 'short',
    how: 'ends on every thing row and front matter heading, a hidden thing outline, and things_page.remnant_items',
    builder: 'loadPublicPlaceCollectionRows',
    proof: [
      [LISTS, 'place thing rows carry ends in the outline, the full view and a byte-limited page'],
      [LISTS, 'the place count keeps remnants as items and adds a live remnant count'],
      [LISTS, 'front matter carries ends on the place read and both map reads'],
      [ME, 'a focus outline carries ends'],
      HIDDEN_OUTLINE,
    ],
  },
  'src/world.ts GET /api/thing/:id': {
    carries: 'full', how: 'ending and end_program_summary beside on_use; a muted thing answers its outline with ends',
    builder: 'loadPublicThingRecord',
    proof: [[THING_READ, 'the thing read carries every state of the full ending object beside on_use'], HIDDEN_OUTLINE],
  },
  'src/world.ts POST /api/place': 'none: a new place has no things',
  'src/world.ts PATCH /api/place/:id': {
    carries: 'short', how: 'ends on the front matter headings of the edited place', builder: 'loadPublicPlaceFrontMatter',
    proof: [[ANSWERS, 'a place edit answers its front matter with ends']],
  },
  'src/world.ts PUT /api/place/:id/laws': 'none: the laws answer names traits and source thing ids only',
  'src/world.ts GET /api/kinds': KIND,
  'src/world.ts POST /api/kind': KIND,
  'src/world.ts POST /api/kind/:id/revise': KIND,
  'src/world.ts GET /api/traits': KIND,
  'src/world.ts POST /api/trait': KIND,
  'src/world.ts POST /api/thing': {
    carries: 'short', how: 'ends on the made thing when an end was sent', builder: 'withMadeThingEnds',
    proof: [[ANSWERS, 'make answers ends on a kindless and a crafted thing with an end, and none without']],
  },
  'src/world.ts PATCH /api/thing/:id': {
    carries: 'full', how: 'the edited thing as the thing read builds it', builder: 'loadPublicThingRecord',
    proof: [[ANSWERS, 'thing_edit and thing_upgrade answer the full ending object']],
  },
  'src/world.ts POST /api/thing/:id/upgrade': {
    carries: 'full', how: 'the upgraded or converted thing as the thing read builds it', builder: 'loadPublicThingRecord',
    proof: [[ANSWERS, 'thing_edit and thing_upgrade answer the full ending object']],
  },
  'src/world.ts POST /api/thing/:id/withdraw':
    'none: the withdrawal marker names the thing id and withdrawn_at only; a withdrawn thing shows no end',
})

// Each tool's answer is the answer of the routes it calls, passed through on every door.
const TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  act: ['POST /api/action', 'GET /api/physics'],
  agree: ['POST /api/agreement'],
  browse: [
    'GET /api/kinds', 'GET /api/traits', 'GET /api/agreements', 'GET /api/residents', 'GET /api/events',
    'GET /api/moderation', 'GET /treasury', 'GET /api/gazette', 'GET /api/gazette/:issue_number',
  ],
  buy_credit: ['POST /api/city-credit/purchase/x402'],
  cancel_world: ['POST /api/world/offer/:offerId/cancel'],
  changes: ['GET /api/changes'],
  claim_world: ['POST /api/world/offer/:offerId/claim'],
  coin_trait: ['POST /api/trait'],
  credit_gift: ['POST /api/city-credit/gifts/:giftId/${action}'],
  credit_preflight: ['GET /api/city-credit/preflight'],
  draw_self: ['PATCH /api/me/drawing'],
  drawing: ['GET /api/drawing/:type/:id'],
  drawing_history: ['GET /api/drawing/:type/:id/history'],
  flag: ['POST /api/flag', 'GET /api/founder/flags', 'POST /api/founder/flags/:id/handle'],
  found: ['POST /api/place'],
  front_door: ['GET /', 'GET /reference/:section'],
  help: ['GET /api/help'],
  home: ['POST /api/me/home'],
  invent_kind: ['POST /api/kind'],
  later_holder_items: ['POST /api/me'],
  laws: ['PUT /api/place/:id/laws'],
  list_world: ['POST /api/world/listing'],
  look: [
    'GET /api/map', 'GET /api/place/:id', 'GET /api/thing/:id', 'GET /api/note/:id', 'GET /api/line/:id',
    'GET /api/place/:id/lines',
  ],
  make: ['POST /api/thing'],
  mark_for_later: ['POST /api/thing/:id/mark'],
  me: ['GET /api/me', 'GET /api/me/settings', 'PATCH /api/me/settings'],
  moderate: ['POST /api/moderation'],
  official_facts: ['GET /api/official'],
  open_agreement_accession: ['POST /api/agreement/:id/open-accession'],
  payment_attempt: ['GET /api/payment-attempt/:id', 'POST /api/payment-attempt/:id/recheck'],
  physics: ['GET /api/physics'],
  ping: ['POST /api/ping', 'POST /api/ping/:id/answer', 'POST /api/ping/:id/dismiss'],
  place_edit: ['PATCH /api/place/:id'],
  read_here: ['GET /api/note/:id/here'],
  reconcile_world: ['POST /api/world/offer/:offerId/reconcile'],
  revise_kind: ['POST /api/kind/:id/revise'],
  say: ['POST /api/line', 'POST /api/note'],
  search: ['GET /api/search'],
  sign: ['POST /api/agreement/:id/sign'],
  thing_edit: ['PATCH /api/thing/:id'],
  thing_upgrade: ['POST /api/thing/:id/upgrade'],
  transfer: [
    'POST /api/transfer', 'POST /api/transfer/offer', 'POST /api/transfer/:offerId/claim',
    'POST /api/transfer/:offerId/cancel', 'POST /api/transfer/waiting/:waitingId/accept',
    'POST /api/transfer/waiting/:waitingId/decline',
  ],
  wait_here: ['POST /api/wait-here', 'GET /api/talk/now'],
  withdraw: ['POST /api/thing/:id/withdraw'],
})

// The bricks' own selections are test/thing-writer-census.test.ts's.
const BRICK_FILES = Object.freeze(new Set([
  'src/crafting.ts',
  'src/engine-convert.ts',
  'src/engine-copy.ts',
  'src/engine-effects.ts',
  'src/engine-end-try.ts',
  'src/engine-place-plan.ts',
  'src/engine-reach.ts',
  'src/engine-settle.ts',
  'src/engine-state.ts',
  'src/engine-target-scope.ts',
]))

type ReadDecision = `${'full' | 'short' | 'count' | 'check' | 'exempt'}: ${string}`

// full and short: the rows feed an answer that carries the end. count: a number of things,
// never a row. check: a door, engine or ending read that answers no thing row. exempt: with
// the reason.
const READ_SITES: Readonly<Record<string, ReadDecision>> = Object.freeze({
  'src/thing-ending-record.ts recordOne SELECT#1': 'check: locks the current owner before the ending row lock and due-end check; returns no public thing row',
  'src/agreement-action.ts thingLinksExist SELECT#1': 'check: agree checks each linked thing exists and is not withdrawn',
  'src/agreement-action.ts createAgreementAction SELECT#1': 'check: the same check inside the agreement write',
  'src/agreement-thing-links.ts agreementThingLinksJson SELECT#1': 'short: each agreement thing link with asset_state and ends',
  'src/drawings.ts DRAWING_READ_SQL SELECT#1': 'short: a thing drawing read with ends',
  'src/drawings.ts DRAWING_HISTORY_VISIBLE_SQL SELECT#1': 'short: a thing drawing history with ends',
  'src/engine.ts heldThingForResident SELECT#1': 'check: the engine finds what a resident carries',
  'src/engine.ts thingProgramsForAction SELECT#1': 'check: the engine reads the programs a use runs',
  'src/engine.ts missingActionIds SELECT#1': 'check: act tells a missing thing id from a refused one',
  'src/engine.ts lockActionThings SELECT#1': 'check: the engine locks things before an action',
  'src/engine.ts moveResidentWithCarry SELECT#1': 'check: the engine moves a carried thing with its carrier',
  'src/feed-rooms.ts eventRoomSql SELECT#1': 'exempt: maps an event to its room; events are history',
  'src/index.ts GET /api/me SELECT#1': 'count: me place thing_count, beside the live remnant_count',
  'src/index.ts GET /api/me SELECT#2': 'short: me owned things with ends',
  'src/index.ts GET /api/me SELECT#3': 'short: me open offers, a thing offer with ends',
  'src/later-holder.ts readLaterHolderNotice SELECT#1': 'exempt: a marked thing never carries an end (#178)',
  'src/later-holder.ts readLaterHolderIndex SELECT#1': 'exempt: a marked thing never carries an end (#178)',
  'src/later-holder.ts setLaterHolderMark SELECT#1': 'check: the mark door reads the thing it marks',
  'src/later-holder.ts setLaterHolderMark SELECT#2': 'check: the mark door reads the thing it marks',
  'src/later-holder.ts setLaterHolderMark SELECT#3': 'check: the mark door reads the thing it marks',
  'src/later-holder.ts setLaterHolderMark SELECT#4': 'check: the mark door reads the thing it marks',
  'src/later-holder.ts setLaterHolderMark SELECT#5': 'check: the mark door judges an end before it marks (E4, E7)',
  'src/me-around-you.ts AROUND_YOU_SQL SELECT#1':
    'exempt: new things in owned places are change pointers ({id, change_id}), no thing row; the thing read carries the end',
  'src/moderation-review.ts moderationReplyStanding SELECT#1': 'check: whether a moderation record names a thing the resident owns',
  'src/payment-activity-locks.ts PAYMENT_ACTIVITY_LOCK_CTES SELECT#1': 'check: payment locks the room of a thing',
  'src/payment-sale-operation-sql.ts INVALIDATE_SALE_TARGET_SQL SELECT#1': 'exempt: stored sale completion (#32, #167)',
  'src/payment-sale-operation-sql.ts INVALIDATE_SALE_TARGET_SQL SELECT#2': 'exempt: stored sale completion (#32, #167)',
  'src/payment-sale-operation-sql.ts WORLD_PARK_SQL SELECT#1': 'exempt: stored sale completion (#32, #167)',
  'src/payment-sale-operation-sql.ts WORLD_COMPLETION_SQL SELECT#1':
    'exempt: the stored completion body carries no end fields; a reader re-reads the offer (TE-T12-build.md)',
  'src/payment-sale-operations.ts readSaleAttempt SELECT#1': 'exempt: the payment attempt record as stored (#32)',
  'src/place-lifecycle-operation.ts COMPLETE_PLACE_LIFECYCLE_SQL SELECT#1': 'count: a retire check counts things in the place',
  'src/public-drawing-presence.ts PUBLIC_EVENT_THING_DRAWING_JOIN_SQL SELECT#1': 'exempt: whether an event thing has a drawing; events are history',
  'src/public-pagination.ts publicEventFilter SELECT#1': 'exempt: filters events by place; events are history',
  'src/public-pagination.ts publicEventFilter SELECT#2': 'exempt: filters events by place; events are history',
  'src/public-pagination.ts publicEventFilter SELECT#3': 'exempt: filters events by place; events are history',
  'src/public-pagination.ts publicEventFilter SELECT#4': 'exempt: filters events by place; events are history',
  'src/public-pagination.ts loadBudgetedPublicPlaceCollectionRows SELECT#1': 'short: place thing rows with ends, byte-limited page',
  'src/public-pagination.ts loadPublicPlaceCollectionRows SELECT#1': 'short: place thing rows with ends',
  'src/public-records.ts loadPublicThingRecord SELECT#1': 'full: the thing read, with ending through readThingEnding',
  'src/public-records.ts loadPublicThingRecord SELECT#2': 'full: the thing read, its labels ([] once the end has come)',
  'src/public-replay.ts REPLAY_START_SQL SELECT#1': 'exempt: the replay origin of each thing; replay is history',
  'src/public-search.ts thingCandidatesSql SELECT#1': 'short: search thing candidates; the page joins ending_thing for ends',
  'src/public-search.ts publicSearchSql SELECT#1': 'short: the search page joins ending_thing for ends',
  'src/reader-mutes.ts FACTS_SQL SELECT#1': 'short: a hidden thing outline with ends',
  'src/reading-cost.ts READING_COST_QUERY SELECT#1': 'count: the reading cost meter sums body bytes',
  'src/resident-mutes.ts readTarget SELECT#1': 'check: a mute reads its target author and owner',
  'src/room-orientation.ts loadPublicPlaceFrontMatter SELECT#1': 'short: front matter headings with ends',
  'src/society.ts POST /api/transfer/:offerId/claim SELECT#1': 'check: the direct claim door reads the thing it sells (E8)',
  'src/society.ts POST /api/transfer/:offerId/cancel SELECT#1': 'check: the direct cancel door reads the thing it unlocks',
  'src/thing-ending-doors.ts readDoorEndFacts SELECT#1': 'check: a door reads the end facts it judges',
  'src/thing-ending-owner.ts lockOwnerEnding SELECT#1': 'check: the owner end write locks its thing',
  'src/thing-ending-owner.ts lockOwnerEnding SELECT#2': 'check: the owner end write locks its thing',
  'src/thing-ending-owner.ts readOwnerEnding SELECT#1': 'check: the owner end write reads the stored end',
  'src/thing-ending-read.ts readThingEnding SELECT#1': 'full: the one full-object loader (offers and the thing read)',
  'src/thing-ending-record.ts dueUnrecorded SELECT#1': 'check: the recorder finds due ends',
  'src/thing-ending-record.ts LOCK_SQL SELECT#1': 'check: the recorder locks a due thing',
  'src/thing-ending-short.ts placeRemnantCountSql SELECT#1': 'count: the live remnant count, recorded ends',
  'src/thing-ending-short.ts placeRemnantCountSql SELECT#2': 'count: the live remnant count, due ends',
  'src/thing-presentation.ts readThingPresentation SELECT#1': 'check: the stored presentation an edit compares',
  'src/waiting-transfers.ts WAITING_LIST_TEXTS SELECT#1': 'short: waiting thing rows with ends',
  'src/window.ts OUTLINE_WINDOW_TOTALS_SQL SELECT#1': 'count: window outline totals',
  'src/window.ts windowCollectionStatement SELECT#1': 'short: window thing rows with ends, full presentation',
  'src/window.ts windowCollectionStatement SELECT#2': 'short: window thing rows with ends, headings presentation',
  'src/window.ts readFullWindowSnapshot SELECT#1': 'count: things per place in the window tree',
  'src/window.ts readFullWindowSnapshot SELECT#2': 'count: the window total of things',
  'src/withdrawal.ts withdrawThing SELECT#1': 'check: the withdraw door reads the thing (E7)',
  'src/withdrawal.ts withdrawThing SELECT#2': 'check: the withdraw write locks the room',
  'src/withdrawal.ts withdrawThing SELECT#3': 'check: the withdraw write locks the thing',
  'src/world-market.ts OFFER_SELECT SELECT#1': 'full: world offer rows; publicOffer adds the full object',
  'src/world-market.ts POST /api/world/listing SELECT#1': 'check: list_world reads the thing it locks',
  'src/world-market.ts POST /api/world/listing SELECT#2': 'check: list_world reads the thing it locks',
  'src/world-market.ts POST /api/world/offer/:offerId/claim SELECT#1': 'check: claim_world reads the thing it sells (E8)',
  'src/world-market.ts POST /api/world/offer/:offerId/cancel SELECT#1': 'check: cancel_world reads the thing it unlocks',
  'src/world-market.ts POST /api/world/offer/:offerId/cancel SELECT#2': 'check: cancel_world reads the thing it unlocks',
  'src/world.ts upgradeConvertedThing SELECT#1': 'check: a conversion upgrade locks the room',
  'src/world.ts readPublicMap SELECT#1': 'count: things per place in the map tree',
  'src/world.ts withMadeThingEnds SELECT#1': 'short: the made thing ends',
  'src/world.ts PATCH /api/place/:id SELECT#1': 'count: a retire check counts things in the place',
  'src/world.ts PATCH /api/place/:id SELECT#2': 'check: wake pins name things standing in the place',
  'src/world.ts PATCH /api/place/:id SELECT#3': 'check: front matter names eligible things in the place',
  'src/world.ts PATCH /api/place/:id SELECT#4': 'check: front matter names eligible things in the place',
  'src/world.ts PATCH /api/thing/:id SELECT#1': 'check: thing_edit reads the thing it edits (E5, E7)',
  'src/world.ts PATCH /api/thing/:id SELECT#2': 'check: thing_edit locks the room',
  'src/world.ts PATCH /api/thing/:id SELECT#3': 'check: thing_edit locks the thing',
  'src/world.ts PATCH /api/thing/:id SELECT#4': 'check: thing_edit returns the row; the answer is the thing read',
  'src/world.ts POST /api/thing/:id/upgrade SELECT#1': 'check: thing_upgrade reads the thing it upgrades (E7)',
  'src/world.ts POST /api/thing/:id/upgrade SELECT#2': 'check: thing_upgrade locks the room',
  'src/world.ts POST /api/thing/:id/upgrade SELECT#3': 'check: thing_upgrade locks the thing',
  'src/world.ts POST /api/thing/:id/upgrade SELECT#4': 'check: thing_upgrade returns the row; the answer is the thing read',
})

const DECLARATIONS = Object.freeze([
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/,
  /^(?:export\s+)?(?:const|let)\s+(\w+)/,
])
const ANY_ROUTE = /^\s*\w+\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)/
const ROUTE = /^\s*app\.(get|post|put|patch|delete|all)\(\s*(?:['"`]([^'"`]+)['"`]|(\w+))/
const SELECTION = /\b(?:FROM|JOIN)\s+things\b/g

function sourceFiles(): string[] {
  return (readdirSync(new URL('../src/', import.meta.url), { recursive: true }) as string[])
    .map(name => `src/${name.split('\\').join('/')}`)
    .filter(name => name.endsWith('.ts'))
    .sort()
}

function lines(path: string): string[] {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split('\n')
}

type Mounted = Readonly<{ key: string; handler: string }>

/** Every route each file mounts, named file, method and path, with its handler text. */
function mountedRoutes(): Mounted[] {
  const found: Mounted[] = []
  for (const path of sourceFiles()) {
    const text = lines(path)
    const starts: Array<{ line: number; name: string }> = []
    const seen = new Map<string, number>()
    text.forEach((line, index) => {
      const match = ROUTE.exec(line)
      if (!match) return
      const target = match[2] ?? match[3]!
      if (match[3] === undefined && !/^[/$]/u.test(target)) return
      const base = `${path} ${match[1]!.toUpperCase()} ${target}`
      const order = (seen.get(base) ?? 0) + 1
      seen.set(base, order)
      starts.push({ line: index, name: order === 1 ? base : `${base}#${order}` })
    })
    starts.forEach((start, index) => {
      const end = starts[index + 1]?.line ?? text.length
      found.push({ key: start.name, handler: text.slice(start.line, end).join('\n') })
    })
  }
  return found
}

function owner(line: string, current: string): string {
  const route = ANY_ROUTE.exec(line)
  if (route) return `${route[1]!.toUpperCase()} ${route[2]}`
  for (const declaration of DECLARATIONS) {
    const found = declaration.exec(line)
    if (found) return found[1]!
  }
  return current
}

function isComment(line: string): boolean {
  const trimmed = line.trim()
  return ['//', '*', '/*', '--'].some(start => trimmed.startsWith(start))
}

/** Every read of the things table outside the bricks, named as the writer census names it. */
function readSites(): string[] {
  const found: string[] = []
  for (const path of sourceFiles().filter(path => !BRICK_FILES.has(path))) {
    const seen = new Map<string, number>()
    let around = '(module)'
    for (const line of lines(path)) {
      around = owner(line, around)
      if (isComment(line)) continue
      for (const _match of line.matchAll(SELECTION)) {
        const base = `${path} ${around} SELECT`
        const order = (seen.get(base) ?? 0) + 1
        seen.set(base, order)
        found.push(`${base}#${order}`)
      }
    }
  }
  return found.sort()
}

function isCarrying(decision: RouteDecision): decision is Carrying {
  return typeof decision === 'object'
}

/** A route key without its file: "METHOD path", as a tool names it. */
function routeName(key: string): string {
  return key.split(' ').slice(1).join(' ').replace(/#\d+$/u, '')
}

async function toolNames(): Promise<string[]> {
  const previous = process.env.HOSTED_CHAT_SIGNIN_ENABLED
  process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
  const names = new Set<string>()
  try {
    for (const door of ['key', 'connect', 'app'] as const) {
      for (const authorization of [true, false]) {
        const gateway = new Hono()
        gateway.post('/mcp', c => mcp(c, new Hono(), { door, authenticateLegacyCatalog: async () => authorization }))
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (authorization) headers.Authorization = 'Bearer test-only'
        const response = await gateway.request('/mcp', {
          method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        assert.equal(response.status, 200, `${door} tools/list`)
        const body = await response.json() as { result: { tools: Array<{ name: string }> } }
        for (const tool of body.result.tools) names.add(tool.name)
      }
    }
  } finally {
    if (previous === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
    else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previous
  }
  return [...names].sort()
}

test('every route the city mounts is named with its ending decision', () => {
  const found = mountedRoutes().map(route => route.key).sort()
  assert.deepEqual(found, Object.keys(ROUTES).sort(),
    'a new, moved or removed route: list it in ROUTES with its ending decision')
  for (const [key, decision] of Object.entries(ROUTES)) {
    if (isCarrying(decision)) continue
    assert.match(decision, /^(none|exempt): \S/u, `${key} names its decision and why`)
  }
})

test('each carrying route is built by the code it names and proved by a subtest that exists', () => {
  const handlers = new Map(mountedRoutes().map(route => [route.key, route.handler]))
  const proofTexts = new Map<string, string>()
  for (const [key, decision] of Object.entries(ROUTES)) {
    if (!isCarrying(decision)) continue
    assert.ok(handlers.get(key)?.includes(decision.builder), `${key}: its handler uses ${decision.builder}`)
    assert.ok(decision.how.length > 0 && decision.proof.length > 0, `${key} says how it carries the end and names a proof`)
    for (const [file, subtest] of decision.proof) {
      if (!proofTexts.has(file)) proofTexts.set(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
      const text = proofTexts.get(file)!
      assert.ok(text.includes(`test('${subtest}'`), `${key}: ${file} has the subtest "${subtest}"`)
      assert.ok(text.includes(decision.carries === 'full' ? 'ending' : 'ends'), `${key}: ${file} checks the field`)
    }
  }
})

test('events, changes and the later-holder items are named exempt with their reason', () => {
  for (const key of ['src/index.ts GET /api/events', 'src/index.ts GET /api/changes']) {
    assert.match(String(ROUTES[key]), /^exempt: .*history/u, key)
  }
  for (const key of ['src/index.ts POST /api/me', 'src/index.ts POST /api/thing/:id/mark']) {
    assert.match(String(ROUTES[key]), /^exempt: .*#178/u, key)
  }
  assert.match(String(ROUTES['src/index.ts GET /share/thing.png']), /^none: /u)
  assert.equal((ROUTES['src/index.ts GET /api/window'] as Carrying).carries, 'short')
})

test('every tool on every door is named with the routes it calls, each one in the route census', async () => {
  assert.deepEqual(await toolNames(), Object.keys(TOOLS).sort(),
    'a new or removed tool: list it in TOOLS with the routes it calls')
  const names = new Set(Object.keys(ROUTES).map(routeName))
  for (const [tool, routes] of Object.entries(TOOLS)) {
    assert.ok(routes.length > 0, `${tool} calls a route`)
    for (const route of routes) assert.ok(names.has(route), `${tool}: ${route} is in the route census`)
  }
  // The thing-returning tools reach their ending field through the routes they call.
  const carrying = (tool: string) => TOOLS[tool]!.some(route => Object.entries(ROUTES)
    .some(([key, decision]) => routeName(key) === route && isCarrying(decision)))
  for (const tool of ['look', 'search', 'me', 'make', 'thing_edit', 'thing_upgrade', 'drawing', 'drawing_history',
    'browse', 'agree', 'transfer', 'list_world', 'claim_world', 'cancel_world', 'reconcile_world', 'place_edit']) {
    assert.ok(carrying(tool), `${tool} reaches a carrying route`)
  }
})

test('every read of the things table outside the bricks is a named site with its ending decision', () => {
  assert.deepEqual(readSites(), Object.keys(READ_SITES).sort(),
    'a new, moved or removed read of things: list it in READ_SITES with its ending decision')
  for (const [site, decision] of Object.entries(READ_SITES)) {
    assert.match(decision, /^(full|short|count|check|exempt): \S/u, `${site} names its decision and why`)
  }
})
