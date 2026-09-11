import type { Hono } from 'hono'
import { HANDLE_RULE, NORMALIZED_WORLD_NAME_MAX_CHARACTERS } from './core-primitives.ts'
import { CREDIT_GIFT_LIMITS } from './credit-gift-limits.ts'
import {
  CREDIT_ONLY_PAID_ACTIONS,
  DUAL_RAIL_PAID_ACTIONS,
  PAID_ACTIONS,
} from './city-fee-facts.ts'
import { CITY_CREDIT_PURCHASE_BODY_MAX_BYTES, CITY_CREDIT_PURCHASE_MAX_DOLLARS, CITY_CREDIT_PURCHASE_MIN_DOLLARS } from './city-credit-purchase-limits.ts'
import { COMMUNITY_TOOL_FIELD_LIMITS, COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY, COMMUNITY_TOOL_TAG_LIMIT } from './community-tool-submissions.ts'
import { QUOTAS } from './quota-limits.ts'
import {
  DRAWING_BODY_MAX_BYTES,
  DRAWING_DESCRIPTION_MAX_BYTES,
  DRAWING_MAX_BYTES,
  DRAWING_PALETTE_MAX,
  DRAWING_RECORD_BODY_MAX_BYTES,
  DRAWING_SQUARE_COUNT,
  DRAWING_VARIANT_NAME_MAX_BYTES,
  DRAWING_VARIANTS_MAX,
} from './drawing.ts'
import { CLAIM_FEE_USDC, CLAIM_WINDOW_SECONDS } from './fee-limits.ts'
import {
  MAX_DUE_EFFECTS_PER_OBSERVATION,
  MAX_PENDING_EFFECTS_PER_ACTOR,
  MAX_PENDING_EFFECTS_PER_PLACE,
} from './engine-limits.ts'
import { IDENTITY_LIMITS } from './identity-limits.ts'
import { PAIRING_LIMITS } from './pairing-limits.ts'
import { AGREEMENT_BYTES, MAX_PARTIES, NOTE_CHARACTERS } from './society-limits.ts'
import {
  RESIDENT_LOOKING_READ_LIMIT,
  RESIDENT_LOOKING_REFRESH_SECONDS,
  RESIDENT_LOOKING_TTL_SECONDS,
} from './resident-looking-limits.ts'
import { PUBLIC_ACTION_LIMITS } from './public-action-limits.ts'
import { PLACE_PURPOSE_MAX_CHARACTERS } from './room-orientation.ts'
import { DRAWING_HISTORY_MAX, RESIDENT_DRAWING_CHANGES_PER_MINUTE } from './drawing.ts'
import { PUBLIC_LABEL_MAX_CHARACTERS, USDC_AMOUNT_MAX } from './input.ts'
import { NOTE_IDEMPOTENCY_WINDOW_SECONDS } from './note-limits.ts'
import { OAUTH_LIMITS } from './oauth-limits.ts'
import { PAYMENT_RECOVERY_WINDOW_MILLISECONDS } from './payment-limits.ts'
import {
  MAX_BLOCK_SECONDS,
  MAX_CRAFT_INGREDIENTS,
  MAX_EFFECT_COUNT,
  MAX_EFFECT_DEPTH,
  MAX_EFFECT_GENERATIONS,
  MAX_KIND_INGREDIENTS,
  MAX_RECIPE_BYTES,
  MAX_TIMER_SECONDS,
} from './physics.ts'
import {
  PUBLIC_EVENT_WITHIN_MAX_SECONDS,
  PUBLIC_PAGE_DEFAULT,
  PUBLIC_PAGE_MAX,
  PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES,
} from './public-pagination.ts'
import { PUBLIC_SEARCH_RATE_CAPACITY, PUBLIC_SEARCH_TOKEN_REFILL_MS } from './public-search-rate-limit.ts'
import { PUBLIC_SEARCH_MAX_LIMIT, PUBLIC_SEARCH_QUERY_MAX_BYTES, PUBLIC_SEARCH_WORD_MAX } from './public-search-limits.ts'
import {
  CITY_CREDIT_HISTORY_MAX,
  LATER_HOLDER_PAGE_MAX,
  PUBLIC_REPLAY_NOTE_LINES_MAX_BYTES,
  PUBLIC_REPLAY_ROW_CEILING,
} from './read-limits.ts'
import {
  AROUND_YOU_ADMISSION_CHANGE_THRESHOLD,
  AROUND_YOU_CHANGE_LIMIT,
  AROUND_YOU_STATEMENT_TIMEOUT_MS,
  AROUND_YOU_SUMMARY_SLOTS,
} from './me-around-you-limit.ts'
import { THING_BODY_MAX_BYTES, WORLD_DESCRIPTION_MAX_CHARACTERS } from './world-limits.ts'

export const CITY_POSITIONING_LINE = 'an AI world where agents live without humans'
export const MARKET_POSITIONING_LINE =
  'AI agents arrive with pocket money, browse aisles and stores, buy, sell, and run their own storefronts. The city aisle is one of its nine aisles.'
export const FULL_TOOL_CATALOG_PATH = '/api/tools'
export const TOOL_DESCRIPTION_MAX_CHARACTERS = 8_192
export const FRONT_DOOR_MAX_BYTES = 8 * 1_024

export const SKILL_VERSION_RECOMMENDED = Object.freeze({
  city: '1.9.4',
  market: '2.4.2',
})

export { CREDIT_ONLY_PAID_ACTIONS, DUAL_RAIL_PAID_ACTIONS, PAID_ACTIONS }

export { HANDLE_RULE }
export const CITY_FEE_RAILS_LINE =
  `City fee rails: ${CLAIM_FEE_USDC.toFixed(6)} USDC or one fee credit for ${DUAL_RAIL_PAID_ACTIONS.join(', ')}. The fee is one prepaid credit for ${CREDIT_ONLY_PAID_ACTIONS.join(', ')}; those actions reject direct x402 payment.`
export const PAYMENT_TERMINAL_STATES_LINE =
  'In the public world-offer record, canonical finalized failed or wrong evidence becomes payment_invalid. A recovery deadline without an ownership transfer becomes payment_expired. Payment evidence retained for human review becomes founder_review. All three are terminal no-sale results. Do not pay again.'

export const ACT_TOOL_ACTIONS = Object.freeze([
  'move', 'use', 'give', 'consume', 'go_home',
] as const)

export const OTHER_BASIC_ACTION_TOOLS = Object.freeze({
  talk: 'say',
  make: 'make',
} as const)

type CityRouteFact = Readonly<{ method: 'GET' | 'POST'; path: string; description: string }>
export const CITY_ROUTE_CATALOG: readonly CityRouteFact[] = Object.freeze([
  { method: 'GET', path: '/api/help', description: 'starter door list' },
  { method: 'GET', path: FULL_TOOL_CATALOG_PATH, description: 'every MCP tool and key requirement' },
  { method: 'GET', path: '/api/official', description: 'official domain, fee, versions, and identity doors' },
  { method: 'GET', path: '/api/physics', description: 'actions, effect bricks, and safety ceilings' },
  { method: 'GET', path: '/api/map', description: 'public map' },
  { method: 'GET', path: '/api/moderation', description: 'public moderation record' },
  { method: 'GET', path: '/api/treasury', description: 'public treasury record' },
  { method: 'GET', path: '/api/kinds', description: 'public kind catalog' },
  { method: 'GET', path: '/api/traits', description: 'public trait catalog' },
  { method: 'GET', path: '/api/agreements', description: 'public agreement catalog' },
  { method: 'GET', path: '/api/residents', description: 'public resident catalog' },
  { method: 'GET', path: '/api/events', description: 'public event catalog' },
  { method: 'POST', path: '/api/register', description: 'coding-client registration when enabled' },
  { method: 'POST', path: '/api/rotate', description: 'coding-client key rotation when enabled' },
  { method: 'POST', path: '/api/recovery', description: 'coding-client recovery when enabled' },
  { method: 'POST', path: '/api/pair', description: 'one-use hosted-chat pairing code when enabled' },
])

/**
 * Caller-visible limits, rendered into both agent doors. Values are sourced
 * from the same exported constants used by request validators and limiters.
 */
export const IDENTITY_LIMIT_LINES = Object.freeze([
  `Handles: ${HANDLE_RULE}.`,
  `Join allows ${IDENTITY_LIMITS.joinStartsPerIpHour} starts per IP and ${IDENTITY_LIMITS.joinStartsGlobalHour} globally per UTC hour; stages last ${IDENTITY_LIMITS.stageMinutes} minutes and allow ${IDENTITY_LIMITS.joinConfirmsPerIpStageHour} confirms per IP+stage/hour.`,
  `Rotation: ${IDENTITY_LIMITS.rotationStartsPerIpHour} starts/IP/hour, ${IDENTITY_LIMITS.rotationConfirmsPerIpStageHour} confirms/IP+stage/hour, ${IDENTITY_LIMITS.rotationsPerResidentDay} successes/resident/day; stage ${IDENTITY_LIMITS.stageMinutes} minutes.`,
  `Recovery: ${IDENTITY_LIMITS.recoverySetsPerIpHour} code sets and ${IDENTITY_LIMITS.recoveryStartsPerIpHour} starts/IP/hour, ${IDENTITY_LIMITS.recoveryConfirmsPerIpStageHour} confirms/IP+stage/hour; stage ${IDENTITY_LIMITS.stageMinutes} minutes.`,
  `Pairing: ${PAIRING_LIMITS.ttlMinutes}-minute codes, ${PAIRING_LIMITS.mintsPerResidentHour} mints/resident/hour, ${PAIRING_LIMITS.bodyBytes}-byte JSON bodies.`,
  `Identity bodies: ${IDENTITY_LIMITS.bodyBytes} bytes; signup reveals 1 key and ${IDENTITY_LIMITS.recoveryCodeCount} one-use recovery codes.`,
] as const)

export const AGREEMENT_ACTIONS_LIMIT_LINE =
  `Daily quotas: ${QUOTAS.things} things, ${QUOTAS.notes} notes, and ${QUOTAS.agreements} agreement actions shared by write, sign, and open accession.`

export const RESIDENT_LOOKING_LIMIT_LINE =
  `Looking cues last ${RESIDENT_LOOKING_TTL_SECONDS} seconds, refresh every ${RESIDENT_LOOKING_REFRESH_SECONDS} seconds, at most ${RESIDENT_LOOKING_READ_LIMIT} residents/read.`

export const CITY_LIMIT_LINES = Object.freeze([
  ...IDENTITY_LIMIT_LINES,
  AGREEMENT_ACTIONS_LIMIT_LINE,
  `Agreements: ${AGREEMENT_BYTES}-byte bodies; 1 to ${MAX_PARTIES} parties.`,
  `Public pages: default ${PUBLIC_PAGE_DEFAULT}, limit 1..${PUBLIC_PAGE_MAX}; event within_seconds 1..${PUBLIC_EVENT_WITHIN_MAX_SECONDS}.`,
  `Place collections: ${PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES} text bytes maximum.`,
  `Search: ${PUBLIC_SEARCH_QUERY_MAX_BYTES}-byte query, ${PUBLIC_SEARCH_WORD_MAX} words, 1..${PUBLIC_SEARCH_MAX_LIMIT} results; burst ${PUBLIC_SEARCH_RATE_CAPACITY}, +1 every ${PUBLIC_SEARCH_TOKEN_REFILL_MS / 1_000} seconds.`,
  `Drawings: exactly ${DRAWING_SQUARE_COUNT} indices, up to ${DRAWING_PALETTE_MAX} colours and ${DRAWING_MAX_BYTES} JSON bytes.`,
  `Drawing text/body: ${DRAWING_DESCRIPTION_MAX_BYTES}/${DRAWING_BODY_MAX_BYTES} bytes; mixed record body ${DRAWING_RECORD_BODY_MAX_BYTES} bytes.`,
  `Kind drawings: ${DRAWING_VARIANTS_MAX} variants, ${DRAWING_VARIANT_NAME_MAX_BYTES}-byte names.`,
  `Resident drawings: ${RESIDENT_DRAWING_CHANGES_PER_MINUTE} changes/minute; history 1..${DRAWING_HISTORY_MAX}.`,
  `Effects: ${MAX_RECIPE_BYTES}-byte recipe, ${MAX_EFFECT_COUNT} effects, depth ${MAX_EFFECT_DEPTH}, generation ${MAX_EFFECT_GENERATIONS}, block ${MAX_BLOCK_SECONDS} seconds.`,
  `Effect queues: ${MAX_PENDING_EFFECTS_PER_PLACE}/place, ${MAX_PENDING_EFFECTS_PER_ACTOR}/actor; resolve at most ${MAX_DUE_EFFECTS_PER_OBSERVATION}/observation.`,
  `Crafting: ${MAX_KIND_INGREDIENTS} kinds, ${MAX_CRAFT_INGREDIENTS} ingredients; timers 1..${MAX_TIMER_SECONDS} seconds.`,
  `${CITY_FEE_RAILS_LINE} Credit buys: $${CITY_CREDIT_PURCHASE_MIN_DOLLARS}..$${CITY_CREDIT_PURCHASE_MAX_DOLLARS}, ${CITY_CREDIT_PURCHASE_BODY_MAX_BYTES}-byte bodies.`,
  `Sales: >0..${USDC_AMOUNT_MAX} USDC, 6 decimals; claim ${CLAIM_WINDOW_SECONDS / 60} minutes; recovery ${PAYMENT_RECOVERY_WINDOW_MILLISECONDS / 3_600_000} hours.`,
  `Community tools: ${COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY}/IP/day, 1..${COMMUNITY_TOOL_TAG_LIMIT} tags; title/URL/operator/description ${COMMUNITY_TOOL_FIELD_LIMITS.titleCharacters}/${COMMUNITY_TOOL_FIELD_LIMITS.urlCharacters}/${COMMUNITY_TOOL_FIELD_LIMITS.operatorCharacters}/${COMMUNITY_TOOL_FIELD_LIMITS.descriptionCharacters} characters.`,
  `Text: notes/descriptions ${NOTE_CHARACTERS}/${WORLD_DESCRIPTION_MAX_CHARACTERS} characters, thing body ${THING_BODY_MAX_BYTES} bytes, purpose ${PLACE_PURPOSE_MAX_CHARACTERS} characters.`,
  `Names: place/thing 1..${PUBLIC_LABEL_MAX_CHARACTERS}; normalized world/kind/trait up to ${NORMALIZED_WORLD_NAME_MAX_CHARACTERS} characters.`,
  `Flags: resident ${PUBLIC_ACTION_LIMITS.residentFlagsPerHour}/hour, anonymous ${PUBLIC_ACTION_LIMITS.anonymousFlagsPerIpHour}/IP/hour, reason 1..${PUBLIC_ACTION_LIMITS.flagReasonCharacters} characters.`,
  `Founder repair: ${PUBLIC_ACTION_LIMITS.founderPaymentRepairsPerHour}/hour, ${PUBLIC_ACTION_LIMITS.founderPaymentRepairBodyBytes}-byte body; tool review ${PUBLIC_ACTION_LIMITS.communityToolReviewBodyBytes}-byte body.`,
  RESIDENT_LOOKING_LIMIT_LINE,
  `Gazette: ${QUOTAS.gazetteSubmissions}/resident/Monday-16:00 week; identical-note replay ${NOTE_IDEMPOTENCY_WINDOW_SECONDS / 60} minutes.`,
  `Gifts: ${CREDIT_GIFT_LIMITS.actionBodyBytes}-byte bodies, ${CREDIT_GIFT_LIMITS.redirectsPerCallerHour} redirects/caller/hour, pages 1..${CREDIT_GIFT_LIMITS.pageMax}.`,
  `OAuth life: ${OAUTH_LIMITS.formBodyBytes}-byte forms; request/code/access/refresh ${OAUTH_LIMITS.authorizationRequestMinutes}m/${OAUTH_LIMITS.authorizationCodeMinutes}m/${OAUTH_LIMITS.accessTokenMinutes}m/${OAUTH_LIMITS.refreshTokenDays}d.`,
  `OAuth/hour: authorize ${OAUTH_LIMITS.authorizationAttemptsPerIpClientHour}/IP+client, key/pair ${OAUTH_LIMITS.credentialAttemptsPerIpClientHour}/IP+client, signup ${OAUTH_LIMITS.signupStartsPerIpHour}/IP/${OAUTH_LIMITS.signupStartsGlobalHour} global/${OAUTH_LIMITS.signupStartsPerClientHour}/client, confirm ${OAUTH_LIMITS.signupConfirmsPerIpSessionHour}/IP+session.`,
  `OAuth/hour: token/revoke ${OAUTH_LIMITS.tokenExchangesPerIpClientHour}/${OAUTH_LIMITS.revocationsPerIpClientHour} per IP+client; refresh ${OAUTH_LIMITS.refreshesPerConnectionHour}/connection, junk ${OAUTH_LIMITS.junkRefreshesPerNetworkHour}/network.`,
  `Private reads: me credit/gift 1..${CITY_CREDIT_HISTORY_MAX}, later-holder 1..${LATER_HOLDER_PAGE_MAX}, replay ${PUBLIC_REPLAY_ROW_CEILING} rows/${PUBLIC_REPLAY_NOTE_LINES_MAX_BYTES} note bytes.`,
  `Around-you: ${AROUND_YOU_CHANGE_LIMIT} changes, admission from ${AROUND_YOU_ADMISSION_CHANGE_THRESHOLD}, ${AROUND_YOU_SUMMARY_SLOTS} slots, ${AROUND_YOU_STATEMENT_TIMEOUT_MS} ms.`,
] as const)

// The starter door carries the limits needed before move-in and first writes.
// The machine index and full reference render the complete caller-visible list.
export const FRONT_DOOR_LIMIT_LINES = Object.freeze(CITY_LIMIT_LINES.slice(0, IDENTITY_LIMIT_LINES.length + 2))

type ToolCatalogSeed = Readonly<{
  name: string
  legacyAnonymous?: boolean
  hostedVisible?: boolean
  writesPublicOrPermanent?: boolean
  annotationNote?: string
}>

const TOOL_CATALOG_SEED: readonly ToolCatalogSeed[] = [
  { name: 'front_door', legacyAnonymous: true },
  { name: 'help', legacyAnonymous: true },
  { name: 'official_facts', legacyAnonymous: true },
  { name: 'physics', legacyAnonymous: true },
  { name: 'search', legacyAnonymous: true },
  { name: 'changes', legacyAnonymous: true },
  {
    name: 'look', legacyAnonymous: true, writesPublicOrPermanent: true,
    annotationNote: 'A signed-in MCP look may publish a brief public looking cue; raw HTTP reads remain passive.',
  },
  { name: 'browse', legacyAnonymous: true },
  { name: 'drawing', legacyAnonymous: true },
  { name: 'drawing_history', legacyAnonymous: true },
  { name: 'credit_preflight' },
  { name: 'buy_credit', writesPublicOrPermanent: true },
  { name: 'found', writesPublicOrPermanent: true },
  { name: 'place_edit', writesPublicOrPermanent: true },
  { name: 'coin_trait', writesPublicOrPermanent: true },
  { name: 'invent_kind', writesPublicOrPermanent: true },
  { name: 'revise_kind', writesPublicOrPermanent: true },
  { name: 'make', writesPublicOrPermanent: true },
  { name: 'thing_edit', writesPublicOrPermanent: true },
  { name: 'thing_upgrade', writesPublicOrPermanent: true },
  { name: 'draw_self', writesPublicOrPermanent: true },
  { name: 'act', writesPublicOrPermanent: true },
  { name: 'laws', writesPublicOrPermanent: true },
  { name: 'home', writesPublicOrPermanent: true },
  { name: 'withdraw', writesPublicOrPermanent: true },
  { name: 'list_world', writesPublicOrPermanent: true },
  { name: 'claim_world', writesPublicOrPermanent: true },
  { name: 'cancel_world', writesPublicOrPermanent: true },
  { name: 'reconcile_world', writesPublicOrPermanent: true },
  { name: 'credit_gift', writesPublicOrPermanent: true },
  {
    name: 'payment_attempt', writesPublicOrPermanent: true,
    annotationNote: 'action=inspect is read-only; action=recheck may permanently update the private attempt, so MCP discovery must use the safer static warning.',
  },
  { name: 'transfer', writesPublicOrPermanent: true },
  { name: 'agree', writesPublicOrPermanent: true },
  { name: 'open_agreement_accession', writesPublicOrPermanent: true },
  { name: 'sign', writesPublicOrPermanent: true },
  { name: 'say', writesPublicOrPermanent: true },
  { name: 'flag', writesPublicOrPermanent: true },
  { name: 'later_holder_items' },
  { name: 'mark_for_later', writesPublicOrPermanent: true },
  {
    name: 'me', writesPublicOrPermanent: true,
    annotationNote: 'Reading me advances private visit checkpoints and may resolve timers into permanent city changes.',
  },
  { name: 'moderate', hostedVisible: false, writesPublicOrPermanent: true },
]

export const CITY_TOOL_CATALOG = Object.freeze(TOOL_CATALOG_SEED.map(seed => {
  const legacyAnonymous = seed.legacyAnonymous === true
  const hostedVisible = seed.hostedVisible !== false
  const writesPublicOrPermanent = seed.writesPublicOrPermanent === true
  return Object.freeze({
    name: seed.name,
    needsKey: !legacyAnonymous,
    legacyAnonymous,
    hostedVisible,
    writesPublicOrPermanent,
    readOnlyHint: !writesPublicOrPermanent,
    destructiveHint: writesPublicOrPermanent,
    ...(seed.annotationNote ? { annotationNote: seed.annotationNote } : {}),
  })
}))

const TOOL_FACTS_BY_NAME = new Map(CITY_TOOL_CATALOG.map(tool => [tool.name, tool]))

export function cityToolFacts(name: string) {
  const facts = TOOL_FACTS_BY_NAME.get(name)
  if (!facts) throw new Error(`tool ${name} is missing from CITY_TOOL_CATALOG`)
  return facts
}

export function describeCityTool(name: string, description: string): string {
  const facts = cityToolFacts(name)
  const annotation = facts.annotationNote ? ` Annotation: ${facts.annotationNote}` : ''
  const described = `${description}${annotation} Full catalog: ${FULL_TOOL_CATALOG_PATH}.`
  if (described.length > TOOL_DESCRIPTION_MAX_CHARACTERS) {
    throw new Error(`${name} description exceeds ${TOOL_DESCRIPTION_MAX_CHARACTERS} characters`)
  }
  return described
}

export function renderToolCatalogText(): string {
  return CITY_TOOL_CATALOG.map(tool => {
    const key = tool.needsKey ? 'key required' : 'public without a key'
    const doors = tool.hostedVisible ? 'local and hosted doors' : 'local door only'
    return `- ${tool.name}: ${key}; ${doors}`
  }).join('\n')
}

export function renderCityLimitsText(): string {
  return CITY_LIMIT_LINES.map(line => `- ${line}`).join('\n')
}

export function renderFrontDoorLimitsText(): string {
  return FRONT_DOOR_LIMIT_LINES.map(line => `- ${line}`).join('\n')
}

export function renderCityRoutesText(): string {
  return CITY_ROUTE_CATALOG
    .map(route => `- ${route.method} ${route.path} - ${route.description}`)
    .join('\n')
}

export function renderCityFactTokens(document: string): string {
  const anonymousCount = CITY_TOOL_CATALOG.filter(tool => tool.legacyAnonymous).length
  const hostedCount = CITY_TOOL_CATALOG.filter(tool => tool.hostedVisible).length
  return document
    .replaceAll('{{CITY_POSITIONING_LINE}}', CITY_POSITIONING_LINE)
    .replaceAll('{{MARKET_POSITIONING_LINE}}', MARKET_POSITIONING_LINE)
    .replaceAll('{{SKILL_VERSIONS}}', `city ${SKILL_VERSION_RECOMMENDED.city}, market ${SKILL_VERSION_RECOMMENDED.market}`)
    .replaceAll('{{CITY_LIMITS}}', renderCityLimitsText())
    .replaceAll('{{FRONT_DOOR_LIMITS}}', renderFrontDoorLimitsText())
    .replaceAll('{{CITY_TOOL_CATALOG}}', renderToolCatalogText())
    .replaceAll('{{CITY_ROUTE_CATALOG}}', renderCityRoutesText())
    .replaceAll('{{PAID_ACTIONS}}', PAID_ACTIONS.join(', '))
    .replaceAll('{{HANDLE_RULE}}', HANDLE_RULE)
    .replaceAll('{{TOOL_COUNT}}', String(CITY_TOOL_CATALOG.length))
    .replaceAll('{{PAYMENT_TERMINAL_STATES}}', PAYMENT_TERMINAL_STATES_LINE)
    .replaceAll(
      '{{TOOL_DOOR_COUNTS}}',
      `The legacy \`/mcp\` door lists ${anonymousCount} public tools without a valid key and all ${CITY_TOOL_CATALOG.length} tools with a valid current key. The hosted \`/mcp/connect\` door lists ${hostedCount} tools to everyone, refuses key-only tools at call time, and omits founder-only \`moderate\`.`,
    )
    .replaceAll(
      '{{CITY_FEE_RAILS}}',
      CITY_FEE_RAILS_LINE,
    )
}

type TextFile = Readonly<{ path: string; text: string }>

export function duplicateParagraphs(files: readonly TextFile[]) {
  const occurrences = new Map<string, { count: number; paths: Set<string> }>()
  for (const file of files) {
    for (const raw of file.text.replaceAll('\r\n', '\n').split(/\n\s*\n/gu)) {
      const paragraph = raw.split('\n').map(line => line.trim()).filter(Boolean).join(' ')
      if (!paragraph || paragraph.startsWith('#') || /^[-=]+$/u.test(paragraph)) continue
      const occurrence = occurrences.get(paragraph) ?? { count: 0, paths: new Set<string>() }
      occurrence.count += 1
      occurrence.paths.add(file.path)
      occurrences.set(paragraph, occurrence)
    }
  }
  return [...occurrences.entries()]
    .filter(([, occurrence]) => occurrence.count > 1)
    .map(([paragraph, occurrence]) => ({ paragraph, paths: [...occurrence.paths].sort() }))
    .sort((left, right) => left.paragraph.localeCompare(right.paragraph))
}

export function mountCityToolCatalogRoute(app: Hono): void {
  app.get(FULL_TOOL_CATALOG_PATH, c => {
    if (Object.keys(c.req.queries()).length > 0) {
      return c.json({ error: 'unknown query parameter; omit query options from this route' }, 400)
    }
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({ count: CITY_TOOL_CATALOG.length, tools: CITY_TOOL_CATALOG })
  })
}
