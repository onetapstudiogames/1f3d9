import { canonicalPaymentRequest } from './source-imports.ts'
import {
  AUTHORIZATION_NOW,
  BUYER_WALLET,
  CONTRACT_DRAWING,
  CONTRACT_DRAWING_DESCRIPTION,
  OTHER_SECRET,
  SALE_X_PAYMENT,
  SECRET,
  SELLER_WALLET,
  STRANGER_WALLET,
  TREASURY,
  TX1,
  TX2,
  TX_CASE_UPPER,
  X_PAYMENT,
  X_PAYMENT_NO_ID,
} from './environment.ts'
import {
  fixtureState,
  paidCompletionError,
} from './state.ts'
import type {
  FakeCityCreditEntry,
  FakeCommunityToolSubmission,
  FakeFounderPayPalDispute,
  FakeLaterHolderItem,
  FakePaymentAttempt,
} from './state.ts'
import {
  descendingPage,
  kindRow,
  mapOutlineParent,
  mapOutlineRows,
  paginationEvents,
  paginationNotes,
  paginationSubplaces,
  paginationThings,
  placeRow,
  recentIds,
  remainingPaginationRows,
  residentArrivalPage,
  residentArrivalRows,
  residentHandleForFakeId,
  residentRow,
  roomOrientationThingRow,
  selectedPlacePermission,
  thingRow,
  visibleRoomFrontMatter,
} from './rows.ts'
import {
  frontMatterIdsIn,
  recordPayment,
  roomPurposeIn,
} from './state-tools.ts'

export function respondToDatabaseStage5(
  query: string,
  params: unknown[],
  q: string,
): Record<string, unknown>[] | undefined {

  if (q.includes('agreement_actions_today = agreement_actions_today + 1')) {
    if (!fixtureState.current.quota.agreements) return []
    if (q.includes('insert into agreement_signatures')) {
      const acceded = !fixtureState.current.agreementParties.includes(fixtureState.current.actorHandle)
      fixtureState.current = {
        ...fixtureState.current,
        agreementParties: acceded
          ? [...fixtureState.current.agreementParties, fixtureState.current.actorHandle]
          : fixtureState.current.agreementParties,
        agreementAcceded: acceded
          ? [...fixtureState.current.agreementAcceded, fixtureState.current.actorHandle]
          : fixtureState.current.agreementAcceded,
      }
      return [{
        agreement_id: 61,
        handle: fixtureState.current.actorHandle,
        acceded,
        signed_at: '2026-08-11T00:00:00.000Z',
      }]
    }
    if (q.includes('insert into agreement_accession_openings')) {
      if (q.includes('insert into agreements')) {
        const accessionOpen = params.some(value => value === true || value === 'true' || value === 't')
        fixtureState.current = { ...fixtureState.current, agreementAccessionOpen: accessionOpen }
        return [{
          id: 61,
          body: 'we keep the square open',
          accession_open: accessionOpen,
          created_at: '2026-08-11T00:00:00.000Z',
        }]
      }
      if (fixtureState.current.agreementAccessionOpen) return []
      fixtureState.current = { ...fixtureState.current, agreementAccessionOpen: true }
      return [{ agreement_id: 61, opened_at: '2026-08-11T00:00:00.000Z' }]
    }
    return [{ id: fixtureState.current.actorId }]
  }

  if (q.includes('/* public:window-directory */')) {
    return [{
      entry_type: 'place', id: 1, parent_id: null, name: 'the world',
      handle: null, description: 'must not escape', owner_id: null,
      joined_at: null, model: 'must not escape', current_place_id: null,
      asleep: null, secret_hash: 'must not escape',
    }, {
      entry_type: 'place', id: 2, parent_id: 1, name: '[removed by maintainer]',
      handle: null, description: 'removed original body', owner_id: 7,
      joined_at: null, model: 'must not escape', current_place_id: 2,
      asleep: null, secret_hash: 'must not escape',
    }, {
      entry_type: 'resident', id: 7, parent_id: null, name: null, handle: 'tiny-lantern',
      has_drawing: true,
      description: 'must not escape', owner_id: null,
      joined_at: '2026-08-11T00:00:00.000Z', model: 'openai-codex',
      current_place_id: 2, asleep: false, secret_hash: 'must not escape',
    }]
  }

  if (q.includes('/* public:resident-presence */')) {
    if (params[0] !== 'tiny-lantern') return []
    return [{
      id: 7,
      handle: 'tiny-lantern',
      joined_at: '2026-08-11T00:00:00.000Z',
      current_place_id: 2,
      asleep: false,
      model: 'openai-codex',
      secret_hash: 'must not escape',
      quota_day: '2026-08-11',
    }]
  }

  if (fixtureState.current.scenario === 'remaining pagination' || fixtureState.current.scenario === 'window outline') {
    if (q.includes('/* public:residents */')) {
      const residentRows = remainingPaginationRows('residents') as Array<{
        id: number
        handle: string
        model: string
        joined_at: string
        current_place_id: number | null
        asleep: boolean
      }>
      const total = residentRows.length
      const includesPresence = q.includes('current_place_id') && q.includes('asleep')
      const rows = residentRows.map(row => ({
        id: row.id,
        handle: row.handle,
        model: row.model,
        joined_at: row.joined_at,
        ...(includesPresence
          ? { current_place_id: row.current_place_id, asleep: row.asleep }
          : {}),
      }))
      const page = descendingPage(rows, params[0], params[1])
      return page.length > 0
        ? page.map(row => ({ ...row, total_items: total, total_text_bytes: 0 }))
        : [{ id: null, total_items: total, total_text_bytes: 0 }]
    }
    const publicCollection = ['kinds', 'traits', 'moderation']
      .find(collection => q.includes(`/* public:${collection} */`))
    if (publicCollection) {
      const all = remainingPaginationRows(publicCollection)
      const field = publicCollection === 'moderation' ? 'reason' : 'description'
      const totalTextBytes = all.reduce(
        (total, row) => total + Buffer.byteLength(String((row as Record<string, unknown>)[field] ?? ''), 'utf8'),
        0,
      )
      const page = descendingPage(all, params[0], params[1])
      return page.length > 0
        ? page.map(row => ({ ...row, total_items: all.length, total_text_bytes: totalTextBytes }))
        : [{ id: null, total_items: all.length, total_text_bytes: totalTextBytes }]
    }
    if (q.includes('/* public:agreements */')) {
      const party = params[0] == null ? null : String(params[0])
      const open = params[1] == null ? null : String(params[1]) === 'true'
      const agreements = remainingPaginationRows('agreements') as Array<{
        id: number
        parties: string[]
        open: boolean
      }>
      const filtered = agreements.filter(row =>
        (party == null || row.parties.includes(party)) && (open == null || row.open === open))
      const totalTextBytes = filtered.reduce(
        (total, row) => total + Buffer.byteLength(String((row as Record<string, unknown>).body ?? ''), 'utf8'),
        0,
      )
      const page = descendingPage(filtered, params[2], params[3])
      return page.length > 0
        ? page.map(row => ({ ...row, total_items: filtered.length, total_text_bytes: totalTextBytes }))
        : [{ id: null, total_items: filtered.length, total_text_bytes: totalTextBytes }]
    }
    const meCollection = [
      'me_places', 'me_things', 'me_kinds', 'me_agreements', 'me_notes', 'me_offers',
    ].find(collection => q.includes(`/* public:${collection} */`))
    if (meCollection) {
      return descendingPage(remainingPaginationRows(meCollection), params[1], params[2])
    }
  }

  if (fixtureState.current.scenario === 'resident arrival pagination' && q.includes('/* public:residents */')) {
    const total = residentArrivalRows().length
    const page = residentArrivalPage(query, params[0], params[1])
    return page.length > 0
      ? page.map(row => ({ ...row, total_items: total, total_text_bytes: 0 }))
      : [{ id: null, total_items: total, total_text_bytes: 0 }]
  }

  if (q.includes('/* public:place-collections-budgeted */')) {
    const paged = fixtureState.current.scenario === 'public pagination'
    const allSubplaces = paged ? paginationSubplaces() : [placeRow(2, 1)]
    const allThings = paged
      ? paginationThings()
      : fixtureState.current.thingWithdrawn ? [] : [thingRow(41)]
    const allNotes = paged
      ? paginationNotes()
      : fixtureState.current.scenario === 'busy place'
        ? Array.from({ length: 205 }, (_, index) => ({
            id: index + 1,
            place_id: 2,
            author: 'tiny-lantern',
            body: `note ${index + 1}`,
            created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, index + 1)).toISOString(),
          }))
        : [{ id: 51, place_id: 2, author: 'tiny-lantern', body: fixtureState.current.noteBody, created_at: '2026-08-11T00:00:00.000Z' }]
    const pack = <T extends { id: number }>(
      rows: readonly T[],
      cursor: unknown,
      fetchLimit: unknown,
      textLimit: unknown,
      field: keyof T,
    ) => {
      const candidates = descendingPage(rows, cursor, fetchLimit)
      const itemLimit = Number(fetchLimit) - 1
      const limit = textLimit == null ? null : Number(textLimit)
      const items: T[] = []
      let returnedTextBytes = 0
      let blocked: T | null = null
      let blockedBytes: number | null = null
      for (const row of candidates.slice(0, itemLimit)) {
        const bytes = Buffer.byteLength(String(row[field] ?? ''), 'utf8')
        if (limit != null && returnedTextBytes + bytes > limit) {
          blocked = row
          blockedBytes = bytes
          break
        }
        items.push(row)
        returnedTextBytes += bytes
      }
      const hasMore = candidates.length > items.length
      return {
        items,
        returnedTextBytes,
        hasMore,
        nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
        stoppedForTextLimit: blocked != null,
        nextItemId: blocked?.id ?? null,
        nextItemTextBytes: blockedBytes,
      }
    }
    const subplaces = pack(allSubplaces, params[1], params[2], params[7], 'description')
    const things = pack(allThings, params[3], params[4], params[8], 'body')
    const notes = pack(allNotes, params[5], params[6], params[9], 'body')
    return [{
      subplaces: subplaces.items,
      things: things.items,
      notes: notes.items,
      subplace_items: paged ? 160 : allSubplaces.length,
      subplace_text_bytes: paged ? 1600 : allSubplaces.reduce(
        (total, row) => total + Buffer.byteLength(String(row.description ?? ''), 'utf8'), 0,
      ),
      thing_items: paged ? 260 : allThings.length,
      thing_text_bytes: paged ? 2600 : allThings.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
      note_items: paged ? 360 : allNotes.length,
      note_text_bytes: paged ? 3600 : allNotes.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
      subplace_returned_text_bytes: subplaces.returnedTextBytes,
      subplace_has_more: subplaces.hasMore,
      subplace_next_cursor: subplaces.nextCursor,
      subplace_stopped_for_text_limit: subplaces.stoppedForTextLimit,
      subplace_next_item_id: subplaces.nextItemId,
      subplace_next_item_text_bytes: subplaces.nextItemTextBytes,
      thing_returned_text_bytes: things.returnedTextBytes,
      thing_has_more: things.hasMore,
      thing_next_cursor: things.nextCursor,
      thing_stopped_for_text_limit: things.stoppedForTextLimit,
      thing_next_item_id: things.nextItemId,
      thing_next_item_text_bytes: things.nextItemTextBytes,
      note_returned_text_bytes: notes.returnedTextBytes,
      note_has_more: notes.hasMore,
      note_next_cursor: notes.nextCursor,
      note_stopped_for_text_limit: notes.stoppedForTextLimit,
      note_next_item_id: notes.nextItemId,
      note_next_item_text_bytes: notes.nextItemTextBytes,
    }]
  }

  if (q.includes('/* public:place-collections */')) {
    const paged = fixtureState.current.scenario === 'public pagination'
    const allSubplaces = paged ? paginationSubplaces() : [placeRow(2, 1)]
    const allThings = paged
      ? paginationThings()
      : fixtureState.current.thingWithdrawn ? [] : [thingRow(41)]
    const allNotes = paged
      ? paginationNotes()
      : fixtureState.current.scenario === 'busy place'
        ? Array.from({ length: 205 }, (_, index) => ({
            id: index + 1,
            place_id: 2,
            author: 'tiny-lantern',
            body: `note ${index + 1}`,
            created_at: new Date(Date.UTC(2026, 7, 11, 0, 0, index + 1)).toISOString(),
          }))
        : [{ id: 51, place_id: 2, author: 'tiny-lantern', body: fixtureState.current.noteBody, created_at: '2026-08-11T00:00:00.000Z' }]
    const subplaces = descendingPage(
      allSubplaces,
      params[1],
      params[2],
    ).map(row => q.includes('as description_text_bytes')
      ? Object.fromEntries(Object.entries({
          ...row,
          description_text_bytes: Buffer.byteLength(String(row.description ?? ''), 'utf8'),
        }).filter(([key]) => key !== 'description'))
      : row)
    const things = descendingPage(
      allThings,
      params[3],
      params[4],
    ).map(row => q.includes('as body_text_bytes')
      ? Object.fromEntries(Object.entries({
          ...row,
          body_text_bytes: Buffer.byteLength(String(row.body ?? ''), 'utf8'),
        }).filter(([key]) => key !== 'body'))
      : row)
    const notes = descendingPage(
      allNotes,
      params[5],
      params[6],
    ).map(row => q.includes('author.handle as author, octet_length(n.body)')
      ? Object.fromEntries(Object.entries({
          ...row,
          body_text_bytes: Buffer.byteLength(String(row.body ?? ''), 'utf8'),
        }).filter(([key]) => key !== 'body'))
      : row)
    return [{
      subplaces,
      things,
      notes,
      subplace_items: paged ? 160 : allSubplaces.length,
      subplace_text_bytes: paged ? 1600 : allSubplaces.reduce(
        (total, row) => total + Buffer.byteLength(String(row.description ?? ''), 'utf8'), 0,
      ),
      thing_items: paged ? 260 : allThings.length,
      thing_text_bytes: paged ? 2600 : allThings.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
      note_items: paged ? 360 : allNotes.length,
      note_text_bytes: paged ? 3600 : allNotes.reduce(
        (total, row) => total + Buffer.byteLength(String(row.body ?? ''), 'utf8'), 0,
      ),
    }]
  }

  if (q.includes('count(*)') && q.includes('octet_length') && !q.includes('/* public:')) {
    if (q.includes('subplace_items') && q.includes('thing_items') && q.includes('note_items')) {
      return fixtureState.current.scenario === 'public pagination'
        ? [{ subplace_items: 160, subplace_text_bytes: 1600, thing_items: 260, thing_text_bytes: 2600, note_items: 360, note_text_bytes: 3600 }]
        : [{ subplace_items: 1, subplace_text_bytes: 21, thing_items: 1, thing_text_bytes: 21, note_items: 1, note_text_bytes: 21 }]
    }
    if (fixtureState.current.scenario === 'public pagination') {
      if (q.includes('from places p')) return [{ items: 160, text_bytes: 1600 }]
      if (q.includes('from things t')) return [{ items: 260, text_bytes: 2600 }]
      if (q.includes('from notes n')) return [{ items: 360, text_bytes: 3600 }]
    }
    return [{ items: 1, text_bytes: Buffer.byteLength(fixtureState.current.noteBody, 'utf8') }]
  }
  if (q.includes('/* public:reading_cost */')) {
    if (fixtureState.current.scenario === 'reading cost unavailable') throw new Error('meter read failed')
    return [{ stored_text_bytes: 1234, first_read_text_bytes: 456 }]
  }
  if (fixtureState.current.scenario === 'public pagination' && q.includes('from places p') && q.includes('where p.parent_id')) {
    if (q.includes('count(*)')) return [{ items: 160, text_bytes: 1600 }]
    return descendingPage(paginationSubplaces(), params[1], params[2])
  }
  if (fixtureState.current.scenario === 'public pagination' && q.includes('from things t') && q.includes('t.place_id')) {
    if (q.includes('count(*)')) return [{ items: 260, text_bytes: 2600 }]
    return descendingPage(paginationThings(), params[1], params[2])
  }
  if (fixtureState.current.scenario === 'public pagination' && q.includes('from notes n') && q.includes('n.place_id')) {
    if (q.includes('count(*)')) return [{ items: 360, text_bytes: 3600 }]
    return descendingPage(paginationNotes(), params[1], params[2])
  }

  if (['map outline', 'window outline'].includes(fixtureState.current.scenario) &&
      q.includes('/* public:map-parent */')) {
    return [mapOutlineParent(Number(params[0] ?? 1))]
  }
  if (['map outline', 'window outline'].includes(fixtureState.current.scenario) &&
      q.includes('/* public:map-outline */')) {
    const parentId = Number(params[0] ?? 1)
    const all = mapOutlineRows().filter(row => row.parent_id === parentId)
    const totalTextBytes = all.reduce(
      (total, row) => total + Buffer.byteLength(row.description, 'utf8'),
      0,
    )
    const page = descendingPage(all, params[2], params[3])
    return page.length > 0
      ? page.map(row => ({
          ...row,
          outline_parent: mapOutlineParent(parentId),
          total_items: all.length,
          total_text_bytes: totalTextBytes,
        }))
      : [{
          id: null,
          outline_parent: mapOutlineParent(parentId),
          total_items: all.length,
          total_text_bytes: totalTextBytes,
        }]
  }
  if (fixtureState.current.scenario === 'window outline' && (
    q.includes('/* public:window-outline-totals */') ||
    q.includes('(select count(*)::int from places) as places')
  )) {
    return [{
      places: 61,
      residents: 60,
      conversations: 60,
      things: 60,
      agreements: 60,
      events: 70,
    }]
  }
  if (fixtureState.current.scenario === 'window outline' && q.includes('from notes note')) {
    return descendingPage(paginationNotes(), params[0], params.at(-1))
  }
  if (fixtureState.current.scenario === 'window outline' && q.includes('from things thing')
      && !q.includes('/* public:events */') && !q.includes('/* public:window-events */')) {
    return descendingPage(paginationThings(), params[0], params.at(-1))
  }
  if (fixtureState.current.scenario === 'window outline' && q.includes('from agreements agreement')) {
    return descendingPage(remainingPaginationRows('agreements'), params[0], params.at(-1))
  }
  if (fixtureState.current.scenario === 'window outline' && (
    q.includes('select id, at, kind, actor, detail') || q.includes('/* public:events */')
      || q.includes('/* public:window-events */')
  )) {
    const events = paginationEvents().map((event, index) => index === 0
      ? {
          ...event,
          kind: 'action',
          detail: {
            action_id: 170,
            action: 'move',
            status: 'applied',
            from_place_id: 1,
            to_place_id: 2,
          },
        }
      : {
          ...event,
          kind: index % 2 === 0 ? 'note' : 'thing_created',
        })
    return descendingPage(events, null, params.at(-1))
  }
  return undefined
}
