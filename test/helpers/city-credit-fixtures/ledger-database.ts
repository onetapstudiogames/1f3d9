import assert from 'node:assert/strict'

export type QueryRow = Readonly<Record<string, unknown>>

export type QueryReply = readonly QueryRow[] | Error

type QueryCall = Readonly<{
  marker: string
  text: string
  params: readonly unknown[]
}>

/**
 * Keeps these service tests independent of SQL layout while still requiring
 * every private credit statement to identify its purpose for audit/debugging.
 */
export class MarkerDatabase {
  readonly calls: QueryCall[] = []
  readonly #replies: Map<string, QueryReply[]>

  constructor(replies: Readonly<Record<string, readonly QueryReply[]>>) {
    this.#replies = new Map(Object.entries(replies).map(([marker, values]) => [
      marker,
      [...values],
    ]))
  }

  async query(text: string, params: readonly unknown[] = []): Promise<readonly QueryRow[]> {
    const marker = /\/\*\s*city-credit:([a-z-]+)\s*\*\//u.exec(text)?.[1]
    assert.ok(marker, 'city-credit SQL must carry a city-credit:* comment marker')
    this.calls.push({ marker, text, params: [...params] })

    const reply = this.#replies.get(marker)?.shift()
    assert.ok(reply, `unexpected or unanswered city-credit:${marker} query`)
    if (reply instanceof Error) throw reply
    return reply.map(row => row.lease_owner === '__bound_lease__'
      ? { ...row, lease_owner: params[2] }
      : row)
  }
}
