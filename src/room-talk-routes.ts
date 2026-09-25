import type { Context, Hono } from 'hono'
import { setTimeout as timerSleep } from 'node:timers/promises'
import { auth, err, RESIDENT_AUTH_REFUSAL } from './core.ts'
import { sql } from './db.ts'
import { moderatePublicRows } from './moderation-store.ts'
import {
  allowedPublicQuery,
  parsePublicPage,
  parsePublicRangeStart,
  utf8TextBytes,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { publicJson } from './public-output.ts'
import { positiveId } from './input.ts'
import { hasOnly, jsonObject } from './society.ts'
import { answerPing, dismissPing, invitePing } from './room-ping-store.ts'
import { loadPublicChangeCheckpoint, parsePublicChangeMarker } from './public-changes.ts'
import { readLine, readPing, readPlaceLines } from './room-talk-reads.ts'
import { sayLine } from './room-line-store.ts'
import { holdWait } from './room-wait-hold.ts'
import { openWait, readWaitChanges, releaseWait } from './room-wait-store.ts'
import {
  LINE_FIELDS_REFUSAL,
  LINE_ID_REFUSAL,
  LINE_WALK_TO_READ_REFUSAL,
  PING_ANSWER_FIELDS_REFUSAL,
  PING_DISMISS_FIELDS_REFUSAL,
  PING_ID_REFUSAL,
  PING_INVITE_FIELDS_REFUSAL,
  PING_READ_ID_REFUSAL,
  PLACE_LINES_ID_REFUSAL,
  WAIT_CURSOR_REFUSAL,
  WAIT_FIELDS_REFUSAL,
  WAIT_SECONDS_REFUSAL,
  lineNotFoundRefusal,
  pingReadNotFoundRefusal,
  placeLinesNotFoundRefusal,
  requestedWaitSeconds,
  type TalkOutcome,
  type TalkRefusal,
} from './room-talk-contract.ts'

const executeTalkQuery: PublicQueryExecutor = async (text, params) =>
  await sql.query(text, [...params]) as Record<string, unknown>[]

type OutgoingCloseEmitter = Readonly<{
  once?: (event: 'close', listener: () => void) => unknown
  off?: (event: 'close', listener: () => void) => unknown
  destroyed?: boolean
}>

export function talkRefusalResponse(c: Context, refusal: TalkRefusal): Response {
  const { status, ...body } = refusal
  return c.json(body, status)
}

export function talkResponse<T>(c: Context, outcome: TalkOutcome<T>): Response {
  return outcome.ok
    ? c.json(outcome.answer, outcome.status)
    : talkRefusalResponse(c, outcome.refusal)
}

function talkWriteHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

export function mountRoomTalkRoutes(app: Hono): void {
  app.post('/api/line', async c => {
    talkWriteHeaders(c)
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['place_id', 'body', 'request_id', 'walk_to_read']))
      return talkRefusalResponse(c, LINE_FIELDS_REFUSAL)
    if (body.walk_to_read !== undefined && body.walk_to_read !== false)
      return talkRefusalResponse(c, LINE_WALK_TO_READ_REFUSAL)
    return talkResponse(c, await sayLine({
      residentId: resident.id,
      residentHandle: resident.handle,
      placeId: body.place_id,
      body: body.body,
      requestId: body.request_id,
    }))
  })

  app.post('/api/ping', async c => {
    talkWriteHeaders(c)
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['to_handle', 'request_id']))
      return talkRefusalResponse(c, PING_INVITE_FIELDS_REFUSAL)
    return talkResponse(c, await invitePing({
      residentId: resident.id,
      residentHandle: resident.handle,
      toHandle: body.to_handle,
      requestId: body.request_id,
    }))
  })

  app.post('/api/ping/:id/answer', async c => {
    talkWriteHeaders(c)
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['answer', 'request_id']))
      return talkRefusalResponse(c, PING_ANSWER_FIELDS_REFUSAL)
    return talkResponse(c, await answerPing({
      residentId: resident.id,
      residentHandle: resident.handle,
      pingId: positiveId(c.req.param('id')),
      answer: body.answer,
      requestId: body.request_id,
    }))
  })

  app.post('/api/ping/:id/dismiss', async c => {
    talkWriteHeaders(c)
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const body = await jsonObject(c)
    if (!body || !hasOnly(body, ['request_id']))
      return talkRefusalResponse(c, PING_DISMISS_FIELDS_REFUSAL)
    return talkResponse(c, await dismissPing({
      residentId: resident.id,
      pingId: positiveId(c.req.param('id')),
      requestId: body.request_id,
    }))
  })

  app.post('/api/wait-here', async c => {
    talkWriteHeaders(c)
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)

    const text = await c.req.text()
    let parsedBody: unknown = {}
    if (text.trim().length > 0) {
      try {
        parsedBody = JSON.parse(text) as unknown
      } catch {
        return talkRefusalResponse(c, WAIT_FIELDS_REFUSAL)
      }
    }
    if (
      parsedBody === null
      || typeof parsedBody !== 'object'
      || Array.isArray(parsedBody)
      || !hasOnly(parsedBody as Record<string, unknown>, [
        'after_line_change',
        'after_ping_change',
        'seconds',
      ])
    ) return talkRefusalResponse(c, WAIT_FIELDS_REFUSAL)
    const body = parsedBody as Record<string, unknown>

    const seconds = requestedWaitSeconds(body.seconds)
    if (seconds === null) return talkRefusalResponse(c, WAIT_SECONDS_REFUSAL)
    const afterLine = body.after_line_change === undefined
      ? null
      : parsePublicChangeMarker(body.after_line_change)
    const afterPing = body.after_ping_change === undefined
      ? null
      : parsePublicChangeMarker(body.after_ping_change)
    if (
      (body.after_line_change !== undefined && afterLine === null)
      || (body.after_ping_change !== undefined && afterPing === null)
    ) return talkRefusalResponse(c, WAIT_CURSOR_REFUSAL)

    const checkpoint = await loadPublicChangeCheckpoint(executeTalkQuery)
    if (
      (afterLine !== null && BigInt(afterLine) > BigInt(checkpoint))
      || (afterPing !== null && BigInt(afterPing) > BigInt(checkpoint))
    ) return talkRefusalResponse(c, WAIT_CURSOR_REFUSAL)

    const opened = await openWait({ residentId: resident.id, seconds })
    if (!opened.ok) return talkRefusalResponse(c, opened.refusal)
    const { lease } = opened.answer
    const outgoing = (c.env as { outgoing?: unknown } | undefined)?.outgoing
    const emitter = outgoing !== null && typeof outgoing === 'object'
      ? outgoing as OutgoingCloseEmitter
      : null
    const canListen = emitter !== null
      && typeof emitter.once === 'function'
      && typeof emitter.off === 'function'
    const controller = new AbortController()
    let closed = false
    const onClose = () => {
      closed = true
      controller.abort()
    }
    if (canListen) {
      emitter.once!('close', onClose)
      if (emitter.destroyed === true) onClose()
    }

    let held: Awaited<ReturnType<typeof holdWait>>
    try {
      held = await holdWait({
        seconds,
        start: {
          line: afterLine ?? checkpoint,
          ping: afterPing ?? checkpoint,
        },
        read: cursors => readWaitChanges({
          residentId: resident.id,
          leaseId: lease.lease_id,
          placeId: lease.place_id,
          cursors,
        }),
        closed: () => closed,
        sleep: milliseconds => timerSleep(milliseconds, undefined, { signal: controller.signal })
          .then(() => undefined)
          .catch(() => undefined),
        now: Date.now,
      })
    } finally {
      try {
        await releaseWait({ residentId: resident.id, leaseId: lease.lease_id })
      } catch (error) {
        console.error('wait_release_failure', error instanceof Error ? error.name : 'UnknownError')
      } finally {
        if (canListen) emitter.off!('close', onClose)
      }
    }

    const [lines, publicPings] = await Promise.all([
      moderatePublicRows('line', held.read.lines),
      moderatePublicRows('ping', held.read.pings.map(entry => entry.ping)),
    ])
    const pings = held.read.pings.map((entry, index) => ({
      ...entry,
      ping: publicPings[index]!,
    }))
    return c.json({
      place_id: lease.place_id,
      reason: held.reason === 'closed' ? 'timeout' : held.reason,
      lines,
      lines_has_more: held.read.linesHasMore,
      next_after_line_change: held.read.next.line,
      pings,
      pings_has_more: held.read.pingsHasMore,
      next_after_ping_change: held.read.next.ping,
    }, 200)
  })

  app.get('/api/line/:id', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const id = positiveId(c.req.param('id'))
    if (!id) return talkRefusalResponse(c, LINE_ID_REFUSAL)
    const line = await readLine(id)
    if (!line) return talkRefusalResponse(c, lineNotFoundRefusal(id))
    const moderated = await moderatePublicRows('line', [line])
    return publicJson(c, { line: moderated[0] })
  })

  app.get('/api/ping/:id', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const id = positiveId(c.req.param('id'))
    if (!id) return talkRefusalResponse(c, PING_READ_ID_REFUSAL)
    const ping = await readPing(id)
    if (!ping) return talkRefusalResponse(c, pingReadNotFoundRefusal(id))
    const moderated = await moderatePublicRows('ping', [ping])
    return publicJson(c, { ping: moderated[0] })
  })

  app.get('/api/place/:id/lines', async c => {
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['before_line_id', 'after_line_id', 'limit'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const parsed = parsePublicPage(queries, 'before_line_id', 'limit')
    if (!parsed.ok) return err(c, 400, parsed.error)
    const rangeStart = parsePublicRangeStart(queries, 'after_line_id', parsed.cursor)
    if (!rangeStart.ok) return err(c, 400, rangeStart.error)
    const placeId = positiveId(c.req.param('id'))
    if (!placeId) return talkRefusalResponse(c, PLACE_LINES_ID_REFUSAL)
    const result = await readPlaceLines({
      placeId,
      beforeLineId: parsed.cursor,
      afterLineId: rangeStart.value,
      limit: parsed.limit,
    })
    if (!result.placeExists) return talkRefusalResponse(c, placeLinesNotFoundRefusal(placeId))
    const lines = await moderatePublicRows('line', result.lines)
    return publicJson(c, {
      place_id: placeId,
      lines,
      lines_page: {
        total_items: result.totalItems,
        total_text_bytes: result.totalTextBytes,
        returned_items: lines.length,
        returned_text_bytes: utf8TextBytes(lines, 'body'),
        has_more: result.hasMore,
        next_before_line_id: result.hasMore ? result.lines.at(-1)?.id ?? null : null,
      },
    })
  })
}
