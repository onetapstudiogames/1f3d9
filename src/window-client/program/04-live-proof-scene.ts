export const PART_04_LIVE_PROOF_SCENE = `  function liveProofPayload(now) {
    const rootId = LIVE_PROOF_ROOT_ID
    const gardenId = LIVE_PROOF_GARDEN_ID
    const workshopId = LIVE_PROOF_WORKSHOP_ID
    const retryRoomId = LIVE_PROOF_RETRY_ROOM_ID
    const residents = Array.from({ length: 8 }, (_, index) => ({
      id: 9201 + index,
      handle: ['proof-alex', 'proof-bea', 'proof-cato', 'proof-dara',
        'proof-eli', 'proof-fia', 'proof-gus', 'proof-hana'][index],
      // Step 3 proof: hana (7) stands in the movement garden, undrawn on
      // its plain paper ground -- the same undrawn neutral-marker sprite
      // as dara (3), who stands in the workshop on its own bold tiled
      // floor, so the owner can compare floor readability at the same
      // zoom with the sprite held constant.
      current_place_id: index === 7 ? gardenId : workshopId,
      joined_at: new Date(now - 86_400_000 - index * 1_000).toISOString(),
      asleep: false,
      // Step 2 proof: alex (0) carries a genuinely transparent portrait over
      // the workshop's own strongly patterned floor; cato (2) is a Blank
      // (all-transparent Complete) portrait; every other proof resident,
      // including bea (1, refused), stays undrawn -- the small neutral
      // marker path this step adds.
      has_drawing: index === 0 || index === 2,
    }))
    const things = Array.from({ length: 7 }, (_, index) => ({
      id: 9401 + index,
      place_id: workshopId,
      name: ['pace lantern', 'shared compass', 'talking kettle', 'motion bell',
        'crowd map', 'retry key', 'quiet marker'][index],
      body: 'A preview-only proof object.',
      maker_id: residents[0].id,
      made_by: residents[0].handle,
      current_owner_id: residents[0].id,
      current_owner: residents[0].handle,
      owner: residents[0].handle,
      open_to_use: true,
      kind: index === 0 ? null : 'proof-object',
      traits: [],
      created_at: new Date(now - 120_000 - index * 1_000).toISOString(),
      moderated: false,
      kind_moderated: false,
      has_drawing: index !== 5,
    }))
    const child = (id, name, thingCount) => ({
      id,
      parent_id: rootId,
      name,
      owner: 'proof-alex',
      purpose: 'Preview-only Live View proof ground.',
      front_matter: [],
      places: 0,
      things: thingCount,
      notes: 0,
      moderated: false,
      children: [],
    })
    const children = [
      child(gardenId, 'Movement garden', 0),
      child(workshopId, 'Crowded activity workshop', things.length),
      child(retryRoomId, 'Retry room', 0),
    ]
    const places = [{
      id: rootId,
      parent_id: null,
      name: WORLD_ROOT_NAME,
      owner: null,
      purpose: 'Repeatable preview proof ground.',
      front_matter: [],
      places: children.length,
      things: 0,
      notes: 0,
      moderated: false,
      children,
    }]
    const snapshot = {
      view: 'outline',
      change_marker: '9500',
      places,
      residents,
      notes: [],
      things,
      agreements: [],
      events: [],
      totals: {
        places: 4,
        residents: residents.length,
        conversations: 1,
        things: things.length,
        agreements: 0,
        events: 5,
      },
      pages: Object.fromEntries(['places', 'residents', 'notes', 'things',
        'agreements', 'events'].map(collection => [collection, { has_more: false }])),
      live_survey: [
        { id: rootId, parent_id: null, things: 0 },
        ...children.map(place => ({
          id: place.id,
          parent_id: rootId,
          things: place.things,
        })),
      ],
      refreshed_at: new Date(now).toISOString(),
    }
    const at = new Date(now - 100).toISOString()
    const changes = [
      { change_id: '9501', created_at: at, kind: 'action', actor: 'proof-alex',
        detail: { action: 'move', status: 'applied',
          from_place_id: gardenId, to_place_id: workshopId } },
      { change_id: '9502', created_at: at, kind: 'action', actor: 'proof-bea',
        detail: { action: 'move', status: 'applied',
          from_place_id: gardenId, to_place_id: workshopId } },
      { change_id: '9503', created_at: new Date(now - 50).toISOString(), kind: 'note',
        actor: 'proof-alex', detail: { place_id: workshopId, note_id: 9301 } },
      { change_id: '9504', created_at: new Date(now - 25).toISOString(), kind: 'action',
        actor: 'proof-alex', detail: { action: 'use', status: 'applied',
          place_id: workshopId, source_thing_id: things[0].id } },
      { change_id: '9505', created_at: new Date(now - 25).toISOString(), kind: 'action',
        actor: 'proof-bea', detail: { action: 'use', status: 'applied',
          place_id: workshopId, source_thing_id: things[1].id } },
    ]
    return Object.freeze({ rootId, snapshot, changes, residents, things })
  }

  function liveProofDrawings(proof) {
    const pixels = Object.freeze({
      palette: Object.freeze(['#174d3c', '#f0c95f']),
      indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? 0 : 1)),
    })
    const alternate = Object.freeze({
      palette: Object.freeze(['#d95c46', '#174d3c']),
      indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index % 2)),
    })
    const blank = Object.freeze({
      palette: Object.freeze([]),
      indices: Object.freeze(Array.from({ length: 64 }, () => null)),
    })
    // Step 2 proof: a real drawing with genuinely transparent cells (every
    // fourth square is null), so the owner can compare it against the
    // fully-opaque alternate pattern side by side on the workshop's own
    // strongly patterned floor.
    const holed = Object.freeze({
      palette: Object.freeze(['#d95c46', '#174d3c']),
      indices: Object.freeze(Array.from(
        { length: 64 }, (_, index) => index % 4 === 0 ? null : index % 2,
      )),
    })
    const held = (state, drawing, description, source, kind = {}) => Object.freeze({
      loading: false,
      loaded: true,
      error: false,
      state,
      presentation_state: windowDrawingStateLabel(state, drawing).toLowerCase().replace(' ', '_'),
      description,
      drawing,
      rows: drawing ? drawingRowsFor(drawing) : null,
      source,
      kind_id: kind.kind_id ?? null,
      kind_name: kind.kind_name ?? null,
      revision: kind.revision ?? null,
      variant_name: kind.variant_name ?? null,
    })
    const undrawn = () => held('undrawn', null, null, 'none')
    const base = Object.freeze({ kind_id: 9601, kind_name: 'proof-object', revision: 3 })
    const entries = [
      ['place:' + String(LIVE_PROOF_ROOT_ID), undrawn()],
      ['place:' + String(LIVE_PROOF_GARDEN_ID),
        held('refused', null, 'This proof place declines a drawing.', 'place')],
      ['place:' + String(LIVE_PROOF_WORKSHOP_ID),
        held('in_progress', pixels, 'The workshop outline is still being drawn.', 'place')],
      ['place:' + String(LIVE_PROOF_RETRY_ROOM_ID),
        held('complete', blank, 'An intentionally transparent room.', 'place')],
      ['resident:' + String(proof.residents[0].id),
        held('complete', holed, 'Proof Alex drew this see-through portrait.', 'resident')],
      ['resident:' + String(proof.residents[1].id),
        held('refused', null, 'Proof Bea chose not to draw.', 'resident')],
      ['resident:' + String(proof.residents[2].id),
        held('complete', blank, 'Proof Cato left this portrait deliberately blank.', 'resident')],
      ...proof.residents.slice(3).map(resident => ['resident:' + String(resident.id), undrawn()]),
      ['thing:' + String(proof.things[0].id),
        held('complete', pixels, 'An untyped owner drawing.', 'thing')],
      ['thing:' + String(proof.things[1].id),
        held('complete', alternate, 'The pinned kind base.', 'kind_base', base)],
      ['thing:' + String(proof.things[2].id), held(
        'complete', pixels, 'The ember glow named variant.', 'kind_variant',
        Object.freeze({ ...base, variant_name: 'ember glow' }),
      )],
      ['thing:' + String(proof.things[3].id),
        held('in_progress', alternate, 'An owner-selected base still in progress.', 'kind_base', base)],
      ['thing:' + String(proof.things[4].id),
        held('complete', blank, 'A deliberately blank named variant.', 'kind_variant',
          Object.freeze({ ...base, variant_name: 'clear glass' }))],
      ['thing:' + String(proof.things[5].id),
        held('refused', null, 'This thing owner explicitly refused.', 'thing', base)],
      ['thing:' + String(proof.things[6].id),
        held('complete', alternate, 'Another pinned kind base.', 'kind_base', base)],
    ]
    return Object.freeze(Object.fromEntries(entries))
  }

  function startLiveProofScene() {
    if (nodes.liveProof?.dataset.previewAvailable !== 'true') return
    if (liveReplayHeldKeys().size) settleLiveReplays()
    window.clearTimeout(state.pollTimer)
    window.clearTimeout(state.live.clockTimer)
    navigationRevision += 1
    authoredRevision += 1
    if (!liveProofRestore) {
      liveProofRestore = Object.freeze({
        state,
        liveCamera,
        liveResidentVisibleIdsByPlaceId,
        liveThingVisibleIdsByPlaceId,
        liveResidentPointsByPlaceId,
        liveThingPointsByPlaceId,
      })
    }
    window.clearTimeout(liveProofScriptedMoveTimer)
    liveProofScriptedMoveTimer = 0
    const now = Date.now()
    const proof = liveProofPayload(now)
    const normalized = normalizeSnapshot(proof.snapshot)
    const navigation = freshSnapshotNavigation(normalized)
    // Quiet opening proof: proof-fia's move is queued as opening backlog
    // (below, queueLiveReplays([residueChange], false)), so it settles at
    // rest with zero SVG lines -- the owner's evidence that entry is quiet.
    // proof-gus's move is scripted to fire LIVE_PROOF_SCRIPTED_MOVE_DELAY_MS
    // after entry instead, queued the way a record actually learned while
    // watching is, so it draws and animates normally.
    const residueChange = normalizeLiveChanges([{
      change_id: '9500',
      created_at: new Date(now - 1_000).toISOString(),
      kind: 'action',
      actor: 'proof-fia',
      detail: {
        action: 'move', status: 'applied',
        from_place_id: LIVE_PROOF_GARDEN_ID, to_place_id: LIVE_PROOF_WORKSHOP_ID,
      },
    }])[0]
    const changes = Object.freeze([
      ...normalizeLiveChanges(proof.changes),
      residueChange,
    ])
    const directory = Object.freeze({
      places: Object.freeze(normalized.flatPlaces.map(place => Object.freeze({
        id: place.id, parent_id: place.parent_id, name: place.name, path: place.path,
      }))),
      residents: Object.freeze(normalized.residents.map(resident => Object.freeze({
        id: resident.id, handle: resident.handle,
      }))),
      loaded: true,
      loading: false,
      error: false,
      marker: '9500',
      recheckTimer: 0,
    })
    liveResidentVisibleIdsByPlaceId = Object.freeze({})
    liveThingVisibleIdsByPlaceId = Object.freeze({})
    liveResidentPointsByPlaceId = Object.freeze({})
    liveThingPointsByPlaceId = Object.freeze({})
    liveCamera = Object.freeze({
      scale: LIVE_CAMERA_CENTER_SCALE,
      offsetX: 0,
      offsetY: 0,
      stageId: null,
      panStart: null,
      pinchStart: null,
    })
    state = {
      ...state,
      refreshing: false,
      hasSnapshot: true,
      pollTimer: 0,
      changeMarker: '9500',
      snapshot: navigation.snapshot,
      directory,
      focusedPlaces: {},
      focusedResidents: {},
      histories: freshSnapshotHistories(navigation.snapshot),
      branches: navigation.branches,
      residentPaging: navigation.residentPaging,
      placeId: null,
      resident: null,
      conversationContext: false,
      live: {
        ...state.live,
        openingMarker: '9500',
        openingEvents: [],
        openingLoaded: true,
        openingLoading: false,
        openingComplete: true,
        openingPaused: false,
        openingError: false,
        openingReplaySuppressed: false,
        openingNextBeforeId: null,
        streamError: false,
        streamMarker: '9500',
        changes,
        drawings: liveProofDrawings(proof),
        noteBodies: Object.freeze({
          '9301': Object.freeze({
            loading: false,
            error: false,
            body: 'spoke: two residents move together while this message appears.',
          }),
        }),
        highlightedKey: null,
        quietReads: 0,
        nextReadAt: now + 25_000,
        lastChangeAt: now,
        clockTimer: 0,
        replayQueues: {},
        replayActive: {},
        replayPositions: {},
        replayReadyAtByActor: {},
        replaySeenKeys: [],
        replayRevealedKeys: [],
        residueKeys: [],
        residueKeySet: new Set(),
        focusResident: null,
        paused: false,
        absorptionEndsAtByPlaceId: {},
        trailStarts: {},
        raisedItemKey: null,
        expandedResidentPlaceIds: [],
        expandedThingPlaceIds: [],
        focusRestoreKey: null,
        focusRestoreFallbackId: null,
        suppressReplayOnNextRead: false,
        proofScene: true,
        proofFailure: true,
        proofRetrySucceeded: false,
      },
    }
    const panel = document.getElementById('live-panel')
    if (panel) panel.dataset.liveProof = 'true'
    populateFilters(state.snapshot)
    queueLiveReplays(changes.filter(change => change !== residueChange))
    queueLiveReplays([residueChange], false)
    renderAll()
    setStatus('Running the repeatable preview proof scene', 'live')
    liveProofScriptedMoveTimer = window.setTimeout(() => {
      liveProofScriptedMoveTimer = 0
      if (!state.live.proofScene) return
      const scriptedChange = normalizeLiveChanges([{
        change_id: '9506',
        created_at: new Date().toISOString(),
        kind: 'action',
        actor: 'proof-gus',
        detail: {
          action: 'move', status: 'applied',
          from_place_id: LIVE_PROOF_GARDEN_ID, to_place_id: LIVE_PROOF_WORKSHOP_ID,
        },
      }])[0]
      state = { ...state, live: {
        ...state.live,
        changes: Object.freeze([...state.live.changes, scriptedChange]),
      } }
      queueLiveReplays([scriptedChange], true)
      if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
    }, LIVE_PROOF_SCRIPTED_MOVE_DELAY_MS)
  }

  function exitLiveProofScene() {
    if (!liveProofRestore) return
    window.clearTimeout(liveProofScriptedMoveTimer)
    liveProofScriptedMoveTimer = 0
    if (liveReplayHeldKeys().size) settleLiveReplays()
    window.clearTimeout(state.pollTimer)
    window.clearTimeout(state.live.clockTimer)
    const restore = liveProofRestore
    liveProofRestore = null
    state = {
      ...restore.state,
      refreshing: false,
      pollTimer: 0,
      live: { ...restore.state.live, clockTimer: 0, nextReadAt: null },
    }
    liveCamera = restore.liveCamera
    liveResidentVisibleIdsByPlaceId = restore.liveResidentVisibleIdsByPlaceId
    liveThingVisibleIdsByPlaceId = restore.liveThingVisibleIdsByPlaceId
    liveResidentPointsByPlaceId = restore.liveResidentPointsByPlaceId
    liveThingPointsByPlaceId = restore.liveThingPointsByPlaceId
    const panel = document.getElementById('live-panel')
    if (panel) delete panel.dataset.liveProof
    if (state.snapshot) populateFilters(state.snapshot)
    renderAll()
    scheduleRefresh(0)
  }

  function liveProofLoadNode(focus, survey) {
    if (!state.live.proofScene ||
        ![LIVE_PROOF_ROOT_ID, LIVE_PROOF_RETRY_ROOM_ID].includes(focus.id)) return null
    const row = element('section', state.live.proofFailure
      ? 'live-proof-load live-proof-load-failed'
      : 'live-proof-load live-proof-load-ready')
    if (focus.id === LIVE_PROOF_ROOT_ID) {
      const retryPlot = survey.plots.find(plot => plot.id === LIVE_PROOF_RETRY_ROOM_ID)
      if (!retryPlot) return null
      row.style.left = String(retryPlot.x + 12) + 'px'
      row.style.top = String(retryPlot.y + 48) + 'px'
      row.style.width = '12rem'
    } else {
      row.style.left = String(Math.max(24, survey.width / 2 - 144)) + 'px'
      row.style.top = String(Math.max(72, survey.height / 2 - 80)) + 'px'
    }
    if (state.live.proofFailure) {
      row.append(element('strong', '', 'Forced preview failure'))
      row.append(element('span', '', 'The proof room did not load. This is deliberate.'))
      const retry = element('button', 'selection-retry', 'Retry proof room')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-proof-retry'
      retry.addEventListener('click', () => {
        state = { ...state, live: {
          ...state.live,
          proofFailure: false,
          proofRetrySucceeded: true,
        } }
        if (state.snapshot) {
          renderLive(state.snapshot)
          window.queueMicrotask(() =>
            revealLiveElements(liveRevealTargetsForPlace(LIVE_PROOF_WORKSHOP_ID)))
        }
      })
      row.append(retry)
    } else {
      row.append(element('strong', '', 'Proof room loaded on Retry'))
    }
    return row
  }
`
