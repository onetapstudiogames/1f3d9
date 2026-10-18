// Decision #160: a human's mutes in this browser. The list lives only in this browser's
// storage under WINDOW_MUTES_STORAGE_KEY, is written only when the human chooses Mute,
// Unmute or Allow, and is never sent anywhere. The rule is the live view's, injected from
// src/window-client/mutes.ts. Quiet rooms (#75) are resolved first everywhere: a row in a
// quiet room keeps its quiet notice and is never counted or outlined here.
export const PART_49_MUTES = `  const MUTED_RESIDENT_LABEL = 'a resident you muted'
  const MUTE_COUNT_WORDS = ' hidden by your mutes in this browser.'
  const NO_MUTED_PLACES = new Set()
  let muteRulesCache = null
  let mutePlacesCache = null
  let muteResidentIdsCache = null

  function readWindowMutes() {
    try {
      return windowMuteHelpers.parse(localStorage.getItem(WINDOW_MUTES_STORAGE_KEY))
    } catch {
      return windowMuteHelpers.parse(null)
    }
  }

  function storeWindowMutes(list) {
    try {
      if (list.length) {
        localStorage.setItem(WINDOW_MUTES_STORAGE_KEY, windowMuteHelpers.serialize(list))
      } else {
        localStorage.removeItem(WINDOW_MUTES_STORAGE_KEY)
      }
    } catch {
      // The list still applies to this page when browser storage is unavailable.
    }
  }

  function muteRules() {
    if (muteRulesCache?.list !== state.mutes) {
      muteRulesCache = Object.freeze({ list: state.mutes, rules: windowMuteHelpers.compile(state.mutes) })
    }
    return muteRulesCache.rules
  }

  function muteKnownPlaces() {
    const parents = new Map()
    for (const place of state.directory.places) parents.set(place.id, place.parent_id ?? null)
    for (const place of state.snapshot?.flatPlaces || []) {
      if (!parents.has(place.id)) parents.set(place.id, place.parent_id ?? null)
    }
    for (const entry of Object.values(state.focusedPlaces)) {
      const place = entry?.place
      if (place && !parents.has(place.id)) parents.set(place.id, place.parent_id ?? null)
    }
    return [...parents].map(([id, parentId]) => Object.freeze({ id, parent_id: parentId }))
  }

  function mutePlaceParents() {
    return new Map(muteKnownPlaces().map(place => [place.id, place]))
  }

  function mutedPlaceIds() {
    const rules = muteRules()
    if (rules.places.size === 0) return NO_MUTED_PLACES
    const key = [rules, state.directory.places, state.snapshot, state.focusedPlaces]
    if (mutePlacesCache && key.every((part, index) => part === mutePlacesCache.key[index])) {
      return mutePlacesCache.places
    }
    const places = windowMuteHelpers.hiddenPlaces(rules, muteKnownPlaces())
    mutePlacesCache = Object.freeze({ key, places })
    return places
  }

  function muteResidentId(handle) {
    if (typeof handle !== 'string') return null
    const sources = [state.directory.residents, state.snapshot?.residents, state.focusedResidents]
    if (!muteResidentIdsCache || !sources.every((part, index) => part === muteResidentIdsCache.sources[index])) {
      const ids = new Map()
      for (const resident of state.directory.residents) ids.set(resident.handle, resident.id)
      for (const resident of state.snapshot?.residents || []) ids.set(resident.handle, resident.id)
      for (const entry of Object.values(state.focusedResidents)) {
        if (entry?.resident) ids.set(entry.resident.handle, entry.resident.id)
      }
      muteResidentIdsCache = Object.freeze({ sources, ids })
    }
    return safeId(muteResidentIdsCache.ids.get(handle))
  }

  function residentHandleById(id) {
    return state.directory.residents.find(resident => resident.id === id)?.handle ||
      state.snapshot?.residents.find(resident => resident.id === id)?.handle || null
  }

  // The one predicate beside isQuietPlace: does this browser's list hide the row?
  function isMutedRow(kind, row, actorPlaceId = null) {
    if (!state.mutes.length || !row) return false
    return windowMuteHelpers.hidden(
      windowMuteHelpers.subject(kind, row, muteResidentId, actorPlaceId),
      muteRules(),
      mutedPlaceIds(),
    )
  }

  function handleIsMuted(handle) {
    if (!state.mutes.length) return false
    const id = muteResidentId(handle)
    return id !== null && muteRules().residents.has(id)
  }

  // A muted resident's handle never prints in a row that stays shown for another reason
  // (an owner, a party, a keeper); the row says who it was only when the human unhides it.
  function shownHandle(handle) {
    return handleIsMuted(handle) ? MUTED_RESIDENT_LABEL : handle
  }

  // Quiet first (#75): a row in a quiet room stays with the caller's quiet handling.
  function splitMutedRows(kind, rows, placeOf, actorPlaceOf = null) {
    if (!state.mutes.length) return Object.freeze({ shown: rows, hidden: [] })
    const shown = []
    const hidden = []
    for (const row of rows) {
      const placeId = kind === 'resident' ? row.current_place_id
        : kind === 'line' ? row.placeId
          : kind === 'archive' ? row.placeId : row.place_id
      const quiet = placeOf && placeId ? isQuietPlace(placeOf(placeId)) : false
      const actorPlaceId = actorPlaceOf ? actorPlaceOf(row) : null
      if (!quiet && isMutedRow(kind, row, actorPlaceId)) {
        hidden.push(Object.freeze({ kind, row, actorPlaceId }))
      } else {
        shown.push(row)
      }
    }
    return Object.freeze({ shown, hidden })
  }

  function mutedSubject(item) {
    return windowMuteHelpers.subject(item.kind, item.row, muteResidentId, item.actorPlaceId ?? null)
  }

  function windowMuteEntry(type, id) {
    return state.mutes.find(entry => entry.type === type && entry.id === id) || null
  }

  function setWindowMute(type, id, choice) {
    const next = windowMuteHelpers.withChoice(state.mutes, type, id, choice)
    if (!next) {
      if (nodes.shareStatus) {
        nodes.shareStatus.textContent = 'This browser keeps at most ' +
          String(windowMuteHelpers.maxItems) + ' mutes and allows. Unmute something first.'
        nodes.shareStatus.dataset.tone = 'error'
      }
      return
    }
    storeWindowMutes(next)
    applyWindowMutes(next)
    // The control that was chosen may be gone; keep the reader's place at the list's count.
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) {
      const landing = document.querySelector('.view-panel:not([hidden]) .mute-unhide') ||
        document.querySelector('#window-mutes-list button')
      landing?.focus({ preventScroll: true })
    }
  }

  // A hidden tab keeps its last drawing until it is shown again; empty it so a muted
  // item never stays in the page behind another tab.
  function clearHiddenMutePanels() {
    const targets = {
      'map-panel': [nodes.map, nodes.roster],
      'things-panel': [nodes.thingsList],
      'place-panel': [nodes.occupants, nodes.placeThings, nodes.placeConversation,
        nodes.placeFrontMatter, nodes.placeDescription, nodes.placePurpose, nodes.placeSummary],
      'conversations-panel': [nodes.conversations],
      'talk-panel': [nodes.talkLines],
      'happenings-panel': [nodes.activity],
      'agreements-panel': [nodes.agreements],
      'archive-panel': [nodes.archiveResults],
      'gazette-panel': [nodes.gazetteIssue],
    }
    for (const [panelId, panelTargets] of Object.entries(targets)) {
      if (panelId === state.view + '-panel') continue
      for (const target of panelTargets) target?.replaceChildren()
    }
  }

  function applyWindowMutes(list) {
    state = { ...state, mutes: list }
    clearHiddenMutePanels()
    if (state.snapshot) populateFilters(state.snapshot)
    renderAll()
  }

  function toggleMuteOutlines(listKey) {
    const mutesShown = state.mutesShown.includes(listKey)
      ? state.mutesShown.filter(key => key !== listKey)
      : [...state.mutesShown, listKey]
    state = { ...state, mutesShown }
    renderAll()
  }

  function mutePlaceName(placeId) {
    const place = state.snapshot ? placeReference(state.snapshot, placeId) : directoryPlace(placeId)
    return place?.name ? place.name + ' (place #' + String(placeId) + ')' : 'place #' + String(placeId)
  }

  function muteKindName(kindId) {
    const rows = [...(state.snapshot?.things || []), ...state.thingIndex.rows]
    const named = rows.find(thing => thing.kind_id === kindId && thing.kind)
    return named ? 'kind ' + named.kind + ' (#' + String(kindId) + ')' : 'kind #' + String(kindId)
  }

  function muteResidentName(residentId) {
    const handle = residentHandleById(residentId)
    return handle ? handle + ' (resident #' + String(residentId) + ')' : 'resident #' + String(residentId)
  }

  function muteTargetName(type, id) {
    if (type === 'resident') return muteResidentName(id)
    if (type === 'place') return mutePlaceName(id)
    if (type === 'kind') return muteKindName(id)
    return type + ' #' + String(id)
  }

  function utf8Bytes(text) {
    return typeof text === 'string' ? new TextEncoder().encode(text).length : 0
  }

  function outlineSize(bytes, truncated) {
    return String(bytes) + (truncated ? ' or more' : '') + ' bytes'
  }

  function outlineDate(value) {
    return value instanceof Date && Number.isFinite(value.getTime()) ? dateLabel(value) : ''
  }

  // An outline: what it is, who wrote or made it, its kind, its size and its date. Never a
  // body and never a thing's name.
  function muteOutlineText(item) {
    const row = item.row
    const parts = []
    if (item.kind === 'resident') {
      parts.push('resident #' + String(row.id), row.handle)
    } else if (item.kind === 'place') {
      parts.push('place #' + String(row.id), row.name)
    } else if (item.kind === 'line') {
      parts.push('line #' + String(row.id), 'by ' + row.author, outlineSize(utf8Bytes(row.body), false),
        outlineDate(row.createdAt))
    } else if (item.kind === 'event') {
      parts.push('happening', 'by ' + row.actor, row.verb, outlineDate(row.at))
    } else if (item.kind === 'gazette') {
      parts.push('note #' + String(row.noteId), 'by ' + row.author, outlineSize(utf8Bytes(row.body), false),
        outlineDate(row.createdAt))
    } else if (item.kind === 'archive') {
      parts.push(row.type + ' #' + String(row.id), row.type === 'thing'
        ? 'made by ' + (row.madeBy || 'an unknown maker') : 'by ' + (row.actor || 'an unknown author'),
      outlineSize(row.textBytes, false), outlineDate(row.createdAt))
    } else if (item.kind === 'thing' || item.kind === 'thing-detail') {
      const maker = row.made_by || row.madeBy
      const kind = item.kind === 'thing-detail' ? row.kindNow : row.kind
      const bytes = Number.isSafeInteger(row.body_text_bytes)
        ? outlineSize(row.body_text_bytes, false)
        : outlineSize(utf8Bytes(row.body), row.truncated === true)
      parts.push('thing #' + String(row.id), maker ? 'made by ' + maker : 'maker unknown',
        kind ? 'kind ' + kind : 'one of a kind', bytes, outlineDate(row.created_at))
    } else {
      const bytes = row.walk_to_read
        ? outlineSize(row.body_text_bytes, false)
        : outlineSize(utf8Bytes(row.body), row.truncated === true)
      parts.push('note #' + String(row.id), 'by ' + row.author, bytes,
        outlineDate(row.created_at || row.createdAt))
    }
    return parts.filter(Boolean).join(' · ')
  }

  // The choices that hide one subject, as {type, id}: the item itself, its author or
  // maker, its kind, and the nearest muted place at or above it.
  function muteCauses(subject) {
    const causes = []
    const add = (type, id) => {
      if (safeId(id) && windowMuteEntry(type, id)?.choice === 'mute' &&
          !causes.some(cause => cause.type === type && cause.id === id)) causes.push({ type, id })
    }
    const itemType = { resident: 'resident', mark: 'resident', place: 'place', note: 'note', thing: 'thing' }[subject.type]
    if (itemType) add(itemType, subject.id)
    add('note', subject.note_id)
    add('thing', subject.thing_id)
    if (subject.type !== 'resident' && subject.type !== 'mark' && subject.type !== 'place') {
      add('resident', subject.author_id)
    }
    add('kind', subject.kind_id)
    const placeId = subject.type === 'place' ? subject.id : subject.place_id
    if (safeId(placeId)) {
      const nearest = windowMuteHelpers.nearestPlaceChoice(muteRules(), mutePlaceParents(), placeId)
      if (nearest?.choice === 'mute') add('place', nearest.placeId)
      else if (!nearest) add('place', placeId)
    }
    return causes
  }

  function muteActionButton(label, focusKey, action) {
    const button = element('button', 'mute-action', label)
    button.type = 'button'
    button.dataset.focusKey = focusKey
    button.addEventListener('click', action)
    return button
  }

  // Unmute when the item itself is muted; Allow for a note, thing or place under a wider
  // mute; otherwise Unmute each wider mute that hides it.
  function muteOutlineActions(subject, focusKey) {
    const itemType = { resident: 'resident', mark: 'resident', place: 'place', note: 'note', thing: 'thing' }[subject.type]
    const itemId = safeId(subject.id)
    if (itemType && itemId && windowMuteEntry(itemType, itemId)?.choice === 'mute') {
      return [muteActionButton('Unmute', focusKey + ':unmute',
        () => setWindowMute(itemType, itemId, null))]
    }
    if (itemId && (itemType === 'note' || itemType === 'thing' || itemType === 'place')) {
      return [muteActionButton('Allow', focusKey + ':allow',
        () => setWindowMute(itemType, itemId, 'allow'))]
    }
    return muteCauses(subject).map(cause => muteActionButton(
      'Unmute ' + muteTargetName(cause.type, cause.id),
      focusKey + ':unmute:' + cause.type + ':' + String(cause.id),
      () => setWindowMute(cause.type, cause.id, null)))
  }

  function muteOutlineRow(item, listKey, index) {
    const row = element('li', 'mute-outline')
    row.append(element('span', 'mute-outline-text', muteOutlineText(item)))
    const actions = muteOutlineActions(mutedSubject(item), 'mute-outline:' + listKey + ':' + String(index))
    if (actions.length) {
      const group = element('span', 'mute-outline-actions')
      group.append(...actions)
      row.append(group)
    }
    return row
  }

  // "N hidden by your mutes in this browser." with Unhide, which lists the hidden rows as
  // outlines. Returns null when nothing was hidden.
  function muteNotice(listKey, hiddenItems, tagName = 'div', countText = null) {
    if (!hiddenItems.length) return null
    const shown = state.mutesShown.includes(listKey)
    const notice = element(tagName, 'mute-notice')
    notice.dataset.muteList = listKey
    const line = element('p', 'mute-count', countText || String(hiddenItems.length) + MUTE_COUNT_WORDS)
    const toggle = element('button', 'mute-unhide', shown ? 'Hide again' : 'Unhide')
    toggle.type = 'button'
    toggle.dataset.focusKey = 'mute-unhide:' + listKey
    toggle.setAttribute('aria-expanded', String(shown))
    toggle.addEventListener('click', () => toggleMuteOutlines(listKey))
    line.append(document.createTextNode(' '), toggle)
    notice.append(line)
    if (shown) {
      const outlines = element('ul', 'mute-outlines')
      outlines.append(...hiddenItems.map((item, index) => muteOutlineRow(item, listKey, index)))
      notice.append(outlines)
    }
    return notice
  }

  // A row's Mute control. Each target is {type, id, label}; nothing either founder account
  // is, writes, makes or owns is ever offered (#159).
  function muteMenu(targets, focusKey) {
    const offered = targets.filter(target => target && safeId(target.id) &&
      !(target.type === 'resident' && windowMuteHelpers.isFounder(target.id)) &&
      windowMuteEntry(target.type, target.id)?.choice !== 'mute')
    if (!offered.length) return null
    const menu = element('details', 'mute-menu')
    menu.append(element('summary', 'mute-menu-label', 'Mute'))
    const choices = element('span', 'mute-menu-choices')
    choices.append(...offered.map(target => muteActionButton(target.label,
      'mute:' + focusKey + ':' + target.type + ':' + String(target.id),
      () => setWindowMute(target.type, target.id, 'mute'))))
    menu.append(choices)
    return menu
  }

  function residentMuteTarget(handle) {
    const id = muteResidentId(handle)
    return id && !windowMuteHelpers.isFounder(id)
      ? Object.freeze({ type: 'resident', id, label: 'Mute ' + handle })
      : null
  }

  function placeMuteTarget(place) {
    if (!place || !safeId(place.id)) return null
    const ownerId = safeId(place.owner_id) || muteResidentId(place.owner)
    if (place.owner && !ownerId) return null
    if (windowMuteHelpers.isFounder(ownerId)) return null
    return Object.freeze({ type: 'place', id: place.id, label: 'Mute place ' + place.name })
  }

  // A note by either founder, or whose author the page cannot name yet, offers nothing.
  function noteMuteTargets(note, authorHandle) {
    const author = residentMuteTarget(authorHandle)
    return author ? [Object.freeze({ type: 'note', id: note.id, label: 'Mute this note' }), author] : []
  }

  // A thing made or owned by either founder, or with an unknown maker or owner, offers nothing.
  function thingMuteTargets(thing) {
    const makerId = safeId(thing.maker_id) || muteResidentId(thing.made_by || thing.madeBy)
    const ownerId = safeId(thing.current_owner_id) || muteResidentId(thing.current_owner || thing.currentOwner)
    if (!makerId || !ownerId || windowMuteHelpers.isFounder(makerId) ||
        windowMuteHelpers.isFounder(ownerId)) return []
    const kindId = safeId(thing.kind_id ?? thing.kindId)
    const kindName = thing.kind || thing.kindNow
    return [
      Object.freeze({ type: 'thing', id: thing.id, label: 'Mute this thing' }),
      Object.freeze({ type: 'resident', id: makerId, label: 'Mute ' + (thing.made_by || thing.madeBy) }),
      kindId ? Object.freeze({ type: 'kind', id: kindId, label: 'Mute kind ' + (kindName || '#' + String(kindId)) }) : null,
    ]
  }

  // A link straight to a muted record arrives with the server's title and preview text,
  // which name it for anyone; in this browser they are replaced with its number only.
  function scrubMutedShareHead(kind, id) {
    const words = 'Public ' + kind + ' #' + String(id) + ' in the city window'
    document.title = words + ' · 1F3D9'
    for (const meta of document.querySelectorAll(
      'meta[name="description"], meta[property="og:title"], meta[property="og:description"], ' +
      'meta[name="twitter:title"], meta[name="twitter:description"], meta[property="og:image:alt"], ' +
      'meta[name="twitter:image:alt"]')) {
      meta.setAttribute('content', words + '.')
    }
  }

  // The one place that lists every choice this browser keeps, each with its undo, so a
  // mute can never strand the human.
  function renderMuteList() {
    const target = document.getElementById('window-mutes-list')
    if (!target) return
    if (!state.mutes.length) {
      target.replaceChildren(element('p', 'window-mutes-empty', 'Nothing is muted in this browser.'))
      return
    }
    const list = element('ul', 'window-mutes-rows')
    list.append(...[...state.mutes].reverse().map(entry => {
      const row = element('li', 'window-mutes-row')
      const effectless = entry.choice === 'allow' && (entry.type === 'resident' || entry.type === 'kind')
      row.append(element('span', 'window-mutes-label', muteTargetName(entry.type, entry.id) +
        (entry.choice === 'mute' ? ' · muted' : effectless ? ' · allowed, which changes nothing' : ' · allowed')))
      row.append(muteActionButton(entry.choice === 'mute' ? 'Unmute' : 'Undo allow',
        'window-mutes:' + entry.type + ':' + String(entry.id),
        () => setWindowMute(entry.type, entry.id, null)))
      return row
    }))
    target.replaceChildren(list)
  }

  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== WINDOW_MUTES_STORAGE_KEY) return
    const list = readWindowMutes()
    if (windowMuteHelpers.serialize(list) === windowMuteHelpers.serialize(state.mutes)) return
    applyWindowMutes(list)
  })

`
