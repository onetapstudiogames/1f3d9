// Agreement thing links (decision #179): an agreement may name up to 16 things it is
// about, written once with the agreement. A link moves nothing, records no end, adds no
// consent and enforces nothing (#4). Every agreement read shows each linked thing's
// status as of that read: active, ends on a date, ended, or withdrawn. The status is
// judged at the database's transaction time with thing_end_due_at_row, the same clock and
// expression as every other end read, and a read never records an end (#37).

import type { AssetState } from './thing-ending-read.ts'
import type { ShortEndingStatus } from './thing-endings.ts'

/** The most things one agreement may link. */
export const MAX_AGREEMENT_THING_LINKS = 16

/** One linked thing as every agreement read shows it. */
export interface AgreementThingLink {
  readonly position: number
  readonly thing_id: number
  /** Left out for a thing a maintainer has hidden, as the v4 snapshot leaves its end out. */
  readonly asset_state?: AssetState
  /** The short status; left out when no end is set and the thing never ended, or it is withdrawn or hidden. */
  readonly ends?: ShortEndingStatus
}

/**
 * The thing_links field of a new agreement: missing means none; otherwise 0 to 16
 * different positive whole thing ids, in the order given. Null means the field is malformed.
 */
export function parseThingLinks(value: unknown): readonly number[] | null {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_AGREEMENT_THING_LINKS) return null
  const ids = value.filter((item): item is number =>
    typeof item === 'number' && Number.isSafeInteger(item) && item > 0 && item <= 2_147_483_647)
  if (ids.length !== value.length || new Set(ids).size !== ids.length) return null
  return Object.freeze([...ids])
}

/**
 * A SQL expression: the links named by `linkRows` (an SQL query yielding position and
 * thing_id) as a jsonb array in position order, with the raw facts agreementThingLinks
 * reads. Only fixed text from this module goes in here, never a caller's value.
 */
export function agreementThingLinksJson(linkRows: string): string {
  return `coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'position', link.position,
            'thing_id', link.thing_id,
            'withdrawn', linked.withdrawn_at IS NOT NULL,
            'hidden', coalesce((
              SELECT moderation.action
              FROM moderation_actions moderation
              WHERE moderation.target_type = 'thing' AND moderation.target_id = link.thing_id
              ORDER BY moderation.created_at DESC, moderation.id DESC
              LIMIT 1
            ), 'restore') = 'remove',
            'has_end', linked.ending_rule IS NOT NULL,
            'ended_at', date_trunc('milliseconds', linked.ended_at),
            'due_at', date_trunc('milliseconds', judged.due_at),
            'reached', linked.ended_at IS NOT NULL
              OR coalesce(judged.due_at <= transaction_timestamp(), false)
          ) ORDER BY link.position)
          FROM (${linkRows}) link
          JOIN things linked ON linked.id = link.thing_id
          CROSS JOIN LATERAL (SELECT thing_end_due_at_row(linked) AS due_at) judged
        ), '[]'::jsonb)`
}

/** The stored links of one agreement; `agreementId` is an SQL expression naming it, such as a.id. */
export function agreementThingLinksSql(agreementId: string): string {
  return agreementThingLinksJson(
    `SELECT stored.position, stored.thing_id FROM agreement_thing_links stored WHERE stored.agreement_id = ${agreementId}`,
  )
}

const RAW_SQL = Symbol('agreement thing links SQL')

/** Fixed SQL text from this module, spliced into a tagged statement by withAgreementLinkSql. */
export interface AgreementLinkSql {
  readonly [RAW_SQL]: string
}

export function agreementLinkSql(text: string): AgreementLinkSql {
  return Object.freeze({ [RAW_SQL]: text })
}

function isAgreementLinkSql(value: unknown): value is AgreementLinkSql {
  return typeof value === 'object' && value !== null && typeof (value as Partial<AgreementLinkSql>)[RAW_SQL] === 'string'
}

type Tagged = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

/** A tagged call that writes AgreementLinkSql values as text and passes every other value as a parameter. */
export function withAgreementLinkSql<Database extends Tagged>(database: Database): Tagged {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const texts: string[] = [strings[0] ?? '']
    const params: unknown[] = []
    values.forEach((value, index) => {
      const suffix = strings[index + 1] ?? ''
      if (isAgreementLinkSql(value)) {
        texts[texts.length - 1] = `${texts[texts.length - 1]}${value[RAW_SQL]}${suffix}`
      } else {
        params.push(value)
        texts.push(suffix)
      }
    })
    const template = Object.freeze(Object.assign([...texts], { raw: Object.freeze([...texts]) }))
    return database(template as unknown as TemplateStringsArray, ...params)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function shortStatus(facts: Record<string, unknown>): ShortEndingStatus | null {
  const endedAt = iso(facts.ended_at)
  if (endedAt !== null) return { state: 'ended', at: endedAt }
  if (facts.has_end !== true) return null
  return { state: facts.reached === true ? 'ended' : 'set', at: iso(facts.due_at) }
}

function linkFrom(facts: unknown): AgreementThingLink | null {
  if (!isRecord(facts)) return null
  const position = facts.position
  const thingId = facts.thing_id
  if (typeof position !== 'number' || !Number.isSafeInteger(position)) return null
  if (typeof thingId !== 'number' || !Number.isSafeInteger(thingId)) return null
  if (facts.hidden === true) return Object.freeze({ position, thing_id: thingId })
  if (facts.withdrawn === true) return Object.freeze({ position, thing_id: thingId, asset_state: 'withdrawn' })
  const ends = shortStatus(facts)
  return Object.freeze({
    position,
    thing_id: thingId,
    asset_state: facts.reached === true ? 'remnant' : 'active',
    ...(ends === null ? {} : { ends }),
  })
}

/** The public links from the raw jsonb agreementThingLinksSql selects; [] when none or unreadable. */
export function agreementThingLinks(value: unknown): readonly AgreementThingLink[] {
  if (!Array.isArray(value)) return Object.freeze([])
  return Object.freeze(value.flatMap(facts => linkFrom(facts) ?? []))
}
