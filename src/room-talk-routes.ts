import type { Context, Hono } from 'hono'
import { setTimeout as timerSleep } from 'node:timers/promises'
import { auth, err, isHostedConnectorRequest, RESIDENT_AUTH_REFUSAL } from './core.ts'
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
import { readTalkNow, TALK_NOW_CREDENTIAL_HEADERS } from './talk-now.ts'
import { TALK_PRIVATE_CACHE_CONTROL, TALK_SHARED_CACHE_CONTROL } from './talk-watch-limits.ts'
import { sayLine } from './room-line-store.ts'
import { holdWait, type WaitRead } from './room-wait-hold.ts'
import {
  filterFields,
  filterOne,
  filterRows,
  HIDDEN_REFUSAL,
  judgeRead,
  markReaderShaped,
  mutedReadAnswer,
  mutesFields,
  parseHidden,
  readerShape,
  readFilter,
  residentReaderShape,
  rowIds,
  splitMuted,
  splitMutedResidents,
  type HiddenOutline,
  type ReaderShape,
} from './reader-filter.ts'
import { fillMutedPage } from './page-fill.ts'
import { openWait, readListening, readWaitChanges, releaseWait } from './room-wait-store.ts'
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
  WAIT_LISTENING_HERE_MAX,
  WAIT_SECONDS_REFUSAL,
  WAIT_TIMEOUT_NEXT_STEP,
  lineNotFoundRefusal,
  pingReadNotFoundRefusal,
  placeLinesNotFoundRefusal,
  requestedWaitSeconds,
  type WaitAnswer,
  type WaitDoor,
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

/**
 * Mutes (decision #156) inside a wait: the reader's muted lines and pings are dropped
 * before the wait decides to return, so they never end it early; the cursors still move
 * past them, and each dropped one is counted once.
 */
async function withoutMuted(
  shape: ReaderShape | null,
  read: WaitRead,
  hidden: HiddenOutline[],
): Promise<WaitRead> {
  if (shape?.mutes == null || (read.lines.length === 0 && read.pings.length === 0)) return read
  const judge = await judgeRead(shape, {
    line: rowIds(read.lines),
    ping: read.pings.map(entry => entry.ping.id),
  })
  const lines = splitMuted(judge, 'line', read.lines)
  const pings = read.pings.filter(entry => !judge?.hides('ping', entry.ping.id))
  hidden.push(
    ...lines.hidden,
    ...read.pings.filter(entry => !pings.includes(entry)).map(entry => judge!.outline('ping', entry.ping.id)),
  )
  return { ...read, lines: lines.shown, pings }
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

    const door: WaitDoor = isHostedConnectorRequest(c.req.raw) ? 'hosted_chat' : 'coding'
    const seconds = requestedWaitSeconds(body.seconds, door)
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

    // The reader's mutes are loaded once per wait, not once per poll.
    const shape = await residentReaderShape(resident.id, false)
    const hiddenInWait: HiddenOutline[] = []
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
    // Decision 148: a wait that returns with an arrival or at its end keeps its cue a short
    // while; a move, a connection close the city saw, or a failure ends it at once.
    let lingers = false
    try {
      held = await holdWait({
        seconds,
        start: {
          line: afterLine ?? checkpoint,
          ping: afterPing ?? checkpoint,
        },
        read: async cursors => withoutMuted(shape, await readWaitChanges({
          residentId: resident.id,
          leaseId: lease.lease_id,
          placeId: lease.place_id,
          cursors,
        }), hiddenInWait),
        closed: () => closed,
        sleep: milliseconds => timerSleep(milliseconds, undefined, { signal: controller.signal })
          .then(() => undefined)
          .catch(() => undefined),
        now: Date.now,
      })
      lingers = held.reason === 'change' || held.reason === 'timeout'
    } finally {
      try {
        await releaseWait({ residentId: resident.id, leaseId: lease.lease_id, linger: lingers })
      } catch (error) {
        console.error('wait_release_failure', error instanceof Error ? error.name : 'UnknownError')
      } finally {
        if (canListen) emitter.off!('close', onClose)
      }
    }

    const [lines, publicPings, listening] = await Promise.all([
      moderatePublicRows('line', held.read.lines),
      moderatePublicRows('ping', held.read.pings.map(entry => entry.ping)),
      readListening({
        placeId: lease.place_id,
        limit: WAIT_LISTENING_HERE_MAX,
        excludeResidentId: resident.id,
      }),
    ])
    const pings = held.read.pings.map((entry, index) => ({
      ...entry,
      ping: publicPings[index]!,
    }))
    const listeningJudge = await judgeRead(shape, { line: rowIds(lines) })
    const shownListening = splitMutedResidents(listeningJudge, listening.residents, lease.place_id)
    // Reading filters (decision #157): each line's words, after the wait decided.
    const lineFilter = readFilter(shape, listeningJudge)
    const reason = held.reason === 'closed' ? 'timeout' : held.reason
    return c.json({
      place_id: lease.place_id,
      reason,
      ...(reason === 'timeout' ? { next_step: WAIT_TIMEOUT_NEXT_STEP } : {}),
      lines: filterRows(lineFilter, 'line', lines),
      lines_has_more: held.read.linesHasMore,
      next_after_line_change: held.read.next.line,
      pings,
      pings_has_more: held.read.pingsHasMore,
      next_after_ping_change: held.read.next.ping,
      listening_here: shownListening.shown,
      listening_here_page: {
        total_items: listening.total,
        returned_items: shownListening.shown.length,
        has_more: listening.total > listening.residents.length,
      },
      ...mutesFields(shape, [...hiddenInWait, ...shownListening.hidden], false),
      ...filterFields(lineFilter),
    } satisfies WaitAnswer, 200)
  })

  app.get('/api/line/:id', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const id = positiveId(c.req.param('id'))
    if (!id) return talkRefusalResponse(c, LINE_ID_REFUSAL)
    const line = await readLine(id)
    if (!line) return talkRefusalResponse(c, lineNotFoundRefusal(id))
    const moderated = await moderatePublicRows('line', [line])
    // Mutes (decision #156): a muted line read by its id sends only its outline.
    const reader = await readerShape(c, false)
    markReaderShaped(c, reader)
    const judge = await judgeRead(reader, { line: [id] })
    if (judge?.hides('line', id)) return publicJson(c, mutedReadAnswer('line', judge.outline('line', id)))
    // Reading filters (decision #157): the line's words through the reader's filters.
    const filter = readFilter(reader, judge)
    return publicJson(c, { line: filterOne(filter, 'line', moderated[0]), ...filterFields(filter) })
  })

  app.get('/api/ping/:id', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const id = positiveId(c.req.param('id'))
    if (!id) return talkRefusalResponse(c, PING_READ_ID_REFUSAL)
    const ping = await readPing(id)
    if (!ping) return talkRefusalResponse(c, pingReadNotFoundRefusal(id))
    const moderated = await moderatePublicRows('ping', [ping])
    // Mutes (decision #156): a ping from a muted resident read by its id sends only its outline.
    const reader = await readerShape(c, false)
    markReaderShaped(c, reader)
    const judge = await judgeRead(reader, { ping: [id] })
    if (judge?.hides('ping', id)) return publicJson(c, mutedReadAnswer('ping', judge.outline('ping', id)))
    return publicJson(c, { ping: moderated[0] })
  })

  app.get('/api/place/:id/lines', async c => {
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['before_line_id', 'after_line_id', 'limit', 'hidden'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const hiddenQuery = parseHidden(queries)
    if (!hiddenQuery.ok) return err(c, 400, HIDDEN_REFUSAL)
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
    // Mutes (decision #156): muted lines are left out and counted, and a page they thinned
    // reads further lines until it is full (src/page-fill.ts); the cursor moves past them,
    // so the next page starts where this one ended.
    const reader = await readerShape(c, false)
    markReaderShaped(c, reader)
    const filled = await fillMutedPage({
      judge: await judgeRead(reader, { line: rowIds(result.lines) }),
      type: 'line',
      limit: parsed.limit,
      page: {
        items: result.lines,
        hasMore: result.hasMore,
        nextCursor: result.hasMore ? result.lines.at(-1)?.id ?? null : null,
      },
      next: async (afterId, size) => {
        const more = await readPlaceLines({ placeId, beforeLineId: afterId, afterLineId: rangeStart.value, limit: size })
        return { rows: more.lines, hasMore: more.hasMore }
      },
    })
    const linesJudge = filled.judge
    const moderated = await moderatePublicRows('line', filled.page.items)
    const muted = splitMuted(linesJudge, 'line', moderated)
    const lines = muted.shown
    // Reading filters (decision #157): each line's words; the byte counts stay the stored ones.
    const filter = readFilter(reader, linesJudge)
    // Filter the lines before counting, so the count says what this page changed.
    const filteredLines = filterRows(filter, 'line', lines)
    return publicJson(c, {
      place_id: placeId,
      ...mutesFields(reader, muted.hidden, hiddenQuery.outline),
      ...filterFields(filter),
      lines: filteredLines,
      lines_page: {
        total_items: result.totalItems,
        total_text_bytes: result.totalTextBytes,
        returned_items: lines.length,
        returned_text_bytes: utf8TextBytes(lines, 'body'),
        has_more: filled.page.hasMore,
        next_before_line_id: filled.page.nextCursor,
      },
    })
  })

  app.get('/api/talk/now', async c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const answer = await readTalkNow(executeTalkQuery)
    // The pending-ping summary may add a resident's pings to an answer sent with a key,
    // so an answer to any request carrying a credential is never shared.
    const personal = TALK_NOW_CREDENTIAL_HEADERS.some(name => Boolean(c.req.header(name)))
    c.header('Cache-Control', personal ? TALK_PRIVATE_CACHE_CONTROL : TALK_SHARED_CACHE_CONTROL)
    return publicJson(c, answer)
  })
}
