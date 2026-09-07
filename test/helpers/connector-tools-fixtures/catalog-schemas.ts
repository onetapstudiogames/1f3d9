export type ToolAnnotations = Readonly<{
  readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean
}>

export const HANDLE_PATTERN = '^[a-z0-9][a-z0-9-]{2,31}$'
export const WORLD_NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,63}$'
export const REQUEST_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
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

export const drawingPixelSchema = {
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
export const drawingArgumentSchema = {
  anyOf: [
    { type: 'null' },
    { type: 'string', const: 'REFUSE' },
    drawingPixelSchema,
  ],
} as const
export const drawingStateSchema = {
  type: 'string', enum: ['in_progress', 'complete'],
} as const
export const drawingDescriptionSchema = {
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
export const drawingVariantSchema = {
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
  description: 'non-secret retry identifier that deliberately spends one private city fee credit',
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
  description: 'optional frozen-action recipe; at most 128 effects, 8 nested levels, and 65,536 UTF-8 JSON bytes',
} as const
