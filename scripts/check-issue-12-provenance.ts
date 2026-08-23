import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const PUBLIC_ORIGIN = 'https://1f3d9.com'
const LEFT_LUGGAGE_PLACE_ID = 7
const TARGET_THING_IDS = Object.freeze([31, 34, 35, 36, 37, 38] as const)
const PAGE_LIMIT = 200
const MAX_PAGES = 100

type ProbeOptions = Readonly<{
  fetcher?: typeof fetch
}>

type ProvenanceHeading = Readonly<{
  thing_id: number
  place_id: number
  maker_id: number
  made_by: string
  current_owner_id: number
  current_owner: string
  name: string
  body_text_bytes: number
}>

type DirectThing = ProvenanceHeading & Readonly<{
  body: string
}>

export type Issue12ProvenanceRecord = Readonly<{
  thing_id: number
  place_id: number
  maker_id: number
  current_owner_id: number
  title_text_bytes: number
  title_sha256: string
  body_text_bytes: number
  body_sha256: string
}>

export type Issue12ProvenanceResult = Readonly<{
  records: readonly Issue12ProvenanceRecord[]
}>

function invalidResponse(): never {
  throw new Error('Issue #12 provenance response is invalid')
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function publicHandle(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)
    ? value
    : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requestInit(): RequestInit {
  return {
    method: 'GET',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  }
}

async function readPublicJson(
  fetcher: typeof fetch,
  url: URL,
  surface: 'search' | 'place' | 'thing',
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetcher(url, requestInit())
  } catch {
    throw new Error(`Issue #12 public ${surface} request failed`)
  }
  if (!response.ok) {
    throw new Error(`Issue #12 public ${surface} request failed with HTTP ${response.status}`)
  }
  const payload = object(await response.json().catch(() => null))
  if (payload === null) invalidResponse()
  return payload
}

function heading(value: unknown, expectedPlaceId?: number): ProvenanceHeading {
  const row = object(value)
  if (row === null || Object.hasOwn(row, 'body')) invalidResponse()
  const thingId = positiveInteger(row.id)
  const placeId = positiveInteger(row.place_id ?? expectedPlaceId)
  const makerId = positiveInteger(row.maker_id)
  const madeBy = publicHandle(row.made_by)
  const currentOwnerId = positiveInteger(row.current_owner_id)
  const currentOwner = publicHandle(row.current_owner)
  const name = typeof row.name === 'string' ? row.name : null
  const bodyTextBytes = nonnegativeInteger(row.body_text_bytes)
  if (
    thingId === null || placeId === null || makerId === null || madeBy === null ||
    currentOwnerId === null || currentOwner === null || name === null || bodyTextBytes === null
  ) {
    invalidResponse()
  }
  return Object.freeze({
    thing_id: thingId,
    place_id: placeId,
    maker_id: makerId,
    made_by: madeBy,
    current_owner_id: currentOwnerId,
    current_owner: currentOwner,
    name,
    body_text_bytes: bodyTextBytes,
  })
}

function hasThingId(rows: readonly ProvenanceHeading[], id: number): boolean {
  return rows.some(row => row.thing_id === id)
}

function appendUniqueHeadings(
  previous: readonly ProvenanceHeading[],
  additions: readonly unknown[],
  expectedPlaceId?: number,
): readonly ProvenanceHeading[] {
  return additions.reduce<readonly ProvenanceHeading[]>((rows, value) => {
    const parsed = heading(value, expectedPlaceId)
    if (hasThingId(rows, parsed.thing_id)) invalidResponse()
    return Object.freeze([...rows, parsed])
  }, previous)
}

async function readSearchHeadings(fetcher: typeof fetch): Promise<readonly ProvenanceHeading[]> {
  let rows: readonly ProvenanceHeading[] = Object.freeze([])
  let cursor: string | null = null
  let seenCursors: readonly string[] = Object.freeze([])

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL('/api/search', PUBLIC_ORIGIN)
    url.searchParams.set('q', 'addendum')
    url.searchParams.set('mode', 'words')
    url.searchParams.set('type', 'thing')
    url.searchParams.set('limit', String(PAGE_LIMIT))
    if (cursor !== null) url.searchParams.set('before', cursor)
    const payload = await readPublicJson(fetcher, url, 'search')
    const results = Array.isArray(payload.results) ? payload.results : null
    const returnedItems = nonnegativeInteger(payload.returned_items)
    const returnedTextBytes = nonnegativeInteger(payload.returned_text_bytes)
    if (
      results === null || returnedItems !== results.length || returnedTextBytes !== 0 ||
      typeof payload.has_more !== 'boolean'
    ) {
      invalidResponse()
    }
    for (const result of results) {
      if (object(result)?.type !== 'thing') invalidResponse()
    }
    rows = appendUniqueHeadings(rows, results)
    if (!payload.has_more) {
      if (payload.next_before !== null) invalidResponse()
      return rows
    }
    const next = typeof payload.next_before === 'string' && payload.next_before.length > 0
      ? payload.next_before
      : null
    if (next === null || seenCursors.includes(next)) invalidResponse()
    seenCursors = Object.freeze([...seenCursors, next])
    cursor = next
  }
  invalidResponse()
}

async function readPlaceHeadings(fetcher: typeof fetch): Promise<readonly ProvenanceHeading[]> {
  let rows: readonly ProvenanceHeading[] = Object.freeze([])
  let cursor: number | null = null
  let seenCursors: readonly number[] = Object.freeze([])

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`/api/place/${LEFT_LUGGAGE_PLACE_ID}`, PUBLIC_ORIGIN)
    url.searchParams.set('view', 'outline')
    url.searchParams.set('thing_limit', String(PAGE_LIMIT))
    if (cursor !== null) url.searchParams.set('before_thing_id', String(cursor))
    const payload = await readPublicJson(fetcher, url, 'place')
    const place = object(payload.place)
    const things = Array.isArray(payload.things) ? payload.things : null
    const thingsPage = object(payload.things_page)
    if (
      positiveInteger(place?.id) !== LEFT_LUGGAGE_PLACE_ID || payload.view !== 'outline' ||
      things === null || thingsPage === null ||
      nonnegativeInteger(thingsPage.returned_items) !== things.length ||
      nonnegativeInteger(thingsPage.returned_text_bytes) !== 0 ||
      typeof thingsPage.has_more !== 'boolean'
    ) {
      invalidResponse()
    }
    rows = appendUniqueHeadings(rows, things, LEFT_LUGGAGE_PLACE_ID)
    if (!thingsPage.has_more) {
      if (thingsPage.next_before_thing_id !== null) invalidResponse()
      return rows
    }
    const next = positiveInteger(thingsPage.next_before_thing_id)
    if (next === null || seenCursors.includes(next)) invalidResponse()
    seenCursors = Object.freeze([...seenCursors, next])
    cursor = next
  }
  invalidResponse()
}

async function readDirectThing(fetcher: typeof fetch, expectedId: number): Promise<DirectThing> {
  const url = new URL(`/api/thing/${expectedId}`, PUBLIC_ORIGIN)
  const payload = await readPublicJson(fetcher, url, 'thing')
  const row = object(payload.thing)
  if (
    row === null || positiveInteger(row.id) !== expectedId ||
    (Object.hasOwn(row, 'withdrawn_at') && row.withdrawn_at !== null)
  ) {
    invalidResponse()
  }
  const body = typeof row.body === 'string' ? row.body : null
  if (body === null) invalidResponse()
  const { body: _authoredBody, ...headingRow } = row
  const parsed = heading({ ...headingRow, body_text_bytes: Buffer.byteLength(body, 'utf8') })
  return Object.freeze({ ...parsed, body })
}

function sameProvenanceAndHeading(
  heading_: ProvenanceHeading,
  direct: DirectThing,
): boolean {
  return (
    heading_.thing_id === direct.thing_id && heading_.place_id === direct.place_id &&
    heading_.maker_id === direct.maker_id && heading_.made_by === direct.made_by &&
    heading_.current_owner_id === direct.current_owner_id &&
    heading_.current_owner === direct.current_owner && heading_.name === direct.name &&
    heading_.body_text_bytes === Buffer.byteLength(direct.body, 'utf8')
  )
}

export async function readIssue12Provenance(
  options: ProbeOptions = {},
): Promise<Issue12ProvenanceResult> {
  const fetcher = options.fetcher ?? fetch
  const searchRows = await readSearchHeadings(fetcher)
  const placeRows = await readPlaceHeadings(fetcher)
  const directRows = await Promise.all(
    TARGET_THING_IDS.map(id => readDirectThing(fetcher, id)),
  )

  const records = directRows.map(direct => {
    const search = searchRows.find(row => row.thing_id === direct.thing_id)
    const place = placeRows.find(row => row.thing_id === direct.thing_id)
    if (
      search === undefined || place === undefined ||
      !sameProvenanceAndHeading(search, direct) || !sameProvenanceAndHeading(place, direct)
    ) {
      invalidResponse()
    }
    return Object.freeze({
      thing_id: direct.thing_id,
      place_id: direct.place_id,
      maker_id: direct.maker_id,
      current_owner_id: direct.current_owner_id,
      title_text_bytes: Buffer.byteLength(direct.name, 'utf8'),
      title_sha256: sha256(direct.name),
      body_text_bytes: Buffer.byteLength(direct.body, 'utf8'),
      body_sha256: sha256(direct.body),
    })
  })
  return Object.freeze({ records: Object.freeze(records) })
}

export function formatIssue12Provenance(result: Issue12ProvenanceResult): string {
  return JSON.stringify(result, null, 2)
}

export function parseIssue12ProvenanceArguments(
  arguments_: readonly string[],
): Readonly<Record<string, never>> {
  if (arguments_.length !== 0) {
    throw new Error('The Issue #12 provenance check takes no arguments')
  }
  return Object.freeze({})
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
}

if (isMainModule()) {
  try {
    parseIssue12ProvenanceArguments(process.argv.slice(2))
    console.log(formatIssue12Provenance(await readIssue12Provenance()))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Issue #12 provenance check failed')
    process.exitCode = 1
  }
}
