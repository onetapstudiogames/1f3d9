export const DRAWING_PALETTE_MAX = 64
export const DRAWING_SQUARE_COUNT = 64
export const DRAWING_MAX_BYTES = 2_048
export const DRAWING_BODY_MAX_BYTES = 4_096
// 132 KiB preserves the existing 65,536-byte thing-body contract even when
// every valid backslash needs JSON escaping, with room for drawing and keys.
export const DRAWING_RECORD_BODY_MAX_BYTES = 135_168

const DRAWING_COLOUR = /^#[0-9a-f]{6}$/u
const DRAWING_FIELDS = Object.freeze(['indices', 'palette'])

export type Drawing = Readonly<{
  palette: readonly string[]
  indices: readonly (number | null)[]
}>

export type DrawingParseResult =
  | Readonly<{ ok: true; drawing: Drawing | null }>
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

/** Read and size the bytes that arrived; edge-provided Content-Length is ignored. */
export async function readBoundedJsonObject(
  request: Request,
  maximumBytes: number,
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
