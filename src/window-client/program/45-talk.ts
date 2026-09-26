export const PART_45_TALK = `  let talkRequestRevision = 0

  async function fetchTalkNow(signal) {
    try {
      const response = await fetch('/api/talk/now', {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) return null
      return normalizeTalkNow(await response.json(), {
        minMs: TALK_CHECK_MIN_MS,
        maxMs: TALK_CHECK_MAX_MS,
      })
    } catch {
      return null
    }
  }

  async function readTalkPage(marker, signal) {
    try {
      const beforeId = state.talk.stack[state.talk.stack.length - 1]
      const path = talkLinesPath({
        placeId: state.placeId,
        resident: state.resident,
        beforeId,
        marker,
        limit: TALK_PAGE_LINES,
      })
      const response = await fetch(path, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) return null
      return normalizeTalkLines(await response.json())
    } catch {
      return null
    }
  }

  function currentTalkScopeKey() {
    return String(state.placeId) + ':' + String(state.resident)
  }

  function talkRequestIsCurrent(revision, scopeKey) {
    return revision === talkRequestRevision &&
      scopeKey === state.talk.scopeKey &&
      scopeKey === currentTalkScopeKey()
  }

  async function checkTalk() {
    if (state.talk.checking || state.view !== 'talk') return
    const scopeKey = currentTalkScopeKey()
    const revision = ++talkRequestRevision
    setTalk({
      checking: true,
      loading: state.talk.rows.length === 0,
    })
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const fail = () => {
      setTalk({
        checking: false,
        loading: false,
        failures: state.talk.failures + 1,
        error: state.talk.rows.length === 0,
        needsRead: false,
        statusText: 'New lines could not be checked just now; the window keeps trying.',
      })
    }
    try {
      const head = await fetchTalkNow(controller.signal)
      if (!talkRequestIsCurrent(revision, scopeKey)) return
      if (!head) {
        fail()
        return
      }
      setTalk({ head, checkMs: head.checkMs })
      const newestPage = state.talk.stack.length === 1
      const markerMoved = state.talk.lineMarker === null ||
        BigInt(head.lineMarker) > BigInt(state.talk.lineMarker)
      const needsPage = state.view === 'talk' &&
        (state.talk.needsRead || (newestPage && markerMoved))
      if (!needsPage) {
        setTalk({
          checking: false,
          loading: false,
          error: false,
          failures: 0,
          statusText: '',
        })
        return
      }
      const page = await readTalkPage(head.lineMarker, controller.signal)
      if (!talkRequestIsCurrent(revision, scopeKey)) return
      if (!page) {
        fail()
        return
      }
      setTalk({
        rows: page.rows,
        hasMore: page.hasMore,
        lineMarker: head.lineMarker,
        needsRead: false,
        checking: false,
        loading: false,
        error: false,
        failures: 0,
        statusText: '',
      })
    } catch {
      if (talkRequestIsCurrent(revision, scopeKey)) fail()
    } finally {
      window.clearTimeout(timeout)
      if (talkRequestIsCurrent(revision, scopeKey)) {
        if (state.talk.checking) setTalk({ checking: false, loading: false })
        renderAll()
      }
    }
  }

  function talkCursorButton(label, action) {
    const button = element('button', 'talk-cursor-button', label)
    button.type = 'button'
    button.disabled = state.talk.loading || state.talk.checking
    button.addEventListener('click', action)
    return button
  }

  function renderTalk(snapshot) {
    if (!nodes.talkLines) return
    const scopeKey = currentTalkScopeKey()
    if (state.talk.scopeKey !== scopeKey) {
      talkRequestRevision += 1
      setTalk({
        stack: [null],
        rows: [],
        hasMore: false,
        lineMarker: null,
        head: null,
        loading: false,
        error: false,
        needsRead: true,
        scopeKey,
        checking: false,
        failures: 0,
        statusText: '',
      })
    }

    const issue = snapshot ? selectionIssue(snapshot, false) : null
    const selectedPlace = state.placeId
      ? snapshot
        ? placeReference(snapshot, state.placeId)
        : directoryPlace(state.placeId)
      : null
    const selectedPlaceIsQuiet = isQuietPlace(selectedPlace)
    let newestPage = state.talk.stack.length === 1
    let pane = talkPane(state.talk.rows, {
      newestPage,
      nowMs: Date.now(),
      paneMs: TALK_PANE_MS,
      hasMore: state.talk.hasMore,
    })
    let quietSelection = false

    nodes.talkOlder.hidden = true
    nodes.talkNewer.hidden = true
    nodes.talkOlder.replaceChildren()
    nodes.talkNewer.replaceChildren()
    if (issue) {
      renderSelectionIssue(nodes.talkLines, issue, 'li')
      quietSelection = true
    } else if (!state.directory.loaded) {
      nodes.talkLines.replaceChildren(element('li', 'loading-row', 'Loading the city directory…'))
      quietSelection = true
    } else if (selectedPlaceIsQuiet) {
      const quietRow = element('li', 'talk-line-quiet')
      quietRow.append(quietRoomNotice(selectedPlace))
      nodes.talkLines.replaceChildren(quietRow)
      quietSelection = true
    } else if (state.talk.loading && state.talk.rows.length === 0) {
      nodes.talkLines.replaceChildren(element('li', 'loading-row', 'Listening for lines…'))
    } else if (state.talk.error && state.talk.rows.length === 0) {
      const errorRow = element('li', 'error-row')
      errorRow.append(element('span', '', 'Talk could not be loaded. Retry below.'))
      const retry = element('button', 'talk-cursor-button', 'Retry')
      retry.type = 'button'
      retry.addEventListener('click', () => {
        setTalk({ needsRead: true, error: false, loading: true, statusText: '' })
        void checkTalk()
      })
      errorRow.append(retry)
      nodes.talkLines.replaceChildren(errorRow)
    } else if (state.talk.rows.length === 0) {
      nodes.talkLines.replaceChildren(
        element('li', 'empty-row', 'No public line matches this selection.'),
      )
    } else if (pane.shown.length === 0 && newestPage) {
      nodes.talkLines.replaceChildren(
        element('li', 'empty-row', 'No lines in the last 24 hours match this selection.'),
      )
    } else {
      const quietPlaceIds = new Set(state.talk.rows.flatMap(row => {
        if (row.removed === true) return []
        const placeId = row.placeId
        const place = snapshot
          ? placeReference(snapshot, placeId)
          : directoryPlace(placeId)
        return isQuietPlace(place) ? [placeId] : []
      }))
      const renderedRows = talkRenderRows(pane.shown, quietPlaceIds)
      const items = renderedRows.map(rendered => {
        if (rendered.type === 'removed') {
          const removed = element('li', 'talk-line talk-line-removed')
          removed.dataset.lineId = String(rendered.id)
          removed.textContent = MODERATED_WINDOW_LABEL
          return removed
        }
        if (rendered.type === 'quiet') {
          const quiet = element('li', 'talk-line talk-line-quiet')
          const place = snapshot
            ? placeReference(snapshot, rendered.placeId)
            : directoryPlace(rendered.placeId)
          const count = rendered.ids.length
          const countText = count === 1 ? '1 line in ' : String(count) + ' lines in '
          quiet.append(
            element(
              'p',
              'quiet-room-context',
              countText + quietRoomName(place, rendered.placeId) + '.',
            ),
            quietRoomNotice(place),
          )
          return quiet
        }
        const row = rendered.row
        const item = element('li', 'talk-line')
        item.dataset.lineId = String(row.id)
        item.append(
          residentNode(row.author, 'talk-speaker', 'talk-speaker:' + String(row.id)),
          element('span', 'talk-separator', ': '),
          element('span', 'talk-body', row.body),
        )
        const meta = element('span', 'talk-meta')
        meta.append(timeNode(row.createdAt, 'talk-time'))
        if (state.placeId === null || row.placeId !== state.placeId) {
          const place = snapshot
            ? placeReference(snapshot, row.placeId)
            : directoryPlace(row.placeId)
          const placeName = place && place.name
            ? place.name
            : 'place #' + String(row.placeId)
          meta.append(element('span', 'talk-place', ' · in ' + placeName))
        }
        item.append(meta)
        return item
      })
      nodes.talkLines.replaceChildren(...items)
    }

    if (!quietSelection) {
      newestPage = state.talk.stack.length === 1
      pane = talkPane(state.talk.rows, {
        newestPage,
        nowMs: Date.now(),
        paneMs: TALK_PANE_MS,
        hasMore: state.talk.hasMore,
      })
      if (pane.olderBeforeId !== null) {
        nodes.talkOlder.hidden = false
        nodes.talkOlder.append(talkCursorButton('Older lines', () => {
          const stack = [...state.talk.stack, pane.olderBeforeId]
          setTalk({ stack, loading: true, needsRead: true, error: false, statusText: '' })
          void checkTalk()
        }))
      }
      if (state.talk.stack.length > 1) {
        nodes.talkNewer.hidden = false
        nodes.talkNewer.append(
          element(
            'p',
            'talk-older-page',
            'You are reading older lines. New lines appear on the newest page.',
          ),
          talkCursorButton('Newer lines', () => {
            const stack = state.talk.stack.slice(0, -1)
            setTalk({ stack, loading: true, needsRead: true, error: false, statusText: '' })
            void checkTalk()
          }),
        )
      }
    }
    nodes.talkStatus.textContent = state.talk.statusText
    nodes.talkStatus.hidden = !state.talk.statusText
    if (!issue && state.view === 'talk' && state.talk.needsRead && !state.talk.checking) {
      void checkTalk()
    }
  }

`;
