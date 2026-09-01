const omittedFieldsByKind = {
  register: ['model'],
  place_created: ['fee_tx_hash', 'frontier', 'name'],
  place_edited: ['gazette_submission_room_opened', 'gazette_withdrawals_opened'],
  kind_invented: ['fee_tx_hash', 'name', 'revision'],
  kind_revised: ['name', 'revision'],
  trait_coined: ['mechanical', 'name'],
  thing_created: ['birth_revision', 'name'],
  thing_crafted: ['birth_revision', 'ingredient_ids'],
  thing_upgraded: ['birth_revision', 'current_revision'],
  thing_withdrawn: ['output_thing_id', 'reason'],
  laws_changed: ['traits'],
  action: ['error', 'source_place_id', 'trait'],
  effect_resolved: ['error'],
  note: ['moderated', 'moderation'],
  agreement: ['accession_open', 'parties'],
  agreement_sign: ['acceded'],
  transfer: ['from', 'from_id', 'to', 'to_id'],
  transfer_offer: ['buyer', 'price_usdc'],
  sale: ['from', 'price_usdc', 'to', 'tx_hash'],
  world_listed: ['market_draft_id', 'price_usdc'],
  world_sale: [
    'from', 'market_checkout_id', 'market_listing_id', 'price_usdc', 'to', 'tx_hash',
  ],
  world_cancel: ['market_draft_id'],
  payment_repair: [
    'attempt_id', 'outcome', 'payment_status', 'place_name', 'repair_key',
    'source_status', 'transaction',
  ],
  moderation: ['reason'],
} as const

export const AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS_BY_KIND = Object.freeze(
  Object.fromEntries(Object.entries(omittedFieldsByKind).map(([kind, fields]) => [
    kind,
    Object.freeze([...fields]),
  ])),
)

export const AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS = Object.freeze([
  ...new Set(Object.values(omittedFieldsByKind).flat()),
].sort())
