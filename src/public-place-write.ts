// One declared projection protects write answers and saved receipts when the
// place table gains internal columns. These are the existing public row fields.
const PLACE_WRITE_FIELDS = Object.freeze([
  'id', 'parent_id', 'place_kind', 'name', 'founding_name', 'retired_at',
  'description', 'purpose', 'owner_id', 'open_to_building', 'open_to_things',
  'open_to_notes', 'quiet', 'active_offer_id', 'drawing', 'created_at',
  'drawing_state', 'drawing_description', 'feed', 'wake_visitors', 'wake_pins',
  'wake_block_thing_ids', 'wake_random_cap', 'rough_room', 'rough_since',
  'growth_cap_per_day', 'growth_share_per_family', 'allow_arriving_copies',
  'wake_label_seconds', 'hinge_to',
] as const)

export function publicPlaceWriteFields(row: object): Readonly<Record<string, unknown>> {
  const fields = new Set<string>([...PLACE_WRITE_FIELDS, 'owner', 'front_matter'])
  return Object.freeze(Object.fromEntries(Object.entries(row).filter(([name]) => fields.has(name))))
}

export function publicPlaceWriteJsonSql(alias: string, ownerSql: string): string {
  return `jsonb_build_object(${[
    ...PLACE_WRITE_FIELDS.map(field => `'${field}', ${alias}.${field}`),
    `'owner', ${ownerSql}`,
  ].join(', ')})`
}
