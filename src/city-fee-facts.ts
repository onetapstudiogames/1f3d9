export const PAID_ACTIONS = Object.freeze([
  'frontier',
  'kind_invention',
  'kind_revision',
  'place_rename',
  'place_retire',
  'place_restore',
] as const)

export const DUAL_RAIL_PAID_ACTIONS = Object.freeze(PAID_ACTIONS.slice(0, 3))
export const CREDIT_ONLY_PAID_ACTIONS = Object.freeze(PAID_ACTIONS.slice(3))

// One home for the fee-credit request id rule. Every served surface renders this
// text instead of restating it, so the door, the reference, and the tool
// descriptions can never drift apart.
export const CREDIT_REQUEST_ID_RULE_LINE =
  'A fee-credit request id is yours alone and belongs to one paid action: make up a new id for every paid action, never a plain number and never your balance. credit_preflight returns a fresh suggested_request_id you can send as it is. Sending an id you already used returns that earlier action\'s recorded result and performs nothing new.'

export const CREDIT_REQUEST_ID_SUGGESTION_LINE =
  'Take the fresh suggested_request_id that credit_preflight returned instead of inventing a number.'

export const CREDIT_REQUEST_ID_SHAPE_REFUSAL =
  'request_id must be an identifier you make up for this one action, not a number or your balance; credit_preflight suggests one'

// A purchase door refuses before any payment starts, so it says the shape in the
// buyer's own words and ends by saying that. The served BUY CREDIT text still
// points a buyer at the same suggested_request_id the spend tools point at.
export const CREDIT_PURCHASE_REQUEST_ID_SHAPE_REFUSAL =
  'request_id must be an identifier you make up for this one purchase, not a number or an amount. No payment was started.'

// A paid action recorded under a number-shaped id before the rule existed cannot be
// retried with that id, so its conflict says what the caller can actually do. What
// that is depends on the recorded attempt's own status, so each recorded state says
// only what is true of it and none of them promises a return the city will not make.
const RECORDED_CONFLICT_OPENING =
  'this action is already recorded under a request id the city no longer accepts, so it cannot be retried with that id; '

export const CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING =
  `${RECORDED_CONFLICT_OPENING}nothing new was spent, and the recorded credit returns on its own at the attempt deadline, after which a fresh request id starts this action again`

export const CREDIT_REQUEST_ID_RECORDED_CONFLICT_COMPLETED =
  `${RECORDED_CONFLICT_OPENING}the action already happened under it and that credit is already spent, so nothing new was spent now and there is nothing left to retry`

export const CREDIT_REQUEST_ID_RECORDED_CONFLICT_REVIEW =
  `${RECORDED_CONFLICT_OPENING}nothing new was spent, and the recorded attempt is waiting on founder review; wait for that review to finish, because no request id moves it along`

export const CREDIT_REQUEST_ID_RECORDED_CONFLICT_UNREAD =
  `${RECORDED_CONFLICT_OPENING}nothing new was spent now, and the city cannot tell from the recorded attempt what happens to the credit already recorded under it, so it promises no return here; read city_fee_credit.balance_usdc in me before you spend again`

// Only a live attempt returns credit at its deadline, so only a status the city
// knows to be live may say so. A missing or unfamiliar status is not evidence of
// a live attempt, and guessing the one wording that promises a refund would
// promise a return the city may never make.
const LIVE_RECORDED_STATUSES: ReadonlySet<string> = new Set(['settling', 'payment_pending'])

/** Say what a recorded attempt's own status leaves the caller able to do. */
export function creditRequestIdRecordedConflict(status: string): string {
  if (status === 'completed') return CREDIT_REQUEST_ID_RECORDED_CONFLICT_COMPLETED
  if (status === 'needs_review') return CREDIT_REQUEST_ID_RECORDED_CONFLICT_REVIEW
  if (LIVE_RECORDED_STATUSES.has(status)) return CREDIT_REQUEST_ID_RECORDED_CONFLICT_PENDING
  return CREDIT_REQUEST_ID_RECORDED_CONFLICT_UNREAD
}

/** True for every wording above, so a caller-facing route can drop a retry line. */
export function isCreditRequestIdRecordedConflict(message: string): boolean {
  return message.startsWith(RECORDED_CONFLICT_OPENING)
}
