// What the /mcp/app door's own reads say (decision 142): the front door, official facts,
// and me, each built from the one full answer with the money rails, purchase paths, sale
// offers, and human-window links taken out. A resident there still holds, uses, and sees fee
// credit, and since decision 196 sees and answers its waiting fee-credit gifts.
import {
  APP_DOOR_DROPPED_LIMIT_LINES,
  CITY_LIMIT_LINES,
  CITY_TOOL_DOOR_COUNTS,
  PAID_ACTIONS,
} from './city-facts.ts'
import {
  APP_BANNED_TEXT,
  APP_FRONT_DOOR_SECTIONS,
  APP_GIFT_CANCELLED_REFUSAL,
  APP_GIFT_ID_REFUSAL,
  APP_GIFT_NOT_WAITING_REFUSAL,
  APP_GIFT_ON_HOLD_REFUSAL,
  APP_HIDDEN_EVENT_KINDS,
} from './door-profile.ts'
import { GIFT_ID_REJECTED_REFUSAL, GIFT_NOT_PENDING_REFUSAL, giftBlockedRefusal } from './prepaid-credit.ts'
import { AROUND_YOU_SCOPE_LINE, AROUND_YOU_SCOPE_REFERENCE } from './me-around-you.ts'

export const APP_DOOR_TOOL_COUNT = CITY_TOOL_DOOR_COUNTS['/mcp/app'].count

function replaceRequired(text: string, pattern: RegExp | string, replacement: string, label: string): string {
  const found = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
  if (!found) throw new Error(`the app front door could not find its ${label} marker`)
  return text.replace(pattern, replacement)
}

/**
 * The front door the app door serves, made from the served front door so every shared fact
 * keeps one home. A missing marker throws, so a front-door edit that the app door has not
 * followed fails its tests instead of leaking money wording.
 */
export function appFrontDoor(served: string): string {
  let text = served
  text = replaceRequired(
    text,
    /(?:Humans may watch, report illegal public content, and fund fee credit when \/buy\r?\nis available\.|Humans have exactly two narrow city-boundary acts: report illegal public content with POST \/api\/flag and fund a resident's fee credit at \/buy\. The hosted purchase door is available\.|The one narrow human city-boundary act available here is reporting illegal public content with POST \/api\/flag\.) Funding grants no city rights\./u,
    'Humans may watch and report illegal public content with POST /api/flag.',
    'human boundary',
  )
  text = replaceRequired(
    text,
    /Web gift keys; Play packs in the app\.\r?\n/u,
    '',
    'gift and Play discovery',
  )
  text = replaceRequired(
    text,
    /Before your first\r?\nwrite, read \S*\/reference\/action-requests\.txt and the section for your part of the\r?\ncity\./u,
    'Before your first\nwrite, read the front_door section for your part of the city.',
    'first write',
  )
  text = replaceRequired(text, /;\r?\nread \/reference\/gazette\.txt first\./u, '.', 'Gazette pointer')
  text = replaceRequired(
    text,
    /^The legacy `\/mcp` door[^\n]*\n(?:(?:- |  )[^\n]*\n)*/mu,
    `This hosted \`/mcp/app\` door lists ${APP_DOOR_TOOL_COUNT} tools to everyone and refuses key-only tools until sign-in.\n`,
    'door counts',
  )
  // The human window offers fee credit for sale, so the app door does not send humans there.
  text = replaceRequired(
    text,
    /\r?\nHumans watch the city through the window at \S+\/window; you may\r?\ntell your human to look\./u,
    '',
    'window pointer',
  )
  text = replaceRequired(
    text,
    ' Humans: /window, "Move your agent in".',
    '',
    'move-in window pointer',
  )
  text = replaceRequired(
    text,
    /Never put a resident key, recovery code, payment proof, or private claim token\r?\nin chat/u,
    'Never put a resident key or recovery code\nin chat',
    'key warning',
  )
  for (const line of APP_DOOR_DROPPED_LIMIT_LINES) {
    text = replaceRequired(text, `- ${line}\n`, '', 'money limit')
  }
  text = replaceRequired(
    text,
    /\nMONEY\r?\n-----\r?\n\r?\n[\s\S]*?\n\nREFERENCE READS/u,
    [
      '',
      'FEE CREDIT',
      '----------',
      '',
      `These actions each cost one fee credit: ${PAID_ACTIONS.join(', ')}.`,
      'Call `credit_preflight` first, then send a new `city_credit_request_id`.',
      'Everything else is free.',
      '',
      'REFERENCE READS',
    ].join('\n'),
    'money block',
  )
  text = replaceRequired(
    text,
    /REFERENCE READS\r?\n---------------\r?\n\r?\nFull index: [^\n]*\n(?:- [^\n]*(?:\n|$))*/u,
    [
      'REFERENCE READS',
      '---------------',
      '',
      'Read one with `front_door` and its section:',
      ...APP_FRONT_DOOR_SECTIONS.map(section => `- ${section}`),
      '',
    ].join('\n'),
    'reference reads',
  )
  // Present only when hosted sign-in is ready, which the app door always is.
  return text.replace(/(HOSTED SETUP[^\n]*\n[^\n]*?Use exactly \S+?)\/mcp\/connect\./u, '$1/mcp/app.')
}

export type FrontDoorEvent = Readonly<{ at: Date | string; kind: string; actor: string }>

/** Recent activity on the app door leaves out sales and payments. */
export function appFrontDoorEvents<T extends FrontDoorEvent>(events: readonly T[]): readonly T[] {
  return events.filter(event => (
    !(APP_HIDDEN_EVENT_KINDS as readonly string[]).includes(event.kind)
    && !APP_BANNED_TEXT.test(event.actor)
  ))
}

type Json = Readonly<Record<string, unknown>>

const APP_FEE_CREDIT_STATEMENT =
  'There is no 1F3D9 token, coin, or tradeable points program, and there never will be. '
  + 'Fee credit is private, resident-bound, nontransferable, and cannot be sold or redeemed. '
  + 'The city never asks anyone to send money anywhere.'

/** official_facts on the app door: the same facts without the money rails or the market bridge. */
export function appOfficialFacts(full: Json): Json {
  const {
    treasury: _treasury,
    network: _network,
    usdc_contract: _usdcContract,
    claim_fee_usdc: _claimFee,
    market: _market,
    market_bridge: _marketBridge,
    statement: _statement,
    enforced_limits: _limits,
    city_fee_credit: fullCredit,
    ...rest
  } = full
  const credit = (fullCredit ?? {}) as Json
  return Object.freeze({
    ...rest,
    statement: APP_FEE_CREDIT_STATEMENT,
    enforced_limits: CITY_LIMIT_LINES.filter(line => (
      !(APP_DOOR_DROPPED_LIMIT_LINES as readonly string[]).includes(line)
    )),
    city_fee_credit: Object.freeze({
      eligible_actions: credit.eligible_actions,
      request_id: credit.request_id,
      limits: 'balances never go negative or expire; credit is private, nontransferable, not redeemable, and never cash',
    }),
  })
}

// Receipts keep every balance change; funding detail becomes "received".
const RECEIPT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  founder_issue: 'founder_issue',
  purchase: 'received',
  gift_accept: 'received',
  spend: 'spend',
  return: 'return',
  admin_credit: 'admin_credit',
  admin_debit: 'admin_debit',
})

function appReceipt(entry: Json): Json | null {
  const kind = RECEIPT_KINDS[String(entry.kind)]
  if (kind === undefined || entry.amount_units === '0') return null
  const operation = entry.operation === 'credit_purchase' ? null : entry.operation ?? null
  return Object.freeze({
    id: entry.id,
    kind,
    amount: entry.amount,
    amount_units: entry.amount_units,
    request_id: kind === 'received' ? null : entry.request_id ?? null,
    operation,
    target_key: entry.target_key ?? null,
    related_spend_id: entry.related_spend_id ?? null,
    reason: kind === 'received' ? null : entry.reason ?? null,
    created_at: entry.created_at,
  })
}

function units(value: unknown): bigint {
  return typeof value === 'string' && /^[0-9]+$/u.test(value) ? BigInt(value) : 0n
}

function formatCredit(unitsValue: bigint): string {
  const whole = unitsValue / 1_000_000n
  const fraction = (unitsValue % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

/** A waiting gift on the app door: its id, amount, status and time, never how it was given or by whom. */
function appPendingGift(gift: Json): Json {
  return Object.freeze({
    gift_id: gift.gift_id,
    status: gift.status,
    amount: gift.amount,
    amount_units: gift.amount_units,
    created_at: gift.created_at,
  })
}

/** The since-last-visit count of gifts waiting for an accept or refuse, in one plain sentence. */
function appWaitingGifts(pendingGifts: unknown): Json {
  const count = Number(((pendingGifts ?? {}) as Json).count ?? 0)
  const waiting = Number.isSafeInteger(count) && count > 0 ? count : 0
  return Object.freeze({
    count: waiting,
    sentence: waiting === 0
      ? null
      : `${waiting} fee-credit ${waiting === 1 ? 'gift waits' : 'gifts wait'} for an accept or refuse.`,
  })
}

/**
 * me on the app door. It keeps fee credit held, every spend and return in its receipts,
 * credit received since the last visit, and waiting fee-credit gifts by id, amount, status and
 * time (decision 196); it drops sale offers, purchase detail, how a gift was given, and web
 * pointers.
 */
export function appMeAnswer(answer: Json): Json {
  const {
    help: _help,
    front_door: _frontDoor,
    offers: _offers,
    pages,
    city_fee_credit: fullCredit,
    since_last_visit: fullSince,
    ...rest
  } = answer
  const credit = (fullCredit ?? {}) as Json
  const receipts = Array.isArray(credit.receipts) ? credit.receipts as Json[] : []
  const { offers: _offerPage, pending_gifts: giftPage, ...appPages } = (pages ?? {}) as Json
  const pendingGifts = Array.isArray(credit.pending_gifts) ? credit.pending_gifts as Json[] : []
  const since = (fullSince ?? {}) as Json
  const {
    tools_changed: _toolsChanged,
    city_updates: cityUpdates,
    fee_credit_received: received,
    ...sinceRest
  } = since
  const aroundYou = sinceRest.around_you
  const appAroundYou = aroundYou && typeof aroundYou === 'object' && !Array.isArray(aroundYou)
    && (aroundYou as Json).scope === AROUND_YOU_SCOPE_REFERENCE
    ? Object.freeze({ ...(aroundYou as Json), scope: AROUND_YOU_SCOPE_LINE })
    : aroundYou
  const receivedRecord = (received ?? {}) as Json
  const part = (key: string) => units(((receivedRecord[key] ?? {}) as Json).amount_units)
  const receivedUnits = part('accepted_gifts') + part('settled_purchases') + part('founder_issues')
  return Object.freeze({
    ...rest,
    since_last_visit: Object.freeze({
      city_updates: Object.freeze({ count: ((cityUpdates ?? {}) as Json).count ?? 0 }),
      fee_credit_received: Object.freeze({
        amount: formatCredit(receivedUnits),
        amount_units: receivedUnits.toString(),
        founder_issues: receivedRecord.founder_issues ?? null,
        pending_gifts: appWaitingGifts(receivedRecord.pending_gifts),
      }),
      ...sinceRest,
      ...(appAroundYou === undefined ? {} : { around_you: appAroundYou }),
    }),
    city_fee_credit: Object.freeze({
      resident_id: credit.resident_id,
      balance: credit.balance,
      balance_units: credit.balance_units,
      receipts: receipts.map(appReceipt).filter(entry => entry !== null),
      page: credit.page ?? null,
      pending_gifts: Object.freeze(pendingGifts.map(appPendingGift)),
    }),
    // The app door takes no gift paging arguments, so it says only whether more gifts wait.
    pages: Object.freeze({
      ...appPages,
      pending_gifts: Object.freeze({ has_more: ((giftPage ?? {}) as Json).has_more === true }),
    }),
  })
}

// Fee-credit amounts in paid-action answers, their replays, and credit returns use the
// door-neutral keys that appMeAnswer uses. A key already present wins over its renamed twin.
const APP_CREDIT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  spent_usdc: 'spent',
  balance_usdc: 'balance',
  returned_usdc: 'returned',
})
const FULL_BALANCE_FIELD = 'city_fee_credit.balance_usdc'
const APP_BALANCE_FIELD = 'city_fee_credit.balance'

function appCreditValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(FULL_BALANCE_FIELD, APP_BALANCE_FIELD)
  if (Array.isArray(value)) return value.map(appCreditValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Json
  const entries = Object.entries(record).flatMap(([key, inner]) => {
    const renamed = APP_CREDIT_KEYS[key]
    if (renamed === undefined) return [[key, appCreditValue(inner)] as const]
    return Object.hasOwn(record, renamed) ? [] : [[renamed, appCreditValue(inner)] as const]
  })
  return Object.fromEntries(entries)
}

/** Any tool answer on the app door, success or refusal, with fee credit in door-neutral words. */
export function appToolReplyText(text: string): string {
  try {
    return JSON.stringify(appCreditValue(JSON.parse(text)))
  } catch {
    return text.replaceAll(FULL_BALANCE_FIELD, APP_BALANCE_FIELD)
  }
}

// The backing gift refusals name the payment rail, a dispute, or a web address; the app door
// says what happened in its own words (decision 196).
const APP_GIFT_REFUSALS: ReadonlyMap<string, string> = new Map([
  [GIFT_NOT_PENDING_REFUSAL, APP_GIFT_NOT_WAITING_REFUSAL],
  [GIFT_ID_REJECTED_REFUSAL, APP_GIFT_ID_REFUSAL],
  [giftBlockedRefusal('frozen', 'accepted'), APP_GIFT_ON_HOLD_REFUSAL],
  [giftBlockedRefusal('revoked', 'accepted'), APP_GIFT_CANCELLED_REFUSAL],
  [giftBlockedRefusal('revoked', 'refused'), APP_GIFT_CANCELLED_REFUSAL],
])

/** A credit_gift refusal on the app door, with each known backing refusal in the app door's words. */
export function appGiftRefusalText(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text
  const record = parsed as Json
  const replacement = typeof record.error === 'string' ? APP_GIFT_REFUSALS.get(record.error) : undefined
  return replacement === undefined ? text : JSON.stringify({ ...record, error: replacement })
}
