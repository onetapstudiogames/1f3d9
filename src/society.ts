import type { Context } from 'hono'
import type { Hono } from 'hono'
import { auth, err, HANDLE_RE, postgresErrorCode, QUOTAS, WALLET_RE } from './core.ts'
import { sql } from './db.ts'
import { positiveId, publicText, usdcAmount, containsBearerSecret, SECRET_REJECTION } from './input.ts'
import {
  canonicalTxHash,
  challenge402,
  CLAIM_WINDOW_SECONDS,
  paymentResponseHeader,
  requirements,
  settleX402,
  verifyDirectPayment,
} from './pay.ts'
import { EngineError, residentPresence, resolveDueEffects, runAction } from './engine.ts'
import { moderatePublicRows } from './moderation-store.ts'
import { runTalkNoteAction } from './note-action.ts'

const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3d9.com'
const NOTE_CHARACTERS = 4_000
const AGREEMENT_BYTES = 65_536
const MAX_PARTIES = 32

const ASSETS = {
  place: { table: 'places', transferable: '' },
  thing: { table: 'things', transferable: ' AND withdrawn_at IS NULL' },
  kind: { table: 'kinds', transferable: '' },
} as const

type AssetType = keyof typeof ASSETS
type JsonObject = Record<string, unknown>

interface OwnerRow {
  id: number
  owner_id: number
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
  const signatures = Array.isArray(row.signatures) ? row.signatures : []
  return {
    ...row,
    parties,
    signatures,
    open: typeof row.open === 'boolean' ? row.open : signatures.length < parties.length,
  }
}

export function mountSocietyRoutes(app: Hono): void {
  app.get('/api/note/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'note id must be a positive integer')
    const rows = await sql`
      SELECT note.id, note.place_id, author.handle AS author, note.body, note.created_at
      FROM notes note
      JOIN residents author ON author.id = note.author_id
      WHERE note.id = ${id}
    ` as Array<Record<string, unknown> & { id: number }>
    if (!rows[0]) return err(c, 404, 'note not found')
    const notes = await moderatePublicRows('note', rows)
    return c.json({ note: notes[0] })
  })

  app.post('/api/note', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['place_id', 'body']))
      return err(c, 400, 'need place_id and body')
    const placeId = positiveId(body.place_id)
    if (containsBearerSecret(body.body)) return err(c, 400, SECRET_REJECTION)
    const text = publicText(body.body, { maximumCharacters: NOTE_CHARACTERS })
    if (!placeId) return err(c, 400, 'place_id must be a positive integer')
    if (text == null) return err(c, 400, 'body must be 1-4000 safe characters')

    const places = await sql`
      SELECT id, owner_id, open_to_notes FROM places WHERE id = ${placeId}
    ` as { id: number; owner_id: number; open_to_notes: boolean }[]
    const place = places[0]
    if (!place) return err(c, 404, 'no such place')
    if (place.owner_id !== resident.id && !place.open_to_notes)
      return err(c, 403, 'this place is not open to notes')
    await resolveDueEffects(placeId)
    // This fast rejection avoids presenting an INSERT to the database when the
    // caller is already known to be capped. The CTE below still rechecks the
    // counter so concurrent requests cannot overspend it.
    if (resident.notes_today >= QUOTAS.notes)
      return err(c, 429, `${QUOTAS.notes} notes per UTC day`)

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
    }, 201)
  })

  app.post('/api/agreement', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['parties', 'body'])) return err(c, 400, 'need parties and body')
    const parties = partyHandles(body.parties)
    if (containsBearerSecret(body.body)) return err(c, 400, SECRET_REJECTION)
    const text = publicText(body.body, { maximumBytes: AGREEMENT_BYTES })
    if (!parties || text == null)
      return err(c, 400, `parties: 1-${MAX_PARTIES} unique resident handles; body: 1 byte-64 KB`)

    const knownRows = await sql`
      SELECT id, handle FROM residents WHERE handle = ANY(${parties}::text[])
    ` as { id: number; handle: string }[]
    const known = new Map(knownRows.map(row => [row.handle, row.id]))
    const missing = parties.filter(handle => !known.has(handle))
    if (missing.length) return err(c, 404, `unknown agreement party: ${missing[0]}`)
    if (resident.agreement_actions_today >= QUOTAS.agreements)
      return err(c, 429, `${QUOTAS.agreements} agreement actions per UTC day`)

    const rows = await sql`
      WITH named_parties AS (
        SELECT id, handle FROM residents WHERE handle = ANY(${parties}::text[])
      ), complete_parties AS (
        SELECT count(*)::int AS n FROM named_parties HAVING count(*) = ${parties.length}
      ), spent_quota AS (
        UPDATE residents SET agreement_actions_today = agreement_actions_today + 1
        WHERE id = ${resident.id} AND agreement_actions_today < ${QUOTAS.agreements}
          AND EXISTS (SELECT 1 FROM complete_parties)
        RETURNING id
      ), new_agreement AS (
        INSERT INTO agreements (created_by_id, body)
        SELECT id, ${text} FROM spent_quota
        RETURNING id, body, created_at
      ), new_parties AS (
        INSERT INTO agreement_parties (agreement_id, resident_id)
        SELECT a.id, p.id FROM new_agreement a CROSS JOIN named_parties p
        RETURNING agreement_id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'agreement', ${resident.handle}, jsonb_build_object(
          'agreement_id', a.id, 'parties', ${JSON.stringify(parties)}::jsonb
        ) FROM new_agreement a
      )
      SELECT a.id, a.body, a.created_at FROM new_agreement a
      WHERE (SELECT count(*) FROM new_parties) = ${parties.length}
    ` as { id: number; body?: string; created_at?: string }[]
    const agreement = rows[0]
    if (!agreement) return err(c, 429, `${QUOTAS.agreements} agreement actions per UTC day`)
    return c.json({ agreement: {
      id: agreement.id,
      body: agreement.body ?? text,
      created_by: resident.handle,
      parties,
      signatures: [],
      open: true,
      ...(agreement.created_at ? { created_at: agreement.created_at } : {}),
    } }, 201)
  })

  app.post('/api/agreement/:id/sign', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'bad agreement id')

    const existingRows = await sql`
      SELECT a.id,
        ARRAY(SELECT r.handle FROM agreement_parties ap JOIN residents r ON r.id = ap.resident_id
          WHERE ap.agreement_id = a.id ORDER BY r.handle) AS parties,
        EXISTS(SELECT 1 FROM agreement_signatures s
          WHERE s.agreement_id = a.id AND s.resident_id = ${resident.id}) AS already_signed
      FROM agreements a WHERE a.id = ${id}
    ` as { id: number; parties?: string[]; already_signed?: boolean }[]
    const existing = existingRows[0]
    if (!existing) return err(c, 404, 'no such agreement')
    if (!existing.parties?.includes(resident.handle))
      return err(c, 403, 'only a named party may sign this agreement')
    if (existing.already_signed) return err(c, 409, 'you already signed this agreement')
    if (resident.agreement_actions_today >= QUOTAS.agreements)
      return err(c, 429, `${QUOTAS.agreements} agreement actions per UTC day`)

    try {
      const rows = await sql`
        WITH named_party AS (
          SELECT agreement_id FROM agreement_parties
          WHERE agreement_id = ${id} AND resident_id = ${resident.id}
        ), spent_quota AS (
          UPDATE residents SET agreement_actions_today = agreement_actions_today + 1
          WHERE id = ${resident.id} AND agreement_actions_today < ${QUOTAS.agreements}
            AND EXISTS (SELECT 1 FROM named_party)
          RETURNING id
        ), new_signature AS (
          INSERT INTO agreement_signatures (agreement_id, resident_id)
          SELECT p.agreement_id, q.id FROM named_party p CROSS JOIN spent_quota q
          RETURNING agreement_id, signed_at
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'agreement_sign', ${resident.handle}, jsonb_build_object('agreement_id', agreement_id)
          FROM new_signature
        )
        SELECT agreement_id, ${resident.handle}::text AS handle, signed_at FROM new_signature
      ` as { agreement_id?: number; handle?: string; signed_at?: string }[]
      const signature = rows[0]
      if (!signature) return err(c, 429, `${QUOTAS.agreements} agreement actions per UTC day`)
      return c.json({ signature: {
        agreement_id: signature.agreement_id ?? id,
        handle: signature.handle ?? resident.handle,
        ...(signature.signed_at ? { signed_at: signature.signed_at } : {}),
      } })
    } catch (error) {
      if (postgresErrorCode(error) === '23505') return err(c, 409, 'you already signed this agreement')
      throw error
    }
  })

  app.get('/api/agreements', async c => {
    const party = c.req.query('party')
    const openValue = c.req.query('open')
    if (party != null && !HANDLE_RE.test(party)) return err(c, 400, 'bad party handle')
    if (openValue != null && openValue !== 'true' && openValue !== 'false')
      return err(c, 400, 'open must be true or false')
    const open = openValue == null ? null : openValue === 'true'
    const rows = await sql`
      WITH public_agreements AS (
        SELECT a.id, a.body, creator.handle AS created_by,
          ARRAY(SELECT r.handle FROM agreement_parties ap JOIN residents r ON r.id = ap.resident_id
            WHERE ap.agreement_id = a.id ORDER BY r.handle) AS parties,
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
      SELECT id, body, created_by, parties, signatures, NOT complete AS open, created_at
      FROM public_agreements
      WHERE (${party ?? null}::text IS NULL OR ${party ?? null} = ANY(parties))
        AND (${open}::boolean IS NULL OR (NOT complete) = ${open})
      ORDER BY created_at DESC, id DESC LIMIT 200
    ` as Record<string, unknown>[]
    const agreements = rows.map(agreementState)
    return c.json({ agreements: await moderatePublicRows('agreement', agreements) })
  })

  app.post('/api/transfer', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
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
    if (!asset) return err(c, 404, `no such ${type}`)
    if (asset.owner_id !== resident.id) return err(c, 403, `only the ${type} owner may transfer it`)
    if (asset.active_offer_id != null || await openOffer(type, id))
      return err(c, 409, 'this asset already has an open transfer offer')
    const recipient = await residentId(toHandle)
    if (!recipient) return err(c, 404, 'no such recipient')
    if (recipient === resident.id) return err(c, 400, 'you already own this asset')
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
      performPrimitive: async transaction => {
        if (!transaction.query) throw new EngineError(500, 'transaction query support is unavailable')
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
              'transfer_id', t.id, 'asset_type', $1::text, 'asset_id', $2,
              'from', $5::text, 'to', $6::text, 'mode', 'gift'
            ) FROM new_transfer t
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
    if (!transfer) return err(c, 500, 'transfer result is unavailable')
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
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
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
      return err(c, 400, 'invalid offer; type is place|thing|kind, price is 0-10000 USDC, wallet is a Base address')

    const asset = await ownerOf(type, id)
    if (!asset) return err(c, 404, `no such ${type}`)
    if (asset.owner_id !== resident.id) return err(c, 403, `only the ${type} owner may offer it`)
    if (asset.active_offer_id != null || await openOffer(type, id))
      return err(c, 409, 'this asset already has an open transfer offer')
    const buyerId = await residentId(toHandle)
    if (!buyerId) return err(c, 404, 'no such buyer')
    if (buyerId === resident.id) return err(c, 400, 'you cannot sell an asset to yourself')
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
      performPrimitive: async transaction => {
        if (!transaction.query) throw new EngineError(500, 'transaction query support is unavailable')
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
            throw new EngineError(409, 'this asset already has an open transfer offer')
          }
          throw error
        }
      },
    })
    if (actionGate.error) {
      return err(c, actionGate.httpStatus as 400 | 403 | 404 | 409 | 500, actionGate.error)
    }
    if (!offer) return err(c, 500, 'transfer offer result is unavailable')
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
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, 'bad offer id')
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['buyer_wallet', 'tx_hash']))
      return err(c, 400, 'body may contain buyer_wallet or tx_hash')
    const requestedWallet = body.buyer_wallet == null
      ? null
      : typeof body.buyer_wallet === 'string' && WALLET_RE.test(body.buyer_wallet)
        ? body.buyer_wallet.toLowerCase()
        : undefined
    if (requestedWallet === undefined)
      return err(c, 400, 'buyer_wallet must be a Base address')
    const suppliedTx = body.tx_hash == null ? null : canonicalTxHash(body.tx_hash)
    if (body.tx_hash != null && !suppliedTx) return err(c, 400, 'tx_hash must be 0x followed by 64 hex characters')

    const offer = await readOffer(offerId)
    if (!offer) return err(c, 404, 'no such transfer offer')
    const type = assetType(offer.asset_type)
    if (!type) return err(c, 409, 'offer refers to an unsupported asset type')
    if (offer.status !== 'open') return err(c, 409, `offer is ${offer.status}`)
    if (offer.buyer_id !== resident.id) return err(c, 403, 'only the named buyer may claim this offer')
    const owner = await ownerOf(type, offer.asset_id)
    if (!owner || owner.owner_id !== offer.seller_id)
      return err(c, 409, 'seller no longer owns this asset')
    if (owner.active_offer_id != null && owner.active_offer_id !== offerId)
      return err(c, 409, 'the asset is locked by a different offer')

    const { table, transferable } = ASSETS[type]
    const accepted = requirements(
      offer.seller_wallet,
      Number(offer.price_usdc),
      `${DOMAIN}/api/transfer/${offerId}/claim`,
      `1F3D9 transfer offer ${offerId}`,
    )
    const paymentHeader = c.req.header('x-payment')
    if (paymentHeader && suppliedTx)
      return err(c, 400, 'use either X-PAYMENT or tx_hash, not both')

    const reservedAt = offer.reserved_at ? new Date(offer.reserved_at) : null
    const reservedUntil = offer.reserved_until ? new Date(offer.reserved_until) : null
    const now = Date.now()
    const activeReservation =
      offer.reserved_by === resident.id &&
      typeof offer.buyer_wallet === 'string' && WALLET_RE.test(offer.buyer_wallet) &&
      reservedAt != null && !Number.isNaN(reservedAt.getTime()) && reservedAt.getTime() <= now &&
      reservedUntil != null && !Number.isNaN(reservedUntil.getTime()) && reservedUntil.getTime() > now

    if (!activeReservation) {
      if (reservedUntil && !Number.isNaN(reservedUntil.getTime()) && reservedUntil.getTime() > now)
        return err(c, 409, 'this offer already has an active reservation')
      if (!requestedWallet)
        return err(c, 400, 'first claim call requires buyer_wallet to open a five-minute reservation')
      if (paymentHeader || suppliedTx)
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
        `reservation opened for five minutes; pay from ${requestedWallet} and retry with X-PAYMENT or tx_hash`,
      )
    }

    const buyerWallet = offer.buyer_wallet!.toLowerCase()
    if (requestedWallet && requestedWallet !== buyerWallet)
      return err(c, 409, 'buyer_wallet does not match the active reservation')
    if (!paymentHeader && !suppliedTx)
      return challenge402(
        c,
        accepted,
        `active reservation: pay $${offer.price_usdc} USDC from ${buyerWallet}, then retry with X-PAYMENT or tx_hash`,
      )

    let txHash: string
    let payer: string
    let verifiedVia: 'x402' | 'claim'
    let paymentBlockTime: string | null
    let responseHeader: string | null = null
    if (paymentHeader) {
      const authorizedPayer = x402HeaderPayer(paymentHeader)
      if (!authorizedPayer)
        return challenge402(c, accepted, 'X-PAYMENT must contain a valid payer address')
      if (authorizedPayer !== buyerWallet)
        return challenge402(c, accepted, 'X-PAYMENT payer does not match the reservation wallet')
      const settled = await settleX402(paymentHeader, accepted)
      if ('error' in settled) return challenge402(c, accepted, settled.error)
      if (!WALLET_RE.test(settled.payer)) return challenge402(c, accepted, 'settlement returned an invalid payer address')
      txHash = settled.transaction
      payer = settled.payer.toLowerCase()
      if (payer !== buyerWallet)
        return challenge402(c, accepted, 'settled payer does not match the reservation wallet')
      verifiedVia = 'x402'
      paymentBlockTime = null
      responseHeader = paymentResponseHeader(settled)
    } else {
      const direct = await verifyDirectPayment(
        suppliedTx!,
        offer.seller_wallet,
        Number(offer.price_usdc),
        reservedAt!,
        reservedUntil!,
      )
      if (!direct)
        return err(c, 402, 'tx did not verify inside the active reservation window')
      txHash = suppliedTx!
      payer = direct.from.toLowerCase()
      if (payer !== buyerWallet)
        return err(c, 402, 'direct payment came from a wallet other than the reservation wallet')
      verifiedVia = 'claim'
      paymentBlockTime = direct.blockTime.toISOString()
    }

    try {
      const rows = await sql.query(`
        WITH claimed_offer AS (
          UPDATE transfer_offers SET status = 'claimed', claimed_at = now()
          WHERE id = $1 AND status = 'open' AND seller_id = $2 AND buyer_id = $3
            AND asset_type = $4 AND asset_id = $5
            AND price_usdc = $6 AND lower(seller_wallet) = lower($7)
            AND reserved_by = $3 AND lower(buyer_wallet) = lower($14)
            AND reserved_at = $15::timestamptz AND reserved_until = $16::timestamptz
            AND reserved_at <= clock_timestamp() AND reserved_until > clock_timestamp()
            AND EXISTS (
              SELECT 1 FROM ${table}
              WHERE id = $5 AND owner_id = $2 AND active_offer_id = $1${transferable}
            )
            AND NOT EXISTS (
              SELECT 1 FROM transfer_offers conflict
              WHERE conflict.asset_type = $4 AND conflict.asset_id = $5
                AND conflict.status = 'open' AND conflict.id <> $1
            )
          RETURNING id, asset_id, seller_id, buyer_id
        ), claimed_payment_use AS (
          INSERT INTO payment_uses (
            tx_hash, actor_id, purpose, payer_wallet, payee_wallet, amount_usdc
          )
          SELECT $8, $3, 'sale', $9, lower($7), $6 FROM claimed_offer
          RETURNING tx_hash
        ), new_payment AS (
          INSERT INTO sale_payments (
            offer_id, buyer_id, payer_wallet, payee_wallet, amount_usdc,
            tx_hash, verified_via, block_time
          )
          SELECT o.id, o.buyer_id, $9, lower($7), $6, p.tx_hash, $12, $13
          FROM claimed_offer o CROSS JOIN claimed_payment_use p
          RETURNING offer_id, tx_hash
        ), changed_owner AS (
          UPDATE ${table} SET owner_id = $3, active_offer_id = NULL
          FROM claimed_offer o CROSS JOIN new_payment p
          WHERE ${table}.id = o.asset_id AND ${table}.owner_id = o.seller_id
            AND ${table}.active_offer_id = o.id${transferable}
          RETURNING ${table}.id
        ), owner_guard AS MATERIALIZED (
          SELECT 1 / count(*)::int AS ok FROM changed_owner
        ), new_transfer AS (
          INSERT INTO transfers (
            asset_type, asset_id, from_id, to_id, offer_id, price_usdc, tx_hash
          )
          SELECT $4, a.id, $2, $3, $1, $6, $8
          FROM changed_owner a CROSS JOIN owner_guard g WHERE g.ok = 1
          RETURNING id, created_at
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'sale', $10, jsonb_build_object(
            'transfer_id', t.id, 'offer_id', $1, 'asset_type', $4::text,
            'asset_id', $5, 'from', $11::text, 'to', $10::text,
            'price_usdc', $6::numeric, 'tx_hash', $8::text
          ) FROM new_transfer t
        )
        SELECT o.id, 'claimed'::text AS status, t.id AS transfer_id, t.created_at
        FROM claimed_offer o CROSS JOIN new_transfer t
      `, [
        offerId, offer.seller_id, resident.id, type, offer.asset_id, Number(offer.price_usdc),
        offer.seller_wallet, txHash, payer, resident.handle, offer.seller,
        verifiedVia, paymentBlockTime, buyerWallet, offer.reserved_at!, offer.reserved_until!,
      ]) as { id: number; status?: string; transfer_id?: number; created_at?: string }[]
      const claimed = rows[0]
      if (!claimed) return err(c, 409, 'offer, ownership, or reservation changed before the sale closed')
      if (responseHeader) c.header('X-PAYMENT-RESPONSE', responseHeader)
      return c.json({
        offer: { id: offerId, status: claimed.status ?? 'claimed' },
        transfer: {
          id: claimed.transfer_id,
          type,
          asset_id: offer.asset_id,
          from: offer.seller,
          to: resident.handle,
          price_usdc: Number(offer.price_usdc),
          tx_hash: txHash,
          ...(claimed.created_at ? { created_at: claimed.created_at } : {}),
        },
      })
    } catch (error) {
      if (postgresErrorCode(error) === '23505') return err(c, 409, 'that payment transaction was already used')
      throw error
    }
  })

  app.post('/api/transfer/:offerId/cancel', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, 'bad or missing bearer secret')
    const offerId = positiveId(c.req.param('offerId'))
    if (!offerId) return err(c, 400, 'bad offer id')
    const offer = await readOffer(offerId)
    if (!offer) return err(c, 404, 'no such transfer offer')
    const type = assetType(offer.asset_type)
    if (!type) return err(c, 409, 'offer refers to an unsupported asset type')
    if (offer.seller_id !== resident.id) return err(c, 403, 'only the seller may cancel this offer')
    if (offer.status !== 'open') return err(c, 409, `offer is already ${offer.status}`)
    const reservedUntil = offer.reserved_until ? new Date(offer.reserved_until) : null
    if (reservedUntil && !Number.isNaN(reservedUntil.getTime()) && reservedUntil > new Date())
      return err(c, 409, 'the buyer has an active five-minute payment window')

    const { table, transferable } = ASSETS[type]
    const rows = await sql.query(`
      WITH canceled_offer AS (
        UPDATE transfer_offers SET status = 'canceled', canceled_at = now()
        WHERE id = $1 AND seller_id = $2 AND status = 'open'
          AND (reserved_until IS NULL OR reserved_until <= now())
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
    if (!canceled) return err(c, 409, 'offer, ownership, or reservation changed before cancellation')
    return c.json({ offer: { id: canceled.id, status: 'canceled' } })
  })
}
