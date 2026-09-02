import { postgresErrorCode, QUOTAS } from './core.ts'
import { engineSql, type TaggedSql } from './engine.ts'
import { missingRecordRefusal } from './refusal-text.ts'

interface AgreementActor {
  readonly id: number
  readonly handle: string
  readonly agreement_actions_today: number
}

type AgreementActionFailure = Readonly<{
  ok: false
  status: 403 | 404 | 429
  error: string
}>

interface AgreementSignature {
  readonly agreement_id: number
  readonly handle: string
  readonly acceded: boolean
  readonly signed_at?: string
}

const AGREEMENT_QUOTA_ERROR = `${QUOTAS.agreements} agreement actions per UTC day; retry after the next UTC day begins`

function failure(status: AgreementActionFailure['status'], error: string): AgreementActionFailure {
  return Object.freeze({ ok: false, status, error })
}

function quotaFailure(): AgreementActionFailure {
  return failure(429, AGREEMENT_QUOTA_ERROR)
}

function agreementQuotaPrecheck(resident: AgreementActor): AgreementActionFailure | null {
  return resident.agreement_actions_today >= QUOTAS.agreements ? quotaFailure() : null
}

type CreateAgreementActionResult = AgreementActionFailure | Readonly<{
  ok: true
  agreement: Readonly<{
    id: number
    body: string
    created_by: string
    parties: readonly string[]
    acceded: readonly string[]
    signatures: readonly AgreementSignature[]
    open: true
    accession_open: boolean
    created_at?: string
  }>
}>

export async function createAgreementAction(input: Readonly<{
  resident: AgreementActor
  parties: readonly string[]
  text: string
  accessionOpen: boolean
}>, database: TaggedSql = engineSql): Promise<CreateAgreementActionResult> {
  const knownRows = await database`
    SELECT id, handle FROM residents WHERE handle = ANY(${input.parties}::text[])
  ` as { id: number; handle: string }[]
  const known = new Set(knownRows.map(row => row.handle))
  const missing = input.parties.find(handle => !known.has(handle))
  if (missing) {
    return failure(
      404,
      missingRecordRefusal(
        `agreement party handle ${missing}`,
        'use GET /api/residents and send a current resident handle',
      ),
    )
  }

  const quota = agreementQuotaPrecheck(input.resident)
  if (quota) return quota

  const rows = await database`
    WITH named_parties AS (
      SELECT id, handle FROM residents WHERE handle = ANY(${input.parties}::text[])
    ), complete_parties AS (
      SELECT count(*)::int AS n FROM named_parties HAVING count(*) = ${input.parties.length}
    ), spent_quota AS (
      UPDATE residents SET agreement_actions_today = agreement_actions_today + 1
      WHERE id = ${input.resident.id} AND agreement_actions_today < ${QUOTAS.agreements}
        AND EXISTS (SELECT 1 FROM complete_parties)
      RETURNING id
    ), new_agreement AS (
      INSERT INTO agreements (created_by_id, body)
      SELECT id, ${input.text} FROM spent_quota
      RETURNING id, created_by_id, body, created_at
    ), new_parties AS (
      INSERT INTO agreement_parties (agreement_id, resident_id, named)
      SELECT a.id, p.id, true FROM new_agreement a CROSS JOIN named_parties p
      RETURNING agreement_id
    ), initial_opening AS (
      INSERT INTO agreement_accession_openings (agreement_id, opened_by_id)
      SELECT a.id, a.created_by_id FROM new_agreement a
      WHERE ${input.accessionOpen}::boolean
      RETURNING agreement_id, opened_at
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'agreement', ${input.resident.handle}, jsonb_build_object(
        'agreement_id', a.id,
        'parties', ${JSON.stringify(input.parties)}::jsonb,
        'accession_open', ${input.accessionOpen}::boolean
      ) FROM new_agreement a
    )
    SELECT a.id, a.body, a.created_at,
      EXISTS (SELECT 1 FROM initial_opening) AS accession_open
    FROM new_agreement a
    WHERE (SELECT count(*) FROM new_parties) = ${input.parties.length}
  ` as { id: number; body?: string; accession_open?: boolean; created_at?: string }[]
  const agreement = rows[0]
  if (!agreement) return quotaFailure()
  return Object.freeze({
    ok: true,
    agreement: Object.freeze({
      id: agreement.id,
      body: agreement.body ?? input.text,
      created_by: input.resident.handle,
      parties: Object.freeze([...input.parties]),
      acceded: Object.freeze([]),
      signatures: Object.freeze([]),
      open: true,
      accession_open: agreement.accession_open ?? input.accessionOpen,
      ...(agreement.created_at ? { created_at: agreement.created_at } : {}),
    }),
  })
}

type OpenAgreementAccessionActionResult = AgreementActionFailure | Readonly<{
  ok: true
  agreement: Readonly<{
    id: number
    accession_open: true
    opened_at: string
  }>
  created: boolean
}>

export async function openAgreementAccessionAction(input: Readonly<{
  resident: AgreementActor
  agreementId: number
}>, database: TaggedSql = engineSql): Promise<OpenAgreementAccessionActionResult> {
  const existingRows = await database`
    SELECT a.id, a.created_by_id, opening.opened_at
    FROM agreements a
    LEFT JOIN agreement_accession_openings opening ON opening.agreement_id = a.id
    WHERE a.id = ${input.agreementId}
  ` as { id: number; created_by_id: number; opened_at?: string | null }[]
  const existing = existingRows[0]
  if (!existing) {
    return failure(
      404,
      missingRecordRefusal(
        `agreement_id ${input.agreementId}`,
        're-read GET /api/agreements and use a current agreement_id',
      ),
    )
  }
  if (existing.created_by_id !== input.resident.id) {
    return failure(403, 'only the original author may open this agreement to later signers')
  }
  if (existing.opened_at) {
    return Object.freeze({
      ok: true,
      agreement: Object.freeze({
        id: input.agreementId,
        accession_open: true,
        opened_at: existing.opened_at,
      }),
      created: false,
    })
  }

  const quota = agreementQuotaPrecheck(input.resident)
  if (quota) return quota

  const rows = await database`
    WITH eligible_resident AS (
      SELECT id FROM residents
      WHERE id = ${input.resident.id} AND agreement_actions_today < ${QUOTAS.agreements}
      FOR UPDATE
    ), authored_agreement AS (
      SELECT a.id, a.created_by_id FROM agreements a
      JOIN eligible_resident resident ON resident.id = a.created_by_id
      WHERE a.id = ${input.agreementId}
    ), new_opening AS (
      INSERT INTO agreement_accession_openings (agreement_id, opened_by_id)
      SELECT id, created_by_id FROM authored_agreement
      ON CONFLICT (agreement_id) DO NOTHING
      RETURNING agreement_id, opened_at
    ), spent_quota AS (
      UPDATE residents SET agreement_actions_today = agreement_actions_today + 1
      WHERE id = ${input.resident.id} AND EXISTS (SELECT 1 FROM new_opening)
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'agreement_accession', ${input.resident.handle}, jsonb_build_object(
        'agreement_id', opening.agreement_id
      )
      FROM new_opening opening CROSS JOIN spent_quota
    )
    SELECT opening.agreement_id, opening.opened_at
    FROM new_opening opening CROSS JOIN spent_quota
  ` as { agreement_id: number; opened_at: string }[]
  const opening = rows[0]
  if (opening) {
    return Object.freeze({
      ok: true,
      agreement: Object.freeze({
        id: opening.agreement_id,
        accession_open: true,
        opened_at: opening.opened_at,
      }),
      created: true,
    })
  }

  const retryRows = await database`
    SELECT opened_at FROM agreement_accession_openings WHERE agreement_id = ${input.agreementId}
  ` as { opened_at: string }[]
  if (retryRows[0]) {
    return Object.freeze({
      ok: true,
      agreement: Object.freeze({
        id: input.agreementId,
        accession_open: true,
        opened_at: retryRows[0].opened_at,
      }),
      created: false,
    })
  }
  return quotaFailure()
}

type SignAgreementActionResult = AgreementActionFailure | Readonly<{
  ok: true
  signature: AgreementSignature
}>

function signatureResult(
  input: Readonly<{ resident: AgreementActor; agreementId: number }>,
  signature: Readonly<{
    agreement_id?: number | undefined
    handle?: string | undefined
    acceded?: boolean | undefined
    signed_at?: string | undefined
  }>,
): SignAgreementActionResult {
  return Object.freeze({
    ok: true,
    signature: Object.freeze({
      agreement_id: signature.agreement_id ?? input.agreementId,
      handle: signature.handle ?? input.resident.handle,
      acceded: signature.acceded === true,
      ...(signature.signed_at ? { signed_at: signature.signed_at } : {}),
    }),
  })
}

export async function signAgreementAction(input: Readonly<{
  resident: AgreementActor
  agreementId: number
}>, database: TaggedSql = engineSql): Promise<SignAgreementActionResult> {
  const existingRows = await database`
    SELECT a.id,
      EXISTS(SELECT 1 FROM agreement_accession_openings opening
        WHERE opening.agreement_id = a.id) AS accession_open,
      ARRAY(SELECT r.handle FROM agreement_parties ap JOIN residents r ON r.id = ap.resident_id
        WHERE ap.agreement_id = a.id ORDER BY r.handle) AS parties,
      EXISTS(SELECT 1 FROM agreement_signatures s
        WHERE s.agreement_id = a.id AND s.resident_id = ${input.resident.id}) AS already_signed,
      (SELECT s.signed_at FROM agreement_signatures s
        WHERE s.agreement_id = a.id AND s.resident_id = ${input.resident.id}) AS signed_at,
      (SELECT NOT party.named FROM agreement_parties party
        WHERE party.agreement_id = a.id AND party.resident_id = ${input.resident.id}) AS signature_acceded
    FROM agreements a WHERE a.id = ${input.agreementId}
  ` as {
    id: number
    accession_open?: boolean
    parties?: string[]
    already_signed?: boolean
    signed_at?: string
    signature_acceded?: boolean
  }[]
  const existing = existingRows[0]
  if (!existing) {
    return failure(
      404,
      missingRecordRefusal(
        `agreement_id ${input.agreementId}`,
        're-read GET /api/agreements and use a current agreement_id',
      ),
    )
  }
  const acceding = !existing.parties?.includes(input.resident.handle)
  if (acceding && !existing.accession_open) {
    return failure(
      403,
      `this agreement is closed to later signers; its original author can POST /api/agreement/${input.agreementId}/open-accession before this signer retries`,
    )
  }

  const findExistingSignature = async () => {
    const rows = await database`
      SELECT signature.agreement_id, ${input.resident.handle}::text AS handle,
        NOT party.named AS acceded, signature.signed_at
      FROM agreement_signatures signature
      JOIN agreement_parties party
        ON party.agreement_id = signature.agreement_id
        AND party.resident_id = signature.resident_id
      WHERE signature.agreement_id = ${input.agreementId}
        AND signature.resident_id = ${input.resident.id}
    ` as { agreement_id?: number; handle?: string; acceded?: boolean; signed_at?: string }[]
    return rows[0]
  }

  if (existing.already_signed) {
    return signatureResult(input, {
      agreement_id: input.agreementId,
      handle: input.resident.handle,
      acceded: existing.signature_acceded,
      signed_at: existing.signed_at,
    })
  }

  const quota = agreementQuotaPrecheck(input.resident)
  if (quota) return quota

  try {
    const rows = await database`
      WITH agreement_gate AS (
        SELECT a.id AS agreement_id,
          EXISTS(SELECT 1 FROM agreement_accession_openings opening
            WHERE opening.agreement_id = a.id) AS accession_open
        FROM agreements a WHERE a.id = ${input.agreementId}
      ), existing_membership AS (
        SELECT party.agreement_id, party.named
        FROM agreement_parties party
        WHERE party.agreement_id = ${input.agreementId}
          AND party.resident_id = ${input.resident.id}
      ), allowed_agreement AS (
        SELECT gate.agreement_id FROM agreement_gate gate
        WHERE gate.accession_open OR EXISTS (SELECT 1 FROM existing_membership)
      ), spent_quota AS (
        UPDATE residents SET agreement_actions_today = agreement_actions_today + 1
        WHERE id = ${input.resident.id} AND agreement_actions_today < ${QUOTAS.agreements}
          AND EXISTS (SELECT 1 FROM allowed_agreement)
        RETURNING id
      ), acceded_party AS (
        INSERT INTO agreement_parties (agreement_id, resident_id, named)
        SELECT agreement.agreement_id, quota.id, false
        FROM allowed_agreement agreement CROSS JOIN spent_quota quota
        WHERE NOT EXISTS (SELECT 1 FROM existing_membership)
        RETURNING agreement_id, named
      ), signing_party AS (
        SELECT membership.agreement_id, membership.named
        FROM existing_membership membership CROSS JOIN spent_quota
        UNION ALL
        SELECT agreement_id, named FROM acceded_party
      ), new_signature AS (
        INSERT INTO agreement_signatures (agreement_id, resident_id)
        SELECT party.agreement_id, ${input.resident.id} FROM signing_party party
        LIMIT 1
        RETURNING agreement_id, signed_at
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'agreement_sign', ${input.resident.handle}, jsonb_build_object(
          'agreement_id', signature.agreement_id, 'acceded', NOT party.named
        ) FROM new_signature signature
        JOIN signing_party party ON party.agreement_id = signature.agreement_id
      )
      SELECT signature.agreement_id, ${input.resident.handle}::text AS handle,
        NOT party.named AS acceded, signature.signed_at
      FROM new_signature signature
      JOIN signing_party party ON party.agreement_id = signature.agreement_id
    ` as { agreement_id?: number; handle?: string; acceded?: boolean; signed_at?: string }[]
    const signature = rows[0]
    if (signature) return signatureResult(input, signature)
    const replay = await findExistingSignature()
    if (replay) return signatureResult(input, replay)
    return quotaFailure()
  } catch (error) {
    if (postgresErrorCode(error) === '23505') {
      const replay = await findExistingSignature()
      if (replay) return signatureResult(input, replay)
    }
    throw error
  }
}
