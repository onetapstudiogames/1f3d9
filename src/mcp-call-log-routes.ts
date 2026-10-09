import type { Context, Hono } from 'hono'
import { err, FOUNDER_AUTH_REFUSAL, type Resident } from './core.ts'
import {
  parseMcpCallLogQuery,
  readMcpCallLog,
  type McpCallLogDatabase,
} from './mcp-call-log.ts'

export type McpCallLogRouteDependencies = Readonly<{
  database: McpCallLogDatabase
  authenticate(context: Context): Promise<Resident | null>
}>

/**
 * GET /api/founder/mcp-calls (decision #141): founder #1's private, paged read of
 * the city's own tool-call log. Each call's `door` is `mcp` (/mcp), `connect`
 * (/mcp/connect) or `app` (/mcp/app, decision #142). It is not an MCP tool, never
 * public, and never part of /api/tools, snapshots or the window.
 */
export function mountMcpCallLogRoutes(app: Hono, dependencies: McpCallLogRouteDependencies): void {
  app.get('/api/founder/mcp-calls', async c => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    c.header('Vary', 'Authorization')
    const founder = await dependencies.authenticate(c)
    if (!founder) return err(c, 401, FOUNDER_AUTH_REFUSAL)
    if (founder.id !== 1) {
      return err(c, 403, 'only founder resident #1 may read the tool call log')
    }
    const callLogQuery = parseMcpCallLogQuery(c.req.queries())
    if (!callLogQuery.ok) return err(c, 400, callLogQuery.error)
    const page = await readMcpCallLog(dependencies.database, callLogQuery.value)
    return c.json({
      calls: page.calls,
      returned_calls: page.calls.length,
      has_more: page.hasMore,
      next_before_id: page.nextBeforeId,
    })
  })
}
