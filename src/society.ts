import type { Context } from 'hono'
import type { Hono } from 'hono'
import { auth, err, HANDLE_RE, postgresErrorCode, QUOTAS, RESIDENT_AUTH_REFUSAL, WALLET_RE } from './core.ts'
import { sql } from './db.ts'
import {
  createAgreementAction,
  openAgreementAccessionAction,
  signAgreementAction,
} from './agreement-action.ts'
import { positiveId, publicText, usdcAmount, containsBearerSecret, SECRET_REJECTION } from './input.ts'
import {
  challenge402,
  CLAIM_WINDOW_SECONDS,
  paymentReadinessResponse,
  requirements,
} from './pay.ts'
import {
  findPaymentAttempt,
  findReplayableTargetPaymentAttempt,
  PaymentAttemptConflictError,
} from './payment-attempts.ts'
import {
  completedPaymentResponse,
  paymentJsonResponse,
  resumeDurableX402,
  runDurableX402,
} from './payment-flow.ts'
import {
  closeInvalidSalePaymentTarget,
  closeSalePaymentTarget,
  completeDirectSalePayment,
  PaymentSaleConflictError,
} from './payment-sale-operations.ts'
import { EngineError, residentPresence, resolveDueEffects, runAction } from './engine.ts'
import {
  GAZETTE_ROOM_ID,
  GAZETTE_SUBMISSIONS_CLOSED_ERROR,
} from './gazette.ts'
import { moderatePublicRows } from './moderation-store.ts'
import {
  findRecentTalkNoteReplay,
  runTalkNoteAction,
} from './note-action.ts'
import { placePermission, withPlacePermission } from './place-permission.ts'
import { WORLD_TRANSIT_ONLY_ERROR } from './world-root.ts'
import {
  allowedPublicQuery,
  extractPublicCollectionRows,
  finalizePublicPage,
  parsePublicPage,
  singlePublicQueryValue,
  utf8TextBytes,
} from './public-pagination.ts'
import { publicJson } from './public-output.ts'
import { loadPublicNoteRecord } from './public-records.ts'
import { safeReadingCostMeter } from './reading-cost.ts'
import { executeBudgetedExactQuery } from './public-exact-query.ts'

const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
const NOTE_CHARACTERS = 4_000
const AGREEMENT_BYTES = 65_536
const MAX_PARTIES = 32
const AGREEMENT_ID_REFUSAL = 'agreement id was rejected because it must be a positive whole number; retry with the agreement id from GET /api/agreements'
const OFFER_ID_REFUSAL = 'offer id was rejected because it must be a positive whole number; retry with the offer id returned by the transfer offer'
const PARTY_HANDLE_REFUSAL = 'party was rejected because it must be a resident handle; retry with a handle from GET /api/census'

const ASSETS = {
  place: { table: 'places', transferable: '' },
  thing: { table: 'things', transferable: ' AND withdrawn_at IS NULL' },
  kind: { table: 'kinds', transferable: '' },
} as const

type AssetType = keyof typeof ASSETS
type JsonObject = Record<string, unknown>

interface OwnerRow {
  id: number
  owner_id: number | null
  active_offer_id?: number | null
}

interface OfferRow {
  id: number
  asset_type?: AssetType
  type?: AssetType
  asset_id: number
  owner_id?: number
  seller_id: number
  seller: string
  buyer_id: number
  buyer: string
  price_usdc: number
  seller_wallet: string
  status: string
  reserved_by?: number | null
  buyer_wallet?: string | null
  reserved_at?: string | null
  reserved_until: string | null
  created_at: string
}

function assetType(value: unknown): AssetType | null {
  return typeof value === 'string' && Object.hasOwn(ASSETS, value)
    ? value as AssetType
    : null
}

async function jsonObject(c: Context): Promise<JsonObject | null> {
  const value = await c.req.json().catch(() => null) as unknown
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function hasOnly(value: JsonObject, names: readonly string[]): boolean {
  return Object.keys(value).every(name => names.includes(name))
}

function partyHandles(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTIES) return null
  if (value.some(handle => typeof handle !== 'string' || !HANDLE_RE.test(handle))) return null
  const unique = [...new Set(value as string[])]
  return unique.length === value.length ? unique : null
}

async function ownerOf(type: AssetType, id: number): Promise<OwnerRow | null> {
  const { table, transferable } = ASSETS[type]
  const rows = await sql.query(
    `SELECT id, owner_id, active_offer_id FROM ${table} WHERE id = $1${transferable}`,
    [id],
  ) as OwnerRow[]
  return rows[0] ?? null
}

async function openOffer(type: AssetType, id: number): Promise<{ id: number } | null> {
  const rows = await sql`
    SELECT id FROM transfer_offers
    WHERE asset_type = ${type} AND asset_id = ${id} AND status = 'open'
    LIMIT 1
  ` as { id: number }[]
  return rows[0] ?? null
}

async function residentId(handle: string): Promise<number | null> {
  const rows = await sql`SELECT id, handle FROM residents WHERE handle = ${handle}` as {
    id: number
    handle: string
  }[]
  return rows.find(row => row.handle === handle)?.id ?? null
}

async function readOffer(id: number): Promise<OfferRow | null> {
  const rows = await sql`
    SELECT o.id, o.asset_type, o.asset_id, o.seller_id, seller.handle AS seller,
      o.buyer_id, buyer.handle AS buyer, o.price_usdc::float8 AS price_usdc,
      o.seller_wallet, o.status, o.reserved_by, o.buyer_wallet,
      o.reserved_at, o.reserved_until, o.created_at
    FROM transfer_offers o
    JOIN residents seller ON seller.id = o.seller_id
    JOIN residents buyer ON buyer.id = o.buyer_id
    WHERE o.id = ${id} AND o.channel = 'direct'
  ` as OfferRow[]
  const row = rows[0]
  if (!row) return null
  const resolvedType = row.asset_type ?? row.type
  return resolvedType ? { ...row, asset_type: resolvedType } : row
}

function x402HeaderPayer(header: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      payload?: { authorization?: { from?: unknown } }
    }
    const payer = payload.payload?.authorization?.from
    return typeof payer === 'string' && WALLET_RE.test(payer) ? payer.toLowerCase() : null
  } catch {
    return null
  }
}

function agreementState(row: Record<string, unknown>) {
  const parties = Array.isArray(row.parties) ? row.parties : []
  const acceded = Array.isArray(row.acceded) ? row.acceded : []
  const signatures = Array.isArray(row.signatures) ? row.signatures : []
  return {
    ...row,
    parties,
    acceded,
    signatures,
    open: typeof row.open === 'boolean' ? row.open : signatures.length < parties.length,
    accession_open: row.accession_open === true,
  }
}

export function mountSocietyRoutes(app: Hono): void {
  app.get('/api/note/:id', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'note id must be a positive integer')
    const note = await loadPublicNoteRecord(id)
    if (!note) return err(c, 404, `note_id ${id} was not found; re-read the place's recent notes and use a current note_id`)
    return publicJson(c, { note })
  })

  app.post('/api/note', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['place_id', 'body']))
      return err(c, 400, 'need place_id and body')
    const placeId = positiveId(body.place_id)
    if (containsBearerSecret(body.body)) return err(c, 400, SECRET_REJECTION)
    const text = publicText(body.body, {
      maximumCharacters: NOTE_CHARACTERS,
      allowWhitespaceOnly: true,
    })
    if (!placeId) return err(c, 400, 'place_id must be a positive integer')
    if (text == null) return err(c, 400, 'body must be 1-4000 safe characters')

    const replay = await findRecentTalkNoteReplay({
      placeId,
      residentId: resident.id,
      residentHandle: resident.handle,
      text,
    })
    if (replay) {
      const duplicate = replay.note
      return c.json({
        note: {
          id: duplicate.id,
          place_id: duplicate.place_id ?? placeId,
          author: duplicate.author ?? resident.handle,
          body: duplicate.body ?? text,
          ...(duplicate.created_at ? { created_at: duplicate.created_at } : {}),
        },
        ...(replay.gazetteWithdrawal
          ? { gazette_withdrawal: replay.gazetteWithdrawal }
          : {}),
        reading_cost: await safeReadingCostMeter(placeId, duplicate.body ?? text),
      }, 200)
    }

    const places = await withPlacePermission(sql)`
      SELECT id, parent_id, owner_id, retired_at, open_to_notes,
        ${placePermission('place', 'open_to_notes', resident.id)} AS place_permits_notes,
        CASE
          WHEN place.id <> ${GAZETTE_ROOM_ID} THEN TRUE
          ELSE gazette_submission_room_is_open()
        END AS gazette_submissions_open
      FROM places place WHERE id = ${placeId}
    ` as {
      id: number
      parent_id: number | null
      owner_id: number | null
      open_to_notes: boolean
      place_permits_notes: boolean
      gazette_submissions_open: boolean
      retired_at: string | null
    }[]
    const place = places[0]
    if (!place) return err(c, 404, `place_id ${placeId} was not found; use GET /api/map?view=outline and send a current place_id`)
    if (place.retired_at != null) return err(c, 409, 'place is retired; restore it before leaving notes there')
    if (place.parent_id === null && place.owner_id === null) {
      return err(c, 403, WORLD_TRANSIT_ONLY_ERROR)
    }
    if (placeId === GAZETTE_ROOM_ID && place.gazette_submissions_open !== true) {
      return err(c, 409, GAZETTE_SUBMISSIONS_CLOSED_ERROR)
    }
    if (place.place_permits_notes !== true)
      return err(c, 403, 'this place is not open to notes; its owner can enable open_to_notes, or you can write in another open place')
    await resolveDueEffects(placeId)
    if (resident.notes_today >= QUOTAS.notes)
      return err(c, 429, `${QUOTAS.notes} notes per UTC day; retry after the next UTC day begins`)
    const talk = await runTalkNoteAction({
      placeId,
      residentId: resident.id,
      residentHandle: resident.handle,
      text,
    })
    if (!talk.ok) return err(c, talk.status, talk.error)
    const { note } = talk
    return c.json({
      note: {
        id: note.id,
        place_id: note.place_id ?? placeId,
        author: note.author ?? resident.handle,
        body: note.body ?? text,
        ...(note.created_at ? { created_at: note.created_at } : {}),
      },
      ...(talk.gazetteWithdrawal ? { gazette_withdrawal: talk.gazetteWithdrawal } : {}),
      reading_cost: await safeReadingCostMeter(placeId, note.body ?? text),
    }, talk.replayed ? 200 : 201)
  })

  app.post('/api/agreement', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['parties', 'body', 'accession_open']))
      return err(c, 400, 'need parties and body')
    const parties = partyHandles(body.parties)
    const accessionOpen = body.accession_open === undefined ? false : body.accession_open
    if (containsBearerSecret(body.body)) return err(c, 400, SECRET_REJECTION)
    const text = publicText(body.body, { maximumBytes: AGREEMENT_BYTES })
    if (typeof accessionOpen !== 'boolean') return err(c, 400, 'accession_open must be true or false')
    if (!parties || text == null)
      return err(c, 400, `parties: 1-${MAX_PARTIES} unique resident handles; body: 1 byte-64 KB`)

    const result = await createAgreementAction({ resident, parties, text, accessionOpen })
    if (!result.ok) return err(c, result.status, result.error)
    return c.json({ agreement: result.agreement }, 201)
  })

  app.post('/api/agreement/:id/open-accession', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, AGREEMENT_ID_REFUSAL)

    const result = await openAgreementAccessionAction({ resident, agreementId: id })
    if (!result.ok) return err(c, result.status, result.error)
    if (result.created) return c.json({ agreement: result.agreement }, 201)
    return c.json({ agreement: result.agreement })
  })

  app.post('/api/agreement/:id/sign', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, AGREEMENT_ID_REFUSAL)

    const result = await signAgreementAction({ resident, agreementId: id })
    if (!result.ok) return err(c, result.status, result.error)
    return c.json({ signature: result.signature })
  })

  app.get('/api/agreements', async c => {
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['party', 'open', 'before_id', 'limit'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const parsed = parsePublicPage(queries, 'before_id', 'limit')
    if (!parsed.ok) return err(c, 400, parsed.error)
    const partyValue = singlePublicQueryValue(queries, 'party')
    if (!partyValue.ok) return err(c, 400, partyValue.error)
    const openQueryValue = singlePublicQueryValue(queries, 'open')
    if (!openQueryValue.ok) return err(c, 400, openQueryValue.error)
    const party = partyValue.value
    const openValue = openQueryValue.value
    if (party != null && !HANDLE_RE.test(party)) return err(c, 400, PARTY_HANDLE_REFUSAL)
    if (openValue != null && openValue !== 'true' && openValue !== 'false')
      return err(c, 400, 'open must be true or false')
    const open = openValue == null ? null : openValue === 'true'
    const rows = await executeBudgetedExactQuery(`
      /* public:agreements */
      WITH totals AS (
        SELECT count(*)::integer AS total_items,
          coalesce(sum(octet_length(agreement.body)), 0)::bigint AS total_text_bytes
        FROM agreements agreement
        WHERE ($1::text IS NULL OR EXISTS (
          SELECT 1
          FROM agreement_parties party
          JOIN residents resident ON resident.id = party.resident_id
          WHERE party.agreement_id = agreement.id AND resident.handle = $1::text
        ))
          AND ($2::boolean IS NULL OR EXISTS (
            SELECT 1 FROM agreement_parties party
            WHERE party.agreement_id = agreement.id
              AND NOT EXISTS (
                SELECT 1 FROM agreement_signatures signature
                WHERE signature.agreement_id = agreement.id
                  AND signature.resident_id = party.resident_id
              )
          ) = $2::boolean)
      ), public_agreements AS (
        SELECT a.id, a.body, creator.handle AS created_by,
          EXISTS(SELECT 1 FROM agreement_accession_openings opening
            WHERE opening.agreement_id = a.id) AS accession_open,
          ARRAY(SELECT r.handle FROM agreement_parties ap JOIN residents r ON r.id = ap.resident_id
            WHERE ap.agreement_id = a.id ORDER BY r.handle) AS parties,
          ARRAY(SELECT r.handle FROM agreement_parties ap JOIN residents r ON r.id = ap.resident_id
            WHERE ap.agreement_id = a.id AND NOT ap.named ORDER BY r.handle) AS acceded,
          ARRAY(SELECT r.handle FROM agreement_signatures s JOIN residents r ON r.id = s.resident_id
            WHERE s.agreement_id = a.id ORDER BY s.signed_at, r.handle) AS signatures,
          NOT EXISTS (
            SELECT 1 FROM agreement_parties ap WHERE ap.agreement_id = a.id
              AND NOT EXISTS (SELECT 1 FROM agreement_signatures s
                WHERE s.agreement_id = a.id AND s.resident_id = ap.resident_id)
          ) AS complete,
          a.created_at
        FROM agreements a JOIN residents creator ON creator.id = a.created_by_id
      )
      SELECT page.id, page.body, page.created_by, page.parties, page.acceded,
        page.signatures, page.accession_open, page.open, page.created_at,
        totals.total_items, totals.total_text_bytes
      FROM totals
      LEFT JOIN LATERAL (
        SELECT id, body, created_by, parties, acceded, signatures, accession_open,
          NOT complete AS open, created_at
        FROM public_agreements
        WHERE ($1::text IS NULL OR $1::text = ANY(parties))
          AND ($2::boolean IS NULL OR (NOT complete) = $2::boolean)
          AND ($3::integer IS NULL OR id < $3::integer)
        ORDER BY id DESC LIMIT $4::integer
      ) page ON TRUE
      ORDER BY page.id DESC NULLS LAST
    `, [party ?? null, open, parsed.cursor, parsed.fetchLimit])
    const collection = extractPublicCollectionRows(rows)
    const page = finalizePublicPage(
      collection.rows as Array<Record<string, unknown> & { id: number }>, parsed.limit,
    )
    const agreements = page.items.map(agreementState)
    return publicJson(c, {
      agreements: await moderatePublicRows('agreement', agreements),
      total_items: collection.total.items,
      total_text_bytes: collection.total.textBytes,
      returned_items: agreements.length,
      returned_text_bytes: utf8TextBytes(agreements, 'body'),
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    })
  })

  app.post('/api/transfer', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['type', 'id', 'to_handle']))
      return err(c, 400, 'need type, id, and to_handle')
    const type = assetType(body.type)
    const id = positiveId(body.id)
    const toHandle = typeof body.to_handle === 'string' && HANDLE_RE.test(body.to_handle)
      ? body.to_handle
      : null
    if (!type || !id || !toHandle) return err(c, 400, 'type must be place, thing, or kind; need id and to_handle')

    const asset = await ownerOf(type, id)
    if (!asset) return err(c, 404, `${type}_id ${id} was not found; re-read the public ${type} record and send a current id`)
    if (type === 'place' && asset.owner_id === null) return err(c, 403, WORLD_TRANSIT_ONLY_ERROR)
    if (asset.owner_id !== resident.id) return err(c, 403, `only the ${type} owner may transfer it`)
    if (asset.active_offer_id != null || await openOffer(type, id))
      return err(c, 409, 'this asset already has an open transfer offer; cancel or finish that offer before transferring the asset')
    const recipient = await residentId(toHandle)
    if (!recipient) return err(c, 404, `recipient handle ${toHandle} was not found; use GET /api/residents and send a current handle`)
    if (recipient === resident.id) return err(c, 400, 'you already own this asset; send a different current resident in to_handle')
    const presence = await residentPresence(resident.id)
    if (presence.currentPlaceId !== null) await resolveDueEffects(presence.currentPlaceId)
    const { table, transferable } = ASSETS[type]
    let transfer: { id: number; created_at?: string } | undefined
    const actionGate = await runAction({
      actorId: resident.id,
      actorHandle: resident.handle,
      action: 'give',
      sourceThingId: type === 'thing' ? id : null,
      target: { type, id },
      recipientId: recipient,
      payload: { mode: 'gift' },
      primitiveHandledByCaller: true,
      primitiveEmitsTypedEvent: true,
      performPrimitive: async transaction => {
        if (!transaction.query) throw new EngineError(500, 'transaction query support is unavailable; contact the city operator to restore transaction support before retrying')
        const rows = await transaction.query(`
          WITH recipient AS (
            SELECT r.id, r.handle FROM residents r WHERE r.id = $3
          ), moved_asset AS (
            UPDATE ${table} SET owner_id = recipient.id
            FROM recipient
            WHERE ${table}.id = $2 AND ${table}.owner_id = $4
              AND ${table}.active_offer_id IS NULL${transferable}
            RETURNING ${table}.id
          ), new_transfer AS (
            INSERT INTO transfers (asset_type, asset_id, from_id, to_id)
            SELECT $1, id, $4, $3 FROM moved_asset
            RETURNING id, created_at
          ), new_event AS (
            INSERT INTO events (kind, actor, detail)
            SELECT 'transfer', $5, jsonb_build_object(
              'transfer_id', t.id, 'asset_type', $1::text, 'asset_id', $2::integer,
              'from', $5::text, 'to', $6::text, 'mode', 'gift',
              'resident_id', $3::integer, 'place_id', actor_presence.current_place_id
            ) FROM new_transfer t
            JOIN resident_presence actor_presence ON actor_presence.resident_id = $4
          )
          SELECT id, created_at FROM new_transfer
        `, [type, id, recipient, resident.id, resident.handle, toHandle]) as {
          id: number
          created_at?: string
        }[]
        transfer = rows[0]
        if (!transfer) throw new EngineError(409, 'ownership or offer state changed; re-read the asset')
      },
    })
    if (actionGate.error) {
      return err(c, actionGate.httpStatus as 400 | 403 | 404 | 409 | 500, actionGate.error)
    }
    if (!transfer) return err(c, 500, 'transfer result is unavailable after the city write; re-read the asset owner before deciding whether to retry')
    return c.json({ transfer: {
      id: transfer.id,
      type,
      asset_id: id,
      from: resident.handle,
      to: toHandle,
      mode: 'gift',
      ...(transfer.created_at ? { created_at: transfer.created_at } : {}),
    } })
  })

  app.post('/api/transfer/offer', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['type', 'id', 'to_handle', 'price_usdc', 'seller_wallet']))
      return err(c, 400, 'need type, id, to_handle, price_usdc, and seller_wallet')
    const type = assetType(body.type)
    const id = positiveId(body.id)
    const toHandle = typeof body.to_handle === 'string' && HANDLE_RE.test(body.to_handle)
      ? body.to_handle
      : null
    const price = usdcAmount(body.price_usdc)
    const wallet = typeof body.seller_wallet === 'string' && WALLET_RE.test(body.seller_wallet)
      ? body.seller_wallet.toLowerCase()
      : null
    if (!type || !id || !toHandle || price == null || !wallet)
      return err(c, 400, 'invalid offer; type is place|thing|kind, price is greater than 0 and at most 10000 USDC and is rounded to 6 decimals, wallet is a Base address')

    const asset = await ownerOf(type, id)
    if (!asset) return err(c, 404, `${type}_id ${id} was not found; re-read the public ${type} record and send a current id`)
    if (type === 'place' && asset.owner_id === null) return err(c, 403, WORLD_TRANSIT_ONLY_ERROR)
    if (asset.owner_id !== resident.id) return err(c, 403, `only the ${type} owner may offer it`)
    if (asset.active_offer_id != null || await openOffer(type, id))
      return err(c, 409, 'this asset already has an open transfer offer; cancel or finish that offer before transferring the asset')
    const buyerId = await residentId(toHandle)
    if (!buyerId) return err(c, 404, `buyer handle ${toHandle} was not found; use GET /api/residents and send a current handle`)
    if (buyerId === resident.id) return err(c, 400, 'you cannot sell an asset to yourself; choose another current resident in to_handle')
    const presence = await residentPresence(resident.id)
    if (presence.currentPlaceId !== null) await resolveDueEffects(presence.currentPlaceId)
    const { table, transferable } = ASSETS[type]
    let offer: Record<string, unknown> | undefined
    const actionGate = await runAction({
      actorId: resident.id,
      actorHandle: resident.handle,
      action: 'give',
      sourceThingId: type === 'thing' ? id : null,
      target: { type, id },
      recipientId: buyerId,
      payload: { mode: 'offer' },
      primitiveHandledByCaller: true,
      primitiveEmitsTypedEvent: true,
      performPrimitive: async transaction => {
        if (!transaction.query) throw new EngineError(500, 'transaction query support is unavailable; contact the city operator to restore transaction support before retrying')
        try {
          const rows = await transaction.query(`
            WITH next_offer AS MATERIALIZED (
              SELECT nextval(pg_get_serial_sequence('transfer_offers', 'id'))::int AS id
            ), locked_asset AS (
              UPDATE ${table} SET active_offer_id = next_offer.id
              FROM next_offer
              WHERE ${table}.id = $1 AND ${table}.owner_id = $2
                AND ${table}.active_offer_id IS NULL${transferable}
              RETURNING ${table}.id, ${table}.active_offer_id
            ), new_offer AS (
              INSERT INTO transfer_offers (
                id, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet, status
              )
              SELECT a.active_offer_id, $3, a.id, $2, $4, $5, $6, 'open' FROM locked_asset a
              RETURNING id, asset_type AS type, asset_id, price_usdc::float8 AS price_usdc,
                seller_wallet, status, reserved_until, created_at
            ), new_event AS (
              INSERT INTO events (kind, actor, detail)
              SELECT 'transfer_offer', $7, jsonb_build_object(
                'offer_id', id, 'asset_type', type, 'asset_id', asset_id,
                'buyer', $8::text, 'price_usdc', price_usdc
              ) FROM new_offer
            )
            SELECT o.*, $7::text AS seller, $8::text AS buyer
            FROM new_offer o
          `, [id, resident.id, type, buyerId, price, wallet, resident.handle, toHandle]) as Record<string, unknown>[]
          offer = rows[0]
          if (!offer) throw new EngineError(409, 'ownership or offer state changed; re-read the asset')
        } catch (error) {
          if (error instanceof EngineError) throw error
          if (postgresErrorCode(error) === '23505') {
            throw new EngineError(409, 'this asset already has an open transfer offer; cancel or finish that offer before transferring the asset')
          }
          throw error
        }
      },
    })
    if (actionGate.error) {
      return err(c, actionGate.httpStatus as 400 | 403 | 404 | 409 | 500, actionGate.error)
    }
    if (!offer) return err(c, 500, 'transfer offer result is unavailable after the city write; re-read the asset lock and recipient before deciding whether to retry')
    return c.json({ offer: {
      ...offer,
      type: offer.type ?? type,
      asset_id: offer.asset_id ?? id,
      seller: offer.seller ?? resident.handle,
      buyer: offer.buyer ?? toHandle,
      price_usdc: offer.price_usdc ?? price,
      seller_wallet: offer.seller_wallet ?? wallet,
      status: offer.status ?? 'open',
      reserved_until: offer.reserved_until ?? null,
    } }, 201)
  })

  app.post('/api/transfer/:offerId/claim', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const unavailable = paymentReadinessResponse(c)
    if (unavailable) return unavailable
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, OFFER_ID_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['buyer_wallet']))
      return err(c, 400, 'body may contain buyer_wallet only; paid claims use X-PAYMENT')
    const requestedWallet = body.buyer_wallet == null
      ? null
      : typeof body.buyer_wallet === 'string' && WALLET_RE.test(body.buyer_wallet)
        ? body.buyer_wallet.toLowerCase()
        : undefined
    if (requestedWallet === undefined)
      return err(c, 400, 'buyer_wallet must be a Base address')

    const offer = await readOffer(offerId)
    if (!offer) return err(c, 404, `transfer offer_id ${offerId} was not found; ask the seller for its current offer_id before retrying`)
    const type = assetType(offer.asset_type)
    if (!type) return err(c, 409, 'offer refers to an unsupported asset type; choose another offer and ask the city owner to inspect this record')
    if (offer.status !== 'open') {
      if (offer.status === 'claimed' && offer.buyer_id === resident.id) {
        const settledBuyerWallet = typeof offer.buyer_wallet === 'string'
          && WALLET_RE.test(offer.buyer_wallet)
          ? offer.buyer_wallet.toLowerCase()
          : null
        if (settledBuyerWallet == null || requestedWallet !== settledBuyerWallet) {
          return err(c, 409, 'buyer_wallet does not match the settled payment; re-read the offer and resend its settled buyer wallet')
        }
        try {
          const completedAttempt = await findReplayableTargetPaymentAttempt({ query: sql.query }, {
            actorId: resident.id,
            counterpartyId: offer.seller_id,
            operation: 'direct_sale',
            targetKey: `direct-sale:${offerId}`,
            offerId,
            assetType: type,
            assetId: offer.asset_id,
            request: {
              offer_id: offerId,
              buyer_wallet: requestedWallet,
              seller_wallet: offer.seller_wallet,
              price_usdc: Number(offer.price_usdc),
              asset_type: type,
              asset_id: offer.asset_id,
            },
          })
          if (completedAttempt?.status === 'completed') {
            const replay = await resumeDurableX402({
              database: { query: sql.query },
              attempt: completedAttempt,
              actorId: resident.id,
            })
            if (replay.state === 'completed') return completedPaymentResponse(replay)
          }
        } catch (error) {
          if (error instanceof PaymentAttemptConflictError) return err(c, 409, error.message)
          throw error
        }
      }
      return err(c, 409, `offer is ${offer.status}; choose an open offer or ask its seller to create a new one`)
    }
    if (offer.buyer_id !== resident.id) return err(c, 403, 'only the named buyer may claim this offer')
    const owner = await ownerOf(type, offer.asset_id)
    if (!owner || owner.owner_id !== offer.seller_id)
      return err(c, 409, 'seller no longer owns this asset; choose an offer whose seller still owns its asset')
    if (owner.active_offer_id != null && owner.active_offer_id !== offerId)
      return err(c, 409, 'the asset is locked by a different offer; use that offer or wait for its seller to close it')

    const { table, transferable } = ASSETS[type]
    const accepted = requirements(
      offer.seller_wallet,
      Number(offer.price_usdc),
      `${DOMAIN}/api/transfer/${offerId}/claim`,
      `1F3D9 transfer offer ${offerId}`,
    )
    const paymentHeader = c.req.header('x-payment')

    const reservedAt = offer.reserved_at ? new Date(offer.reserved_at) : null
    const reservedUntil = offer.reserved_until ? new Date(offer.reserved_until) : null
    const now = Date.now()
    const boundReservation =
      offer.reserved_by === resident.id &&
      typeof offer.buyer_wallet === 'string' && WALLET_RE.test(offer.buyer_wallet) &&
      reservedAt != null && !Number.isNaN(reservedAt.getTime()) && reservedAt.getTime() <= now &&
      reservedUntil != null && !Number.isNaN(reservedUntil.getTime())
    const activeReservation = boundReservation && reservedUntil!.getTime() > now
    const existingAttempt = boundReservation
      ? await findPaymentAttempt({ query: sql.query }, {
        actorId: resident.id,
        operation: 'direct_sale',
        offerId,
      })
      : null

    if (!activeReservation && !existingAttempt) {
      if (reservedUntil && !Number.isNaN(reservedUntil.getTime()) && reservedUntil.getTime() > now)
        return err(c, 409, 'this offer already has an active reservation; wait for its five-minute window to end or let its buyer finish')
      if (!requestedWallet)
        return err(c, 400, 'first claim call requires buyer_wallet to open a five-minute reservation')
      if (paymentHeader)
        return err(c, 409, 'no active reservation; open one before sending payment')

      const reservedRows = await sql.query(`
        UPDATE transfer_offers SET
          reserved_by = $1,
          buyer_wallet = $7,
          reserved_at = clock_timestamp(),
          reserved_until = clock_timestamp() + make_interval(secs => $2)
        WHERE id = $3 AND status = 'open' AND buyer_id = $1 AND seller_id = $4
          AND (reserved_until IS NULL OR reserved_until <= clock_timestamp())
          AND EXISTS (
            SELECT 1 FROM ${table}
            WHERE id = $5 AND owner_id = $4 AND active_offer_id = $3${transferable}
          )
          AND NOT EXISTS (
            SELECT 1 FROM transfer_offers conflict
            WHERE conflict.asset_type = $6 AND conflict.asset_id = $5
              AND conflict.status = 'open' AND conflict.id <> $3
          )
        RETURNING id, reserved_by, buyer_wallet, reserved_at, reserved_until
      `, [
        resident.id, CLAIM_WINDOW_SECONDS, offerId, offer.seller_id,
        offer.asset_id, type, requestedWallet,
      ]) as { id: number; reserved_until: string }[]
      if (!reservedRows[0])
        return err(c, 409, 'offer, reservation, withdrawal, or ownership changed; re-read the offer')
      return challenge402(
        c,
        accepted,
        `reservation opened for five minutes; pay from ${requestedWallet} and retry with X-PAYMENT`,
      )
    }

    const buyerWallet = offer.buyer_wallet!.toLowerCase()
    if (requestedWallet && requestedWallet !== buyerWallet)
      return err(c, 409, 'buyer_wallet does not match the active reservation; re-read the offer and resend its reserved buyer wallet')
    if (!paymentHeader && !existingAttempt)
      return challenge402(
        c,
        accepted,
        `active reservation: pay $${offer.price_usdc} USDC from ${buyerWallet}, then retry with X-PAYMENT`,
      )

    const payment = paymentHeader
      ? await runDurableX402({
        database: { query: sql.query },
        paymentHeader,
        accepted,
        actorId: resident.id,
        counterpartyId: offer.seller_id,
        operation: 'direct_sale',
        targetKey: `direct-sale:${offerId}`,
        offerId,
        assetType: type,
        assetId: offer.asset_id,
        request: {
          offer_id: offerId,
          buyer_wallet: buyerWallet,
          seller_wallet: offer.seller_wallet,
          price_usdc: Number(offer.price_usdc),
          asset_type: type,
          asset_id: offer.asset_id,
        },
        expectedPayerWallet: buyerWallet,
        notBefore: reservedAt!,
        notAfter: reservedUntil!,
      })
      : await resumeDurableX402({
        database: { query: sql.query },
        attempt: existingAttempt!,
        actorId: resident.id,
      })

    if (payment.state === 'completed') {
      return completedPaymentResponse(payment)
    }
    if (payment.state === 'payment_pending') return c.json(payment.body, 202)
    if (payment.state === 'unavailable') return c.json(payment.body, 503)
    if (payment.state === 'rejected') {
      if (existingAttempt) {
        try {
          await closeInvalidSalePaymentTarget({ query: sql.query }, {
            attemptId: existingAttempt.publicId,
          })
        } catch (error) {
          if (!(error instanceof PaymentSaleConflictError)) throw error
        }
      }
      return payment.status === 409
        ? c.json(payment.body, 409)
        : c.json(payment.body, 400)
    }

    try {
      const completed = await completeDirectSalePayment({ query: sql.query }, {
        attemptId: payment.attemptId,
        leaseOwner: payment.leaseOwner,
      })
      if (completed.state !== 'completed') {
        const reason = completed.state === 'deadline_passed'
          ? 'matching payment finalized after automatic recovery closed'
          : completed.reason
        await closeSalePaymentTarget({ query: sql.query }, {
          attemptId: payment.attemptId,
          leaseOwner: payment.leaseOwner,
          reason,
          state: 'founder_review',
        })
        return paymentJsonResponse(JSON.stringify({
          payment: 'founder_review',
          payment_attempt_id: payment.attemptId,
          transaction: payment.txHash,
          do_not_pay_again: true,
          error: 'payment needs founder review; no ownership changed',
        }), 409, payment.paymentResponseHeader)
      }
      return paymentJsonResponse(
        completed.responseBody,
        completed.status,
        completed.paymentResponseHeader ?? payment.paymentResponseHeader,
      )
    } catch (error) {
      if (postgresErrorCode(error) === '23505') return err(c, 409, 'that payment transaction was already used; do not pay again and re-read the offer before starting a new claim')
      throw error
    }
  })

  app.post('/api/transfer/:offerId/cancel', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, OFFER_ID_REFUSAL)
    const offer = await readOffer(offerId)
    if (!offer) return err(c, 404, `transfer offer_id ${offerId} was not found; ask the seller for its current offer_id before retrying`)
    const type = assetType(offer.asset_type)
    if (!type) return err(c, 409, 'offer refers to an unsupported asset type; choose another offer and ask the city owner to inspect this record')
    if (offer.seller_id !== resident.id) return err(c, 403, 'only the seller may cancel this offer')
    if (offer.status !== 'open') return err(c, 409, `offer is already ${offer.status}; choose an open offer because this one cannot be canceled again`)
    const reservedUntil = offer.reserved_until ? new Date(offer.reserved_until) : null
    if (reservedUntil && !Number.isNaN(reservedUntil.getTime()) && reservedUntil > new Date())
      return err(c, 409, 'the buyer has an active five-minute payment window; let the buyer finish or retry cancellation after the window ends')

    const { table, transferable } = ASSETS[type]
    const rows = await sql.query(`
      WITH canceled_offer AS (
        UPDATE transfer_offers SET status = 'canceled', canceled_at = now()
        WHERE id = $1 AND seller_id = $2 AND status = 'open'
          AND (reserved_until IS NULL OR reserved_until <= now())
          AND NOT EXISTS (
            SELECT 1 FROM payment_attempts
            WHERE payment_attempts.operation = 'direct_sale'
              AND payment_attempts.offer_id = $1
              AND payment_attempts.status IN ('settling', 'payment_pending', 'needs_review')
          )
          AND EXISTS (
            SELECT 1 FROM ${table}
            WHERE id = $3 AND owner_id = $2 AND active_offer_id = $1${transferable}
          )
        RETURNING id, asset_id, seller_id, status
      ), released_asset AS (
        UPDATE ${table} SET active_offer_id = NULL
        FROM canceled_offer o
        WHERE ${table}.id = o.asset_id AND ${table}.owner_id = o.seller_id
          AND ${table}.active_offer_id = o.id${transferable}
        RETURNING ${table}.id
      ), release_guard AS MATERIALIZED (
        SELECT 1 / count(*)::int AS ok FROM released_asset
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'transfer_cancel', $4, jsonb_build_object('offer_id', o.id)
        FROM canceled_offer o CROSS JOIN released_asset a CROSS JOIN release_guard g
        WHERE g.ok = 1
      )
      SELECT o.id, o.status FROM canceled_offer o
      CROSS JOIN released_asset a CROSS JOIN release_guard g WHERE g.ok = 1
    `, [offerId, resident.id, offer.asset_id, resident.handle]) as { id: number; status?: string }[]
    const canceled = rows[0]
    if (!canceled) return err(c, 409, 'offer, ownership, or reservation changed before cancellation; re-read the offer before retrying')
    return c.json({ offer: { id: canceled.id, status: 'canceled' } })
  })
}
