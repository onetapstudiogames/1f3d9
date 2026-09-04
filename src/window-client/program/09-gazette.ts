export const PART_09_GAZETTE = `  function safeGazetteCount(value) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }

  function safeGazetteStoredText(value, maximum, allowEmpty = false) {
    if (
      typeof value !== 'string' || containsMalformedPublicText(value) || hasUnsafeText(value) ||
      /1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)
    ) return null
    const characters = Array.from(value)
    if (characters.length > maximum || (!allowEmpty && !value.trim())) return null
    return value
  }

  function normalizeGazetteIssueSummary(rawIssue) {
    if (!rawIssue || typeof rawIssue !== 'object') return null
    const issueNumber = safeId(rawIssue.issue_number)
    const scheduledFor = safeDate(rawIssue.scheduled_for)
    const printedAt = safeDate(rawIssue.printed_at)
    const entryCount = safeGazetteCount(rawIssue.entry_count)
    if (!issueNumber || !scheduledFor || !printedAt || entryCount === null) return null
    if (printedAt.getTime() < scheduledFor.getTime()) return null
    return Object.freeze({ issueNumber, scheduledFor, printedAt, entryCount })
  }

  function normalizeGazetteListPayload(payload, requestedBeforeIssueNumber) {
    if (!payload || typeof payload !== 'object' ||
        !payload.submission_room || Array.isArray(payload.submission_room) ||
        payload.submission_room.place_id !== 454 ||
        typeof payload.submission_room.submissions_open !== 'boolean' ||
        payload.first_print_at !== GAZETTE_FIRST_PRINT_AT || !Array.isArray(payload.issues) ||
        payload.issues.length > GAZETTE_ISSUE_PAGE_LIMIT) {
      throw new Error('invalid Gazette issue page')
    }
    const firstPrintAt = safeDate(payload.first_print_at)
    const issues = payload.issues.map(normalizeGazetteIssueSummary)
    if (!firstPrintAt || issues.some(issue => !issue)) {
      throw new Error('invalid Gazette issue page')
    }
    for (let index = 1; index < issues.length; index += 1) {
      if (issues[index - 1].issueNumber <= issues[index].issueNumber) {
        throw new Error('invalid Gazette issue order')
      }
    }
    if (
      requestedBeforeIssueNumber &&
      issues.some(issue => issue.issueNumber >= requestedBeforeIssueNumber)
    ) throw new Error('invalid Gazette issue cursor page')
    const hasMore = payload.has_more === true
    const nextBeforeIssueNumber = payload.next_before_issue_number === null ||
      payload.next_before_issue_number === undefined
      ? null
      : safeId(payload.next_before_issue_number)
    if (hasMore !== Boolean(nextBeforeIssueNumber)) {
      throw new Error('invalid Gazette issue continuation')
    }
    if (hasMore && (
      !issues.length || nextBeforeIssueNumber !== issues.at(-1).issueNumber ||
      (requestedBeforeIssueNumber && nextBeforeIssueNumber >= requestedBeforeIssueNumber)
    )) throw new Error('stalled Gazette issue continuation')
    return Object.freeze({
      firstPrintAt,
      submissionsOpen: payload.submission_room.submissions_open,
      issues,
      hasMore,
      nextBeforeIssueNumber,
    })
  }

  function normalizeGazetteEntry(rawEntry, scheduledFor) {
    if (!rawEntry || typeof rawEntry !== 'object') return null
    const ordinal = safeId(rawEntry.ordinal)
    const noteId = safeId(rawEntry.note_id)
    const author = safeHandle(rawEntry.author)
    const body = safeGazetteStoredText(rawEntry.body, 65536)
    const createdAt = safeDate(rawEntry.created_at)
    if (!ordinal || !noteId || !author || body === null || !createdAt ||
        createdAt.getTime() >= scheduledFor.getTime()) return null
    return Object.freeze({ ordinal, noteId, author, body, createdAt })
  }

  function sameGazetteIssue(left, right) {
    return Boolean(left && right &&
      left.issueNumber === right.issueNumber &&
      left.scheduledFor.getTime() === right.scheduledFor.getTime() &&
      left.printedAt.getTime() === right.printedAt.getTime() &&
      left.entryCount === right.entryCount && left.header === right.header)
  }

  function normalizeGazetteDetailPayload(
    payload,
    expectedIssueNumber,
    requestedAfterOrdinal,
    acceptedIssue,
  ) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid Gazette issue')
    const summary = normalizeGazetteIssueSummary(payload.issue)
    const header = safeGazetteStoredText(payload.issue?.header, 4000)
    if (!summary || summary.issueNumber !== expectedIssueNumber || header === null ||
        !Array.isArray(payload.entries) || payload.entries.length > GAZETTE_ENTRY_PAGE_LIMIT) {
      throw new Error('invalid Gazette issue')
    }
    const entries = payload.entries.map(entry => normalizeGazetteEntry(entry, summary.scheduledFor))
    if (entries.some(entry => !entry)) throw new Error('invalid Gazette entries')
    let expectedOrdinal = (requestedAfterOrdinal || 0) + 1
    for (const entry of entries) {
      if (entry.ordinal !== expectedOrdinal) {
        throw new Error('invalid Gazette entry order')
      }
      expectedOrdinal += 1
    }
    const issue = Object.freeze({ ...summary, header })
    if (acceptedIssue && !sameGazetteIssue(issue, acceptedIssue)) {
      throw new Error('Gazette issue metadata changed between pages')
    }
    const hasMore = payload.has_more === true
    const nextAfterOrdinal = payload.next_after_ordinal === null ||
      payload.next_after_ordinal === undefined
      ? null
      : safeId(payload.next_after_ordinal)
    const lastOrdinal = entries.at(-1)?.ordinal ?? (requestedAfterOrdinal || 0)
    if (
      hasMore !== Boolean(nextAfterOrdinal) || summary.entryCount < entries.length ||
      (hasMore && (
        !entries.length || nextAfterOrdinal !== lastOrdinal ||
        nextAfterOrdinal >= summary.entryCount
      )) ||
      (!hasMore && lastOrdinal !== summary.entryCount)
    ) {
      throw new Error('invalid Gazette entry continuation')
    }
    return Object.freeze({
      issue,
      entries,
      hasMore,
      nextAfterOrdinal,
    })
  }

  function gazetteDateLabel(date, includeWeekday = false) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ]
    const weekday = includeWeekday ? weekdays[date.getUTCDay()] + ', ' : ''
    return weekday + String(date.getUTCDate()) + ' ' + months[date.getUTCMonth()] + ' ' +
      String(date.getUTCFullYear()) + ' at ' + String(date.getUTCHours()).padStart(2, '0') +
      ':' + String(date.getUTCMinutes()).padStart(2, '0') + ' UTC'
  }

  function selectGazetteIssue(issueNumber, push) {
    if (!issueNumber || state.gazetteIssueId === issueNumber) return
    gazetteDetailRequestRevision += 1
    resetShareFeedback()
    state = {
      ...state,
      gazetteIssueId: issueNumber,
      gazette: {
        ...state.gazette,
        issue: null,
        entries: [],
        nextAfterOrdinal: null,
        hasMoreEntries: false,
        detailLoading: false,
        detailInitialized: false,
        detailError: null,
      },
    }
    writeLocation(push)
    renderGazettePreservingFocus()
    void loadGazetteIssue(issueNumber, true)
  }

  function gazetteIssueLink(issue) {
    const item = element('li', 'gazette-issue-summary')
    const link = element('a', 'gazette-issue-link', 'Issue ' + String(issue.issueNumber))
    link.href = '/window/gazette?issue=' + String(issue.issueNumber)
    link.dataset.focusKey = 'gazette-issue-' + String(issue.issueNumber)
    if (issue.issueNumber === state.gazetteIssueId) link.setAttribute('aria-current', 'page')
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      selectGazetteIssue(issue.issueNumber, true)
    })
    const count = String(issue.entryCount) + (issue.entryCount === 1 ? ' submission' : ' submissions')
    const meta = element(
      'p',
      'gazette-issue-summary-meta',
      gazetteDateLabel(issue.scheduledFor, true) + ' · ' + count,
    )
    item.append(link, meta)
    return item
  }

  function gazetteListRetryButton() {
    const retry = element('button', 'gazette-retry', 'Retry loading Gazette issues')
    retry.type = 'button'
    retry.dataset.focusKey = 'gazette-retry-issues'
    retry.dataset.focusFallbackId = 'gazette-issue-list'
    retry.addEventListener('click', () => void loadGazetteIssues(state.gazette.listRetryMode))
    return retry
  }

  function gazetteDetailRetryButton() {
    const retry = element('button', 'gazette-retry', 'Retry loading this Gazette issue')
    retry.type = 'button'
    retry.dataset.focusKey = 'gazette-retry-detail'
    retry.dataset.focusFallbackId = 'gazette-issue'
    retry.addEventListener('click', () => {
      if (state.gazetteIssueId) void loadGazetteIssue(state.gazetteIssueId, state.gazette.entries.length === 0)
    })
    return retry
  }

  function renderGazetteIssuesPage(gazette) {
    if (!nodes.gazetteIssuesPage) return
    nodes.gazetteIssuesPage.hidden = true
    nodes.gazetteIssuesPage.replaceChildren()
    if (gazette.listLoading && gazette.issues.length) {
      nodes.gazetteIssuesPage.hidden = false
      nodes.gazetteIssuesPage.replaceChildren(
        element('p', 'loading-row', 'Checking the Gazette archive…'),
      )
      return
    }
    if (gazette.listError && gazette.issues.length) {
      nodes.gazetteIssuesPage.hidden = false
      nodes.gazetteIssuesPage.replaceChildren(
        element('p', 'error-row', gazette.listError),
        gazetteListRetryButton(),
      )
      return
    }
    if (!gazette.hasMoreIssues || !gazette.nextBeforeIssueNumber) return
    const load = element('button', 'gazette-load', 'Load older issues')
    load.type = 'button'
    load.dataset.focusKey = 'gazette-load-issues'
    load.dataset.focusFallbackId = 'gazette-issue-list'
    load.addEventListener('click', () => void loadGazetteIssues('older'))
    nodes.gazetteIssuesPage.hidden = false
    nodes.gazetteIssuesPage.replaceChildren(load)
  }

  function gazetteEntryCard(entry) {
    const item = element('li', 'gazette-entry')
    const body = element('p', 'gazette-entry-body')
    body.textContent = entry.body
    const attribution = element('p', 'gazette-entry-attribution')
    const source = element('a', 'gazette-source-note', 'Note #' + String(entry.noteId))
    source.href = '/window/note/' + String(entry.noteId)
    attribution.append(
      document.createTextNode('by '),
      residentNode(entry.author, 'gazette-entry-author',
        'gazette-entry-author:' + String(entry.noteId)),
      document.createTextNode(' · '),
      source,
      document.createTextNode(' · ' + gazetteDateLabel(entry.createdAt)),
    )
    item.append(body, attribution)
    return item
  }

  function renderGazetteEntriesPage(gazette) {
    if (!nodes.gazetteEntriesPage) return
    nodes.gazetteEntriesPage.hidden = true
    nodes.gazetteEntriesPage.replaceChildren()
    if (gazette.detailLoading && gazette.entries.length) {
      nodes.gazetteEntriesPage.hidden = false
      nodes.gazetteEntriesPage.replaceChildren(
        element('p', 'loading-row', 'Reading more entries in this issue…'),
      )
      return
    }
    if (gazette.detailError && gazette.entries.length) {
      nodes.gazetteEntriesPage.hidden = false
      nodes.gazetteEntriesPage.replaceChildren(
        element('p', 'error-row', gazette.detailError),
        gazetteDetailRetryButton(),
      )
      return
    }
    if (!gazette.hasMoreEntries || !gazette.nextAfterOrdinal) return
    const load = element('button', 'gazette-load', 'Load more entries')
    load.type = 'button'
    load.dataset.focusKey = 'gazette-load-entries'
    load.dataset.focusFallbackId = 'gazette-issue'
    load.addEventListener('click', () => {
      if (state.gazetteIssueId) void loadGazetteIssue(state.gazetteIssueId, false)
    })
    nodes.gazetteEntriesPage.hidden = false
    nodes.gazetteEntriesPage.replaceChildren(load)
  }

  function renderGazetteIssue(gazette) {
    if (!nodes.gazetteIssue) return
    nodes.gazetteIssue.setAttribute('aria-busy', String(gazette.detailLoading))
    if (!state.gazetteIssueId) {
      renderEmpty(
        nodes.gazetteIssue,
        'empty-row',
        gazette.issues.length
          ? 'Choose a permanent Gazette issue.'
          : 'The first permanent issue will appear here after its scheduled print.',
      )
      renderGazetteEntriesPage(gazette)
      return
    }
    if (gazette.detailLoading && !gazette.issue) {
      renderEmpty(nodes.gazetteIssue, 'loading-row', 'Reading Gazette issue ' + String(state.gazetteIssueId) + '…')
      renderGazetteEntriesPage(gazette)
      return
    }
    if (gazette.detailError && !gazette.issue) {
      nodes.gazetteIssue.replaceChildren(
        element('p', 'error-row', gazette.detailError),
        gazetteDetailRetryButton(),
      )
      renderGazetteEntriesPage(gazette)
      return
    }
    if (!gazette.issue) {
      renderEmpty(nodes.gazetteIssue, 'loading-row', 'Opening this permanent issue…')
      renderGazetteEntriesPage(gazette)
      return
    }
    const heading = element('h3', 'gazette-issue-title', 'Issue ' + String(gazette.issue.issueNumber))
    const printTime = element(
      'p',
      'gazette-print-time',
      'Weekly print for ' + gazetteDateLabel(gazette.issue.scheduledFor, true),
    )
    const provenance = element('p', 'gazette-provenance', gazette.issue.header)
    const entries = element('ol', 'gazette-entries')
    if (gazette.entries.length) {
      entries.append(...gazette.entries.map(gazetteEntryCard))
      nodes.gazetteIssue.replaceChildren(heading, printTime, provenance, entries)
    } else {
      nodes.gazetteIssue.replaceChildren(
        heading,
        printTime,
        provenance,
        element('p', 'empty-row', 'This permanent issue printed with no submissions.'),
      )
    }
    renderGazetteEntriesPage(gazette)
  }

  function renderGazette() {
    if (!nodes.gazetteIssueList) return
    const gazette = state.gazette
    if (nodes.gazetteSubmissionStatus) {
      if (gazette.submissionsOpen === true) {
        nodes.gazetteSubmissionStatus.dataset.state = 'open'
        nodes.gazetteSubmissionStatus.textContent = 'Room #454 is open for Gazette submissions.'
      } else if (gazette.submissionsOpen === false) {
        nodes.gazetteSubmissionStatus.dataset.state = 'closed'
        nodes.gazetteSubmissionStatus.textContent = 'Room #454 is closed for Gazette submissions. Wait until this notice says open before submitting.'
      } else {
        nodes.gazetteSubmissionStatus.dataset.state = gazette.listError ? 'unavailable' : 'checking'
        nodes.gazetteSubmissionStatus.textContent = gazette.listError
          ? 'Gazette submission status is unavailable. Check again before submitting.'
          : 'Checking whether Room #454 is open for submissions…'
      }
    }
    if (nodes.gazetteShare) {
      const label = state.gazetteIssueId
        ? 'Share issue ' + String(state.gazetteIssueId)
        : 'Share this Gazette'
      nodes.gazetteShare.dataset.shareLabel = label
      nodes.gazetteShare.textContent = label
    }
    if (nodes.gazetteRead) {
      const issueNumber = safeId(state.gazetteIssueId) ? state.gazetteIssueId : null
      nodes.gazetteRead.hidden = issueNumber === null
      nodes.gazetteRead.textContent = issueNumber === null
        ? 'Read issue'
        : 'Read issue ' + String(issueNumber)
      if (issueNumber === null) nodes.gazetteRead.removeAttribute('href')
      else nodes.gazetteRead.href = '/gazette/' + String(issueNumber)
    }
    nodes.gazetteIssueList.setAttribute('aria-busy', String(gazette.listLoading))
    if (gazette.listLoading && !gazette.issues.length) {
      renderEmpty(nodes.gazetteIssueList, 'loading-row', 'Opening the Gazette archive…')
    } else if (gazette.listError && !gazette.issues.length) {
      nodes.gazetteIssueList.replaceChildren(
        element('p', 'error-row', gazette.listError),
        gazetteListRetryButton(),
      )
    } else if (gazette.listInitialized && !gazette.issues.length) {
      renderEmpty(nodes.gazetteIssueList, 'empty-row', GAZETTE_FIRST_PRINT_EMPTY_STATE)
    } else if (gazette.issues.length) {
      const list = element('ol', 'gazette-issue-list-items')
      list.append(...gazette.issues.map(gazetteIssueLink))
      nodes.gazetteIssueList.replaceChildren(list)
    }
    renderGazetteIssuesPage(gazette)
    renderGazetteIssue(gazette)
  }

  function renderGazettePreservingFocus() {
    const active = document.activeElement
    const focusKey = active?.dataset?.focusKey || null
    const focusFallbackKey = active?.dataset?.focusFallbackKey || null
    const focusFallbackId = active?.dataset?.focusFallbackId || null
    renderGazette()
    restoreFocus(focusKey, focusFallbackKey, focusFallbackId)
  }

  async function loadGazetteIssues(mode) {
    if (gazetteListRequestPromise) return gazetteListRequestPromise
    const previous = state.gazette
    const initial = mode === 'initial'
    const older = mode === 'older'
    const requestRevision = ++gazetteListRequestRevision
    state = {
      ...state,
      gazette: {
        ...previous,
        submissionsOpen: older ? previous.submissionsOpen : null,
        issues: initial ? [] : previous.issues,
        nextBeforeIssueNumber: initial ? null : previous.nextBeforeIssueNumber,
        hasMoreIssues: initial ? false : previous.hasMoreIssues,
        listLoading: true,
        listInitialized: true,
        listError: null,
        listRetryMode: mode,
      },
    }
    renderGazettePreservingFocus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const request = (async () => {
      try {
        const url = new URL('/api/gazette', window.location.origin)
        url.searchParams.set('limit', String(GAZETTE_ISSUE_PAGE_LIMIT))
        if (older && previous.nextBeforeIssueNumber) {
          url.searchParams.set('before_issue_number', String(previous.nextBeforeIssueNumber))
        }
        const response = await fetch(url.pathname + url.search, {
          cache: 'no-store',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Gazette archive unavailable')
        const requestedBeforeIssueNumber = older ? previous.nextBeforeIssueNumber : null
        const page = normalizeGazetteListPayload(
          await response.json(),
          requestedBeforeIssueNumber,
        )
        if (gazetteListRequestRevision !== requestRevision) return false
        const combined = new Map()
        for (const issue of initial ? [] : previous.issues) {
          combined.set(issue.issueNumber, issue)
        }
        for (const issue of page.issues) combined.set(issue.issueNumber, issue)
        const issues = [...combined.values()]
          .sort((left, right) => right.issueNumber - left.issueNumber)
        const shouldSelectLatest = state.view === 'gazette' && !state.gazetteIssueId && issues.length
        const selectedIssueNumber = shouldSelectLatest ? issues[0].issueNumber : state.gazetteIssueId
        const preserveLoadedPagination = mode === 'refresh' && previous.issues.length > 0
        const nextBeforeIssueNumber = preserveLoadedPagination
          ? previous.nextBeforeIssueNumber
          : page.nextBeforeIssueNumber
        const hasMoreIssues = preserveLoadedPagination
          ? previous.hasMoreIssues
          : page.hasMore && Boolean(page.nextBeforeIssueNumber)
        if (shouldSelectLatest) resetShareFeedback()
        state = {
          ...state,
          gazetteIssueId: selectedIssueNumber,
          gazette: {
            ...state.gazette,
            firstPrintAt: page.firstPrintAt,
            submissionsOpen: page.submissionsOpen,
            issues,
            nextBeforeIssueNumber,
            hasMoreIssues,
            listLoading: false,
            listError: null,
          },
        }
        if (shouldSelectLatest) writeLocation(false)
        if (shouldSelectLatest) void loadGazetteIssue(selectedIssueNumber, true)
        return true
      } catch {
        if (gazetteListRequestRevision !== requestRevision) return false
        state = {
          ...state,
          gazette: {
            ...state.gazette,
            listLoading: false,
            listError: 'Gazette issues could not be loaded. Check the connection and try again.',
          },
        }
        return false
      } finally {
        window.clearTimeout(timeout)
        renderGazettePreservingFocus()
      }
    })()
    gazetteListRequestPromise = request
    try {
      return await request
    } finally {
      if (gazetteListRequestPromise === request) gazetteListRequestPromise = null
    }
  }

  async function loadGazetteIssue(issueNumber, reset) {
    const previous = state.gazette
    if (previous.detailLoading || !safeId(issueNumber)) return
    const sameIssue = previous.issue?.issueNumber === issueNumber
    const requestRevision = ++gazetteDetailRequestRevision
    state = {
      ...state,
      gazette: {
        ...previous,
        issue: reset || !sameIssue ? null : previous.issue,
        entries: reset || !sameIssue ? [] : previous.entries,
        nextAfterOrdinal: reset || !sameIssue ? null : previous.nextAfterOrdinal,
        hasMoreEntries: reset || !sameIssue ? false : previous.hasMoreEntries,
        detailLoading: true,
        detailInitialized: true,
        detailError: null,
      },
    }
    renderGazettePreservingFocus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/gazette/' + String(issueNumber), window.location.origin)
      url.searchParams.set('limit', String(GAZETTE_ENTRY_PAGE_LIMIT))
      if (!reset && previous.nextAfterOrdinal) {
        url.searchParams.set('after_ordinal', String(previous.nextAfterOrdinal))
      }
      const response = await fetch(url.pathname + url.search, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('Gazette issue unavailable')
      const requestedAfterOrdinal = reset || !sameIssue ? null : previous.nextAfterOrdinal
      const acceptedIssue = reset || !sameIssue ? null : previous.issue
      const page = normalizeGazetteDetailPayload(
        await response.json(),
        issueNumber,
        requestedAfterOrdinal,
        acceptedIssue,
      )
      if (gazetteDetailRequestRevision !== requestRevision || state.gazetteIssueId !== issueNumber) return
      const combined = new Map()
      for (const entry of reset || !sameIssue ? [] : previous.entries) {
        combined.set(entry.ordinal, entry)
      }
      for (const entry of page.entries) combined.set(entry.ordinal, entry)
      state = {
        ...state,
        gazette: {
          ...state.gazette,
          issue: page.issue,
          entries: [...combined.values()].sort((left, right) => left.ordinal - right.ordinal),
          nextAfterOrdinal: page.nextAfterOrdinal,
          hasMoreEntries: page.hasMore && Boolean(page.nextAfterOrdinal),
          detailLoading: false,
          detailError: null,
        },
      }
    } catch {
      if (gazetteDetailRequestRevision !== requestRevision || state.gazetteIssueId !== issueNumber) return
      state = {
        ...state,
        gazette: {
          ...state.gazette,
          detailLoading: false,
          detailError: 'This Gazette issue could not be loaded. Check the connection and try again.',
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderGazettePreservingFocus()
    }
  }

  function loadSharedGazette() {
    if (state.view !== 'gazette') return
    if (!state.gazette.listInitialized && !state.gazette.listLoading) {
      void loadGazetteIssues('initial')
    }
    if (
      state.gazetteIssueId && !state.gazette.detailLoading &&
      (!state.gazette.detailInitialized || state.gazette.issue?.issueNumber !== state.gazetteIssueId)
    ) {
      void loadGazetteIssue(state.gazetteIssueId, true)
    }
  }

`
