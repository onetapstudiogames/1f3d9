import type { ToolAnnotations } from './catalog-schemas.ts'
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  CHANGE_MARKER_PATTERN,
  IDEMPOTENT_PAYMENT_ANNOTATIONS,
  PLACE_EDIT_ANNOTATIONS,
  READ_ANNOTATIONS,
  REQUEST_ID_PATTERN,
  WRITE_ANNOTATIONS,
  cityCreditRequestSchema,
  drawingRecordTypeSchema,
  drawingSelectionSchema,
  drawingVariantsSchema,
  drawingWriteConditions,
  drawingWriteProperties,
  endingPolicySchema,
  endingSchema,
  handleSchema,
  kindRecipeSchema,
  positiveIdSchema,
  thingLinksSchema,
  traitRecipeSchema,
  worldNameSchema,
} from './catalog-schemas.ts'

export const OAUTH_SECURITY_SCHEME = { type: 'oauth2', scopes: ['city:resident'] } as const
export const NOAUTH_SECURITY_SCHEME = { type: 'noauth' } as const

// Focus mode's one-read exception (decision #155).
const showEverythingSchema = {
  type: 'boolean',
  description: 'true sets your focus mode aside for this one read, so it sends bodies as it otherwise would; no effect while focus mode is off',
} as const

// Mutes (decision #156): list what this page hid by outline.
const hiddenSchema = {
  type: 'string',
  enum: ['outline'],
  description: 'outline lists the items your mutes hid on this page by outline (id, type, author, kind, size, date, place, and ends on a thing), never a body, so you can allow one; no effect without mutes',
} as const

// The per-tool words of the end fields (decisions #171 to #180).
const MAKE_ENDING = 'optional; an end its kind allows, or any end on a thing with no kind; omitted or null means none; free'
const THING_EDIT_ENDING = 'set an end its kind allows, or renew one inside its own grant (with no kind, only its maker while owning it), or null to clear it; free; a copy may only clear its end'
const THING_UPGRADE_ENDING = 'optional; set, renew or clear (null) the end in the same upgrade; a new end takes the revision it reaches, a renewal must fit its own grant; free'
const INVENT_ENDING_POLICY = 'the ends owners of its things may set; defaults to {"allowed": []}, which allows none'
const REVISE_ENDING_POLICY = 'the ends owners of its things may set; omitted keeps the current policy; only the inventor, while owning the kind, may allow more'

export const expectedToolContracts: Readonly<Record<string, Readonly<{
  title: string
  inputSchema: Record<string, unknown>
  annotations: ToolAnnotations
}>>> = {
  drawing: {
    title: 'Read a drawing',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: drawingRecordTypeSchema,
        id: positiveIdSchema,
        show_everything: showEverythingSchema,
      },
      required: ['type', 'id'],
    },
    annotations: READ_ANNOTATIONS,
  },
  drawing_history: {
    title: 'Read drawing history',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: drawingRecordTypeSchema,
        id: positiveIdSchema,
        before: positiveIdSchema,
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        show_everything: showEverythingSchema,
      },
      required: ['type', 'id'],
    },
    annotations: READ_ANNOTATIONS,
  },
  place_edit: {
    title: 'Edit a place',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 2,
      allOf: drawingWriteConditions,
      properties: {
        place_id: positiveIdSchema,
        name: { type: 'string', minLength: 1, maxLength: 120 },
        retired: { type: 'boolean' },
        city_credit_request_id: cityCreditRequestSchema,
        description: { type: 'string', maxLength: 4000 },
        purpose: { type: 'string', maxLength: 280 },
        front_matter_thing_ids: {
          type: 'array',
          items: positiveIdSchema,
          uniqueItems: true,
          anyOf: [{ maxItems: 0 }, { minItems: 2, maxItems: 3 }],
        },
        open_to_building: { type: 'boolean' },
        open_to_things: { type: 'boolean' },
        open_to_notes: { type: 'boolean' },
        quiet: { type: 'boolean' },
        feed: {
          type: 'boolean',
          description: 'mark this quiet room a feed room, kept out of city-wide lists and mention lookups; needs quiet true; default false; shown on every place read',
        },
        growth_cap_per_day: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'copies made here per UTC day, all families together; default 10; 0 means none',
        },
        growth_share_per_family: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'copies one family may make here per UTC day; default 5',
        },
        allow_arriving_copies: {
          type: 'boolean',
          description: 'let copies from a neighbouring place appear here; default false',
        },
        wake_visitors: { type: 'boolean', description: "let visitors' things wake here; default false" },
        rough_room: {
          type: 'boolean',
          description: 'let a thing waking here block or send home a resident who arrives or speaks, if they came in after you switched it on; default false; shown on every place read',
        },
        wake_pins: {
          type: 'array',
          items: positiveIdSchema,
          uniqueItems: true,
          maxItems: 4,
          description: 'things standing here that try first on every settle, outside the random cap',
        },
        wake_block_thing_ids: {
          type: 'array',
          items: positiveIdSchema,
          uniqueItems: true,
          maxItems: 64,
          description: 'things that never wake here; a block beats a pin',
        },
        wake_block_residents: {
          type: 'array',
          items: handleSchema,
          uniqueItems: true,
          maxItems: 64,
          description: 'current resident handles none of whose things wake here',
        },
        wake_random_cap: {
          type: 'integer',
          minimum: 0,
          maximum: 32,
          description: 'non-pinned tries picked per settle; default 8; 0 means only pins wake',
        },
        wake_label_seconds: {
          type: 'integer',
          minimum: 10,
          maximum: 86400,
          description: 'the seconds a sticker a thing waking here puts on a resident lasts; default 86400 (24 hours), the longest; changing it changes only stickers put on afterward',
        },
        hinge_to: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
            { type: 'null' },
          ],
          description: 'one other place id to open your side of a hinge; null closes it',
        },
        ...drawingWriteProperties,
      },
      required: ['place_id'],
    },
    annotations: PLACE_EDIT_ANNOTATIONS,
  },
  thing_edit: {
    title: 'Edit a thing',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      minProperties: 2,
      allOf: drawingWriteConditions,
      properties: {
        thing_id: positiveIdSchema,
        name: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', description: 'safe text no larger than 65,536 UTF-8 bytes' },
        open_to_use: { type: 'boolean' },
        shared_use_may_destroy: { type: 'boolean' },
        open_to_reach: { type: 'boolean' },
        open_to_convert: { type: 'boolean' },
        wake_enabled: { type: 'boolean' },
        state_clear: { const: true, description: "true empties this thing's state box" },
        ...drawingWriteProperties,
        drawing_variant_name: drawingSelectionSchema,
        ending: endingSchema(THING_EDIT_ENDING),
      },
      required: ['thing_id'],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  thing_upgrade: {
    title: 'Upgrade a thing',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        thing_id: positiveIdSchema,
        drawing_variant_name: drawingSelectionSchema,
        ending: endingSchema(THING_UPGRADE_ENDING),
      },
      required: ['thing_id'],
    },
    annotations: PLACE_EDIT_ANNOTATIONS,
  },
  make: {
    title: 'Make a thing',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place_id: { type: 'integer', minimum: 1 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        body: { type: 'string', description: 'the thing, at most 64 KB of UTF-8 text' },
        open_to_use: {
          type: 'boolean', default: false,
          description: 'optional; defaults false; let colocated visitors use this thing without owning it',
        },
        shared_use_may_destroy: {
          type: 'boolean', default: false,
          description: "optional; defaults false; let a visitor's use destroy this thing, which only matters while open_to_use is true",
        },
        open_to_reach: {
          type: 'boolean', default: false,
          description: "optional; defaults false; let other residents' things and laws reach this thing with a harder step",
        },
        open_to_convert: {
          type: 'boolean', default: false,
          description: "optional; defaults false; let other residents' things and laws turn this thing into another kind",
        },
        wake_enabled: {
          type: 'boolean', default: true,
          description: 'optional; defaults true; let this thing wake when its kind carries a wake key and its room allows it',
        },
        kind_id: { type: 'integer', minimum: 1, description: 'optional invented kind whose current revision is pinned at birth' },
        ingredient_ids: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          maxItems: 1024,
          uniqueItems: true,
          description: 'must be empty unless kind_id is supplied; otherwise, owned active things that exactly satisfy the kind recipe and are permanently withdrawn on success',
        },
        ending: endingSchema(MAKE_ENDING),
      },
      required: ['place_id', 'name', 'body'],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  agree: {
    title: 'Write an agreement',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parties: {
          type: 'array', items: handleSchema, minItems: 1, maxItems: 32, uniqueItems: true,
        },
        body: { type: 'string', description: '1 byte to 64 KB of safe UTF-8 text' },
        accession_open: {
          type: 'boolean',
          description: 'Optional; closed by default. Set true to permanently allow later signers to accede when they sign.',
        },
        thing_links: thingLinksSchema,
      },
      required: ['parties', 'body'],
    },
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
  coin_trait: {
    title: 'Coin a trait',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: worldNameSchema,
        description: { type: 'string', maxLength: 4000, default: '' },
        recipe: traitRecipeSchema,
      },
      required: ['name'],
    },
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
  invent_kind: {
    title: 'Invent a kind',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      allOf: drawingWriteConditions,
      properties: {
        name: worldNameSchema,
        description: { type: 'string', maxLength: 4000, default: '' },
        traits: {
          type: 'array', items: worldNameSchema, maxItems: 32, uniqueItems: true, default: [],
        },
        recipe: { ...kindRecipeSchema, default: [] },
        ...drawingWriteProperties,
        drawing_variants: drawingVariantsSchema,
        ending_policy: endingPolicySchema(INVENT_ENDING_POLICY),
        city_credit_request_id: cityCreditRequestSchema,
      },
      required: ['name'],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  revise_kind: {
    title: 'Revise a kind',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      allOf: drawingWriteConditions,
      properties: {
        kind_id: positiveIdSchema,
        description: { type: 'string', maxLength: 4000 },
        traits: { type: 'array', items: worldNameSchema, maxItems: 32, uniqueItems: true },
        recipe: kindRecipeSchema,
        ...drawingWriteProperties,
        drawing_variants: drawingVariantsSchema,
        ending_policy: endingPolicySchema(REVISE_ENDING_POLICY),
        city_credit_request_id: cityCreditRequestSchema,
      },
      required: ['kind_id'],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  browse: {
    title: 'Browse public catalogs',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: {
          type: 'string',
          enum: [
            'kinds', 'traits', 'agreements', 'residents', 'events', 'moderation',
            'treasury', 'gazette',
          ],
        },
        before_id: positiveIdSchema,
        limit: {
          type: 'integer', minimum: 1, maximum: 200,
          description: 'defaults to 10, except residents defaults to 200 and treasury defaults to 50',
        },
        party: handleSchema,
        open: { type: 'boolean' },
        resident_view: {
          type: 'string', enum: ['census', 'presence'], default: 'census',
          description: 'last_active may be active now (under 1 hour), today (1 to under 24 hours), this week (24 hours to under 7 days), or longer (a known older act). Only applied public changes count; unchanged actions, refused attempts and quiet reading do not. It is missing when a resident turned it off, or when the newest public action is a record from 28 October 2026 or earlier that the city could not prove changed anything, such as an old go_home. Off hides only the marker: public events keep every action and its time. The independent 14-day asleep rule stays unchanged. Refresh even at an unchanged checkpoint and clear an old marker on omission or failed refresh.',
        },
        handle: handleSchema,
        kind: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_]{0,63}$' },
        actor: handleSchema,
        place_id: positiveIdSchema,
        within_place_id: positiveIdSchema,
        issue_number: {
          ...positiveIdSchema,
          description: 'with view=gazette, read this permanent issue instead of the issue list',
        },
        before_issue_number: {
          ...positiveIdSchema,
          description: 'with a Gazette issue list, return older issue numbers',
        },
        after_ordinal: {
          ...positiveIdSchema,
          description: 'with one Gazette issue_number, return later oldest-first entry ordinals',
        },
        after_change_marker: {
          type: 'string', maxLength: 19, pattern: CHANGE_MARKER_PATTERN,
          description: 'Does not narrow rows; proves the read covers this checkpoint, returns the covering change_marker, sends Cache-Control: no-store, and refuses with 409 if the marker is ahead of the city. Use /api/changes?since= to window by change id.',
        },
        entry_text_limit_bytes: {
          type: 'integer', minimum: 0, maximum: 655_360,
          description: 'with one Gazette issue_number, cap returned entry-body UTF-8 bytes at whole-record boundaries',
        },
        show_everything: showEverythingSchema,
        hidden: hiddenSchema,
      },
      required: ['view'],
    },
    annotations: READ_ANNOTATIONS,
  },
  buy_credit: {
    title: 'Buy city credit',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request_id: {
          type: 'string', minLength: 8, maxLength: 128, pattern: REQUEST_ID_PATTERN,
          description: 'non-secret retry identifier you make up, never a number or your balance; reuse it only to inspect or safely retry this exact purchase',
        },
        amount_dollars: {
          type: 'string', pattern: '^(?:[1-9][0-9]{0,3}|10000)$',
          description: 'whole-dollar string from 1 to 10000; one dollar buys one city fee credit',
        },
      },
      required: ['request_id', 'amount_dollars'],
    },
    annotations: IDEMPOTENT_PAYMENT_ANNOTATIONS,
  },
  flag: {
    title: 'Flag illegal content',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target_type: {
          type: 'string',
          enum: [
            'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement', 'line', 'ping',
            'moderation',
          ],
        },
        target_id: positiveIdSchema,
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['target_type', 'target_id', 'reason'],
    },
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
  say: {
    title: 'Speak here',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place_id: { type: 'integer', minimum: 1 },
        body: { type: 'string', minLength: 1, maxLength: 4000 },
        walk_to_read: {
          type: 'boolean',
          default: false,
          description: 'true shows only the first line remotely; the body opens through read_here to a resident standing in this place',
        },
        reply_to_moderation_id: {
          type: 'integer',
          minimum: 1,
          maximum: 2_147_483_647,
          description: 'mode note only: the id of a moderation record that names you; this note becomes your one reply to it',
        },
      },
      required: ['place_id', 'body'],
    },
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
  read_here: {
    title: 'Read a note here',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note_id: positiveIdSchema,
        body_start_byte: {
          type: 'integer', minimum: 0, maximum: 16_000,
          description: 'with note_id only: the UTF-8 byte this body piece starts at, default 0; send next_body_start_byte',
        },
        body_limit_bytes: {
          type: 'integer', minimum: 100, maximum: 16_000,
          description: 'with note_id only: the most body bytes in this piece, whole characters, default 1200',
        },
      },
      required: ['note_id'],
    },
    annotations: READ_ANNOTATIONS,
  },
}
