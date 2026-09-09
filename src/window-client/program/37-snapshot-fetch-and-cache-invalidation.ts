export const PART_37_SNAPSHOT_FETCH_AND_CACHE_INVALIDATION = `  async function getSnapshot(signal, minimumMarker) {
    const url = new URL('/api/window', window.location.origin)
    url.searchParams.set('view', 'outline')
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    const response = await fetch(url.pathname + url.search, {
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

  async function checkPublicChanges() {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const startingMarker = state.changeMarker
      let cursor = startingMarker
      let marker = startingMarker
      let changes = []
      let unchanged = true
      const seenCursors = new Set()
      while (true) {
        const url = new URL('/api/changes', window.location.origin)
        if (cursor) url.searchParams.set('since', cursor)
        url.searchParams.set('limit', '200')
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('public changes unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object') throw new Error('invalid public changes')
        const nextMarker = safeChangeMarker(payload.change_marker ?? payload.checkpoint)
        if (!nextMarker || (cursor && !markerCovers(nextMarker, cursor)) ||
            (startingMarker && !markerCovers(nextMarker, startingMarker))) {
          throw new Error('public change marker did not cover its page')
        }
        marker = nextMarker
        unchanged = unchanged && payload.unchanged === true
        if (!startingMarker) {
          return Object.freeze({
            status: 'unchanged', marker, changes: Object.freeze([]),
          })
        }
        const incoming = normalizePublicChanges(payload.changes)
        if (incoming.some(change =>
          (cursor && BigInt(change.change_id) <= BigInt(cursor)) ||
          BigInt(change.change_id) > BigInt(nextMarker))) {
          throw new Error('public change page crossed its cursor')
        }
        changes = mergePublicChanges(changes, incoming)
        if (payload.has_more !== true) break
        const nextSince = safeChangeMarker(payload.next_since)
        if (!nextSince || !cursor || BigInt(nextSince) <= BigInt(cursor) ||
            BigInt(nextSince) > BigInt(nextMarker) || seenCursors.has(nextSince)) {
          throw new Error('public change cursor did not progress')
        }
        seenCursors.add(nextSince)
        cursor = nextSince
      }
      return Object.freeze({
        status: changes.length || marker !== startingMarker || !unchanged ? 'changed' : 'unchanged',
        marker,
        changes: Object.freeze(changes),
      })
    } catch {
      return Object.freeze({
        status: 'unavailable', marker: null, changes: Object.freeze([]),
      })
    } finally {
      window.clearTimeout(timeout)
    }
  }

  async function refreshUnchangedPresence(signal, minimumMarker) {
    const targetCount = state.snapshot?.residents.length || 0
    if (!targetCount) return []
    let residents = []
    let beforeId = null
    const seenCursors = new Set()
    while (residents.length < targetCount) {
      const url = new URL('/api/residents', window.location.origin)
      url.searchParams.set('view', 'presence')
      url.searchParams.set('limit', String(Math.min(200, targetCount - residents.length)))
      if (beforeId) url.searchParams.set('before_id', String(beforeId))
      if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) throw new Error('public presence unavailable')
      const payload = await response.json()
      if (!payload || typeof payload !== 'object') throw new Error('invalid public presence')
      requireExactReadMarker(payload.change_marker, minimumMarker)
      const incoming = normalizeResidents(payload.residents)
      const merged = mergeResidentRows(residents, incoming)
      if (merged.length === residents.length && residents.length < targetCount) {
        throw new Error('public presence did not advance')
      }
      residents = merged
      if (residents.length >= targetCount) break
      if (payload.has_more !== true) throw new Error('public presence ended early')
      const nextBeforeId = safeId(payload.next_before_id)
      if (!nextBeforeId || seenCursors.has(nextBeforeId)) {
        throw new Error('invalid public presence cursor')
      }
      seenCursors.add(nextBeforeId)
      beforeId = nextBeforeId
    }
    return residents.slice(0, targetCount)
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

  async function finishWatchingPublicStreets() {
    const gazetteFresh = state.view !== 'gazette' || await loadGazetteIssues(
      state.gazette.listInitialized ? 'refresh' : 'initial',
    )
    if (state.view === 'gazette' && !gazetteFresh) {
      setStatus('The public streets are current. The Gazette could not be refreshed.', 'stale')
      return
    }
    setStatus('Watching the public streets', 'live')
  }

`
