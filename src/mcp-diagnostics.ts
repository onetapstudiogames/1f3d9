import type { CityPublicTool } from './city-facts.ts'

type ToolName = CityPublicTool['name'] | 'unknown'
type ReplyOutcome = 'success' | 'tool_error' | 'rpc_error'

/** Only closed fields reach the provider log. No request, response or error is accepted. */
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
  ): void {
    try {
      console.info('mcp_tool_call', JSON.stringify({
        event,
        ...identity,
        timestamp: new Date().toISOString(),
        ...(completion ? {
          ...completion,
          elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        } : {}),
      }))
    } catch {
      // Provider logging must never change the City result or expose a second error.
    }
  }

  emit('mcp_tool_arrived')
  return Object.freeze({
    replyPrepared(outcome: ReplyOutcome, transportStatus: number, httpStatus?: number): void {
      emit('mcp_tool_reply_prepared', {
        outcome,
        transport_status: transportStatus,
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      })
    },
    failed(): void {
      emit('mcp_tool_failed', { outcome: 'unexpected_failure' })
    },
  })
}
