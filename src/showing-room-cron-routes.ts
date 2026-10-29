import type { Hono } from 'hono'
import type { TaggedSql } from './engine.ts'
import { ShowingRoomRunError, type ShowingRoomRunResult } from './showing-room-runner.ts'
import { cronBearerAuthorization } from './cron-auth.ts'

export interface ShowingRoomCronDependencies {
  database: TaggedSql
  environment: Readonly<Record<string, string | undefined>>
  runShowingRoomClose(database: TaggedSql): Promise<ShowingRoomRunResult>
}

export function mountShowingRoomCronRoutes(
  app: Hono,
  dependencies: ShowingRoomCronDependencies,
): void {
  app.get('/api/internal/showing-room-close', async c => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    c.header('Vary', 'Authorization')
    if (Object.keys(c.req.queries()).length) return c.json({ error:
      'showing room close accepts no query options; retry the same path without query options' }, 400)
    const authorization = cronBearerAuthorization(dependencies.environment, c.req.header('authorization'))
    if (authorization === 'unavailable') return c.json({ error:
      'showing room close is unavailable because CRON_SECRET is not configured; the city owner must configure it before retrying' }, 503)
    if (authorization !== 'authorized') return c.json({ error:
      'showing room close authorization was rejected; retry with the configured cron bearer' }, 401)
    try { return c.json(await dependencies.runShowingRoomClose(dependencies.database)) }
    catch (error) {
      if (error instanceof ShowingRoomRunError) return c.json({ error: error.message }, 503)
      return c.json({ error:
        'the showing room count could not finish; retry the same Monday slot or ask founder #1 to review showing room status' }, 503)
    }
  })
}
