export const PART_33_AGREEMENTS_AND_HISTORY_CONTROLS = `  function renderAgreements(snapshot) {
    if (!nodes.agreements) return
    const filters = Object.freeze({ placeId: null, resident: state.resident })
    const issue = state.resident ? selectionIssue(snapshot, false) : null
    if (issue?.kind === 'resident') {
      renderSelectionIssue(nodes.agreements, issue)
      hideHistoryControl(nodes.agreementsPage)
      return
    }
    autoLoadFilteredHistory('agreements', filters, historyEntry('agreements', filters))
    const entry = historyEntry('agreements', filters)
    const agreements = entry.rows
    if (renderHistoryOutcome(nodes.agreements, entry, Object.freeze({
      loading: 'Fetching agreements that match this resident…',
      failure: 'Agreements could not be loaded. Retry below.',
      empty: 'No public agreement matches this resident selection.',
    }))) {
      renderHistoryControl(nodes.agreementsPage, 'agreements', 'agreements', filters)
      return
    }
    nodes.agreements.replaceChildren(...agreements.map(agreement => {
      const card = element('article', 'agreement-card')
      const copy = element('div', '')
      const agreementMeta = element('p', 'agreement-meta')
      agreementMeta.append(
        document.createTextNode('agreement #' + String(agreement.id) + ' · written by '),
        residentNode(agreement.created_by, 'agreement-author',
          'agreement-author:' + String(agreement.id)),
      )
      copy.append(
        agreementMeta,
        renderExpandableBody('agreement', agreement.id, agreement.body, agreement.truncated),
        timeNode(agreement.created_at, 'agreement-meta'),
      )
      if (state.resident && agreement.parties_truncated &&
          agreement.created_by !== state.resident && !agreement.parties.includes(state.resident)) {
        copy.append(element('p', 'agreement-filter-note',
          'Party preview is incomplete; this agreement stays visible in filtered views.'))
      }
      if (agreement.moderated) copy.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
      const side = element('aside', 'agreement-side')
      side.append(element('h3', '', 'Parties & signatures'))
      const signatures = element('div', 'signature-list')
      // Named parties first, then whoever acceded later. An acceded party has
      // always signed -- joining is the signing -- so it gets its own mark
      // rather than a tick that would read as an invitation the author wrote.
      const named = agreement.parties.filter(party => !agreement.acceded.includes(party))
      signatures.append(...named.concat(agreement.acceded).map(party => {
        const acceded = agreement.acceded.includes(party)
        const signed = agreement.signatures.includes(party)
        const chip = element('span', 'signature-chip')
        const resident = residentReference(snapshot, party)
        if (resident) {
          chip.append(portraitNode(
            'resident', resident.id, party, resident.has_drawing, 'signature-portrait',
          ))
        }
        chip.append(document.createTextNode((acceded ? '+ ' : signed ? '✓ ' : '○ ') + party))
        chip.dataset.signed = String(signed)
        if (acceded) {
          chip.dataset.acceded = 'true'
          chip.title = 'acceded after the agreement was written'
        }
        return chip
      }))
      const hiddenPartyCount = Math.max(0, agreement.party_count - agreement.parties.length)
      if (agreement.parties_truncated && hiddenPartyCount) {
        signatures.append(element('span', 'signature-overflow',
          '+' + String(hiddenPartyCount) + ' more not shown here'))
      }
      side.append(signatures, element('span', agreement.open ? 'badge badge-open' : 'badge badge-complete',
        agreement.open ? 'Awaiting signatures' : 'Fully signed'))
      side.append(element('span', agreement.accession_open ? 'badge badge-open' : 'badge badge-complete',
        agreement.accession_open ? 'Open to later signers' : 'Closed to later signers'))
      card.append(copy, side)
      return card
    }))
    renderHistoryControl(nodes.agreementsPage, 'agreements', 'agreements', filters)
  }

  // A filtered view whose slice has never been fetched from the server only
  // holds whatever happened to sit in the newest city-wide page. Fetch the
  // real filtered slice once instead of leaving the view falsely quiet.
  function autoLoadFilteredHistory(collection, filters, entry) {
    if (!filters.placeId && !filters.resident) return
    if (entry.initialized || entry.loading || entry.error) return
    void loadHistory(collection, filters)
  }

  function renderHistoryControl(target, collection, label, filters) {
    if (!target) return
    const entry = historyEntry(collection, filters)
    const hasRefreshState = entry.refreshing || entry.refreshError
    const hasPagingState = entry.hasMore || entry.loading || entry.error
    if (!hasRefreshState && !hasPagingState) {
      target.hidden = true
      target.replaceChildren()
      return
    }
    const parts = []
    if (entry.refreshing) {
      parts.push(element('p', 'loading-row', 'Loading updated ' + label + '…'))
    } else if (entry.refreshError) {
      const message = element('p', 'navigation-error',
        'Updated ' + label + ' could not be loaded. Showing the previous completed results.')
      message.setAttribute('role', 'alert')
      const retry = element('button', 'history-load', 'Retry refreshing ' + label)
      retry.type = 'button'
      retry.dataset.focusKey = 'refresh:' + collection + ':' + historyKey(collection, filters)
      retry.addEventListener('click', () => void forwardRefreshHistory(collection, filters))
      parts.push(message, retry)
    }
    if (!hasPagingState) {
      target.hidden = false
      target.replaceChildren(...parts)
      return
    }
    // While the first filtered slice is being fetched nothing "older" is
    // involved yet; every click-driven state keeps the familiar wording.
    const older = entry.initialized ? 'older ' : ''
    const text = entry.loading
      ? 'Loading ' + older + label + '…'
      : entry.error ? 'Retry loading ' + older + label : 'Load ' + older + label
    const button = element('button', 'history-load', text)
    button.type = 'button'
    // Never disabled: a disabled control cannot take restored focus, and
    // loadHistory already ignores clicks while a fetch is in flight.
    button.setAttribute('aria-busy', String(entry.loading))
    button.dataset.focusKey = 'load:' + collection + ':' + historyKey(collection, filters)
    button.dataset.focusFallbackId = collection === 'events'
      ? 'activity-list'
      : collection === 'agreements'
        ? 'agreement-list'
        : collection === 'things'
          ? 'place-things'
          : label === 'conversations' ? 'conversation-stream' : 'place-conversation'
    button.addEventListener('click', () => void loadHistory(collection, filters))
    if (entry.error && entry.rows.length) {
      const message = element('p', 'navigation-error',
        (older ? 'Older ' : '') + label + ' could not be loaded.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    parts.push(button)
    target.hidden = false
    target.replaceChildren(...parts)
  }

  function historyRequestUrl(collection, entry, filters, minimumMarker) {
    const url = new URL(
      collection === 'events' ? '/api/events' : '/api/window',
      window.location.origin,
    )
    // Context pages carry up to four neighbors per own note, so they use a
    // smaller page to stay well inside the client's 200-row safety cap.
    url.searchParams.set('limit', filters.context ? '25' : '50')
    if (collection === 'events') {
      if (filters.placeId) url.searchParams.set('within_place_id', String(filters.placeId))
      if (filters.resident) url.searchParams.set('actor', filters.resident)
    } else {
      url.searchParams.set('collection', collection)
      if (filters.placeId) url.searchParams.set('within_place_id', String(filters.placeId))
      if (filters.resident) url.searchParams.set('resident', filters.resident)
      if (filters.context) url.searchParams.set('context', 'place')
    }
    if (entry.initialized && entry.nextBeforeId) {
      url.searchParams.set('before_id', String(entry.nextBeforeId))
    }
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  function normalizeHistoryRows(collection, payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public history page')
    if (collection === 'notes') return normalizeNotes(payload.notes)
    if (collection === 'things') return normalizeThings(payload.things)
    if (collection === 'agreements') return normalizeAgreements(payload.agreements)
    return normalizeEvents(payload.events)
  }

  // A filtered entry only pages backward once initialized, and the snapshot
  // merge can only place-match events it can resolve client-side. Refetching
  // the newest filtered page after each snapshot refresh keeps an open
  // filtered view complete without touching its backward cursor.
  const forwardRefreshKeys = new Set()
  async function forwardRefreshHistory(collection, filters) {
    const key = collection + '|' + historyKey(collection, filters)
    if (forwardRefreshKeys.has(key)) return
    forwardRefreshKeys.add(key)
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    const current = historyEntry(collection, filters)
    setHistoryEntry(collection, filters, {
      ...current,
      refreshing: true,
      refreshError: false,
    })
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = historyRequestUrl(
        collection, { initialized: false, nextBeforeId: null }, filters, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('updated public history unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const incoming = normalizeHistoryRows(collection, payload)
      const latest = historyEntry(collection, filters)
      setHistoryEntry(collection, filters, {
        ...latest,
        rows: mergeWindowRows(latest.rows, incoming),
        refreshing: false,
        refreshError: false,
      })
      renderAll()
    } catch {
      if (authoredRevision === requestAuthoredRevision) {
        const latest = historyEntry(collection, filters)
        setHistoryEntry(collection, filters, {
          ...latest,
          refreshing: false,
          refreshError: true,
        })
        renderAll()
      }
    } finally {
      window.clearTimeout(timeout)
      forwardRefreshKeys.delete(key)
    }
  }

`
