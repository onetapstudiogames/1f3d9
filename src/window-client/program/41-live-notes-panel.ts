export const PART_41_LIVE_NOTES_PANEL = `  function emptyLiveNotesPanel(placeId = null, total = 0) {
    return Object.freeze({
      placeId, rows: Object.freeze([]), total, nextBeforeId: null,
      hasMore: false, initialized: false, loading: false, error: false,
    })
  }

  function liveNotesControl(snapshot, place, className = '') {
    const count = liveSurveyNoteTotal(snapshot, place.id)
    if (count === null) return null
    const control = element('button', ['live-place-notes', className].filter(Boolean).join(' '),
      'notes · ' + String(count))
    control.type = 'button'
    control.dataset.liveNotesPlaceId = String(place.id)
    control.dataset.liveNotesCount = String(count)
    control.dataset.focusKey = 'live-notes:' + String(place.id)
    control.setAttribute('aria-controls', 'live-notes-panel')
    control.setAttribute('aria-expanded', String(
      state.liveNotesOpen && state.placeId === place.id))
    control.setAttribute('aria-label', 'Open ' + String(count) + ' notes in ' + place.name)
    control.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      openLiveNotes(place.id, null, control)
    })
    return control
  }

  function openLiveNotes(placeId, noteId = null, opener = null) {
    const id = safeId(placeId)
    if (!id || !state.snapshot) return
    const total = liveSurveyNoteTotal(state.snapshot, id)
    if (total === null) return
    liveNotesTargetId = safeId(noteId)
    const focusesClose = !liveNotesTargetId
    liveNotesReturnFocus = Object.freeze({
      focusKey: opener?.dataset?.focusKey || document.activeElement?.dataset?.focusKey || null,
      fallbackKey: opener?.dataset?.focusFallbackKey || null,
      placeId: id,
    })
    liveNotesRequestRevision += 1
    liveNotesController?.abort()
    liveNotesController = null
    const held = state.live.notesPanel
    const notesPanel = held.placeId === id && held.total === total
      ? held
      : emptyLiveNotesPanel(id, total)
    state = { ...state, live: { ...state.live, notesPanel } }
    navigate({ view: 'live', placeId: id, liveNotesOpen: true })
    // Move keyboard focus into the panel once it is rendered, the mirror of
    // closeLiveNotes returning focus to the opener; the close control is the
    // first thing a keyboard or screen-reader user needs.
    window.requestAnimationFrame(() => {
      const target = focusesClose ? nodes.liveNotesClose : null
      if (target && !target.closest('[hidden]')) target.focus({ preventScroll: true })
    })
  }

  function closeLiveNotes() {
    if (!state.liveNotesOpen) return
    const returnFocus = liveNotesReturnFocus || Object.freeze({
      focusKey: null, placeId: state.placeId,
    })
    liveNotesRequestRevision += 1
    liveNotesController?.abort()
    liveNotesController = null
    liveNotesTargetId = null
    liveNotesReturnFocus = null
    navigate({ liveNotesOpen: false })
    window.requestAnimationFrame(() => {
      // The opener first (a bubble, a footnote mark, or the room's notes
      // control), then the speaker's sprite if the bubble has since faded,
      // then the room's notes control, then the viewport.
      const keys = [
        returnFocus.focusKey,
        returnFocus.fallbackKey,
        'live-notes:' + String(returnFocus.placeId || ''),
      ].filter(Boolean)
      const target = keys
        .map(key => document.querySelector('[data-focus-key="' + CSS.escape(key) + '"]'))
        .find(node => node && !node.closest('[hidden]'))
      if (target) target.focus({ preventScroll: true })
      else nodes.liveViewport?.focus({ preventScroll: true })
    })
  }

  function liveNoteRow(note, place) {
    if (isQuietPlace(place)) return quietRoomNotice(place)
    const row = element('li', 'live-note-row')
    row.dataset.liveNoteId = String(note.id)
    row.dataset.focusKey = 'live-note:' + String(place.id) + ':' + String(note.id)
    row.tabIndex = -1
    const meta = element('p', 'live-note-meta')
    meta.append(
      element('strong', '', note.author),
      document.createTextNode(' · '),
      timeNode(note.created_at, ''),
      document.createTextNode(' · note #' + String(note.id)),
    )
    row.append(meta, element('p', 'live-note-body', note.body))
    if (note.moderated) {
      row.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
    }
    return row
  }

  function renderLiveNotesPanel(snapshot) {
    const panel = nodes.liveNotesPanel
    if (!panel || state.view !== 'live' || !state.liveNotesOpen || !state.placeId) {
      if (panel) panel.hidden = true
      return
    }
    const place = placeReference(snapshot, state.placeId)
    const total = place ? liveSurveyNoteTotal(snapshot, place.id) : null
    if (!place || total === null) {
      panel.hidden = true
      return
    }
    panel.hidden = false
    nodes.liveNotesTitle.textContent = place.name + ' notes · ' + String(total)
    if (isQuietPlace(place)) {
      nodes.liveNotesStatus.textContent = 'This room asks for quiet.'
      nodes.liveNotesList.replaceChildren(quietRoomNotice(place))
      nodes.liveNotesPage.hidden = true
      nodes.liveNotesPage.replaceChildren()
      return
    }
    let entry = state.live.notesPanel
    if (entry.placeId !== place.id || entry.total !== total) {
      entry = emptyLiveNotesPanel(place.id, total)
      state = { ...state, live: { ...state.live, notesPanel: entry } }
    }
    nodes.liveNotesStatus.textContent = entry.loading
      ? 'Reading the next bounded page of up to 50 notes…'
      : entry.error
        ? 'This room’s next note page could not be read. Completed notes remain visible.'
        : 'Showing ' + String(entry.rows.length) + ' of ' + String(total) +
          ' direct room notes, newest first.'
    const focusedNoteKey = nodes.liveNotesList.contains(document.activeElement)
      ? document.activeElement?.dataset?.focusKey || null
      : null
    nodes.liveNotesList.replaceChildren(...(entry.rows.length
      ? entry.rows.map(note => liveNoteRow(note, place))
      : [element('li', entry.loading ? 'loading-row' : entry.error ? 'error-row' : 'empty-row',
          entry.loading ? 'Reading room notes…' : entry.error
            ? 'No note page is available yet.'
            : entry.initialized ? 'No public notes are in this room.' : 'Preparing room notes…')]))
    if (liveNotesTargetId) {
      const target = nodes.liveNotesList.querySelector(
        '[data-live-note-id="' + String(liveNotesTargetId) + '"]')
      if (target) {
        liveNotesTargetId = null
        target.scrollIntoView({ block: 'nearest' })
        target.focus({ preventScroll: true })
      } else if (entry.initialized && !entry.loading) {
        liveNotesTargetId = null
        nodes.liveNotesList.scrollTop = 0
        nodes.liveNotesClose?.focus({ preventScroll: true })
      }
    }
    if (focusedNoteKey) restoreFocus(focusedNoteKey, null, 'live-notes-close')
    const focusedKey = nodes.liveNotesPage.contains(document.activeElement)
      ? document.activeElement?.dataset?.focusKey || null
      : null
    const controls = []
    if (entry.loading || entry.error || entry.hasMore) {
      const button = element('button', 'live-notes-continue', entry.loading
        ? 'Reading notes…' : entry.error ? 'Retry notes page' : 'Continue')
      button.type = 'button'
      button.disabled = entry.loading
      button.dataset.focusKey = 'live-notes-continue:' + String(place.id)
      button.setAttribute('aria-busy', String(entry.loading))
      button.addEventListener('click', () => void loadLiveNotes(place.id, entry.initialized))
      controls.push(button)
    }
    nodes.liveNotesPage.hidden = controls.length === 0
    nodes.liveNotesPage.replaceChildren(...controls)
    if (focusedKey) restoreFocus(focusedKey, null, 'live-notes-close')
    if (!entry.initialized && !entry.loading && !entry.error && !document.hidden) {
      window.queueMicrotask(() => void loadLiveNotes(place.id, false))
    }
  }

  async function loadLiveNotes(placeId, continuing) {
    if (state.view !== 'live' || document.hidden || !state.liveNotesOpen ||
        state.placeId !== placeId) return
    const current = state.live.notesPanel
    if (current.placeId !== placeId || current.loading ||
        (continuing && !current.hasMore && !current.error) ||
        (!continuing && current.initialized && !current.error)) return
    const returnPageFocus = continuing &&
      document.activeElement?.dataset?.focusKey === 'live-notes-continue:' + String(placeId)
    const requestRevision = ++liveNotesRequestRevision
    const controller = new AbortController()
    liveNotesController?.abort()
    liveNotesController = controller
    state = { ...state, live: { ...state.live, notesPanel: Object.freeze({
      ...current, loading: true, error: false,
    }) } }
    if (state.snapshot) renderLiveNotesPanel(state.snapshot)
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      let page
      if (state.live.proofScene) {
        const proofRows = state.live.proofNotesByPlaceId[String(placeId)] || []
        const offset = continuing ? current.rows.length : 0
        const rows = Object.freeze(proofRows.slice(offset, offset + 50))
        const hasMore = offset + rows.length < proofRows.length
        page = Object.freeze({
          rows, hasMore, nextBeforeId: hasMore ? rows.at(-1)?.id || null : null,
        })
        await Promise.resolve()
      } else {
        const url = historyRequestUrl('notes', {
          initialized: continuing, nextBeforeId: current.nextBeforeId,
        }, { placeId, resident: null, context: false, exactPlace: true }, state.changeMarker)
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
          redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        })
        if (!response.ok) throw new Error('room notes unavailable')
        const payload = await response.json()
        requireCurrentReadMarker(payload?.change_marker, state.changeMarker)
        page = normalizeLiveNotesPage(payload, placeId, continuing ? current.nextBeforeId : null)
      }
      if (!page || requestRevision !== liveNotesRequestRevision || document.hidden ||
          state.view !== 'live' || !state.liveNotesOpen || state.placeId !== placeId) return
      const latest = state.live.notesPanel
      const rows = mergeWindowRows(continuing ? latest.rows : [], page.rows)
      if (rows.length > latest.total || (!page.hasMore && rows.length !== latest.total) ||
          (continuing && rows.length <= latest.rows.length)) {
        throw new Error('room note coverage did not progress')
      }
      state = { ...state, live: { ...state.live, notesPanel: Object.freeze({
        ...latest, rows: Object.freeze(rows), nextBeforeId: page.nextBeforeId,
        hasMore: page.hasMore, initialized: true, loading: false, error: false,
      }) } }
    } catch {
      if (requestRevision === liveNotesRequestRevision && state.liveNotesOpen &&
          state.placeId === placeId && !document.hidden) {
        state = { ...state, live: { ...state.live, notesPanel: Object.freeze({
          ...state.live.notesPanel, loading: false, error: true,
        }) } }
      }
    } finally {
      window.clearTimeout(timeout)
      if (liveNotesController === controller) liveNotesController = null
      if (state.snapshot) renderLiveNotesPanel(state.snapshot)
      if (returnPageFocus && state.liveNotesOpen && state.placeId === placeId) {
        restoreFocus('live-notes-continue:' + String(placeId), null, 'live-notes-close')
      }
    }
  }

`
