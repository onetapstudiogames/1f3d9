import { sql } from './db.ts'

const EXACT_READ_STATEMENT_TIMEOUT = '1500ms'
const EXACT_READ_ADVISORY_NAMESPACE = 524_128_259
type PublicExactReadOrder = 'id_desc' | 'joined_at_desc' | 'search_desc'

export const PUBLIC_EXACT_READ_BUSY_MESSAGE = 'exact public totals are temporarily busy; retry'

export class PublicExactReadBusyError extends Error {
  constructor() {
    super(PUBLIC_EXACT_READ_BUSY_MESSAGE)
    this.name = 'PublicExactReadBusyError'
  }
}

export function isPublicExactReadBusy(error: unknown): error is PublicExactReadBusyError {
  return error instanceof PublicExactReadBusyError
}

function postgresErrorCode(error: unknown, depth = 0): string | null {
  if (depth > 4 || error == null || typeof error !== 'object') return null
  const candidate = error as { readonly code?: unknown; readonly sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}

export function budgetedExactStatement(
  text: string,
  order: PublicExactReadOrder = 'id_desc',
): string {
  const orderBy = order === 'joined_at_desc'
    ? `__public_exact_result.joined_at DESC NULLS LAST,
        __public_exact_result.id DESC NULLS LAST`
    : order === 'search_desc'
      ? `__public_exact_result.created_at DESC NULLS LAST,
          __public_exact_result.result_type ASC NULLS LAST,
          __public_exact_result.id DESC NULLS LAST`
      : '__public_exact_result.id DESC NULLS LAST'
  return `/* public:budgeted-exact */
    WITH __public_exact_admission AS MATERIALIZED (
      SELECT CASE
        WHEN pg_try_advisory_xact_lock(${EXACT_READ_ADVISORY_NAMESPACE}, 0) THEN 0
        WHEN pg_try_advisory_xact_lock(${EXACT_READ_ADVISORY_NAMESPACE}, 1) THEN 1
        ELSE NULL
      END AS slot
    )
    SELECT __public_exact_result.*, __public_exact_admission.slot AS __exact_read_slot
    FROM __public_exact_admission
    LEFT JOIN LATERAL (
      SELECT __public_exact_source.*
      FROM (
        ${text}
      ) __public_exact_source
      LIMIT CASE WHEN __public_exact_admission.slot IS NULL THEN 0 ELSE 2147483647 END
    ) __public_exact_result ON TRUE
    ORDER BY ${orderBy}`
}

export async function executeBudgetedExactQuery(
  text: string,
  params: readonly unknown[],
  order: PublicExactReadOrder = 'id_desc',
): Promise<readonly Record<string, unknown>[]> {
  try {
    const resultSets = await sql.transaction(transaction => [
      transaction.query(`SET LOCAL statement_timeout = '${EXACT_READ_STATEMENT_TIMEOUT}'`),
      transaction.query('SET LOCAL max_parallel_workers_per_gather = 0'),
      transaction.query(budgetedExactStatement(text, order), [...params]),
    ], { readOnly: true })
    const rows = (resultSets[2] ?? []) as readonly Record<string, unknown>[]
    const rawSlot = rows[0]?.__exact_read_slot
    const slot = Number(rawSlot)
    if (rows.length === 0 || rawSlot == null || !Number.isInteger(slot) || slot < 0 || slot > 1) {
      throw new PublicExactReadBusyError()
    }
    return Object.freeze(rows.map(row => {
      const { __exact_read_slot: _slot, ...publicRow } = row
      return Object.freeze(publicRow)
    }))
  } catch (error) {
    if (isPublicExactReadBusy(error)) throw error
    if (postgresErrorCode(error) === '57014') throw new PublicExactReadBusyError()
    throw error
  }
}
