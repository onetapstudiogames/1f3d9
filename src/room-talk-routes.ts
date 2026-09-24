import type { Context, Hono } from 'hono'
import { auth, err, RESIDENT_AUTH_REFUSAL } from './core.ts'
import { moderatePublicRows } from './moderation-store.ts'
import { allowedPublicQuery, parsePublicPage, parsePublicRangeStart, utf8TextBytes } from './public-pagination.ts'
import { publicJson } from './public-output.ts'
import { positiveId } from './input.ts'
import { hasOnly, jsonObject } from './society.ts'
import { answerPing, dismissPing, invitePing } from './room-ping-store.ts'
import { readLine, readPing, readPlaceLines } from './room-talk-reads.ts'
import { sayLine } from './room-line-store.ts'
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
  lineNotFoundRefusal,
  pingReadNotFoundRefusal,
  placeLinesNotFoundRefusal,
  type TalkOutcome,
  type TalkRefusal,
} from './room-talk-contract.ts'

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
