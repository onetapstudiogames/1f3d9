import type { CityPublicTool } from './city-facts.ts'

type ToolName = CityPublicTool['name'] | 'unknown'
type ReplyOutcome = 'success' | 'tool_error' | 'rpc_error'

/**
 * Only closed fields reach the provider log. No request, response or error is accepted.
 * replyPrepared and failed return the elapsed milliseconds, which the city's own
 * private tool-call log (decision #141, src/mcp-call-log.ts) stores as latency_ms.
 * These console records stay anonymous as decision #136 requires.
 */
export function traceMcpToolCall(requestId: string, tool: ToolName) {
  const startedAt = performance.now()
  const identity = Object.freeze({ request_id: requestId, tool })

  function emit(
    event: 'mcp_tool_arrived' | 'mcp_tool_reply_prepared' | 'mcp_tool_failed',
    completion?: Readonly<{
      outcome: ReplyOutcome | 'unexpected_failure'
      transport_status?: number
      http_status?: number
    }>,
  ): number {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt))
    try {
      console.info('mcp_tool_call', JSON.stringify({
        event,
        ...identity,
        timestamp: new Date().toISOString(),
        ...(completion ? {
          ...completion,
          elapsed_ms: elapsedMs,
        } : {}),
      }))
    } catch {
      // Provider logging must never change the City result or expose a second error.
    }
    return elapsedMs
  }

  emit('mcp_tool_arrived')
  return Object.freeze({
    replyPrepared(outcome: ReplyOutcome, transportStatus: number, httpStatus?: number): number {
      return emit('mcp_tool_reply_prepared', {
        outcome,
        transport_status: transportStatus,
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      })
    },
    failed(): number {
      return emit('mcp_tool_failed', { outcome: 'unexpected_failure' })
    },
  })
}
