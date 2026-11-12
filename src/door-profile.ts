// One home for what each MCP door shows (decision 142). /mcp is the key-capable door,
// /mcp/connect the hosted-chat door, and /mcp/app the hosted door made for app stores:
// the same sign-in and residents as /mcp/connect, with no purchase, payment recheck, or
// world-sale tools and no money rails in any answer. Since decision 197 it accepts and refuses
// a waiting fee-credit gift, and still cannot give one or add fee credit. Since decision 147 no door
// carries app-block advice; the one sentence lives in the reference only.
// This file imports only the leaf module of app door wording, so core.ts and city-facts.ts
// can read it without a cycle.

import { APP_ARGUMENT_DESCRIPTION_EDITS, APP_DESCRIPTION_EDITS } from './app-door-descriptions.ts'

export type DoorName = 'key' | 'connect' | 'app'
export type MoneyFacts = 'full' | 'credit-only'

type Hints = Readonly<{ readOnlyHint?: boolean; destructiveHint?: boolean }>

/** One exact wording change: the first text, found exactly once, becomes the second. */
export type DescriptionEdit = readonly [from: string, to: string]

export interface DoorProfile {
  readonly name: DoorName
  readonly path: '/mcp' | '/mcp/connect' | '/mcp/app'
  readonly hostedChat: boolean
  /** Tools this door neither lists nor calls. */
  readonly droppedTools: ReadonlySet<string>
  /** tool -> argument -> the only enum values this door accepts. */
  readonly narrowedEnums: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  /** tool -> arguments this door neither advertises nor accepts. */
  readonly droppedArguments: Readonly<Record<string, readonly string[]>>
  /** tool -> the title this door advertises for it. Absent keeps the catalog title. */
  readonly titles: Readonly<Record<string, string>>
  /** tool -> argument -> the description this door advertises for it. */
  readonly argumentDescriptions: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** null means every reference section. */
  readonly frontDoorSections: readonly string[] | null
  /** Event kinds this door does not offer as a filter or show as recent activity. */
  readonly hiddenEventKinds: readonly string[]
  readonly moneyFacts: MoneyFacts
  readonly recordsLookingCue: boolean
  readonly forwardsPayment: boolean
  readonly hintOverrides: Readonly<Record<string, Hints>>
  /** Until this instant (ms) every tool this door lists says destructiveHint false; null for never. */
  readonly destructiveHintsOffUntil: number | null
  /** tool -> the annotation note this door shows, or null for none. Absent keeps the catalog note. */
  readonly annotationNotes: Readonly<Record<string, string | null>>
  readonly descriptionTokens: Readonly<Record<string, string>>
  /** Whether every tool description ends with the short front-door pointer (decision 188). */
  readonly toolPointer: boolean
  /** tool -> exact wording changes to the description this door serves. */
  readonly descriptionEdits: Readonly<Record<string, readonly DescriptionEdit[]>>
  /** tool -> argument -> exact wording changes to every description inside that argument. */
  readonly argumentDescriptionEdits: Readonly<Record<string, Readonly<Record<string, readonly DescriptionEdit[]>>>>
}

export const APP_DOOR_PATH = '/mcp/app'

// Decision 162: a dated test on /mcp/connect only. From the deploy until this instant every
// tool that door lists says destructiveHint false; after it the door's labels are the
// decision 135 labels again with no deploy. Every other hint and door is unchanged.
export const CONNECT_LABEL_TEST_END = '2026-11-03T23:59:59Z'

// The tools the owner left off the app door on 2026-10-09, less credit_gift, which came back
// on 2026-11-12 (decision 197). Founder-only moderate is dropped from both hosted doors as before.
export const APP_DROPPED_TOOLS = Object.freeze([
  'buy_credit',
  'payment_attempt',
  'list_world',
  'claim_world',
  'cancel_world',
  'reconcile_world',
] as const)

// Reference sections whose served text carries no money rail, sale, or app-block wording.
// test/app-door.test.ts proves each one is clean; a section joins this list only that way.
export const APP_FRONT_DOOR_SECTIONS = Object.freeze([
  'what-this-is',
  'public-city-media',
  'kinds-traits-physics',
  'things-ending',
  'moving-in',
  'coding-identity',
  'room-orientation',
  'quiet-rooms',
  'reading-settings',
  'live-page',
  'same-room-talk',
  'later-holder',
  'citylife-skill',
] as const)

// Event kinds about sales and payments. The app door does not offer them as a changes
// filter and leaves them out of the front door's recent activity.
export const APP_HIDDEN_EVENT_KINDS = Object.freeze([
  'transfer_offer',
  'sale',
  'transfer_cancel',
  'world_listed',
  'world_sale',
  'world_cancel',
  'payment_repair',
] as const)

// The one test pattern for the app door's own served text: money rails, purchase or sale
// wording, and app-block advice. "cannot be blocked" and "never blocked" are the bedrock
// right to go home, not app-block advice.
export const APP_BANNED_TEXT =
  /\$\s?\d|USDC|x402|X-PAYMENT|PayPal|\/buy|\bbuy|purchase|wallet|dollar|treasury|sale\b|safety|(?<!cannot be |never )blocked|its filter/iu

// Decision 197: the app door's fee-credit refusals say "use", and the one with no credit says
// where credit comes from in one fact with no address.
export const APP_PAYMENT_REQUIRED_REFUSAL =
  'This action uses one fee credit. Call credit_preflight, then send a new city_credit_request_id. Nothing was used.'
export const APP_INSUFFICIENT_CREDIT_REFUSAL =
  'This action uses one fee credit and this resident has none. Fee credit is added outside this app. Nothing was used.'

// Decision 197: what the app door says when a gift cannot be accepted or refused. The other
// doors keep the backing words, which name the payment rail and a web address.
export const APP_GIFT_NOT_WAITING_REFUSAL =
  'That gift is not waiting for this resident, or it was not found. Call me and send one gift_id from city_fee_credit.pending_gifts.'
export const APP_GIFT_ID_REFUSAL =
  'That gift id does not match a city gift id. Call me and send one gift_id from city_fee_credit.pending_gifts.'
export const APP_GIFT_ON_HOLD_REFUSAL =
  'This gift is on hold and cannot be accepted now. It can still be refused. Nothing changed.'
export const APP_GIFT_CANCELLED_REFUSAL =
  'This gift was cancelled and can never add credit. Nothing changed.'

// Money fragments inside tool descriptions. Each description keeps one text; the door
// fills these tokens, and the key and connect doors get exactly the words they had.
const FULL_DESCRIPTION_TOKENS = Object.freeze({
  '{{OFFICIAL_FACTS_SUBJECTS}}': 'treasury, Base USDC, no-token statement',
  '{{OFFICIAL_FACTS_SAME_AS}}': 'This returns the exact same response as GET /api/official without requiring the host to open that URL.',
  '{{BROWSE_VIEWS}}': 'moderation, treasury, or gazette',
  '{{BROWSE_DEFAULTS}}': 'residents 200 and treasury 50',
  '{{PREFLIGHT_GIFTS}}': 'pending_gifts_count (ordinary pending plus dispute-frozen gifts still listed in me.city_fee_credit.pending_gifts), ',
  '{{FRONTIER_FEE}}': 'the $1 fee frontier',
  '{{FOUND_PAYMENT_CHOICE}}': 'Then send a new city_credit_request_id to deliberately spend exactly one prepaid fee credit, or omit it to keep using X-PAYMENT.',
  '{{SALE_OFFER}}': 'sale offer',
  '{{OPEN_SALE}}': 'open sale',
  '{{PLACE_EDIT_PAYMENT}}': 'Each costs one fee credit, never X-PAYMENT, and never mixes with another edit.',
  '{{KIND_FEE}}': 'the exact $1 city fee',
  '{{INVENT_PAYMENT_CHOICE}}': 'Then send a new city_credit_request_id to spend exactly one credit, or omit it to use the outer X-PAYMENT header; never send both payment rails.',
  '{{REVISE_PAYMENT_CHOICE}}': 'then send a new city_credit_request_id for one credit, or omit it for outer X-PAYMENT, never both.',
  '{{GO_HOME_ALWAYS}}': 'is never blocked',
  '{{REFUSED_OR_BLOCKED}}': 'refused or blocked',
  '{{LOOK_CUE}}': 'Only an authenticated resident MCP look may publish a generic looking cue at your place for {{LOOKING_TTL}} seconds; recording is best effort and never changes or fails the read.',
  '{{ME_COLLECTIONS}}': 'notes, offers, labels, quotas, fee credit, pending gifts, and changes since your last visit',
  '{{ME_PENDING_GIFTS}}': 'Pending gifts name their empty-body accept or refuse paths. ',
  '{{TRANSFER_DESCRIPTION}}': 'Omitting action defaults to give. give requires type, id, and to_handle. When giving a place, its nested places move with it. Your home is cleared with a private attention line in the transfer response if it is that place or inside it. A nested place with another owner or an open sale blocks the whole gift. A give to a resident that muted you waits for its yes: nothing moves, and the answer\'s waiting_transfers says it is held until that resident accepts and stays yours meanwhile; for a place holding your home, its attention line says your home will be cleared if it is accepted. accept or decline requires waiting_id, from waiting_transfers in your own me settings "show": accept makes that give then, with every rule checked again, and decline leaves it with the giver. A thing with an end set cannot be given until its owner clears the end, and a held gift whose giver has since set one cannot be accepted; a remnant can be given. offer also requires price_usdc and seller_wallet; price must be greater than 0 and at most 10,000 USDC and is rounded to 6 decimal places. claim requires offer_id; its first call also requires buyer_wallet to reserve a five-minute payment window and receive the current payment requirements before payment. cancel requires offer_id and is available only to the seller outside an active payment window. A remnant cannot be offered, and a claim refuses a thing whose end has come or would come within the payment window.',
} as const)

export type DescriptionToken = keyof typeof FULL_DESCRIPTION_TOKENS

const APP_DESCRIPTION_TOKENS: Readonly<Record<DescriptionToken, string>> = Object.freeze({
  '{{OFFICIAL_FACTS_SUBJECTS}}': 'fee credit rules, no-token statement',
  '{{OFFICIAL_FACTS_SAME_AS}}': 'This door returns those facts without requiring the host to open a URL.',
  '{{BROWSE_VIEWS}}': 'moderation, or gazette',
  '{{BROWSE_DEFAULTS}}': 'residents 200',
  '{{PREFLIGHT_GIFTS}}': '',
  '{{FRONTIER_FEE}}': 'a frontier for one fee credit',
  '{{FOUND_PAYMENT_CHOICE}}': 'Then send a new city_credit_request_id to spend exactly one fee credit.',
  '{{SALE_OFFER}}': 'offer',
  '{{OPEN_SALE}}': 'open offer',
  '{{PLACE_EDIT_PAYMENT}}': 'Each uses one fee credit and never mixes with another edit.',
  '{{KIND_FEE}}': 'one fee credit',
  '{{INVENT_PAYMENT_CHOICE}}': 'Then send a new city_credit_request_id to spend exactly one fee credit.',
  '{{REVISE_PAYMENT_CHOICE}}': 'then send a new city_credit_request_id for one fee credit.',
  '{{GO_HOME_ALWAYS}}': 'always works',
  '{{REFUSED_OR_BLOCKED}}': 'refused or stopped',
  '{{LOOK_CUE}}': 'On this door look only reads; it publishes no looking cue.',
  '{{ME_COLLECTIONS}}': 'notes, labels, quotas, fee credit held and used, and changes since your last visit',
  '{{ME_PENDING_GIFTS}}': 'Fee-credit gifts waiting for an accept or refuse are listed in city_fee_credit.pending_gifts by id, amount, status and time. ',
  '{{TRANSFER_DESCRIPTION}}': 'Give one place, thing, or kind you own to another resident. action may be omitted or give; give requires type, id, and to_handle. When giving a place, its nested places move with it. Your home is cleared with a private attention line in the transfer response if it is that place or inside it. A nested place with another owner or an open offer blocks the whole gift. A give to a resident that muted you waits for its yes: nothing moves, and the answer\'s waiting_transfers says it is held until that resident accepts and stays yours meanwhile; for a place holding your home, its attention line says your home will be cleared if it is accepted. accept or decline requires waiting_id, from waiting_transfers in your own me settings "show": accept makes that give then, with every rule checked again, and decline leaves it with the giver. A thing with an end set cannot be given until its owner clears the end, and a held gift whose giver has since set one cannot be accepted; a remnant can be given.',
})

const NO_TOOLS: ReadonlySet<string> = Object.freeze(new Set<string>())

const KEY_PROFILE: DoorProfile = Object.freeze({
  name: 'key',
  path: '/mcp',
  hostedChat: false,
  droppedTools: NO_TOOLS,
  narrowedEnums: Object.freeze({}),
  droppedArguments: Object.freeze({}),
  titles: Object.freeze({}),
  argumentDescriptions: Object.freeze({}),
  frontDoorSections: null,
  hiddenEventKinds: Object.freeze([]),
  moneyFacts: 'full',
  recordsLookingCue: true,
  forwardsPayment: true,
  hintOverrides: Object.freeze({}),
  destructiveHintsOffUntil: null,
  annotationNotes: Object.freeze({}),
  descriptionTokens: FULL_DESCRIPTION_TOKENS,
  toolPointer: true,
  descriptionEdits: Object.freeze({}),
  argumentDescriptionEdits: Object.freeze({}),
})

const CONNECT_PROFILE: DoorProfile = Object.freeze({
  ...KEY_PROFILE,
  name: 'connect',
  path: '/mcp/connect',
  hostedChat: true,
  droppedTools: Object.freeze(new Set<string>(['moderate'])),
  destructiveHintsOffUntil: Date.parse(CONNECT_LABEL_TEST_END),
})

const APP_PROFILE: DoorProfile = Object.freeze({
  name: 'app',
  path: APP_DOOR_PATH,
  hostedChat: true,
  droppedTools: Object.freeze(new Set<string>([...APP_DROPPED_TOOLS, 'moderate'])),
  narrowedEnums: Object.freeze({
    // Decision #158: the recipient answers a waiting transfer here too; offers stay off.
    transfer: Object.freeze({ action: Object.freeze(['give', 'accept', 'decline']) }),
    browse: Object.freeze({
      view: Object.freeze([
        'kinds', 'traits', 'agreements', 'residents', 'events', 'moderation', 'gazette',
      ]),
    }),
    front_door: Object.freeze({ section: APP_FRONT_DOOR_SECTIONS }),
  }),
  droppedArguments: Object.freeze({
    transfer: Object.freeze(['price_usdc', 'seller_wallet', 'offer_id', 'buyer_wallet']),
    me: Object.freeze(['before_offer_id', 'offer_limit', 'before_gift_id', 'gift_limit']),
  }),
  titles: Object.freeze({ credit_gift: 'Accept or refuse a fee-credit gift' }),
  argumentDescriptions: Object.freeze({
    credit_gift: Object.freeze({ gift_id: 'opaque id of one fee-credit gift waiting for this resident' }),
    transfer: Object.freeze({
      id: 'id of the place, thing, or kind to give',
      to_handle: 'recipient handle',
    }),
    browse: Object.freeze({ limit: 'defaults to 10, except residents defaults to 200' }),
  }),
  frontDoorSections: APP_FRONT_DOOR_SECTIONS,
  hiddenEventKinds: APP_HIDDEN_EVENT_KINDS,
  moneyFacts: 'credit-only',
  // Decision 82 lets a look leave the cue; this door chooses not to, so look is a passive read here.
  recordsLookingCue: false,
  forwardsPayment: false,
  hintOverrides: Object.freeze({
    look: Object.freeze({ readOnlyHint: true, destructiveHint: false }),
  }),
  destructiveHintsOffUntil: null,
  annotationNotes: Object.freeze({ look: null }),
  descriptionTokens: APP_DESCRIPTION_TOKENS,
  // Decision 188: these descriptions name no other tool, give no call order, and point at no
  // outside source; that guidance lives in the server instructions, help, and the front door.
  toolPointer: false,
  descriptionEdits: APP_DESCRIPTION_EDITS,
  argumentDescriptionEdits: APP_ARGUMENT_DESCRIPTION_EDITS,
})

export const DOOR_PROFILES: Readonly<Record<DoorName, DoorProfile>> = Object.freeze({
  key: KEY_PROFILE,
  connect: CONNECT_PROFILE,
  app: APP_PROFILE,
})

export function doorProfile(name: DoorName): DoorProfile {
  return DOOR_PROFILES[name]
}

/** True while this door's dated test lists every tool with destructiveHint false (decision 162). */
export function destructiveHintsOff(profile: DoorProfile, now: number = Date.now()): boolean {
  return profile.destructiveHintsOffUntil !== null && now <= profile.destructiveHintsOffUntil
}

/** Fill every description token for one door; a token left unfilled is a build failure. */
export function renderDescriptionTokens(
  text: string,
  profile: DoorProfile,
  values: Readonly<Record<string, string>> = {},
): string {
  let rendered = text
  for (const [token, value] of Object.entries(profile.descriptionTokens)) {
    rendered = rendered.replaceAll(token, value)
  }
  for (const [token, value] of Object.entries(values)) rendered = rendered.replaceAll(token, value)
  const left = rendered.indexOf('{{')
  if (left >= 0) {
    throw new Error(`unfilled description token on the ${profile.name} door: ${rendered.slice(left, left + 40)}`)
  }
  return rendered
}

/**
 * Keep only the front_door sections this door serves in a description's pointer, and drop
 * the whole sentence when none is left.
 */
export function narrowSectionPointers(text: string, profile: DoorProfile): string {
  const allowed = profile.frontDoorSections
  if (allowed === null) return text
  const narrowed = text.replace(
    /(^|(?<=\. ))([^.]*?)front_door sections? ([a-z0-9, -]+?)\.( |$)/gu,
    (_whole, start: string, lead: string, list: string, tail: string) => {
      const slugs = list.split(/,\s*(?:and\s+)?|\s+and\s+/u).map(slug => slug.trim()).filter(Boolean)
      const kept = slugs.filter(slug => allowed.includes(slug))
      if (kept.length === 0) return start
      const named = kept.length === 1
        ? `front_door section ${kept[0]}`
        : `front_door sections ${kept.slice(0, -1).join(', ')} and ${kept.at(-1)}`
      return `${start}${lead}${named}.${tail}`
    },
  )
  // A dropped closing sentence leaves the space that came before it.
  return /\s$/u.test(text) ? narrowed : narrowed.trimEnd()
}

/** Apply each exact wording change once; a change whose text is missing or repeated fails the build. */
export function applyDescriptionEdits(text: string, edits: readonly DescriptionEdit[], label: string): string {
  let edited = text
  for (const [from, to] of edits) {
    const at = edited.indexOf(from)
    if (at < 0 || edited.indexOf(from, at + 1) >= 0) {
      throw new Error(`${label}: wording to change must appear exactly once: ${from.slice(0, 60)}`)
    }
    edited = edited.slice(0, at) + to + edited.slice(at + from.length)
  }
  return edited
}
