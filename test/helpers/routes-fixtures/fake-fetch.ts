import { TRANSFER_TOPIC, TREASURY, TX_CASE_UPPER, USDC } from './environment.ts'
import { dbRespond } from './db-respond.ts'
import { fixtureState } from './state.ts'

export function installFakeFetch(): void {


  const pad32 = (address: string) => '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

  // Neon's SQL-over-HTTP endpoint reports a failed query as one HTTP 400 whose
  // JSON body carries the Postgres error fields (code, constraint, ...) flatly;
  // the driver copies those straight onto the top-level NeonDbError it throws.
  // Mirror that exact shape here instead of letting a thrown fake-DB error
  // reject the fetch() call itself, which the driver reports as a network
  // failure and nests the original error one level deeper under
  // `sourceError` -- a shape real Postgres query failures never take.
  function postgresErrorHttpResponse(error: unknown): Response | null {
    if (error == null || typeof error !== 'object') return null
    const code = (error as { code?: unknown }).code
    if (typeof code !== 'string') return null
    const constraint = (error as { constraint?: unknown }).constraint
    const message = error instanceof Error ? error.message : 'database error'
    return jsonResponse({
      message,
      code,
      ...(typeof constraint === 'string' ? { constraint } : {}),
    }, 400)
  }

  function pgArray(values: unknown[]) {
    return `{${values.map(value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
  }

  function neonEncode(rows: Record<string, unknown>[]) {
    const keys = Object.keys(rows[0] ?? {})
    const typeOf = (value: unknown) => {
      if (Buffer.isBuffer(value)) return 17
      if (typeof value === 'boolean') return 16
      if (typeof value === 'number') return Number.isInteger(value) ? 23 : 701
      if (Array.isArray(value)) {
        return value.some(item => item != null && typeof item === 'object') ? 3802 : 1009
      }
      if (value != null && typeof value === 'object') return 3802
      return 25
    }
    const encode = (value: unknown) => {
      if (value === null) return null
      if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
      if (typeof value === 'boolean') return value ? 't' : 'f'
      if (Array.isArray(value)) {
        return value.some(item => item != null && typeof item === 'object')
          ? JSON.stringify(value)
          : pgArray(value)
      }
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    }
    return {
      command: 'SELECT',
      rowCount: rows.length,
      fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]![name]) })),
      rows: rows.map(row => keys.map(key => encode(row[key]))),
    }
  }

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(init.body) : null
    const databaseCalls = Array.isArray(body?.queries)
      ? body.queries.map((query: { query?: string; params?: unknown[] }) => ({
        url, query: query.query, params: query.params,
      }))
      : [{ url, query: body?.query, params: body?.params }]
    fixtureState.current = { ...fixtureState.current, calls: [...fixtureState.current.calls, ...databaseCalls] }
    if (url.includes('/sql') && Array.isArray(body?.queries)) {
      const results = body.queries.map((query: { query: string; params?: unknown[] }) => {
        if (/^\s*SET\s+LOCAL\b/iu.test(query.query)) return neonEncode([])
        if (query.query.includes('/* public:budgeted-exact */')) {
          const shouldReject = fixtureState.current.exactTotalsBusy || (
            fixtureState.current.exactTotalsBusyAfter !== null &&
            fixtureState.current.exactTotalsSuccessfulReads >= fixtureState.current.exactTotalsBusyAfter
          )
          if (shouldReject) return neonEncode([{ __exact_read_slot: null }])
          fixtureState.current = {
            ...fixtureState.current,
            exactTotalsSuccessfulReads: fixtureState.current.exactTotalsSuccessfulReads + 1,
          }
        }
        const rows = dbRespond(query.query, query.params ?? [])
          .map(row => ({ ...row, __exact_read_slot: 0 }))
        return neonEncode(rows)
      })
      return jsonResponse({ results })
    }
    if (url.includes('/sql')) {
      try {
        return jsonResponse(neonEncode(dbRespond(body.query, body.params ?? [])))
      } catch (error) {
        const errorResponse = postgresErrorHttpResponse(error)
        if (errorResponse) return errorResponse
        throw error
      }
    }
    if (url.includes('base-rpc.test')) {
      const result = body.method === 'eth_blockNumber'
        ? '0x100'
        : body.method === 'eth_getTransactionReceipt'
        ? {
          status: '0x1',
          blockHash: '0x' + 'bb'.repeat(32),
          blockNumber: '0x100',
          logs: [{
            address: USDC,
            topics: [TRANSFER_TOPIC, pad32(fixtureState.current.chainFrom), pad32(fixtureState.current.chainTo)],
            data: fixtureState.current.chainTo.toLowerCase() === TREASURY.toLowerCase() ? '0x0f4240' : '0x1e8480',
          }],
        }
        : body.method === 'eth_getBlockByHash'
          ? { timestamp: '0x' + Math.floor((Date.now() - fixtureState.current.chainAgeSeconds * 1000) / 1000).toString(16) }
          : body.method === 'eth_getBlockByNumber'
            ? body.params?.[0] === 'finalized'
              ? { number: '0x100' }
              : { number: '0x100', hash: '0x' + 'bb'.repeat(32) }
          : body.method === 'eth_call'
            ? '0x0f4240'
            : body.method === 'eth_getLogs'
              ? []
              : null
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result })
    }
    if (url.includes('/verify')) return jsonResponse(fixtureState.current.facilitatorVerify
      ? { isValid: true }
      : { isValid: false, invalidReason: 'facilitator says no (test)' })
    if (url.includes('/settle')) return jsonResponse(fixtureState.current.facilitatorSettle
      ? { success: true, transaction: TX_CASE_UPPER, payer: fixtureState.current.chainFrom }
      : { success: false, errorReason: 'settlement failed (test)' })
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
}
