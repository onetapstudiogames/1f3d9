import { publicLabel, publicText } from './input.ts'

export const DRAWING_PALETTE_MAX = 64
export const DRAWING_SQUARE_COUNT = 64
export const DRAWING_MAX_BYTES = 2_048
export const DRAWING_DESCRIPTION_MAX_BYTES = 280
export const DRAWING_VARIANTS_MAX = 8
export const DRAWING_VARIANT_NAME_MAX_BYTES = 64
export const DRAWING_BODY_MAX_BYTES = 4_096
// 132 KiB preserves the existing 65,536-byte thing-body contract even when
// every valid backslash needs JSON escaping, with room for drawing and keys.
export const DRAWING_RECORD_BODY_MAX_BYTES = 135_168

const DRAWING_COLOUR = /^#[0-9a-f]{6}$/u
const DRAWING_FIELDS = Object.freeze(['indices', 'palette'])
const DRAWING_VARIANT_FIELDS = Object.freeze([
  'drawing',
  'drawing_description',
  'drawing_state',
  'name',
])

export type Drawing = Readonly<{
  palette: readonly string[]
  indices: readonly (number | null)[]
}>

export type DrawingParseResult =
  | Readonly<{ ok: true; drawing: Drawing | null }>
  | Readonly<{ ok: false; error: string }>

export type DrawingState = 'undrawn' | 'refused' | 'in_progress' | 'complete'
export type DrawingPresentationState = DrawingState | 'blank'

export type DrawingValue = Readonly<{
  state: DrawingState
  description: string | null
  drawing: Drawing | null
}>

export type DrawingWriteParseResult =
  | Readonly<{ ok: true; value: DrawingValue }>
  | Readonly<{ ok: false; error: string }>

export type DrawingVariant = Readonly<{
  name: string
  state: 'in_progress' | 'complete'
  description: string
  drawing: Drawing
}>

export type DrawingVariantsParseResult =
  | Readonly<{ ok: true; variants: readonly DrawingVariant[] }>
  | Readonly<{ ok: false; error: string }>

export type BoundedJsonResult =
  | Readonly<{ ok: true; body: Record<string, unknown> }>
  | Readonly<{ ok: false; error: string }>

function invalidDrawing(reason: string): DrawingParseResult {
  return Object.freeze({ ok: false, error: `drawing ${reason}` })
}

function exactDrawingFields(value: Record<string, unknown>): boolean {
  const fields = Object.keys(value).sort()
  return fields.length === DRAWING_FIELDS.length
    && fields.every((field, index) => field === DRAWING_FIELDS[index])
}

function drawingBytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return null
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function owns(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const fields = Object.keys(value).sort()
  return fields.length === expected.length
    && fields.every((field, index) => field === expected[index])
}

function parseDrawingDescription(
  value: unknown,
): Readonly<{ ok: true; description: string }> | Readonly<{ ok: false; error: string }> {
  if (typeof value !== 'string') {
    return Object.freeze({ ok: false, error: 'drawing_description must be a string' })
  }
  if (utf8Bytes(value) > DRAWING_DESCRIPTION_MAX_BYTES) {
    return Object.freeze({
      ok: false,
      error: `drawing_description must be no larger than ${DRAWING_DESCRIPTION_MAX_BYTES} UTF-8 bytes`,
    })
  }
  const description = publicText(value, {
    maximumBytes: DRAWING_DESCRIPTION_MAX_BYTES,
    allowEmpty: true,
  })
  if (description === null) {
    return Object.freeze({
      ok: false,
      error: 'drawing_description must be safe public text',
    })
  }
  return Object.freeze({ ok: true, description })
}

/**
 * Validate only the public drawing boundary. The server never interprets the
 * picture represented by these palette indices.
 */
export function parseDrawing(value: unknown): DrawingParseResult {
  if (value === null) return Object.freeze({ ok: true, drawing: null })
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidDrawing('must be null or an object with palette and indices')
  }

  const candidate = value as Record<string, unknown>
  if (!exactDrawingFields(candidate)) {
    return invalidDrawing('accepts exactly palette and indices')
  }
  if (!Array.isArray(candidate.palette) || candidate.palette.length > DRAWING_PALETTE_MAX) {
    return invalidDrawing(`palette must contain at most ${DRAWING_PALETTE_MAX} colours`)
  }
  if (!candidate.palette.every(colour => typeof colour === 'string' && DRAWING_COLOUR.test(colour))) {
    return invalidDrawing('palette colours must use lowercase #rrggbb')
  }
  if (!Array.isArray(candidate.indices) || candidate.indices.length !== DRAWING_SQUARE_COUNT) {
    return invalidDrawing(`indices must contain exactly ${DRAWING_SQUARE_COUNT} squares`)
  }
  const paletteLength = candidate.palette.length
  if (!candidate.indices.every(index => (
    index === null
    || (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < paletteLength)
  ))) {
    return invalidDrawing('indices must be null or integers naming an existing palette colour')
  }
  const byteLength = drawingBytes(candidate)
  if (byteLength === null || byteLength > DRAWING_MAX_BYTES) {
    return invalidDrawing(`must be no larger than ${DRAWING_MAX_BYTES} UTF-8 bytes`)
  }

  return Object.freeze({
    ok: true,
    drawing: Object.freeze({
      palette: Object.freeze([...candidate.palette] as string[]),
      indices: Object.freeze([...candidate.indices] as Array<number | null>),
    }),
  })
}

/** Normalize the drawing fields carried by an owner-authorized write request. */
export function parseDrawingWrite(value: unknown): DrawingWriteParseResult {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ ok: false, error: 'drawing write must be a JSON object' })
  }
  const body = value as Record<string, unknown>
  if (!owns(body, 'drawing')) {
    return Object.freeze({ ok: false, error: 'drawing is required' })
  }

  if (body.drawing === null) {
    if (owns(body, 'drawing_state')) {
      return Object.freeze({ ok: false, error: 'undrawn clear must omit drawing_state' })
    }
    if (owns(body, 'drawing_description')) {
      return Object.freeze({ ok: false, error: 'undrawn clear must omit drawing_description' })
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({ state: 'undrawn', description: null, drawing: null }),
    })
  }

  const description = parseDrawingDescription(body.drawing_description)
  if (!description.ok) return description
  if (body.drawing === 'REFUSE') {
    if (owns(body, 'drawing_state')) {
      return Object.freeze({ ok: false, error: 'REFUSE must omit drawing_state' })
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        state: 'refused',
        description: description.description,
        drawing: null,
      }),
    })
  }
  const parsed = parseDrawing(body.drawing)
  if (!parsed.ok || parsed.drawing === null) {
    return Object.freeze({
      ok: false,
      error: parsed.ok
        ? 'drawing must be an object with palette and indices'
        : parsed.error.replace('must be null or', 'must be null, exact REFUSE, or'),
    })
  }
  if (body.drawing_state !== 'in_progress' && body.drawing_state !== 'complete') {
    return Object.freeze({
      ok: false,
      error: 'drawing_state must be exactly in_progress or complete for pixel drawings',
    })
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      state: body.drawing_state,
      description: description.description,
      drawing: parsed.drawing,
    }),
  })
}

/** Blank is a presentation of explicitly complete transparent pixels. */
export function drawingPresentationState(
  value: Readonly<{ state: DrawingState; drawing: Drawing | null }>,
): DrawingPresentationState {
  if (
    value.state === 'complete'
    && value.drawing !== null
    && value.drawing.indices.every(index => index === null)
  ) return 'blank'
  return value.state
}

/** Canonical text form for exact agent-to-human comparison of the 8x8 indices. */
export function drawingRows(drawing: Drawing): readonly string[] {
  return Object.freeze(Array.from({ length: 8 }, (_, row) => (
    drawing.indices
      .slice(row * 8, (row + 1) * 8)
      .map(index => index === null ? '.' : String(index))
      .join(' ')
  )))
}

export function parseDrawingVariantName(value: unknown): string | null {
  const name = publicLabel(value, DRAWING_VARIANT_NAME_MAX_BYTES)
  if (name === null || utf8Bytes(name) > DRAWING_VARIANT_NAME_MAX_BYTES) return null
  return name
}

function parseDrawingVariant(value: unknown): DrawingVariant | string {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return 'drawing variant must be an object'
  }
  const candidate = value as Record<string, unknown>
  if (!exactFields(candidate, DRAWING_VARIANT_FIELDS)) {
    return 'drawing variant accepts exactly name, drawing, drawing_state, and drawing_description'
  }
  const name = parseDrawingVariantName(candidate.name)
  if (name === null) {
    return `drawing variant name must be a safe one-line label of 1-${DRAWING_VARIANT_NAME_MAX_BYTES} UTF-8 bytes`
  }
  if (candidate.drawing_state !== 'in_progress' && candidate.drawing_state !== 'complete') {
    return 'drawing variant drawing_state must be exactly in_progress or complete'
  }
  const description = parseDrawingDescription(candidate.drawing_description)
  if (!description.ok) return description.error
  const parsed = parseDrawing(candidate.drawing)
  if (!parsed.ok || parsed.drawing === null) return 'drawing variant drawing must be a Drawing object'
  return Object.freeze({
    name,
    state: candidate.drawing_state,
    description: description.description,
    drawing: parsed.drawing,
  })
}

/** Validate and normalize the named immutable presentations offered by one kind revision. */
export function parseDrawingVariants(value: unknown): DrawingVariantsParseResult {
  if (!Array.isArray(value)) {
    return Object.freeze({ ok: false, error: 'drawing_variants must be an array' })
  }
  if (value.length > DRAWING_VARIANTS_MAX) {
    return Object.freeze({
      ok: false,
      error: `drawing_variants may contain at most ${DRAWING_VARIANTS_MAX} entries`,
    })
  }
  const variants: DrawingVariant[] = []
  const names = new Set<string>()
  for (const candidate of value) {
    const variant = parseDrawingVariant(candidate)
    if (typeof variant === 'string') return Object.freeze({ ok: false, error: variant })
    if (names.has(variant.name)) {
      return Object.freeze({ ok: false, error: 'drawing variant entries must use unique exact names' })
    }
    names.add(variant.name)
    variants.push(variant)
  }
  return Object.freeze({ ok: true, variants: Object.freeze(variants) })
}

/** Read and size the bytes that arrived; edge-provided Content-Length is ignored. */
export async function readBoundedJsonObject(
  request: Request,
  maximumBytes: number,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): Promise<BoundedJsonResult> {
  // Hand-driving request.body's reader never resolves on Vercel's Node
  // bridge (the PR #115 class) — only the framework read is safe, with the
  // bound enforced on the actual bytes afterward.
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await request.arrayBuffer())
  } catch {
    return Object.freeze({ ok: false, error: 'body could not be read' })
  }
  if (bytes.byteLength > maximumBytes) {
    return Object.freeze({
      ok: false,
      error: `body must be no larger than ${maximumBytes} UTF-8 bytes`,
    })
  }
  if (bytes.byteLength === 0 && options.allowEmpty) {
    return Object.freeze({ ok: true, body: Object.freeze({}) as Record<string, unknown> })
  }

  let value: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(text) as unknown
  } catch {
    return Object.freeze({ ok: false, error: 'body must be a JSON object' })
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ ok: false, error: 'body must be a JSON object' })
  }
  return Object.freeze({ ok: true, body: value as Record<string, unknown> })
}
