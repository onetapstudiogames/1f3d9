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
