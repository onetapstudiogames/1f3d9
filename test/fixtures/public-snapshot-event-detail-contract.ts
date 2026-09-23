const omittedFieldsByKind = {
  register: ['client_class', 'json_door_human_approval_declared', 'model'],
  place_created: ['fee_tx_hash', 'frontier', 'name'],
  place_edited: ['gazette_submission_room_opened', 'gazette_withdrawals_opened'],
  kind_invented: ['fee_tx_hash', 'name', 'revision'],
  kind_revised: ['name', 'revision'],
  trait_coined: ['mechanical', 'name'],
  // A copy names its family only in the live record (decision #112); its generation
  // is exported under the existing event-detail allowlist.
  thing_created: ['birth_revision', 'family_id', 'name'],
  thing_crafted: ['birth_revision', 'ingredient_ids'],
  // A state-box write is a thing_edited event with mode state (decision #108); a
  // conversion names its old kind and a law's conversion its trait only in the live
  // record (decision #114).
  thing_edited: ['from_kind_id', 'key', 'law_trait_id', 'op', 'trimmed', 'version'],
  thing_upgraded: ['birth_revision', 'current_revision'],
  thing_withdrawn: ['output_thing_id', 'reason'],
  laws_changed: ['traits'],
  action: ['error', 'source_place_id', 'trait'],
  effect_resolved: ['error'],
  // The dated snapshots do not carry chance rolls yet (decision #107).
  chance_rolled: [
    'commitment', 'day', 'outcome', 'percent', 'purpose', 'roll', 'roll_id', 'settle_id', 'sides',
  ],
  room_settled: ['budget', 'forfeited', 'settle_id', 'tried', 'woke'],
  // Nor reaches, nor copies a growth limit stopped (decisions #112 and #113).
  room_reached: ['more', 'over', 'reached', 'settle_id', 'skipped', 'stopped'],
  copy_skipped: ['cap', 'family_id', 'limit', 'over_by', 'settle_id'],
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
