export type ToolAnnotations = Readonly<{
  readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean
}>

const HANDLE_PATTERN = '^[a-z0-9][a-z0-9-]{2,31}$'
const WORLD_NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,63}$'
export const REQUEST_ID_PATTERN = String.raw`^(?![0-9]+(?:\.[0-9]+)?$)[A-Za-z0-9][A-Za-z0-9_.:-]*$`
export const CHANGE_MARKER_PATTERN = '^(?:0|[1-9][0-9]*)$'

export const READ_ANNOTATIONS = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
} as const
export const PLACE_EDIT_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
} as const
export const WRITE_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
} as const
export const ADDITIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
} as const
export const IDEMPOTENT_PAYMENT_ANNOTATIONS = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
} as const

export const positiveIdSchema = { type: 'integer', minimum: 1, maximum: 2_147_483_647 } as const
export const drawingRecordTypeSchema = {
  type: 'string', enum: ['place', 'resident', 'kind', 'thing'],
} as const

const drawingPixelSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    palette: {
      type: 'array', maxItems: 64,
      items: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
    },
    indices: {
      type: 'array', minItems: 64, maxItems: 64,
      items: {
        anyOf: [
          { type: 'null' },
          { type: 'integer', minimum: 0, maximum: 63 },
        ],
      },
    },
  },
  required: ['palette', 'indices'],
} as const
const drawingArgumentSchema = {
  anyOf: [
    { type: 'null' },
    { type: 'string', const: 'REFUSE' },
    drawingPixelSchema,
  ],
} as const
const drawingStateSchema = {
  type: 'string', enum: ['in_progress', 'complete'],
} as const
const drawingDescriptionSchema = {
  type: 'string',
  description: 'HTTP/MCP runtime enforces safe public text and at most 280 UTF-8 bytes; HTTP is authoritative and MCP forwards its exact errors',
} as const
export const drawingWriteProperties = {
  drawing: drawingArgumentSchema,
  drawing_state: drawingStateSchema,
  drawing_description: drawingDescriptionSchema,
} as const
export const drawingWriteConditions = [
  {
    if: {
      anyOf: [{ required: ['drawing_state'] }, { required: ['drawing_description'] }],
    },
    then: { required: ['drawing'] },
  },
  {
    if: { properties: { drawing: { type: 'null' } }, required: ['drawing'] },
    then: {
      not: {
        anyOf: [{ required: ['drawing_state'] }, { required: ['drawing_description'] }],
      },
    },
  },
  {
    if: { properties: { drawing: { const: 'REFUSE' } }, required: ['drawing'] },
    then: { required: ['drawing_description'], not: { required: ['drawing_state'] } },
  },
  {
    if: { properties: { drawing: { type: 'object' } }, required: ['drawing'] },
    then: { required: ['drawing_state', 'drawing_description'] },
  },
] as const
const drawingVariantSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: {
      type: 'string', minLength: 1,
      description: 'HTTP/MCP runtime enforces a safe trimmed one-line exact variant name and at most 64 UTF-8 bytes; HTTP is authoritative and MCP forwards its exact errors',
    },
    drawing: drawingPixelSchema,
    drawing_state: drawingStateSchema,
    drawing_description: drawingDescriptionSchema,
  },
  required: ['name', 'drawing', 'drawing_state', 'drawing_description'],
} as const
export const drawingVariantsSchema = {
  type: 'array', maxItems: 8, items: drawingVariantSchema,
  description: 'zero to 8 variants authored for this kind revision; HTTP/MCP runtime enforces unique exact variant names; HTTP is authoritative and MCP forwards its exact errors',
} as const
export const drawingSelectionSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'string', minLength: 1,
      description: 'HTTP/MCP runtime enforces a safe trimmed one-line exact offered variant name and at most 64 UTF-8 bytes; HTTP is authoritative and MCP forwards its exact errors',
    },
  ],
  description: 'null deliberately selects the pinned kind base; a string selects that exact named variant',
} as const
export const handleSchema = { type: 'string', pattern: HANDLE_PATTERN } as const
export const worldNameSchema = {
  type: 'string', minLength: 1, maxLength: 64, pattern: WORLD_NAME_PATTERN,
} as const
export const cityCreditRequestSchema = {
  type: 'string', minLength: 8, maxLength: 128, pattern: REQUEST_ID_PATTERN,
  description: 'non-secret retry identifier you make up for this one paid action, never a number or your balance',
} as const
export const kindRecipeSchema = {
  type: 'array',
  maxItems: 64,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: worldNameSchema,
      quantity: { type: 'integer', minimum: 1, maximum: 1024 },
    },
    required: ['kind', 'quantity'],
  },
  description: 'unique kind names; at most 64 rows, 1,024 total ingredients, and 65,536 UTF-8 JSON bytes',
} as const
export const traitRecipeSchema = {
  anyOf: [
    { type: 'array', maxItems: 128, items: { type: 'object' } },
    { type: 'object' },
    { type: 'null' },
  ],
  description: 'optional recipe keyed by the frozen actions, one optional wake key and one optional end key; at most 128 effects, 8 nested levels, and 65,536 UTF-8 JSON bytes',
} as const

// A thing's end (decisions #171 to #180): the one shape make, thing_edit and thing_upgrade
// publish for ending, the kind ending_policy, and agreement thing_links.
export const ENDING_UTC_TIME_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|\+00:00)$`
const endingSeconds = { type: 'integer', minimum: 60, maximum: 31_622_400 } as const
const endingCondition = (mode: string, schema: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, properties: { [mode]: schema }, required: [mode],
})
export function endingSchema(description: string) {
  return {
    anyOf: [
      { type: 'null' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          any: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              anyOf: [
                endingCondition('at', {
                  type: 'string', pattern: ENDING_UTC_TIME_PATTERN,
                  description: 'a UTC time in the future, at most 366 days ahead',
                }),
                endingCondition('after_setting_seconds', { ...endingSeconds, description: 'seconds after the end is set' }),
                endingCondition('uses', { type: 'integer', minimum: 1, maximum: 10_000, description: 'successful uses' }),
                endingCondition('idle_seconds', { ...endingSeconds, description: 'seconds with no successful use' }),
                endingCondition('label_added', { ...worldNameSchema, description: 'a label being put on the thing; a kind names the labels it allows' }),
              ],
            },
            description: 'each condition a different way; the first one met ends the thing',
          },
        },
        required: ['any'],
      },
    ],
    description,
  }
}
export function endingPolicySchema(description: string) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      allowed: {
        type: 'array',
        items: { type: 'string', enum: ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'] },
        maxItems: 5,
        uniqueItems: true,
      },
      labels: {
        type: 'array', items: worldNameSchema, minItems: 1, maxItems: 8, uniqueItems: true,
        description: 'required exactly when allowed has label_added: the labels a label_added end may name',
      },
      max_seconds: { ...endingSeconds, description: 'optional; lowers the longest time an end may count or a date may lie ahead' },
      max_uses: { type: 'integer', minimum: 1, maximum: 10_000, description: 'optional; lowers the most uses an end may count' },
    },
    required: ['allowed'],
    description,
  }
}
export const thingLinksSchema = {
  type: 'array',
  items: positiveIdSchema,
  maxItems: 16,
  uniqueItems: true,
  description: 'optional; 0 to 16 different ids of things that exist and are not withdrawn, stored with the agreement for good; a link moves nothing and changes no terms',
} as const
