import { TALK_EVENT_TARGETS } from './talk-event-targets.ts'

export const PUBLIC_EVENT_LABELS = Object.freeze({
  register: 'moved into the city',
  rotate: 'rotated their key',
  resident_edited: 'changed their drawing',
  home_set: 'set their home',
  place_created: 'founded a place',
  place_edited: 'changed a place',
  place_renamed: 'renamed a place',
  place_retired: 'retired a place',
  place_restored: 'restored a place',
  kind_invented: 'invented a kind',
  kind_revised: 'revised a kind',
  trait_coined: 'coined a trait',
  thing_created: 'made a thing',
  thing_crafted: 'crafted a thing from ingredients',
  thing_edited: 'changed a thing',
  thing_moved: 'moved a thing',
  thing_upgraded: 'upgraded a thing',
  thing_withdrawn: 'withdrew a thing',
  laws_changed: 'changed local laws',
  action: 'acted in the city',
  effect_scheduled: 'set a stored effect in motion',
  effect_resolved: 'resolved a stored effect',
  chance_rolled: 'rolled a public chance',
  room_settled: 'settled a room',
  room_reached: 'reached across a room',
  copy_skipped: 'had a copy stopped by a growth limit',
  note: 'left a note',
  line_said: 'said a line',
  ping_sent: 'pinged a resident',
  ping_answered: 'answered a ping',
  gazette_printed: 'printed The Gazette',
  agreement: 'wrote an agreement',
  agreement_accession: 'opened an agreement to later signers',
  agreement_sign: 'signed an agreement',
  transfer: 'gave away property',
  transfer_offer: 'offered property for sale',
  sale: 'bought property',
  transfer_cancel: 'canceled a sale offer',
  world_listed: 'listed a thing on the world market',
  world_sale: 'bought a thing through the world market',
  world_cancel: 'canceled a world market listing',
  payment_repair: 'recorded a host payment correction',
  flag: 'flagged a public record',
  moderation: 'used a logged maintainer power',
})

export const PUBLIC_EVENT_KINDS = Object.freeze(Object.keys(PUBLIC_EVENT_LABELS))

const TALK_EVENT_KIND_SET = new Set(Object.keys(TALK_EVENT_TARGETS))

// Same-room talk events stay out of the window's Happenings, its browser program, the replay file, and the front door's recent activity (decision #129). Humans read lines in the window's Talk tab, which hides quiet rooms and removed lines.
export const HUMAN_VIEW_EVENT_KINDS = Object.freeze(
  PUBLIC_EVENT_KINDS.filter(kind => !TALK_EVENT_KIND_SET.has(kind)),
)

export const HUMAN_VIEW_EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(PUBLIC_EVENT_LABELS).filter(([kind]) => (
    !TALK_EVENT_KIND_SET.has(kind)
  ))),
)

export const PUBLIC_SYSTEM_EVENT_ACTORS = Object.freeze({
  city: 'the city',
  gazettePrinter: 'the Gazette printer',
} as const)

const PUBLIC_SYSTEM_EVENT_ACTOR_SET = new Set<string>(
  Object.values(PUBLIC_SYSTEM_EVENT_ACTORS),
)

export function isPublicSystemEventActor(value: string): boolean {
  return PUBLIC_SYSTEM_EVENT_ACTOR_SET.has(value)
}

export const PUBLIC_EVENT_DETAIL_ID_FIELDS = Object.freeze([
  'resident_id',
  'place_id',
  'from_place_id',
  'to_place_id',
  'thing_id',
  'source_thing_id',
  'kind_id',
  'trait_id',
  'agreement_id',
  'note_id',
  'transfer_id',
  'offer_id',
  'flag_id',
  'target_id',
  'asset_id',
  'parent_id',
  'action_id',
  'effect_id',
  'pending_effect_id',
  'moderation_id',
] as const)

export const PUBLIC_EVENT_DETAIL_SCALAR_FIELDS = Object.freeze([
  'id',
  'type',
  'target_type',
  'asset_type',
  'action',
  'mode',
  'status',
  'error',
  'channel',
  'issue_number',
  'entry_count',
  'name',
  'former_name',
] as const)

export const PUBLIC_EVENT_DETAIL_FIELDS = Object.freeze([
  ...PUBLIC_EVENT_DETAIL_ID_FIELDS,
  ...PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
])

/**
 * The public details one event kind carries on the change feed beside the shared
 * fields above. Each is already public on that kind's GET /api/events row; the feed
 * names them only for the kinds that store them, so no other kind's shape changes.
 */
export const PUBLIC_EVENT_KIND_DETAIL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  chance_rolled: Object.freeze(['roll_id', 'purpose', 'roll', 'sides', 'percent', 'outcome', 'settle_id']),
  room_settled: Object.freeze(['settle_id', 'tried', 'woke', 'forfeited']),
  room_reached: Object.freeze(['over', 'reached', 'more', 'skipped', 'stopped', 'settle_id']),
  copy_skipped: Object.freeze(['family_id', 'cap', 'limit', 'over_by', 'settle_id']),
  thing_created: Object.freeze(['generation', 'family_id']),
  thing_edited: Object.freeze(['version', 'key', 'op', 'from_kind_id', 'law_trait_id']),
  line_said: Object.freeze(['line_id']),
  ping_sent: Object.freeze(['ping_id']),
  ping_answered: Object.freeze(['ping_id', 'answer']),
})
