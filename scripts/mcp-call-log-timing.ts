import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { neon } from '@neondatabase/serverless'
import { recordMcpCall, type McpCallLogDatabase } from '../src/mcp-call-log.ts'

/**
 * Real-network timing for decision #141 after the Preview migration: 200 inserts over
 * Neon HTTP, exactly the city's write, then p50 and p95, then it deletes its own rows by
 * request_id. It reads the Preview URL inside this process and never prints it.
 *
 *   CONFIRM_MCP_CALL_LOG_TIMING=PREVIEW_ONLY PREVIEW_DATABASE_URL_UNPOOLED=... \
 *     node --experimental-strip-types scripts/mcp-call-log-timing.ts
 */

export const TIMING_INSERTS = 200
const CONFIRMATION = 'PREVIEW_ONLY'

export function timingDatabaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  if (environment.CONFIRM_MCP_CALL_LOG_TIMING !== CONFIRMATION) {
    throw new Error(`set CONFIRM_MCP_CALL_LOG_TIMING=${CONFIRMATION}; this script writes and deletes test rows in Preview only`)
  }
  const url = environment.PREVIEW_DATABASE_URL_UNPOOLED?.trim()
  if (!url || !/^postgres(?:ql)?:\/\//u.test(url)) {
    throw new Error('PREVIEW_DATABASE_URL_UNPOOLED must be the Preview Postgres URL')
  }
  return url
}

export function percentileMs(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new RangeError('no timing samples')
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!
}

export async function timeInserts(
  database: McpCallLogDatabase,
  count = TIMING_INSERTS,
): Promise<{ samples: number[]; requestIds: string[] }> {
  const samples: number[] = []
  const requestIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    const requestId = randomUUID()
    requestIds.push(requestId)
    const started = performance.now()
    await recordMcpCall(database, {
      door: 'mcp', tool: 'unknown', clientFamily: 'other',
      requestId, outcome: 'ok', refusalClass: null, httpStatus: null, latencyMs: 0,
    })
    samples.push(performance.now() - started)
  }
  return { samples, requestIds }
}

async function main(): Promise<void> {
  const client = neon(timingDatabaseUrl(process.env))
  const database: McpCallLogDatabase = {
    query: async (text, params = []) => await client.query(text, [...params]) as Record<string, unknown>[],
  }
  const { samples, requestIds } = await timeInserts(database)
  try {
    console.log(JSON.stringify({
      inserts: samples.length,
      p50_ms: Number(percentileMs(samples, 0.5).toFixed(1)),
      p95_ms: Number(percentileMs(samples, 0.95).toFixed(1)),
      max_ms: Number(Math.max(...samples).toFixed(1)),
    }))
  } finally {
    const deleted = await database.query(
      'DELETE FROM mcp_call_log WHERE request_id = ANY($1::uuid[]) RETURNING id',
      [requestIds],
    )
    console.log(JSON.stringify({ deleted_rows: deleted.length }))
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Only our own guard messages are printed in full; a driver error may carry connection detail.
    const own = error instanceof Error && /^(?:set CONFIRM_|PREVIEW_DATABASE_URL_UNPOOLED must)/u.test(error.message)
    console.error(own ? (error as Error).message : `timing failed: ${error instanceof Error ? error.name : 'Error'}`)
    process.exitCode = 1
  })
}
