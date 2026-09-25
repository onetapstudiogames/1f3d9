import type { MiddlewareHandler } from 'hono'
import { authenticatedResidentId } from './core.ts'
import { moderatePublicRows } from './moderation-store.ts'
import { readPendingSummary } from './room-receipt-store.ts'
import { PENDING_PINGS_NEXT_STEP, type PendingPing } from './room-talk-contract.ts'

const MAX_JSON_BODY_BYTES = 262_144

export async function moderatePendingPingRows(
  receipts: readonly PendingPing[],
): Promise<readonly (Record<string, unknown> & { ping_id: number })[]> {
  const rows = receipts.map(({ ping_id, ...receipt }) => ({ ...receipt, id: ping_id }))
  const moderated = await moderatePublicRows('ping', rows)
  return moderated.map(row => {
    const { id, ...receipt } = row as Record<string, unknown>
    return { ping_id: Number(id), ...receipt }
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

export function pendingPingSummary(read = readPendingSummary): MiddlewareHandler {
  return async (c, next) => {
    await next()

    const residentId = authenticatedResidentId(c.req.raw)
    const path = c.req.path
    if (
      c.req.header('x-1f3d9-tool-call') !== '1'
      || !path.startsWith('/api/')
      || path === '/api/me'
      || residentId === null
      || (c.res.status !== 200 && c.res.status !== 201)
    ) return

    const mediaType = c.res.headers.get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) return

    const originalText = await c.res.clone().text()
    if (new TextEncoder().encode(originalText).byteLength > MAX_JSON_BODY_BYTES) return

    let original: unknown
    try {
      original = JSON.parse(originalText) as unknown
    } catch {
      return
    }
    if (!isPlainObject(original)) return

    try {
      const summary = await read(residentId)
      if (summary.total === 0) return
      const [newest] = summary.newest === null
        ? []
        : await moderatePendingPingRows([summary.newest])
      const answer = {
        pending_pings: {
          total: summary.total,
          senders: summary.senders,
          newest: newest ?? null,
          next_pending_before_ping_id: summary.nextBeforePingId,
          next_step: PENDING_PINGS_NEXT_STEP,
        },
        ...original,
      }
      const headers = new Headers(c.res.headers)
      headers.delete('content-length')
      c.res = new Response(JSON.stringify(answer), {
        status: c.res.status,
        statusText: c.res.statusText,
        headers,
      })
    } catch (error) {
      console.error('pending_ping_summary_failure', error instanceof Error ? error.name : typeof error)
    }
  }
}
