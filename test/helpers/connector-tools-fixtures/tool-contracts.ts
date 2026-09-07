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
  handleSchema,
  kindRecipeSchema,
  positiveIdSchema,
  traitRecipeSchema,
  worldNameSchema,
} from './catalog-schemas.ts'

export const OAUTH_SECURITY_SCHEME = { type: 'oauth2', scopes: ['city:resident'] } as const
export const NOAUTH_SECURITY_SCHEME = { type: 'noauth' } as const

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
        ...drawingWriteProperties,
        drawing_variant_name: drawingSelectionSchema,
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
      properties: { thing_id: positiveIdSchema, drawing_variant_name: drawingSelectionSchema },
      required: ['thing_id'],
    },
    annotations: PLACE_EDIT_ANNOTATIONS,
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
        resident_view: { type: 'string', enum: ['census', 'presence'], default: 'census' },
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
          description: 'non-secret retry identifier; reuse it to inspect or safely retry this exact purchase',
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
          enum: ['place', 'thing', 'kind', 'trait', 'note', 'agreement', 'resident'],
        },
        target_id: positiveIdSchema,
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['target_type', 'target_id', 'reason'],
    },
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
  },
}
