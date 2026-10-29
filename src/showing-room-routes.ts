import type { Context, Hono } from 'hono'
import { declaredBodyLength } from './bounded-body.ts'
import { publicText } from './input.ts'
import { showingRoomSchedule } from './showing-room-schedule.ts'

export type ShowingRoomOperationResult = Readonly<
  | { ok: true; value: unknown; created?: boolean }
  | { ok: false; status: 400 | 404 | 409 | 429 | 503; error: string; retry_after?: number }
>

export interface ShowingRoomRouteDependencies {
  authRootKey(c: Context): Promise<Readonly<{ id: number }> | null>
  list(input: Readonly<{ before_id: number | null; before_run_id: number | null; limit: number }>): Promise<ShowingRoomOperationResult>
  add(input: Readonly<{ request_id: string; title: string; prompt: string }>): Promise<ShowingRoomOperationResult>
  edit(id: number, input: Readonly<{
    expected_revision: number
    title?: string
    prompt?: string
    state?: 'cancelled'
  }>): Promise<ShowingRoomOperationResult>
  control(input: Readonly<Record<string, unknown>>): Promise<ShowingRoomOperationResult>
}

const MAX_BODY_BYTES = 16_384
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
type Json = Readonly<Record<string, unknown>>

function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fields(input: Json, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(input, key))
    && Object.keys(input).every(key => required.includes(key) || optional.includes(key))
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
}

function questionText(value: unknown, maximum: number, singleLine = false): value is string {
  return publicText(value, { maximumCharacters: maximum }) !== null
    && (!singleLine || !/[\r\n\t]/u.test(value as string))
}

function requestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value) && publicText(value) !== null
}

function manualLegacy(value: unknown): boolean {
  if (!object(value) || !fields(value, ['rules_note_id', 'count_note_id', 'winner_note_ids', 'credit_source_keys'])) return false
  const winners = value.winner_note_ids
  const keys = value.credit_source_keys
  return value.rules_note_id === 40225 && positive(value.count_note_id) && value.count_note_id !== 40225
    && Array.isArray(winners) && winners.length <= 100 && winners.every(positive)
    && new Set(winners).size === winners.length && !winners.includes(40225)
    && Array.isArray(keys) && keys.length <= 100
    && keys.every(key => typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(key) && publicText(key) !== null)
    && new Set(keys).size === keys.length && (winners.length === 0) === (keys.length === 0)
}

function controlValid(input: Json): boolean {
  if (!requestId(input.request_id)) return false
  if (input.action === 'pause' || input.action === 'resume') return fields(input, ['request_id', 'action'])
  if (input.action === 'square') return fields(input, ['request_id', 'action', 'enabled']) && typeof input.enabled === 'boolean'
  if (input.action !== 'activate') return false
  return fields(input, ['request_id', 'action', 'first_slot', 'first_question_number', 'manual_legacy'])
    && typeof input.first_slot === 'string' && showingRoomSchedule(input.first_slot) !== null
    && positive(input.first_question_number) && input.first_question_number >= 11
    && manualLegacy(input.manual_legacy)
}

async function body(c: Context): Promise<Json | Response> {
  if (declaredBodyLength(c.req.header('content-length'), MAX_BODY_BYTES) === 'unusable') {
    return c.json({ error: 'Content-Length must be one decimal byte count no larger than 16384, or omitted' }, 400)
  }
  const raw = await c.req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return c.json({ error: 'showing room request bodies are limited to 16384 bytes' }, 413)
  try {
    const parsed: unknown = JSON.parse(raw)
    if (object(parsed)) return parsed
  } catch { /* The same JSON object refusal covers malformed JSON. */ }
  return c.json({ error: 'body must be a JSON object' }, 400)
}

function answer(c: Context, result: ShowingRoomOperationResult): Response {
  if (result.ok) return c.json(result.value as object, result.created ? 201 : 200)
  if (result.retry_after !== undefined) c.header('Retry-After', String(result.retry_after))
  return c.json({ error: result.error }, result.status)
}

function queryNumber(c: Context, name: string, maximum: number): number | null | false {
  const values = c.req.queries(name)
  if (!values) return null
  if (values.length !== 1 || !/^[0-9]+$/u.test(values[0]!)) return false
  const value = Number(values[0])
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : false
}

export function mountShowingRoomRoutes(app: Hono, dependencies: ShowingRoomRouteDependencies): void {
  const guarded = (handle: (c: Context) => Promise<Response>) => async (c: Context): Promise<Response> => {
    c.header('Cache-Control', 'private, no-store')
    c.header('Pragma', 'no-cache')
    c.header('Vary', 'Authorization')
    try {
      const founder = await dependencies.authRootKey(c)
      if (!founder) return c.json({ error: 'use the resident root key of founder resident #1 to manage the showing room' }, 401)
      if (founder.id !== 1) return c.json({ error: 'only founder resident #1 may manage the showing room' }, 403)
      const allowed = c.req.method === 'GET' ? ['before_id', 'before_run_id', 'limit'] : []
      if (Object.keys(c.req.queries()).some(key => !allowed.includes(key))) return c.json({ error: 'remove unsupported showing room query options and retry' }, 400)
      return await handle(c)
    } catch {
      if (c.req.method === 'PATCH') return c.json({ error: 'the showing room edit result is temporarily unavailable; read the current question revision before editing again' }, 503)
      return c.json({ error: 'the showing room backlog is temporarily unavailable; retry the read, or retry a change with its original request_id' }, 503)
    }
  }
  app.get('/api/founder/showing-room', guarded(async c => {
    const beforeId = queryNumber(c, 'before_id', 2_147_483_647)
    const beforeRunId = queryNumber(c, 'before_run_id', 2_147_483_647)
    const limit = queryNumber(c, 'limit', 100)
    if (beforeId === false || beforeRunId === false || limit === false) return c.json({ error: 'send each cursor once as a positive integer and limit once from 1 to 100' }, 400)
    return answer(c, await dependencies.list({ before_id: beforeId, before_run_id: beforeRunId, limit: limit ?? 20 }))
  }))
  app.post('/api/founder/showing-room/contests', guarded(async c => {
    const input = await body(c)
    if (input instanceof Response) return input
    if (!fields(input, ['request_id', 'title', 'prompt']) || !requestId(input.request_id)
      || !questionText(input.title, 120, true) || !questionText(input.prompt, 1800)) {
      return c.json({ error: 'send only request_id, title and prompt; request_id starts with a letter or number and has 1 to 128 letters, numbers, dots, underscores, colons or hyphens, title is 1 to 120 plain characters on one line, and prompt is 1 to 1800 plain characters' }, 400)
    }
    return answer(c, await dependencies.add({ request_id: input.request_id, title: input.title, prompt: input.prompt }))
  }))
  app.patch('/api/founder/showing-room/contests/:id', guarded(async c => {
    const rawId = c.req.param('id') ?? ''
    const id = Number(rawId)
    if (!positive(id) || !/^[0-9]+$/u.test(rawId)) return c.json({ error: 'question id must be a positive integer' }, 400)
    const input = await body(c)
    if (input instanceof Response) return input
    if (!fields(input, ['expected_revision'], ['title', 'prompt', 'state']) || !positive(input.expected_revision)
      || Object.keys(input).length < 2 || ('title' in input && !questionText(input.title, 120, true))
      || ('prompt' in input && !questionText(input.prompt, 1800)) || ('state' in input && input.state !== 'cancelled')) {
      return c.json({ error: 'send expected_revision as a positive integer and at least one of title, prompt or state cancelled; only queued questions can change, within the published text limits' }, 400)
    }
    return answer(c, await dependencies.edit(id, input as { expected_revision: number; title?: string; prompt?: string; state?: 'cancelled' }))
  }))
  app.post('/api/founder/showing-room/control', guarded(async c => {
    const input = await body(c)
    if (input instanceof Response) return input
    if (!controlValid(input)) return c.json({ error: 'send request_id and action pause or resume; square also needs boolean enabled; activate needs a Monday 15:00 UTC first_slot with four-digit years for opening and both closes, first_question_number at least 11, and the documented manual question ten handover' }, 400)
    return answer(c, await dependencies.control(input))
  }))
}
