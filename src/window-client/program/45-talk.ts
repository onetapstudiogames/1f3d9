export const PART_45_TALK = `  let talkRequestRevision = 0
  let talkChecks = 0
  let talkDelayIsIdle = false

  function talkViewActive() {
    return state.view === 'talk'
  }

  function noteTalkCheck() {
    talkChecks += 1
    document.body.dataset.talkChecks = String(talkChecks)
  }

  function nextTalkCheckDelay(idleMs) {
    return talkCheckDelay({
      failures: state.talk.failures,
      idleMs,
      checkMs: state.talk.checkMs,
      retryMaxMs: TALK_RETRY_MAX_MS,
      idleAfterMs: TALK_IDLE_MS,
      idleCheckMs: TALK_IDLE_CHECK_MS,
      jitterMaxMs: TALK_CHECK_JITTER_MS,
      random: Math.random(),
    })
  }

  function scheduleTalkCheck(delay) {
    window.clearTimeout(state.talk.timer)
    setTalk({ timer: 0 })
    talkDelayIsIdle = false
    if (document.hidden || !talkViewActive()) return
    const idleMs = Date.now() - state.talk.lastInputAt
    talkDelayIsIdle = state.talk.failures === 0 &&
      TALK_IDLE_MS > 0 && idleMs >= TALK_IDLE_MS &&
      delay === Math.max(TALK_IDLE_CHECK_MS, state.talk.checkMs)
    const timer = window.setTimeout(() => {
      setTalk({ timer: 0 })
      talkDelayIsIdle = false
      void checkTalk()
    }, delay)
    setTalk({ timer })
  }

  function syncTalkTimer() {
    if (!talkViewActive() || document.hidden) {
      if (!talkViewActive() || state.talk.timer) scheduleTalkCheck(0)
      return
    }
    if (!state.talk.timer && !state.talk.checking) void checkTalk()
  }

  function noteTalkInput() {
    const wasIdle = talkDelayIsIdle
    setTalk({ lastInputAt: Date.now() })
    if (!wasIdle) return
    scheduleTalkCheck(nextTalkCheckDelay(0))
    nodes.talkStatus.textContent = state.talk.statusText
    nodes.talkStatus.hidden = !state.talk.statusText
  }

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

  function syncTalkScope() {
    const scopeKey = currentTalkScopeKey()
    if (state.talk.scopeKey === scopeKey) return
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

  function talkRequestIsCurrent(revision, scopeKey) {
    return revision === talkRequestRevision &&
      scopeKey === state.talk.scopeKey &&
      scopeKey === currentTalkScopeKey()
  }

  async function checkTalk() {
    if (document.hidden) return
    if (!talkViewActive()) return
    syncTalkScope()
    if (state.talk.checking) return
    const scopeKey = currentTalkScopeKey()
    const revision = ++talkRequestRevision
    let keepTalkAtBottom = false
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
      const addsRows = page.rows.some(row =>
        !state.talk.rows.some(current => current.id === row.id))
      if (newestPage && addsRows && nodes.talkLines) {
        const distanceToBottom = nodes.talkLines.scrollHeight - nodes.talkLines.scrollTop -
          nodes.talkLines.clientHeight
        keepTalkAtBottom = distanceToBottom <= 24
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
      noteTalkCheck()
      if (talkRequestIsCurrent(revision, scopeKey)) {
        if (state.talk.checking) setTalk({ checking: false, loading: false })
        scheduleTalkCheck(nextTalkCheckDelay(Date.now() - state.talk.lastInputAt))
        renderAll()
        if (keepTalkAtBottom && nodes.talkLines) {
          nodes.talkLines.scrollTop = nodes.talkLines.scrollHeight
        }
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
    syncTalkScope()

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
        element('li', 'empty-row', talkEmptyPaneText(TALK_PANE_HOURS)),
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
    const idle = state.talk.failures === 0 && TALK_IDLE_MS > 0 &&
      Date.now() - state.talk.lastInputAt >= TALK_IDLE_MS
    const idleStatus = talkIdleStatus({
      idleMs: TALK_IDLE_MS,
      idleCheckMs: TALK_IDLE_CHECK_MS,
      checkMs: state.talk.checkMs ?? TALK_CHECK_MS,
      jitterMaxMs: TALK_CHECK_JITTER_MS,
    })
    const statusText = state.talk.statusText || (idle ? idleStatus : '')
    nodes.talkStatus.textContent = statusText
    nodes.talkStatus.hidden = !statusText
    if (!issue && state.view === 'talk' && state.talk.needsRead && !state.talk.checking) {
      void checkTalk()
    }
  }

`;
