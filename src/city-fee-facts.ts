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

// Buying credit has no credit_preflight to point at and starts no payment, so the
// two purchase doors say the same rule once, in the buyer's words.
export const CREDIT_PURCHASE_REQUEST_ID_SHAPE_REFUSAL =
  'request_id must be an identifier you make up for this one purchase, not a number or an amount. No payment was started.'

// A paid action recorded under a number-shaped id before the rule existed cannot be
// retried with that id, so its conflict says what the caller can actually do.
export const CREDIT_REQUEST_ID_RECORDED_CONFLICT =
  'this action is already recorded under a request id the city no longer accepts, so it cannot be retried with that id; nothing new was spent, and the recorded credit returns on its own at the attempt deadline, after which a fresh request id starts this action again'
