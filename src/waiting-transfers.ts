// Waiting transfers, the held gifts of decision #158. When a resident has muted a giver
// (decision #156) and has not let that giver's gifts through, a give of a thing, kind or
// place to it, or a transfer effect in the giver's use or timer, is held: one private row
// is written instead of the move. Nothing moves, no transfer event is written, no law
// runs, and nothing is locked; the asset stays the giver's until the recipient accepts.
// The giver is told in plain words that it waits; the recipient sees only a count and a
// list inside its own settings, with no notice. Accepting makes the ordinary give then,
// with every rule checked again (src/society.ts); declining ends it. Credit gifts are
// never held (#48). The table is private, never public and never in a snapshot. The
// served names avoid the word the app door's me must not carry (#142): waiting_transfers
// and waiting_id. This module imports no engine code, so the engine can call it.
import { isFounderResident } from './founders.ts'

export const WAITING_ASSET_TYPES = Object.freeze(['thing', 'kind', 'place'] as const)
export type WaitingAssetType = typeof WAITING_ASSET_TYPES[number]

/** How many open waiting transfers a settings answer lists, oldest first. */
export const WAITING_TRANSFERS_LISTED = 50

/** What the giver is told when its gift waits (owner's choice 3, 2026-10-15). */
export function heldUntilAccepted(recipientHandle: string): string {
  return `Held until ${recipientHandle} accepts; it stays yours meanwhile.`
}

/** The giver's private line when a held place holds the giver's home (#92, #158). */
export const WAITING_HOME_LINE = 'If accepted, your home will be cleared then.'

export const WAITING_ID_REFUSAL =
  'waiting_id must be a positive whole number from waiting_transfers in your settings; read them with me and settings "show", or GET /api/me/settings if your client can open URLs'

export function waitingNotFound(waitingId: number): string {
  return `waiting_id ${waitingId} is not waiting for you; read waiting_transfers with me and settings "show", or GET /api/me/settings if your client can open URLs, and send a current waiting_id`
}

export function waitingAlreadyAnswered(waitingId: number, answer: string): string {
  return `waiting_id ${waitingId} was already ${answer}; nothing changed`
}

export function waitingAcceptFailed(waitingId: number, reason: string): string {
  return `waiting_id ${waitingId} could not be accepted, so it has ended and nothing moved: ${reason}`
}

const WAITING_TRANSFERS_ABOUT =
  'Things, kinds and places a resident you muted gave you wait here until you answer. Accept one with transfer, action accept and its waiting_id: it moves to you then, with every rule checked again, and if one no longer holds it ends and nothing moves. Decline one with action decline: it stays theirs. Nothing moves meanwhile, and the resident who gave it was told only that it waits for your yes. A mute of that resident with let_transfers_through: true lets its next ones move at once.'

type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

async function rows(promise: Promise<unknown>): Promise<Record<string, unknown>[]> {
  const value = await promise
  return Array.isArray(value) ? value as Record<string, unknown>[] : []
}

function stamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * True when the recipient muted the giver and has not let that giver's gifts through.
 * A gift from either founder account is never held (#159): neither can be muted.
 */
export async function giftsWaitFor(recipientId: number, giverId: number, db: Query): Promise<boolean> {
  if (isFounderResident(giverId)) return false
  const found = await rows(db`/* private:waiting-transfers-held */
    SELECT 1 AS held FROM resident_mutes
    WHERE resident_id = ${recipientId} AND target_type = 'resident' AND target_id = ${giverId}
      AND choice = 'mute' AND NOT let_gifts_through
  `)
  return found.length > 0
}

/** True when the giver's home is this place or a place inside it. */
export async function giverHomeInside(giverId: number, placeId: number, db: Query): Promise<boolean> {
  const found = await rows(db`/* private:waiting-transfers-home */
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM places WHERE id = ${placeId}
      UNION
      SELECT child.id FROM places child JOIN tree ON child.parent_id = tree.id
    )
    SELECT 1 AS inside FROM resident_presence
    WHERE resident_id = ${giverId} AND home_place_id IN (SELECT id FROM tree)
  `)
  return found.length > 0
}

/** What the giver's answer says about one held transfer. */
export type WaitingNote = Readonly<{
  waiting_id: number
  type: WaitingAssetType
  asset_id: number
  to: string
  note: string
  /** Only for a place that holds the giver's home: the giver's own private line. */
  home?: string
}>

/**
 * Write one waiting row, or find the open one for the same giver, recipient and asset,
 * and say what the giver is told. Nothing moves and no event is written.
 */
export async function holdTransfer(
  input: Readonly<{ giverId: number; recipientId: number; type: WaitingAssetType; assetId: number }>,
  db: Query,
): Promise<WaitingNote> {
  const held = await rows(db`/* private:waiting-transfers-hold */
    WITH written AS (
      INSERT INTO waiting_transfers (giver_id, recipient_id, asset_type, asset_id)
      VALUES (${input.giverId}, ${input.recipientId}, ${input.type}, ${input.assetId})
      ON CONFLICT (giver_id, recipient_id, asset_type, asset_id) WHERE answer IS NULL DO NOTHING
      RETURNING id
    )
    SELECT coalesce(
      (SELECT id FROM written),
      (SELECT id FROM waiting_transfers
        WHERE giver_id = ${input.giverId} AND recipient_id = ${input.recipientId}
          AND asset_type = ${input.type} AND asset_id = ${input.assetId} AND answer IS NULL)
    ) AS id,
    (SELECT handle FROM residents WHERE id = ${input.recipientId}) AS handle
  `)
  const row = held[0]
  const handle = typeof row?.handle === 'string' ? row.handle : String(input.recipientId)
  const homeClears = input.type === 'place' && await giverHomeInside(input.giverId, input.assetId, db)
  return Object.freeze({
    waiting_id: Number(row?.id),
    type: input.type,
    asset_id: input.assetId,
    to: handle,
    note: heldUntilAccepted(handle),
    ...(homeClears ? { home: WAITING_HOME_LINE } : {}),
  })
}

/** The giver's answer fields for held transfers: the list, and any home line as attention. */
export function waitingAnswer(notes: readonly WaitingNote[]): Readonly<Record<string, unknown>> {
  if (notes.length === 0) return Object.freeze({})
  const attention = notes.some(note => note.home !== undefined) ? [WAITING_HOME_LINE] : []
  return Object.freeze({
    waiting_transfers: notes.map(({ home: _home, ...note }) => note),
    ...(attention.length === 0 ? {} : { attention }),
  })
}

export type OpenWaiting = Readonly<{
  id: number
  giverId: number
  giverHandle: string
  recipientId: number
  type: WaitingAssetType
  assetId: number
  answer: string | null
}>

/** One waiting row of this recipient, open or answered, or null when it is not its own. */
export async function readWaiting(waitingId: number, recipientId: number, db: Query): Promise<OpenWaiting | null> {
  const found = await rows(db`/* private:waiting-transfers-read */
    SELECT waiting.id, waiting.giver_id, giver.handle AS giver_handle, waiting.recipient_id,
      waiting.asset_type, waiting.asset_id, waiting.answer
    FROM waiting_transfers waiting
    JOIN residents giver ON giver.id = waiting.giver_id
    WHERE waiting.id = ${waitingId} AND waiting.recipient_id = ${recipientId}
  `)
  const row = found[0]
  if (row === undefined) return null
  return Object.freeze({
    id: Number(row.id),
    giverId: Number(row.giver_id),
    giverHandle: String(row.giver_handle),
    recipientId: Number(row.recipient_id),
    type: String(row.asset_type) as WaitingAssetType,
    assetId: Number(row.asset_id),
    answer: row.answer == null ? null : String(row.answer),
  })
}

/** End one open waiting row; false when it was already answered. */
export async function answerWaiting(
  waitingId: number,
  answer: 'accepted' | 'declined' | 'failed',
  detail: string,
  db: Query,
): Promise<boolean> {
  const ended = await rows(db`/* private:waiting-transfers-answer */
    UPDATE waiting_transfers
    SET answer = ${answer}, answer_detail = ${detail}, answered_at = now()
    WHERE id = ${waitingId} AND answer IS NULL
    RETURNING id
  `)
  return ended.length > 0
}

/** The recipient's open waiting transfers for its settings answer: a count and the oldest. */
export async function listWaitingTransfers(recipientId: number, db: Query): Promise<Readonly<Record<string, unknown>>> {
  const found = await rows(db`/* private:waiting-transfers-list */
    SELECT waiting.id, waiting.asset_type, waiting.asset_id, giver.handle AS giver_handle,
      waiting.created_at, count(*) OVER () AS total
    FROM waiting_transfers waiting
    JOIN residents giver ON giver.id = waiting.giver_id
    WHERE waiting.recipient_id = ${recipientId} AND waiting.answer IS NULL
    ORDER BY waiting.id
    LIMIT ${WAITING_TRANSFERS_LISTED}
  `)
  return Object.freeze({
    count: found.length === 0 ? 0 : Number(found[0]!.total),
    oldest: found.map(row => Object.freeze({
      waiting_id: Number(row.id),
      type: String(row.asset_type),
      asset_id: Number(row.asset_id),
      from: String(row.giver_handle),
      held_at: stamp(row.created_at),
    })),
    about: WAITING_TRANSFERS_ABOUT,
  })
}
