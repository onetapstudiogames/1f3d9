export const PART_11_LIVE_RECORDS_ANCHORS_AND_NOTES = `  function liveTraceKey(record) {
    return record.change_id ? 'change:' + record.change_id : 'event:' + String(record.id)
  }

  function liveRecordType(record) {
    if (record.kind === 'note' && record.detail.note_id && record.detail.place_id) return 'note'
    if ((record.kind === 'thing_created' || record.kind === 'thing_crafted') &&
        record.detail.place_id) return 'make'
    if (record.kind !== 'action' || record.detail.status !== 'applied') {
      return null
    }
    if ((record.detail.action === 'move' || record.detail.action === 'go_home') &&
        record.detail.from_place_id && record.detail.to_place_id) return 'move'
    if (record.detail.action === 'use' && record.detail.source_thing_id &&
        record.detail.place_id) return 'use'
    if (record.detail.action === 'make' && record.detail.place_id) return 'make'
    return null
  }

  function liveRecords() {
    const records = new Map()
    for (const record of [...state.live.changes, ...state.live.openingEvents]) {
      records.set(liveTraceKey(record), record)
    }
    return windowLiveReplayOrder([...records.values()], Number.NEGATIVE_INFINITY).reverse()
  }

  function liveInteractionRecords() {
    return liveRecords().filter(record =>
      record.kind === 'transfer' &&
      record.detail.resident_id && record.detail.place_id && liveRecordIsRecent(record))
  }

  function liveRecordLifetime(record) {
    return liveRecordType(record) === 'note' ? LIVE_NOTE_LIFETIME_MS : LIVE_MOVE_LIFETIME_MS
  }

  function liveRecordIsRecent(record, now = Date.now()) {
    return windowLiveTraceOpacity(record.at.getTime(), now, liveRecordLifetime(record)) > 0
  }

  function liveRecordPlaceId(record) {
    const type = liveRecordType(record)
    if (type === 'move') return record.detail.to_place_id || null
    if (record.detail.place_id) return record.detail.place_id
    return null
  }

  function liveMotionReduced() {
    return LIVE_MOTION_PREFERENCE.matches
  }

  // Quiet opening: a record settles as residue -- final position only, no
  // trail, no arrowhead, and no bubble -- when the viewer was not present
  // to watch it happen: opening backlog, or a hidden-tab catch-up the
  // visibility gates suppressed. state.live.residueKeys names those
  // records, set in queueLiveReplays from the caller's own 'animate'
  // argument, which already knows which case this is. That call-site
  // signal is used here rather than comparing the record's own timestamp
  // against a client-captured "watch started" moment: a server-assigned
  // record timestamp and a client Date.now() capture do not have a
  // guaranteed ordering, and gating render output on that race produced
  // wrong answers under measurement. state.live.residueKeySet mirrors
  // residueKeys as a real Set, kept in lockstep everywhere residueKeys is
  // written, so this per-record check (called once per rendered record)
  // stays O(1) instead of rescanning the array on every call.
  function liveIsRecordResidue(record) {
    return state.live.residueKeySet.has(liveTraceKey(record))
  }

  function liveReplayRecordIsRevealed(record) {
    if (record.change_id && !state.live.openingLoaded) return false
    const key = liveTraceKey(record)
    return !state.live.replaySeenKeys.includes(key) ||
      state.live.replayRevealedKeys.includes(key)
  }

  function liveReplayHeldKeys() {
    return new Set([
      ...Object.values(state.live.replayQueues).flat().map(liveTraceKey),
      ...Object.values(state.live.replayActive).map(active => active.key),
    ])
  }

  function queueLiveReplays(records, animate = true) {
    const now = Date.now()
    const recentKeys = new Set(liveRecords().filter(record =>
      liveRecordIsRecent(record, now)).map(liveTraceKey))
    const heldKeys = liveReplayHeldKeys()
    const seen = new Set(state.live.replaySeenKeys.filter(key =>
      recentKeys.has(key) || heldKeys.has(key)))
    const revealed = new Set(state.live.replayRevealedKeys.filter(key =>
      recentKeys.has(key) || heldKeys.has(key)))
    // Every record that clears change_id/type/recency/seen is a candidate
    // for residue when this batch is backlog (animate === false), whether
    // or not an active Follow then excludes its non-movement detail below --
    // otherwise clearing Follow later pops a stale opening-backlog bubble
    // for a record that never got its residue key recorded.
    const backlogKeys = new Set()
    const additions = windowLiveReplayOrder(records, Number.NEGATIVE_INFINITY).filter(record => {
      const key = liveTraceKey(record)
      const type = liveRecordType(record)
      if (!record.change_id || !type || !liveRecordIsRecent(record, now) ||
          seen.has(key)) return false
      seen.add(key)
      if (!animate) backlogKeys.add(key)
      if (type !== 'move' && state.resident && record.actor !== state.resident) {
        revealed.add(key)
        return false
      }
      return true
    })
    // A Follow-excluded backlog record is added to backlogKeys above but
    // never to additions, so additions.length alone cannot gate this
    // return: if exactly as many stale seen/revealed keys aged out as new
    // ones arrived, both size comparisons below can still hold even
    // though a new backlog key was just learned. Losing that key here
    // means it never settles as residue, so clearing Follow later pops
    // its bubble and trail as if the viewer had watched it happen.
    const learnedNewBacklogKey = [...backlogKeys].some(key =>
      !state.live.residueKeySet.has(key))
    if (!additions.length && !learnedNewBacklogKey &&
        seen.size === state.live.replaySeenKeys.length &&
        revealed.size === state.live.replayRevealedKeys.length) return

    const animates = animate && !liveMotionReduced()
    const retainedAdditions = animates
      ? additions.slice(-LIVE_REPLAY_BACKLOG_LIMIT)
      : additions
    const caughtUpAdditions = animates
      ? additions.slice(0, Math.max(0, additions.length - retainedAdditions.length))
      : []
    if (!animates) {
      const trailStarts = { ...state.live.trailStarts }
      const residue = new Set(state.live.residueKeys.filter(key =>
        recentKeys.has(key) || heldKeys.has(key)))
      // The caller's own 'animate' argument already says whether this
      // batch is backlog (opening history, or a hidden-tab catch-up the
      // visibility gates suppressed) or a record actually learned while
      // watching that only skipped its glide because motion is reduced.
      // Backlog settles at rest with no trail: minting a fresh trailStart
      // here would draw brick ink the viewer never watched happen. Backlog
      // residue is drawn from backlogKeys, not additions, so a record an
      // active Follow excluded from additions still settles as residue.
      if (animate) {
        for (const record of additions) {
          const key = liveTraceKey(record)
          if (liveRecordType(record) === 'move') trailStarts[key] = now
          residue.delete(key)
        }
      } else {
        for (const key of backlogKeys) residue.add(key)
      }
      for (const record of additions) revealed.add(liveTraceKey(record))
      state = { ...state, live: {
        ...state.live,
        residueKeys: Object.freeze([...residue]),
        residueKeySet: residue,
        replaySeenKeys: Object.freeze([...seen]),
        replayRevealedKeys: Object.freeze([...revealed]),
        trailStarts: Object.freeze(trailStarts),
      } }
      return
    }

    const queues = Object.fromEntries(Object.entries(state.live.replayQueues)
      .map(([actor, queue]) => [actor, [...queue]]))
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    for (const record of caughtUpAdditions) {
      const key = liveTraceKey(record)
      revealed.add(key)
      if (liveRecordType(record) === 'move') trailStarts[key] = now
    }
    for (const record of retainedAdditions) {
      queues[record.actor] = Object.freeze([...(queues[record.actor] || []), record])
      if (!Object.hasOwn(positions, record.actor) && liveRecordType(record) === 'move') {
        positions[record.actor] = record.detail.from_place_id
      }
    }
    const animatedResidue = new Set(state.live.residueKeys.filter(key =>
      recentKeys.has(key) || heldKeys.has(key)))
    for (const record of additions) animatedResidue.delete(liveTraceKey(record))
    state = { ...state, live: {
      ...state.live,
      residueKeys: Object.freeze([...animatedResidue]),
      residueKeySet: animatedResidue,
      replayQueues: Object.freeze(queues),
      replayPositions: Object.freeze(positions),
      replaySeenKeys: Object.freeze([...seen]),
      replayRevealedKeys: Object.freeze([...revealed]),
      trailStarts: Object.freeze(trailStarts),
    } }
  }

  function settleLiveReplays() {
    window.clearTimeout(liveReplayStartTimer)
    window.clearTimeout(liveReplayCompletionTimer)
    liveReplayStartTimer = 0
    liveReplayCompletionTimer = 0
    liveReplayCompletionDeadlines = Object.freeze([])
    const heldRecords = [
      ...Object.values(state.live.replayQueues).flat(),
      ...Object.values(state.live.replayActive).map(active => active.record),
    ]
    const keys = new Set([
      ...state.live.replaySeenKeys,
      ...liveReplayHeldKeys(),
    ])
    const trailStarts = { ...state.live.trailStarts }
    const settledAt = Date.now()
    for (const record of heldRecords) {
      if (liveRecordType(record) === 'move') trailStarts[liveTraceKey(record)] = settledAt
    }
    state = { ...state, live: {
      ...state.live,
      replayQueues: {}, replayActive: {}, replayPositions: {}, replayReadyAtByActor: {},
      replaySeenKeys: Object.freeze([...keys]),
      replayRevealedKeys: Object.freeze([...keys]),
      trailStarts: Object.freeze(trailStarts),
    } }
  }

  function livePlaceAnchorLookup(focusId, children) {
    const places = state.snapshot
      ? livePlaceRows(state.snapshot)
      : state.directory.loaded ? state.directory.places : []
    const byId = new Map(places.map(place => [place.id, place]))
    const childIds = new Set(children.map(place => place.id))
    const anchors = new Map()
    return Object.freeze({
      resolve(placeId) {
        if (anchors.has(placeId)) return anchors.get(placeId)
        const seen = new Set()
        let current = byId.get(placeId)
        let anchor = null
        while (current && !seen.has(current.id)) {
          if (childIds.has(current.id) || current.parent_id === focusId) {
            anchor = current.id
            break
          }
          seen.add(current.id)
          current = current.parent_id ? byId.get(current.parent_id) : null
        }
        anchors.set(placeId, anchor)
        return anchor
      },
    })
  }

  function livePlaceAnchor(placeId, focusId, children, renderContext = null) {
    if (!placeId) return null
    if (placeId === focusId) return focusId
    const buildLookup = () => livePlaceAnchorLookup(focusId, children)
    const lookup = renderContext
      ? renderContext.remember('place-anchor-lookup:' + String(focusId), buildLookup)
      : buildLookup()
    return lookup.resolve(placeId)
  }

  // Step 3 removed the per-plot JSON-drawing fetch queue that used to back
  // this key (fetchLiveDrawing/loadLiveDrawing/drainLiveDrawingQueue/
  // refillLiveDrawingQueue/refreshLiveDrawingNodes/drawingNode). Floor tiles
  // now read the same cacheable thumb.png the resident/thing sprites already
  // use (see liveTiledDrawing), so a plate with 40 plots costs 40 cached
  // image requests and zero JSON reads. This key survives only to address
  // the deterministic preview proof scene's synthetic fixture pixels, which
  // have no real backend record for the thumb route to serve.
  function liveDrawingKey(type, id) {
    return type + ':' + String(id)
  }

  function paintedDrawingNode(drawing, columns, rows) {
    const tile = document.createElement('canvas')
    tile.width = 8
    tile.height = 8
    const tileContext = tile.getContext('2d')
    if (!tileContext) return null
    tileContext.imageSmoothingEnabled = false
    drawing.indices.forEach((paletteIndex, index) => {
      if (paletteIndex === null) return
      tileContext.fillStyle = drawing.palette[paletteIndex]
      tileContext.fillRect(index % 8, Math.floor(index / 8), 1, 1)
    })
    const canvas = document.createElement('canvas')
    canvas.classList.add('drawing-authored')
    canvas.width = columns * 8
    canvas.height = rows * 8
    const context = canvas.getContext('2d')
    const pattern = context?.createPattern(tile, 'repeat')
    if (!context || !pattern) return null
    context.imageSmoothingEnabled = false
    context.fillStyle = pattern
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas
  }

  function applyDrawingData(node, entry) {
    node.dataset.drawingState = entry.state
    node.dataset.drawingPresentationState = entry.presentation_state
    node.dataset.drawingSource = entry.source
    if (entry.kind_id) node.dataset.drawingKindId = String(entry.kind_id)
    if (entry.kind_name) node.dataset.drawingKindName = entry.kind_name
    if (entry.revision) node.dataset.drawingRevision = String(entry.revision)
    if (entry.variant_name) node.dataset.drawingVariantName = entry.variant_name
  }

  async function fetchLiveNote(noteId) {
    const key = String(noteId)
    const held = state.live.noteBodies[key]
    if (held) return
    const loading = Object.freeze({ loading: true, error: false, body: null })
    state = {
      ...state,
      live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: loading,
      } },
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let settled = false
    try {
      const response = await fetch('/api/note/' + key, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('note unavailable')
      const payload = await response.json()
      const body = safeExactText(payload?.note?.body, null, 4000, false)
      if (!body || safeId(payload?.note?.id) !== noteId) throw new Error('invalid note')
      if (state.live.noteBodies[key] !== loading) return
      state = { ...state, live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: Object.freeze({ loading: false, error: false, body }),
      } } }
      settled = true
    } catch {
      if (state.live.noteBodies[key] !== loading) return
      state = { ...state, live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: Object.freeze({ loading: false, error: true, body: null }),
      } } }
      settled = true
    } finally {
      window.clearTimeout(timeout)
      if (settled && state.view === 'live' && state.snapshot) markLiveDirty()
    }
  }

  function drainLiveNoteQueue() {
    if (state.view !== 'live' || document.hidden ||
        liveNoteFetches >= LIVE_NOTE_FETCH_CONCURRENCY || !liveNoteQueue.length) return
    const [noteId, ...remaining] = liveNoteQueue
    liveNoteQueue = Object.freeze(remaining)
    if (state.live.noteBodies[String(noteId)]) {
      drainLiveNoteQueue()
      return
    }
    liveNoteFetches += 1
    void fetchLiveNote(noteId).finally(() => {
      liveNoteFetches = Math.max(0, liveNoteFetches - 1)
      drainLiveNoteQueue()
    })
    drainLiveNoteQueue()
  }

  function loadLiveNote(noteId) {
    if (state.live.noteBodies[String(noteId)]) return
    if (!liveNoteQueue.includes(noteId) && liveNoteQueue.length < LIVE_NOTE_QUEUE_LIMIT) {
      liveNoteQueue = Object.freeze([...liveNoteQueue, noteId])
    }
    drainLiveNoteQueue()
  }

  function pruneLiveNoteBodies(now = Date.now()) {
    const retainedNoteIds = new Set(liveRecords()
      .filter(record => liveRecordType(record) === 'note' && liveRecordIsRecent(record, now))
      .map(record => record.detail.note_id))
    liveNoteQueue = Object.freeze(liveNoteQueue.filter(noteId => retainedNoteIds.has(noteId)))
    const entries = Object.entries(state.live.noteBodies)
      .filter(([key]) => retainedNoteIds.has(Number(key)))
    if (entries.length === Object.keys(state.live.noteBodies).length) return
    state = { ...state, live: { ...state.live, noteBodies: Object.fromEntries(entries) } }
  }

  function setLiveHighlight(key) {
    state = { ...state, live: { ...state.live, highlightedKey: key } }
    for (const node of document.querySelectorAll('[data-live-key]')) {
      node.dataset.highlighted = String(node.dataset.liveKey === key)
    }
  }

`
