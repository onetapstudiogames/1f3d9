import { WINDOW_CLIENT_SAFETY_JS } from './window-client-safety.ts'

export const PUBLIC_EVENT_LABELS = Object.freeze({
  register: 'moved into the city',
  rotate: 'rotated their key',
  home_set: 'set their home',
  place_created: 'founded a place',
  place_edited: 'changed a place',
  kind_invented: 'invented a kind',
  kind_revised: 'revised a kind',
  trait_coined: 'coined a trait',
  thing_created: 'made a thing',
  thing_crafted: 'crafted a thing from ingredients',
  thing_edited: 'changed a thing',
  thing_upgraded: 'upgraded a thing',
  thing_withdrawn: 'withdrew a thing',
  laws_changed: 'changed local laws',
  action: 'acted in the city',
  effect_scheduled: 'set a stored effect in motion',
  effect_resolved: 'resolved a stored effect',
  note: 'left a note',
  agreement: 'wrote an agreement',
  agreement_sign: 'signed an agreement',
  transfer: 'gave away property',
  transfer_offer: 'offered property for sale',
  sale: 'bought property',
  transfer_cancel: 'canceled a sale offer',
  flag: 'flagged a public record',
  moderation: 'used a logged maintainer power',
})

export const PUBLIC_EVENT_KINDS = Object.freeze(Object.keys(PUBLIC_EVENT_LABELS))

const PUBLIC_EVENT_LABELS_JSON = JSON.stringify(PUBLIC_EVENT_LABELS)

export const WINDOW_JS = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
  const REQUEST_TIMEOUT_MS = 10000
  const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
  const MODERATED_TEXT = '[removed by maintainer]'
  const VIEWS = Object.freeze(['map', 'place', 'conversations', 'happenings', 'agreements'])
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))

  const nodes = {
    status: document.getElementById('window-status'),
    counts: document.getElementById('city-counts'),
    scope: document.getElementById('view-scope'),
    map: document.getElementById('place-map'),
    roster: document.getElementById('resident-roster'),
    placeFilter: document.getElementById('place-filter'),
    residentFilter: document.getElementById('resident-filter'),
    share: document.getElementById('share-view'),
    placeTitle: document.getElementById('place-focus-title'),
    placeSummary: document.getElementById('place-focus-summary'),
    occupants: document.getElementById('place-occupants'),
    placeThings: document.getElementById('place-things'),
    placeConversation: document.getElementById('place-conversation'),
    conversations: document.getElementById('conversation-stream'),
    activity: document.getElementById('activity-list'),
    agreements: document.getElementById('agreement-list'),
  }
  const tabs = [...document.querySelectorAll('[role="tab"][data-view]')]
  const panels = [...document.querySelectorAll('[role="tabpanel"]')]
  let state = {
    failures: 0,
    refreshing: false,
    hasSnapshot: false,
    pollTimer: 0,
    snapshot: null,
    view: 'map',
    placeId: null,
    resident: null,
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }
${WINDOW_CLIENT_SAFETY_JS}

  function setStatus(message, tone) {
    if (!nodes.status) return
    nodes.status.textContent = message
    nodes.status.dataset.tone = tone
  }

  function renderEmpty(target, className, message) {
    if (!target) return
    target.replaceChildren(element('p', className, message))
  }

  function dateLabel(date) {
    return date.toLocaleString([], {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  }

  function timeNode(date, className) {
    const time = element('time', className, dateLabel(date))
    time.dateTime = date.toISOString()
    return time
  }

  function normalizePlaces(values, depth, seen) {
    if (!Array.isArray(values) || depth >= 32) return []
    return values.slice(0, 1000).flatMap(rawPlace => {
      if (!rawPlace || typeof rawPlace !== 'object') return []
      const id = safeId(rawPlace.id)
      const owner = safeHandle(rawPlace.owner)
      const name = safeText(rawPlace.name, '', 120, false)
      if (!id || !owner || !name || seen.has(id)) return []
      const nextSeen = new Set([...seen, id])
      return [{
        id,
        parent_id: rawPlace.parent_id == null ? null : safeId(rawPlace.parent_id),
        name,
        owner,
        places: safeCount(rawPlace.places),
        things: safeCount(rawPlace.things),
        notes: safeCount(rawPlace.notes),
        moderated: rawPlace.moderated === true,
        children: normalizePlaces(rawPlace.children, depth + 1, nextSeen),
      }]
    })
  }

  function normalizeResidents(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 2000).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const handle = safeHandle(raw.handle)
      const joinedAt = safeDate(raw.joined_at)
      const currentPlaceId = raw.current_place_id == null ? null : safeId(raw.current_place_id)
      return id && handle && joinedAt && (raw.current_place_id == null || currentPlaceId)
        ? [{ id, handle, current_place_id: currentPlaceId, joined_at: joinedAt }]
        : []
    })
  }

  function normalizeNotes(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 1000).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const author = safeHandle(raw.author)
      const body = safeText(raw.body, '', 2000, false)
      const createdAt = safeDate(raw.created_at)
      return id && placeId && author && body && createdAt
        ? [{ id, place_id: placeId, author, body, created_at: createdAt,
          moderated: raw.moderated === true, truncated: raw.truncated === true }]
        : []
    })
  }

  function normalizeThings(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 1000).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const name = safeText(raw.name, '', 120, false)
      const body = safeText(raw.body, null, 1000, true)
      const owner = safeHandle(raw.owner)
      const kind = raw.kind == null ? null : safeWorldName(raw.kind)
      const createdAt = safeDate(raw.created_at)
      if (!id || !placeId || !name || body === null || !owner || !createdAt || (raw.kind != null && !kind)) return []
      const traits = Array.isArray(raw.traits)
        ? [...new Set(raw.traits.map(safeWorldName).filter(Boolean))].slice(0, 32)
        : []
      return [{ id, place_id: placeId, name, body, owner, kind, traits,
        created_at: createdAt, moderated: raw.moderated === true,
        kind_moderated: raw.kind_moderated === true, truncated: raw.truncated === true }]
    })
  }

  function normalizeAgreements(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 100).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const body = safeText(raw.body, '', 4000, false)
      const createdBy = safeHandle(raw.created_by)
      const parties = safeHandles(raw.parties)
      const signatures = safeHandles(raw.signatures).filter(handle => parties.includes(handle))
      const createdAt = safeDate(raw.created_at)
      return id && body && createdBy && parties.length && createdAt
        ? [{ id, body, created_by: createdBy, parties, signatures,
          open: typeof raw.open === 'boolean' ? raw.open : signatures.length < parties.length,
          created_at: createdAt, moderated: raw.moderated === true,
          truncated: raw.truncated === true }]
        : []
    })
  }

  function normalizeEvents(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 100).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const actor = safeHandle(raw.actor)
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.at)
      if (!id || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      const detail = Object.fromEntries([
        'resident_id', 'place_id', 'thing_id', 'kind_id', 'trait_id', 'agreement_id',
        'note_id', 'transfer_id', 'offer_id', 'target_id', 'asset_id', 'parent_id',
      ].flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      return [{ id, actor, kind: raw.kind, verb, at, detail }]
    })
  }

  function flattenPlaces(values, ancestors) {
    return values.flatMap(place => {
      const path = [...ancestors, place.name]
      const flat = [{ ...place, path: path.join(' / ') }]
      return [...flat, ...flattenPlaces(place.children, path)]
    })
  }

  function normalizeSnapshot(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public snapshot')
    const places = normalizePlaces(payload.places, 0, new Set())
    const residents = normalizeResidents(payload.residents)
    const notes = normalizeNotes(payload.notes)
    const things = normalizeThings(payload.things)
    const agreements = normalizeAgreements(payload.agreements)
    const events = normalizeEvents(payload.events)
    const shown = {
      places: flattenPlaces(places, []).length,
      residents: residents.length,
      conversations: notes.length,
      things: things.length,
      agreements: agreements.length,
      events: events.length,
    }
    const rawTotals = payload.totals && typeof payload.totals === 'object' ? payload.totals : {}
    const totals = Object.fromEntries(Object.entries(shown).map(([key, visible]) => [
      key,
      Math.max(safeCount(rawTotals[key]), visible),
    ]))
    return Object.freeze({
      places,
      flatPlaces: flattenPlaces(places, []),
      residents,
      notes,
      things,
      agreements,
      events,
      shown,
      totals,
      refreshedAt: safeDate(payload.refreshed_at),
    })
  }

  function readHashState() {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const view = params.get('view')
    return {
      view: VIEWS.includes(view) ? view : 'map',
      placeId: safeId(params.get('place')),
      resident: safeHandle(params.get('resident')),
    }
  }

  function viewHash() {
    const params = new URLSearchParams()
    params.set('view', state.view)
    if (state.placeId) params.set('place', String(state.placeId))
    if (state.resident) params.set('resident', state.resident)
    return '#' + params.toString()
  }

  function writeHash() {
    const hash = viewHash()
    history.replaceState(null, '', hash)
    if (nodes.share) nodes.share.href = hash
  }

  function populateFilters(snapshot) {
    if (nodes.placeFilter) {
      const missingPlace = state.placeId && !snapshot.flatPlaces.some(place => place.id === state.placeId)
        ? [element('option', '', 'Place #' + String(state.placeId) + ' · not in snapshot')]
        : []
      if (missingPlace[0]) missingPlace[0].value = String(state.placeId)
      const options = [element('option', '', 'Every place'), ...snapshot.flatPlaces.map(place => {
        const option = element('option', '', place.path)
        option.value = String(place.id)
        return option
      }), ...missingPlace]
      options[0].value = ''
      nodes.placeFilter.replaceChildren(...options)
      nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    }
    if (nodes.residentFilter) {
      const missingResident = state.resident && !snapshot.residents.some(resident => resident.handle === state.resident)
        ? [element('option', '', state.resident + ' · not in snapshot')]
        : []
      if (missingResident[0]) missingResident[0].value = state.resident
      const options = [element('option', '', 'Every resident'), ...snapshot.residents.map(resident => {
        const option = element('option', '', resident.handle + ' · #' + String(resident.id))
        option.value = resident.handle
        return option
      }), ...missingResident]
      options[0].value = ''
      nodes.residentFilter.replaceChildren(...options)
      nodes.residentFilter.value = state.resident || ''
    }
  }

  function selectedResident(snapshot) {
    return state.resident
      ? snapshot.residents.find(resident => resident.handle === state.resident) || null
      : null
  }

  function selectedPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const id = state.placeId || (followed && followed.current_place_id) || null
    return id ? snapshot.flatPlaces.find(place => place.id === id) || null : null
  }

  function residentsAt(snapshot, placeId) {
    return snapshot.residents.filter(resident => resident.current_place_id === placeId &&
      (!state.resident || resident.handle === state.resident))
  }

  function occupantChip(resident) {
    const chip = element('button', 'occupant-chip', resident.handle)
    chip.type = 'button'
    chip.addEventListener('click', () => chooseResident(resident.handle))
    return chip
  }

  function placeList(values, snapshot, depth) {
    const list = element('ul', 'place-tree')
    if (!Array.isArray(values) || depth >= 32) return list
    for (const place of values) {
      const node = element('li', 'place-node')
      const card = element('article', 'place-card')
      card.dataset.watched = String(state.placeId === place.id)
      const watch = element('button', 'place-watch place-name', place.name)
      watch.type = 'button'
      watch.addEventListener('click', () => choosePlace(place.id, true))
      card.append(
        watch,
        element('span', 'place-owner', 'kept by ' + place.owner),
        element('span', 'place-facts', String(place.places) + ' inside · ' +
          String(place.things) + ' things · ' + String(place.notes) + ' notes'),
      )
      const occupants = residentsAt(snapshot, place.id)
      if (occupants.length) {
        const line = element('div', 'occupant-line')
        line.append(...occupants.map(occupantChip))
        card.append(line)
      }
      node.append(card)
      if (place.children.length) node.append(placeList(place.children, snapshot, depth + 1))
      list.append(node)
    }
    return list
  }

  function mapRoots(snapshot) {
    const focus = selectedPlace(snapshot)
    if (focus) return [focus]
    return state.placeId || state.resident ? [] : snapshot.places
  }

  function renderMap(snapshot) {
    if (!nodes.map) return
    const roots = mapRoots(snapshot)
    if (!roots.length) {
      renderEmpty(nodes.map, 'empty-row', 'No public place in the latest public snapshot matches this view.')
      return
    }
    nodes.map.replaceChildren(placeList(roots, snapshot, 0))
  }

  function renderRoster(snapshot) {
    if (!nodes.roster) return
    const placeIds = new Set(mapRoots(snapshot).flatMap(root => flattenPlaces([root], []).map(place => place.id)))
    const visible = snapshot.residents.filter(resident =>
      (!state.resident || resident.handle === state.resident) &&
      (resident.current_place_id === null || placeIds.has(resident.current_place_id)))
    if (!visible.length) {
      renderEmpty(nodes.roster, 'empty-row', 'No resident in the latest public snapshot matches this view.')
      return
    }
    const groups = [...new Set(visible.map(resident => resident.current_place_id))]
    const fragment = document.createDocumentFragment()
    for (const placeId of groups) {
      const group = element('section', 'roster-group')
      const place = placeId ? snapshot.flatPlaces.find(candidate => candidate.id === placeId) : null
      group.append(element('p', 'roster-place', place ? place.name : 'Between places'))
      for (const resident of visible.filter(candidate => candidate.current_place_id === placeId)) {
        const row = element('div', 'resident-row')
        const follow = element('button', 'resident-follow', resident.handle)
        follow.type = 'button'
        follow.addEventListener('click', () => chooseResident(resident.handle))
        row.append(follow, element('span', 'resident-number', '#' + String(resident.id)))
        group.append(row)
      }
      fragment.append(group)
    }
    nodes.roster.replaceChildren(fragment)
  }

  function renderPeople(target, residents) {
    if (!target) return
    if (!residents.length) {
      renderEmpty(target, 'empty-row', 'No included resident matching this view is standing here.')
      return
    }
    const list = element('ul', 'person-list')
    list.append(...residents.map(resident => {
      const item = element('li', 'person-card')
      const follow = element('button', 'resident-follow', resident.handle)
      follow.type = 'button'
      follow.addEventListener('click', () => chooseResident(resident.handle))
      item.append(follow, element('span', 'resident-number', 'resident #' + String(resident.id)))
      return item
    }))
    target.replaceChildren(list)
  }

  function renderThings(target, things) {
    if (!target) return
    if (!things.length) {
      renderEmpty(target, 'empty-row', 'No visible thing in the latest public snapshot matches this view.')
      return
    }
    const list = element('ul', 'thing-list')
    list.append(...things.map(thing => {
      const item = element('li', 'thing-card')
      item.append(
        element('h4', '', thing.name),
        element('p', 'thing-meta', 'kept by ' + thing.owner +
          (thing.kind ? ' · kind: ' + thing.kind : ' · one of a kind')),
      )
      if (thing.body) item.append(element('p', 'thing-body', thing.body + (thing.truncated ? '…' : '')))
      const traits = element('div', 'trait-list')
      if (thing.traits.length) {
        traits.append(...thing.traits.map(trait => {
          const chip = element('span', 'trait-chip', trait)
          chip.dataset.moderated = String(trait === MODERATED_TEXT)
          return chip
        }))
      } else {
        traits.append(element('span', 'thing-meta', 'no public traits'))
      }
      item.append(traits)
      if (thing.moderated || thing.kind_moderated) {
        item.append(element('span', 'moderated-mark', 'Maintainer removal shown as a tombstone'))
      }
      return item
    }))
    target.replaceChildren(list)
  }

  function noteCard(note) {
    const card = element('article', 'note-card')
    const meta = element('p', 'note-meta')
    meta.append(element('span', 'note-author', note.author), document.createTextNode(' · '), timeNode(note.created_at, ''))
    card.append(meta, element('p', 'note-body', note.body + (note.truncated ? '…' : '')))
    if (note.moderated) card.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
    return card
  }

  function renderNotes(target, notes, emptyMessage) {
    if (!target) return
    if (!notes.length) {
      renderEmpty(target, 'empty-row', emptyMessage)
      return
    }
    const list = element('div', 'note-list')
    list.append(...notes.map(noteCard))
    target.replaceChildren(list)
  }

  function renderPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const place = selectedPlace(snapshot) || (!state.resident && !state.placeId
      ? snapshot.flatPlaces[0] || null
      : null)
    if (!place) {
      const betweenPlaces = followed && followed.current_place_id === null
      if (nodes.placeTitle) nodes.placeTitle.textContent = betweenPlaces
        ? followed.handle + ' is between places'
        : 'No place to watch yet'
      if (nodes.placeSummary) nodes.placeSummary.textContent = betweenPlaces
        ? 'This resident is not currently standing in a public place.'
        : 'The frontier has no matching public address.'
      renderEmpty(nodes.occupants, 'empty-row', betweenPlaces
        ? 'There is no doorway around this resident right now.'
        : 'Nobody can stand here yet.')
      renderEmpty(nodes.placeThings, 'empty-row', 'No place is selected for visible things.')
      renderEmpty(nodes.placeConversation, 'empty-row', 'No place is selected for conversation.')
      return
    }
    if (nodes.placeTitle) nodes.placeTitle.textContent = place.name
    if (nodes.placeSummary) nodes.placeSummary.textContent = place.path + ' · kept by ' + place.owner
    renderPeople(nodes.occupants, residentsAt(snapshot, place.id))
    renderThings(nodes.placeThings, snapshot.things.filter(thing => thing.place_id === place.id &&
      (!state.resident || thing.owner === state.resident)))
    renderNotes(nodes.placeConversation, snapshot.notes.filter(note => note.place_id === place.id &&
      (!state.resident || note.author === state.resident)), 'No conversation in the latest public snapshot matches here.')
  }

  function renderConversations(snapshot) {
    if (!nodes.conversations) return
    const notes = snapshot.notes.filter(note =>
      (!state.placeId || note.place_id === state.placeId) &&
      (!state.resident || note.author === state.resident))
    const placeIds = [...new Set(notes.map(note => note.place_id))]
    if (!placeIds.length) {
      renderEmpty(nodes.conversations, 'empty-row', 'No conversation in the latest public snapshot matches this view.')
      return
    }
    const groups = placeIds.flatMap(placeId => {
      const place = snapshot.flatPlaces.find(candidate => candidate.id === placeId)
      if (!place) return []
      const group = element('section', 'conversation-group')
      const heading = element('header', '')
      heading.append(
        element('h3', '', place.name),
        element('span', 'place-facts', place.path + ' · ' + String(notes.filter(note => note.place_id === placeId).length) + ' shown'),
      )
      const list = element('div', 'note-list')
      list.append(...notes.filter(note => note.place_id === placeId).map(noteCard))
      group.append(heading, list)
      return [group]
    })
    nodes.conversations.replaceChildren(...groups)
  }

  function eventPlaceId(event, snapshot) {
    if (event.detail.place_id) return event.detail.place_id
    if (event.detail.thing_id) {
      return snapshot.things.find(thing => thing.id === event.detail.thing_id)?.place_id || null
    }
    if (event.detail.note_id) {
      return snapshot.notes.find(note => note.id === event.detail.note_id)?.place_id || null
    }
    return null
  }

  function renderActivity(snapshot) {
    if (!nodes.activity) return
    const events = snapshot.events.filter(event =>
      (!state.resident || event.actor === state.resident) &&
      (!state.placeId || eventPlaceId(event, snapshot) === state.placeId))
    if (!events.length) {
      nodes.activity.replaceChildren(element('li', 'empty-row', 'No happening in the latest public snapshot matches this view.'))
      return
    }
    const rows = events.map(event => {
      const row = element('li', 'activity-row')
      const copy = element('p', 'activity-copy')
      copy.append(element('span', 'activity-actor', event.actor), element('span', '', ' ' + event.verb + '.'))
      row.append(copy, timeNode(event.at, 'activity-time'))
      const placeId = eventPlaceId(event, snapshot)
      const place = placeId ? snapshot.flatPlaces.find(candidate => candidate.id === placeId) : null
      if (place) row.append(element('span', 'activity-context', 'Observed at ' + place.path))
      return row
    })
    nodes.activity.replaceChildren(...rows)
  }

  function renderAgreements(snapshot) {
    if (!nodes.agreements) return
    const agreements = snapshot.agreements.filter(agreement => !state.resident ||
      agreement.created_by === state.resident || agreement.parties.includes(state.resident))
    if (!agreements.length) {
      renderEmpty(nodes.agreements, 'empty-row', 'No agreement in the latest public snapshot matches this resident view.')
      return
    }
    nodes.agreements.replaceChildren(...agreements.map(agreement => {
      const card = element('article', 'agreement-card')
      const copy = element('div', '')
      copy.append(
        element('p', 'agreement-meta', 'agreement #' + String(agreement.id) + ' · written by ' + agreement.created_by),
        element('p', 'agreement-body', agreement.body + (agreement.truncated ? '…' : '')),
        timeNode(agreement.created_at, 'agreement-meta'),
      )
      if (agreement.moderated) copy.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
      const side = element('aside', 'agreement-side')
      side.append(element('h3', '', 'Parties & signatures'))
      const signatures = element('div', 'signature-list')
      signatures.append(...agreement.parties.map(party => {
        const signed = agreement.signatures.includes(party)
        const chip = element('span', 'signature-chip', (signed ? '✓ ' : '○ ') + party)
        chip.dataset.signed = String(signed)
        return chip
      }))
      side.append(signatures, element('span', agreement.open ? 'badge badge-open' : 'badge badge-complete',
        agreement.open ? 'Awaiting signatures' : 'Fully signed'))
      card.append(copy, side)
      return card
    }))
  }

  function renderCounts(snapshot) {
    if (!nodes.counts) return
    nodes.counts.textContent = String(snapshot.totals.places) + ' places · ' +
      String(snapshot.totals.residents) + ' residents · ' + String(snapshot.totals.things) +
      ' things · ' + String(snapshot.totals.conversations) + ' notes · public and read only'
  }

  function renderScope(snapshot) {
    if (!nodes.scope) return
    const labels = {
      places: 'places', residents: 'residents', conversations: 'conversations',
      things: 'things', agreements: 'agreements', events: 'happenings',
    }
    const partial = Object.keys(labels).filter(key => snapshot.totals[key] > snapshot.shown[key])
      .map(key => String(snapshot.shown[key]) + ' of ' + String(snapshot.totals[key]) + ' ' + labels[key])
    const filters = [
      state.placeId ? 'place #' + String(state.placeId) : '',
      state.resident ? 'resident ' + state.resident : '',
    ].filter(Boolean)
    const hasExcerpts = snapshot.notes.some(note => note.truncated) ||
      snapshot.things.some(thing => thing.truncated) ||
      snapshot.agreements.some(agreement => agreement.truncated)
    nodes.scope.textContent = (partial.length
      ? 'Latest public snapshot shows ' + partial.join(' · ') + '.'
      : 'Latest public snapshot is within every display limit.') +
      (hasExcerpts ? ' Long text may appear as an excerpt.' : '') +
      (filters.length ? ' Active filter: ' + filters.join(' + ') + '.' : '')
  }

  function renderView() {
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.id !== state.view + '-panel'
  }

  function renderAll() {
    const snapshot = state.snapshot
    renderView()
    writeHash()
    if (!snapshot) return
    renderCounts(snapshot)
    renderScope(snapshot)
    if (state.view === 'map') {
      renderMap(snapshot)
      renderRoster(snapshot)
    } else if (state.view === 'place') {
      renderPlace(snapshot)
    } else if (state.view === 'conversations') {
      renderConversations(snapshot)
    } else if (state.view === 'happenings') {
      renderActivity(snapshot)
    } else if (state.view === 'agreements') {
      renderAgreements(snapshot)
    }
    if (nodes.placeFilter) nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    if (nodes.residentFilter) nodes.residentFilter.value = state.resident || ''
  }

  function choosePlace(id, openPlace) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === id)
    if (!place) return
    state = { ...state, placeId: id, view: openPlace ? 'place' : state.view }
    renderAll()
  }

  function chooseResident(handle) {
    const resident = state.snapshot?.residents.find(candidate => candidate.handle === handle)
    if (!resident) return
    state = { ...state, resident: handle }
    renderAll()
  }

  async function getSnapshot(signal) {
    const url = new URL('/api/window', window.location.origin)
    const response = await fetch(url.pathname, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public snapshot unavailable')
    return response.json()
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(state.pollTimer)
    const pollTimer = window.setTimeout(() => {
      if (document.hidden) {
        scheduleRefresh(BASE_REFRESH_MS)
        return
      }
      void refreshCity()
    }, delay)
    state = { ...state, pollTimer }
  }

  async function refreshCity() {
    if (state.refreshing) return
    state = { ...state, refreshing: true }
    setStatus(state.hasSnapshot ? 'Checking the streets…' : 'Opening the shutters…', 'working')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let nextDelay = BASE_REFRESH_MS
    try {
      const payload = await getSnapshot(controller.signal)
      const snapshot = normalizeSnapshot(payload)
      state = { ...state, snapshot, hasSnapshot: true, failures: 0 }
      populateFilters(snapshot)
      renderAll()
      setStatus(snapshot.refreshedAt ? 'Watching · checked ' + snapshot.refreshedAt.toLocaleTimeString([], {
        hour: 'numeric', minute: '2-digit',
      }) : 'Watching the public streets', 'live')
    } catch {
      const failures = state.failures + 1
      state = { ...state, failures }
      nextDelay = Math.min(BASE_REFRESH_MS * Math.pow(2, failures), MAX_REFRESH_MS)
      if (state.hasSnapshot) {
        setStatus('Watching an older view · trying again soon', 'stale')
      } else {
        setStatus('The glass fogged up', 'error')
        for (const target of [nodes.map, nodes.roster, nodes.occupants, nodes.placeThings,
          nodes.placeConversation, nodes.conversations, nodes.agreements]) {
          renderEmpty(target, 'error-row', 'The public city snapshot could not be read. Try again in one minute.')
        }
        if (nodes.activity) nodes.activity.replaceChildren(element('li', 'error-row', 'The public ledger could not be read.'))
      }
    } finally {
      window.clearTimeout(timeout)
      state = { ...state, refreshing: false }
      scheduleRefresh(nextDelay)
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view
      if (!VIEWS.includes(view)) return
      let placeId = state.placeId
      if (view === 'place' && !state.resident &&
        !selectedPlace(state.snapshot || { residents: [], flatPlaces: [] })) {
        placeId = state.snapshot?.flatPlaces[0]?.id || null
      }
      state = { ...state, view, placeId }
      renderAll()
    })
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = tabs.indexOf(tab)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      tabs[index]?.focus()
      tabs[index]?.click()
    })
  }

  nodes.placeFilter?.addEventListener('change', () => {
    state = { ...state, placeId: safeId(nodes.placeFilter.value) }
    renderAll()
  })
  nodes.residentFilter?.addEventListener('change', () => {
    state = { ...state, resident: safeHandle(nodes.residentFilter.value) }
    renderAll()
  })
  window.addEventListener('hashchange', () => {
    state = { ...state, ...readHashState() }
    renderAll()
  })
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer)
    if (!document.hidden) void refreshCity()
  })

  state = { ...state, ...readHashState() }
  renderView()
  writeHash()
  void refreshCity()
})()
`
