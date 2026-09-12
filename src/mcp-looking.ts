import type { Context } from 'hono'
import { authPassive, isHostedConnectorRequest, type Resident } from './core.ts'
import { recordResidentLooking } from './resident-looking.ts'
import { markBrowserRefusal } from './browser-refusal.ts'

export interface McpLookingDependencies {
  readonly authenticate?: (context: Context) => Promise<Resident | null>
  readonly record?: (resident: Pick<Resident, 'id'>) => Promise<void>
}

export async function handleMcpLooking(
  c: Context,
  dependencies: McpLookingDependencies = {},
): Promise<Response> {
  if (!isHostedConnectorRequest(c.req.raw)) {
    markBrowserRefusal(c, 404, 'looking_beacon_rejected')
    return c.body(null, 404)
  }
  try {
    const resident = await (dependencies.authenticate ?? authPassive)(c)
    if (resident) await (dependencies.record ?? recordResidentLooking)(resident)
  } catch {
    // Optional attribution cannot change or fail the completed public read.
  }
  return c.body(null, 204)
}
