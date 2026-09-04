export const PART_10_SNAPSHOT_NORMALIZERS = `  function dateLabel(date) {
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
    return values.flatMap(rawPlace => {
      if (!rawPlace || typeof rawPlace !== 'object') return []
      const id = safeId(rawPlace.id)
      const parentId = rawPlace.parent_id === null ? null : safeId(rawPlace.parent_id)
      const owner = rawPlace.owner === null ? null : safeHandle(rawPlace.owner)
      const name = safeText(rawPlace.name, '', 120, false)
      const foundingName = safeText(rawPlace.founding_name ?? rawPlace.name, '', 120, false)
      const retiredAt = rawPlace.retired_at == null ? null : safeDate(rawPlace.retired_at)
      const placeStatus = rawPlace.status ?? (retiredAt ? 'retired' : 'active')
      const nameHistory = Array.isArray(rawPlace.name_history)
        ? rawPlace.name_history.flatMap(span => {
            if (!span || typeof span !== 'object') return []
            const spanName = safeText(span.name, '', 120, false)
            const startedAt = safeDate(span.started_at)
            const endedAt = span.ended_at == null ? null : safeDate(span.ended_at)
            return spanName && startedAt && (span.ended_at == null || endedAt)
              ? [Object.freeze({ name: spanName, startedAt, endedAt })]
              : []
          })
        : []
      const isOwnerlessWorld = rawPlace.owner === null && parentId === null && name === WORLD_ROOT_NAME
      if (
        !id || !name || !foundingName || seen.has(id) ||
        (placeStatus !== 'active' && placeStatus !== 'retired') ||
        (rawPlace.retired_at != null && !retiredAt) ||
        (!owner && !isOwnerlessWorld) ||
        (rawPlace.parent_id !== null && !parentId)
      ) return []
      const nextSeen = new Set([...seen, id])
      const moderated = rawPlace.moderated === true
      return [{
        id,
        parent_id: parentId,
        name,
        foundingName,
        nameHistory: Object.freeze(nameHistory),
        retiredAt,
        status: placeStatus,
        purpose: moderated ? '' : safePlacePurpose(rawPlace.purpose),
        front_matter: moderated ? [] : normalizeFrontMatter(rawPlace.front_matter),
        owner,
        places: safeCount(rawPlace.places),
        things: safeCount(rawPlace.things),
        notes: safeCount(rawPlace.notes),
        moderated,
        quiet: rawPlace.quiet === true,
        children: normalizePlaces(rawPlace.children, depth + 1, nextSeen),
      }]
    })
  }

  function normalizeLiveSurvey(values) {
    if (values === undefined) return Object.freeze([])
    if (!Array.isArray(values)) throw new Error('invalid public live survey')
    const seen = new Set()
    const rows = values.map(raw => {
      if (!raw || typeof raw !== 'object') throw new Error('invalid public live survey')
      const id = safeId(raw.id)
      const parentId = raw.parent_id === null ? null : safeId(raw.parent_id)
      const things = raw.things
      if (!id || (raw.parent_id !== null && !parentId) || parentId === id || seen.has(id) ||
          typeof things !== 'number' || !Number.isSafeInteger(things) || things < 0) {
        throw new Error('invalid public live survey')
      }
      seen.add(id)
      return Object.freeze({ id, parent_id: parentId, things })
    })
    return Object.freeze(rows)
  }

  function normalizeResidents(values) {
    if (!Array.isArray(values)) return []
    return values.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const handle = safeHandle(raw.handle)
      const joinedAt = safeDate(raw.joined_at)
      const currentPlaceId = raw.current_place_id == null ? null : safeId(raw.current_place_id)
      return id && handle && joinedAt && (raw.current_place_id == null || currentPlaceId)
        ? [{ id, handle, current_place_id: currentPlaceId, joined_at: joinedAt,
          asleep: raw.asleep === true, has_drawing: raw.has_drawing === true }]
        : []
    })
  }

  function normalizeDirectory(payload) {
    if (!payload || typeof payload !== 'object' || payload.view !== 'directory') {
      throw new Error('invalid public directory')
    }
    const rawPlaces = Array.isArray(payload.places) ? payload.places : []
    const places = deriveWindowDirectoryPlaces(rawPlaces.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const parentId = raw.parent_id === null ? null : safeId(raw.parent_id)
      const name = safeText(raw.name, '', 120, false)
      return id && name && (raw.parent_id === null || parentId)
        ? [{ id, parent_id: parentId, name, quiet: raw.quiet === true }]
        : []
    }))
    const residentsByHandle = new Map()
    if (Array.isArray(payload.residents)) {
      for (const raw of payload.residents) {
        if (!raw || typeof raw !== 'object') continue
        const id = safeId(raw.id)
        const handle = safeHandle(raw.handle)
        if (id && handle && !residentsByHandle.has(handle)) {
          residentsByHandle.set(handle, Object.freeze({
            id, handle, has_drawing: raw.has_drawing === true,
          }))
        }
      }
    }
    return Object.freeze({
      places: Object.freeze(places.map(place => Object.freeze(place))),
      residents: Object.freeze([...residentsByHandle.values()]),
    })
  }

  function normalizeNotes(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
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
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const name = safeText(raw.name, '', 120, false)
      const body = safeText(raw.body, null, 1000, true)
      const makerId = raw.maker_id == null ? null : safeId(raw.maker_id)
      const madeBy = raw.made_by == null ? null : safeHandle(raw.made_by)
      const currentOwnerId = raw.current_owner_id == null ? null : safeId(raw.current_owner_id)
      const currentOwner = safeHandle(raw.current_owner ?? raw.owner)
      const owner = safeHandle(raw.owner ?? raw.current_owner)
      const hasProvenance = [raw.maker_id, raw.made_by, raw.current_owner_id, raw.current_owner]
        .some(value => value !== null && value !== undefined)
      const kind = raw.kind == null ? null : safeWorldName(raw.kind)
      const kindId = raw.kind_id == null ? null : safeId(raw.kind_id)
      const createdAt = safeDate(raw.created_at)
      if (
        !id || !placeId || !name || body === null || !currentOwner || !owner ||
        owner !== currentOwner || !createdAt || (raw.kind != null && !kind) ||
        (raw.kind_id != null && !kindId) ||
        (hasProvenance && (!makerId || !madeBy || !currentOwnerId))
      ) return []
      const traits = Array.isArray(raw.traits)
        ? [...new Set(raw.traits.map(safeWorldName).filter(Boolean))].slice(0, 32)
        : []
      return [{ id, place_id: placeId, name, body,
        maker_id: makerId, made_by: madeBy,
        current_owner_id: currentOwnerId, current_owner: currentOwner,
        owner, open_to_use: raw.open_to_use === true, kind_id: kindId, kind, traits,
        created_at: createdAt, moderated: raw.moderated === true,
        kind_moderated: raw.kind_moderated === true, truncated: raw.truncated === true,
        has_drawing: raw.has_drawing === true }]
    })
  }

  function normalizeThingHeadings(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const name = safeText(raw.name, '', 120, false)
      const kindId = raw.kind_id == null ? null : safeId(raw.kind_id)
      const kind = raw.kind == null ? null : safeWorldName(raw.kind)
      const makerId = safeId(raw.maker_id)
      const madeBy = safeHandle(raw.made_by)
      const currentOwnerId = safeId(raw.current_owner_id)
      const currentOwner = safeHandle(raw.current_owner)
      const bodyTextBytes = Number(raw.body_text_bytes)
      const createdAt = safeDate(raw.created_at)
      if (
        !id || !placeId || !name || !makerId || !madeBy || !currentOwnerId ||
        !currentOwner || !createdAt ||
        (raw.kind_id != null && !kindId) || (raw.kind != null && !kind) ||
        !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0
      ) return []
      return [Object.freeze({
        id, place_id: placeId, name, kind_id: kindId, kind,
        maker_id: makerId, made_by: madeBy,
        current_owner_id: currentOwnerId, current_owner: currentOwner,
        body_text_bytes: bodyTextBytes, created_at: createdAt,
        has_drawing: raw.has_drawing === true,
      })]
    })
  }

  function normalizeAgreements(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const body = safeText(raw.body, '', 4000, false)
      const createdBy = safeHandle(raw.created_by)
      const parties = safeHandles(raw.parties)
      const acceded = safeHandles(raw.acceded).filter(handle => parties.includes(handle))
      const signatures = safeHandles(raw.signatures).filter(handle => parties.includes(handle))
      const partyCount = Math.max(safeCount(raw.party_count), parties.length)
      const createdAt = safeDate(raw.created_at)
      return id && body && createdBy && parties.length && createdAt
        ? [{ id, body, created_by: createdBy, parties, acceded, signatures,
          open: typeof raw.open === 'boolean' ? raw.open : signatures.length < parties.length,
          accession_open: raw.accession_open === true,
          party_count: partyCount,
          parties_truncated: raw.parties_truncated === true && partyCount > parties.length,
          created_at: createdAt, moderated: raw.moderated === true,
          truncated: raw.truncated === true }]
        : []
    })
  }

  function normalizeEvents(values, maximum = 100) {
    if (!Array.isArray(values)) return []
    return values.slice(0, maximum).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const changeId = raw.change_id == null ? null : safeChangeMarker(raw.change_id)
      const actor = safeHandle(raw.actor) || (
        SAFE_SYSTEM_EVENT_ACTORS.has(raw.actor) ? raw.actor : null
      )
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.at)
      if (!id || (raw.change_id != null && !changeId) || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      let detail = Object.fromEntries(SAFE_EVENT_DETAIL_IDS.flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      detail = normalizeLiveTransferDetail(raw.kind, source, detail)
      if (raw.kind === 'gazette_printed') {
        const issueNumber = safeId(source.issue_number)
        const entryCount = safeGazetteCount(source.entry_count)
        if (!issueNumber || entryCount === null || detail.place_id !== 454) return []
        detail.issue_number = issueNumber
        detail.entry_count = entryCount
      }
      let carriesFailureCause = false
      if (raw.kind === 'action' && SAFE_ACTIONS.has(source.action)) {
        detail.action = source.action
        if (SAFE_ACTION_STATUSES.has(source.status)) {
          detail.status = source.status
          carriesFailureCause = source.status === 'blocked' || source.status === 'failed'
        }
        if (source.action === 'move' && source.mode === 'carry') detail.mode = 'carry'
      } else if (raw.kind === 'effect_resolved' && SAFE_EFFECT_STATUSES.has(source.status)) {
        detail.status = source.status
        carriesFailureCause = source.status === 'skipped' || source.status === 'failed'
      }
      if (raw.kind === 'thing_moved' && source.mode === 'carry') detail.mode = 'carry'
      if (carriesFailureCause && Object.hasOwn(source, 'error')) {
        const error = safeText(source.error, null, EVENT_ERROR_LIMIT + 1, false)
        if (error) {
          const truncated = source.error_truncated === true || error.length > EVENT_ERROR_LIMIT
          detail.error = error.length > EVENT_ERROR_LIMIT
            ? error.slice(0, EVENT_ERROR_LIMIT - 1) + '…'
            : error
          if (truncated) detail.error_truncated = true
        } else {
          detail.error = UNSAFE_EVENT_ERROR
        }
      }
      return [{ id, ...(changeId ? { change_id: changeId } : {}),
        actor, kind: raw.kind, verb, at, detail,
        thingHasDrawing: raw.thing_has_drawing === true }]
    })
  }

  function normalizeLiveChanges(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, LIVE_OPENING_PAGE_LIMIT).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const changeId = safeChangeMarker(raw.change_id)
      const actor = safeHandle(raw.actor)
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.created_at)
      if (!changeId || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      let detail = Object.fromEntries(SAFE_EVENT_DETAIL_IDS.flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      detail = normalizeLiveTransferDetail(raw.kind, source, detail)
      if (raw.kind === 'action' && SAFE_ACTIONS.has(source.action)) {
        detail.action = source.action
        if (SAFE_ACTION_STATUSES.has(source.status)) detail.status = source.status
        if (source.mode === 'carry') detail.mode = 'carry'
      }
      return [Object.freeze({ change_id: changeId, actor, kind: raw.kind, verb, at, detail })]
    })
  }

  function normalizeLiveTransferDetail(kind, source, detail) {
    if (kind !== 'transfer') return detail
    const assetType = ['place', 'thing', 'kind'].includes(source.asset_type)
      ? source.asset_type
      : ['place', 'thing', 'kind'].includes(source.type) ? source.type : null
    const assetId = safeId(source.asset_id ?? source.id)
    return assetType && assetId
      ? { ...detail, asset_type: assetType, asset_id: assetId }
      : detail
  }

  function mergeLiveChanges(current, incoming) {
    const rows = new Map(current.map(row => [row.change_id, row]))
    for (const row of incoming) rows.set(row.change_id, row)
    return Object.freeze([...rows.values()].sort((left, right) =>
      Number(BigInt(right.change_id) - BigInt(left.change_id))))
  }

`
