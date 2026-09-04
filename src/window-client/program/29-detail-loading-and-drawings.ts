export const PART_29_DETAIL_LOADING_AND_DRAWINGS = `  async function ensureDetail(force, placeId = null) {
    const target = placeId ? Object.freeze({ kind: 'place', id: placeId }) : state.detail
    if (!target || (target.kind === 'place' && !placeId) || target.kind === 'resident') return
    const key = target.kind + ':' + String(target.id)
    const current = state.details[key]
    if (current?.loading || (!force && (current?.record || current?.notFound ||
        (placeId && current?.error)))) return
    const requestAuthoredRevision = authoredRevision
    const requestDetailRevision = placeId ? null : ++detailRequestRevision
    const pending = Object.freeze({ loading: true, error: false, notFound: false, record: null })
    const requestIsCurrent = () => (
      authoredRevision === requestAuthoredRevision &&
      (placeId ? state.details[key] === pending : (
        detailRequestRevision === requestDetailRevision &&
        state.detail?.kind === target.kind &&
        state.detail?.id === target.id
      ))
    )
    state = {
      ...state,
      details: {
        ...state.details,
        [key]: pending,
      },
    }
    if (placeId) renderAll()
    else renderDetail()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/' + target.kind + '/' + String(target.id), window.location.origin)
      if (placeId) {
        url.searchParams.set('view', 'outline')
        url.searchParams.set('limit', '1')
      }
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      if (response.status === 404) {
        state = {
          ...state,
          details: {
            ...state.details,
            [key]: Object.freeze({ loading: false, error: false, notFound: true, record: null }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('public detail unavailable')
      const record = normalizeDetailRecord(target.kind, target.id, await response.json())
      if (!requestIsCurrent()) return
      if (!record) throw new Error('invalid public detail')
      state = {
        ...state,
        details: {
          ...state.details,
          [key]: Object.freeze({ loading: false, error: false, notFound: false, record }),
        },
      }
    } catch {
      if (!requestIsCurrent()) return
      state = {
        ...state,
        details: {
          ...state.details,
          [key]: Object.freeze({ loading: false, error: true, notFound: false, record: null }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (placeId) {
        if (authoredRevision === requestAuthoredRevision) renderAll()
      } else if (requestIsCurrent()) renderDetail()
    }
  }

  function detailDrawingKey(type, id) {
    return type + ':' + String(id)
  }

  async function ensureDetailDrawing(type, id, force = false) {
    if (!['place', 'resident', 'thing'].includes(type) ||
        state.detail?.kind !== type || state.detail.id !== id) return
    const key = detailDrawingKey(type, id)
    const current = state.detailDrawings[key]
    if (current?.loading || (!force && (current?.drawing || current?.unavailable))) return
    const requestAuthoredRevision = authoredRevision
    const requestRevision = ++detailDrawingRequestRevision
    const requestIsCurrent = () => authoredRevision === requestAuthoredRevision &&
      detailDrawingRequestRevision === requestRevision &&
      state.detail?.kind === type && state.detail?.id === id
    state = {
      ...state,
      detailDrawings: {
        ...state.detailDrawings,
        [key]: Object.freeze({ loading: true, error: false, unavailable: false, drawing: null }),
      },
    }
    renderDetail()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/drawing/' + type + '/' + String(id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      if (response.status === 404) {
        state = {
          ...state,
          detailDrawings: {
            ...state.detailDrawings,
            [key]: Object.freeze({
              loading: false, error: false, unavailable: true, drawing: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('drawing unavailable')
      const drawing = normalizeDrawingRead(type, id, await response.json())
      if (!drawing) throw new Error('invalid drawing')
      if (!requestIsCurrent()) return
      state = {
        ...state,
        detailDrawings: {
          ...state.detailDrawings,
          [key]: Object.freeze({
            loading: false, error: false, unavailable: false, drawing,
          }),
        },
      }
    } catch {
      if (!requestIsCurrent()) return
      state = {
        ...state,
        detailDrawings: {
          ...state.detailDrawings,
          [key]: Object.freeze({ loading: false, error: true, unavailable: false, drawing: null }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (requestIsCurrent()) renderDetail()
    }
  }

  function drawingExactReadback(snapshot) {
    if (!snapshot.drawing) return null
    const exact = element('section', 'drawing-exact-readback')
    exact.append(element('h4', '', 'Exact drawing readback'))
    const palette = element('p', 'drawing-exact-line')
    palette.append(document.createTextNode('Palette · '))
    const paletteValue = element('code', '', snapshot.drawing.palette.join(' '))
    paletteValue.dataset.drawingPalette = 'true'
    palette.append(paletteValue)
    const indices = element('p', 'drawing-exact-line')
    indices.append(document.createTextNode('64 indices · '))
    const indexValue = element('code', '', JSON.stringify(snapshot.drawing.indices))
    indexValue.dataset.drawingIndices = 'true'
    indices.append(indexValue)
    const rowsTitle = element('p', 'drawing-exact-line', 'Canonical eight rows')
    const rows = element('ol', 'drawing-canonical-rows')
    for (const row of snapshot.rows) {
      const item = document.createElement('li')
      const code = element('code', '', row)
      code.dataset.drawingRow = 'true'
      item.append(code)
      rows.append(item)
    }
    exact.append(palette, indices, rowsTitle, rows)
    return exact
  }

  function drawingSnapshotNode(snapshot, title, compact = false, descriptionId = null) {
    const section = element('section', compact ? 'drawing-snapshot drawing-snapshot-compact' :
      'drawing-snapshot')
    if (title) section.append(element('h4', '', title))
    const stateLabel = windowDrawingStateLabel(snapshot.state, snapshot.drawing)
    section.append(element('p', 'drawing-state-label', stateLabel))
    const sourceLabel = windowDrawingSourceLabel(snapshot)
    if (sourceLabel) section.append(element('p', 'drawing-provenance', sourceLabel))
    let descriptionNode = null
    if (snapshot.description !== null) {
      descriptionNode = element('p', 'drawing-owner-description', snapshot.description)
      if (descriptionId) descriptionNode.id = descriptionId
      section.append(descriptionNode)
    }
    if (snapshot.drawing) {
      const canvas = paintedDrawingNode(snapshot.drawing, 1, 1)
      if (canvas) {
        canvas.classList.add('drawing-detail-canvas')
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', stateLabel + (sourceLabel ? ' · ' + sourceLabel : ''))
        if (descriptionNode?.id) canvas.setAttribute('aria-describedby', descriptionNode.id)
        applyDrawingData(canvas, snapshot)
        section.append(canvas)
      }
    } else {
      section.append(element('p', 'drawing-no-pixels',
        snapshot.state === 'refused' ? 'The owner explicitly refused to draw.' :
          'No owner-authored pixels are set.'))
    }
    const exact = drawingExactReadback(snapshot)
    if (exact) section.append(exact)
    return section
  }

  function drawingHistoryNode(type, id, history) {
    const historyNode = element('section', 'drawing-history')
    historyNode.id = 'drawing-history-' + type + '-' + String(id)
    historyNode.setAttribute('aria-live', 'polite')
    historyNode.append(element('h4', '', 'Drawing history'))
    if (history.loading) {
      historyNode.append(element('p', 'loading-row', history.revisions.length
        ? 'Reading earlier drawing revisions…'
        : 'Reading drawing history…'))
    } else if (history.error) {
      historyNode.append(element('p', 'error-row', 'Drawing history could not be read.'))
      const retry = element('button', 'drawing-history-control', 'Retry drawing history')
      retry.type = 'button'
      retry.dataset.focusKey = 'drawing-history-retry'
      retry.addEventListener('click', () => void loadDrawingHistory(
        type, id, history.failedBefore, history.failedAppend))
      historyNode.append(retry)
    }
    for (const revision of history.revisions) {
      const row = element('article', 'drawing-history-revision')
      const when = new Date(revision.created_at).toLocaleString()
      row.append(element('h5', '', 'Revision #' + String(revision.id)))
      row.append(element('p', 'drawing-history-meta',
        'by ' + (revision.author.handle || revision.author.relation) + ' · ' +
        revision.author.relation + ' · ' + when +
        (revision.slot_variant_name ? ' · slot ' + revision.slot_variant_name : '')))
      row.append(
        drawingSnapshotNode(
          revision.previous,
          'Before',
          true,
          'drawing-description-' + type + '-' + String(id) + '-revision-' + String(revision.id) + '-before',
        ),
        drawingSnapshotNode(
          revision.current,
          'After',
          true,
          'drawing-description-' + type + '-' + String(id) + '-revision-' + String(revision.id) + '-after',
        ),
      )
      historyNode.append(row)
    }
    if (!history.loading && !history.error && history.initialized && !history.revisions.length) {
      historyNode.append(element('p', 'empty-row', 'No drawing changes have been recorded yet.'))
    }
    if (!history.loading && !history.error && history.hasMore && history.nextBefore) {
      const earlier = element('button', 'drawing-history-control', 'Load earlier drawing revisions')
      earlier.type = 'button'
      earlier.dataset.focusKey = 'drawing-history-earlier'
      earlier.addEventListener('click', () => void loadDrawingHistory(
        type, id, history.nextBefore, true))
      historyNode.append(earlier)
    }
    return historyNode
  }

  function drawingDetailNode(type, id, label) {
    const key = detailDrawingKey(type, id)
    const entry = state.detailDrawings[key]
    const section = element('section', 'drawing-detail')
    section.setAttribute('aria-label', label + ' drawing details')
    section.append(element('h3', '', 'Owner drawing'))
    if (!entry || entry.loading) {
      section.append(element('p', 'loading-row', 'Reading the current drawing…'))
      if (!entry) window.queueMicrotask(() => void ensureDetailDrawing(type, id))
      return section
    }
    if (entry.unavailable) {
      section.append(element('p', 'drawing-unavailable', 'Drawing unavailable'))
      return section
    }
    if (entry.error || !entry.drawing) {
      section.append(element('p', 'error-row', 'The current drawing could not be read.'))
      const retry = element('button', 'drawing-history-control', 'Retry current drawing')
      retry.type = 'button'
      retry.dataset.focusKey = 'drawing-current-retry'
      retry.addEventListener('click', () => void ensureDetailDrawing(type, id, true))
      section.append(retry)
      return section
    }
    section.append(drawingSnapshotNode(
      entry.drawing,
      '',
      false,
      'drawing-description-' + type + '-' + String(id) + '-current',
    ))
    const history = state.detailDrawingHistories[key] || null
    const expanded = history?.expanded === true
    const toggle = element('button', 'drawing-history-control', expanded
      ? 'Hide drawing history'
      : 'Show drawing history')
    toggle.type = 'button'
    toggle.dataset.focusKey = 'drawing-history-toggle'
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.setAttribute('aria-controls', 'drawing-history-' + type + '-' + String(id))
    toggle.addEventListener('click', () => {
      const held = state.detailDrawingHistories[key]
      if (held?.expanded) {
        state = {
          ...state,
          detailDrawingHistories: {
            ...state.detailDrawingHistories,
            [key]: Object.freeze({ ...held, expanded: false }),
          },
        }
        renderDetail()
        return
      }
      const next = held
        ? Object.freeze({ ...held, expanded: true })
        : Object.freeze({
            expanded: true, initialized: false, loading: false, error: false,
            revisions: Object.freeze([]), hasMore: false, nextBefore: null,
            failedBefore: null, failedAppend: false,
          })
      state = {
        ...state,
        detailDrawingHistories: { ...state.detailDrawingHistories, [key]: next },
      }
      renderDetail()
      if (!next.initialized && !next.loading) void loadDrawingHistory(type, id)
    })
    section.append(toggle)
    if (expanded && history) section.append(drawingHistoryNode(type, id, history))
    return section
  }

  function currentDrawingDetailSubject(target) {
    if (!state.snapshot || !target) return null
    if (target.kind === 'place') {
      const place = placeReference(state.snapshot, target.id) ||
        state.snapshot.flatPlaces.find(candidate => candidate.id === target.id)
      if (!place) return null
      return Object.freeze({
        title: place.name,
        meta: place.path + (place.owner
          ? ' · kept by ' + place.owner
          : ' · nobody owns it · transit only'),
      })
    }
    if (target.kind === 'resident') {
      const resident = displayedResidents(state.snapshot).find(candidate => candidate.id === target.id) ||
        Object.values(state.focusedResidents)
          .map(entry => entry?.resident || null)
          .find(candidate => candidate?.id === target.id) ||
        null
      if (!resident) return null
      const location = windowPlaceLabel(
        resident.current_place_id,
        resident.current_place_id ? placeReference(state.snapshot, resident.current_place_id) : null,
      )
      return Object.freeze({
        title: resident.handle,
        meta: 'resident #' + String(resident.id) +
          (resident.asleep ? ' · asleep' : '') +
          (location ? ' · at ' + location : ' · between places'),
      })
    }
    return null
  }

`
