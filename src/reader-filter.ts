// One home for shaping a read by its own reader's settings (decisions #154 and #155).
// A read that carries the resident's own key or sign-in may look up that resident's
// reading settings; it still changes nothing, binds nobody for ping summaries, and
// never fails because a credential is missing or wrong. Each read path applies this
// right after its moderation overlay, so later reading settings land in the same place.
// Focus mode is the first setting: while it is on, a read that can send many bodies
// sends outlines, unless that one read asks for show_everything.
import type { Context } from 'hono'
import { readerForShaping } from './core.ts'
import type { Drawing } from './drawing.ts'
import { readReadingSettings, type ReadingSettings } from './resident-settings.ts'

export const SHOW_EVERYTHING_REFUSAL =
  'show_everything must be true or false; send true to see every body in this one read'

export const NOTE_VIEW_REFUSAL =
  'note_view must be outline or full; outline sends each of your notes with its size instead of its body'

export const FOCUS_OUTLINE_NEXT_STEP =
  'Focus mode sent outlines only. Read one item by its id for its body, or send show_everything: true with this same read to see every body just this once.'
export const FOCUS_SET_ASIDE_NEXT_STEP =
  'Focus mode is on; show_everything set it aside for this one read only.'

/** The 8 by 8 square every pixel drawing uses. */
const DRAWING_SIDE = 8

export type ReaderShape = Readonly<{
  residentId: number
  focus: boolean
  showEverything: boolean
}>

type QueryValues = Record<string, readonly string[] | undefined>

/** show_everything is absent (false), or exactly true or false once. */
export function parseShowEverything(query: QueryValues): { ok: true; value: boolean } | { ok: false } {
  const values = query.show_everything
  if (!values || values.length === 0) return { ok: true, value: false }
  if (values.length !== 1 || (values[0] !== 'true' && values[0] !== 'false')) return { ok: false }
  return { ok: true, value: values[0] === 'true' }
}

/**
 * Who is reading and how they chose to read. Null for an anonymous read, an invalid
 * credential, or settings that cannot be read now: that read is answered as anyone's.
 */
export async function readerShape(
  c: Context,
  showEverything: boolean,
  readSettings: (residentId: number) => Promise<ReadingSettings> = readReadingSettings,
): Promise<ReaderShape | null> {
  const reader = await readerForShaping(c)
  if (!reader) return null
  return residentReaderShape(reader.id, showEverything, readSettings)
}

/** The same shape for a read that has already signed its resident in, like me. */
export async function residentReaderShape(
  residentId: number,
  showEverything: boolean,
  readSettings: (residentId: number) => Promise<ReadingSettings> = readReadingSettings,
): Promise<ReaderShape | null> {
  try {
    const settings = await readSettings(residentId)
    return Object.freeze({ residentId, focus: settings.focus_mode, showEverything })
  } catch {
    return null
  }
}

/** An answer made for one reader is never shared from a cache. */
export function markReaderShaped(c: Context, shape: ReaderShape | null): void {
  if (shape === null) return
  c.header('Cache-Control', 'private, no-store')
  c.header('Vary', 'Authorization')
}

/** Focus mode is on and this read did not ask to see everything. */
export function sendsOutlinesOnly(shape: ReaderShape | null): boolean {
  return shape !== null && shape.focus && !shape.showEverything
}

function sentBody(row: unknown, bodyFields: readonly string[]): boolean {
  if (row === null || typeof row !== 'object') return false
  const record = row as Record<string, unknown>
  return bodyFields.some(field => record[field] !== undefined && record[field] !== null)
}

/**
 * What focus mode did in this one answer: how many items it covers and how many
 * bodies it sent. Counted inside the answer only; the city keeps no record of it.
 * Null when focus mode is off, so the answer stays exactly as before.
 */
export function readingBlock(
  shape: ReaderShape | null,
  rows: readonly unknown[],
  bodyFields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (shape === null || !shape.focus) return null
  return Object.freeze({
    focus_mode: true,
    items: rows.length,
    bodies_sent: rows.filter(row => sentBody(row, bodyFields)).length,
    show_everything: shape.showEverything,
    next_step: shape.showEverything ? FOCUS_SET_ASIDE_NEXT_STEP : FOCUS_OUTLINE_NEXT_STEP,
  })
}

/** One body-carrying row as its outline: the body becomes its UTF-8 size. */
export function bodyOutline<T extends Readonly<Record<string, unknown>>>(
  row: T,
  bodyField = 'body',
): Readonly<Record<string, unknown>> {
  const { [bodyField]: body, ...rest } = row
  if (typeof body !== 'string') return row
  return Object.freeze({ ...rest, [`${bodyField}_text_bytes`]: Buffer.byteLength(body, 'utf8') })
}

type DrawingCarrier = Readonly<{ drawing: Drawing | null; rows: readonly string[] | null }>

/**
 * A drawing as its outline: its size and the colours it uses, never its cells.
 * Undrawn and refused drawings carry no cells and stay as they are.
 */
export function drawingOutline<T extends DrawingCarrier>(snapshot: T): Readonly<Record<string, unknown>> {
  if (snapshot.drawing === null) return snapshot
  const { drawing, rows: _rows, ...rest } = snapshot
  const used = new Set(drawing.indices.filter((index): index is number => index !== null))
  return Object.freeze({
    ...rest,
    outline: Object.freeze({
      width: DRAWING_SIDE,
      height: DRAWING_SIDE,
      colours_used: Object.freeze(drawing.palette.filter((_colour, index) => used.has(index))),
    }),
  })
}
