export const PART_08_ARCHIVE = `  function safeArchiveChoice(value, choices, fallback) {
    return typeof value === 'string' && choices.includes(value) ? value : fallback
  }

  function safeArchiveCursor(value) {
    return safeText(value, null, 2048, false)
  }

  function safeChangeMarker(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return null
    try {
      return BigInt(value) <= 9223372036854775807n ? value : null
    } catch {
      return null
    }
  }

  function markerCovers(actual, minimum) {
    const safeActual = safeChangeMarker(actual)
    const safeMinimum = safeChangeMarker(minimum)
    return Boolean(safeActual && safeMinimum && BigInt(safeActual) >= BigInt(safeMinimum))
  }

  function requireExactReadMarker(actual, requested) {
    if (!requested) return
    const responseMarker = safeChangeMarker(actual)
    if (responseMarker === requested) return
    throw new Error('public read marker does not match its accepted rows')
  }

  function requireCurrentReadMarker(actual, requested) {
    if (!requested) return
    const responseMarker = safeChangeMarker(actual)
    if (responseMarker === requested && state.changeMarker === requested) return
    if (responseMarker && state.changeMarker &&
        BigInt(responseMarker) > BigInt(state.changeMarker)) void refreshCity()
    throw new Error('public read marker does not match the neighboring snapshot totals')
  }

  function normalizeArchiveResult(rawResult) {
    if (!rawResult || typeof rawResult !== 'object') return null
    const type = safeArchiveChoice(rawResult.type, ['note', 'thing'], null)
    const id = safeId(rawResult.id)
    const createdAt = safeDate(rawResult.created_at)
    if (!type || !id || !createdAt) return null
    const placeId = rawResult.place_id === null || rawResult.place_id === undefined
      ? null
      : safeId(rawResult.place_id)
    if (rawResult.place_id !== null && rawResult.place_id !== undefined && !placeId) return null
    const madeBy = type === 'thing' ? safeHandle(rawResult.made_by) : null
    const currentOwner = type === 'thing'
      ? safeHandle(rawResult.current_owner ?? rawResult.owner)
      : null
    const makerId = type === 'thing' ? safeId(rawResult.maker_id) : null
    const currentOwnerId = type === 'thing' ? safeId(rawResult.current_owner_id) : null
    const hasThingProvenance = type === 'thing' && [
      rawResult.maker_id, rawResult.made_by,
      rawResult.current_owner_id, rawResult.current_owner,
    ].some(value => value !== null && value !== undefined)
    if (hasThingProvenance && (!makerId || !madeBy || !currentOwnerId || !currentOwner)) return null
    const actor = type === 'note' ? safeHandle(rawResult.author) : currentOwner
    const name = type === 'thing'
      ? safeText(rawResult.name, '', 160, false)
      : ''
    return Object.freeze({
      type,
      id,
      createdAt,
      placeId,
      actor,
      makerId,
      madeBy,
      currentOwnerId,
      currentOwner,
      name,
      hasDrawing: rawResult.has_drawing === true,
      textBytes: safeCount(rawResult.body_text_bytes ?? rawResult.text_bytes),
      href: '/window/' + type + '/' + String(id),
    })
  }

  function normalizeArchivePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid archive response')
    const rawResults = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.items) ? payload.items : []
    if (rawResults.length > 25) throw new Error('invalid archive response')
    const results = rawResults.map(normalizeArchiveResult)
    if (results.some(result => !result)) throw new Error('invalid archive response')
    const totalItems = safeCount(payload.total_items ?? payload.totalItems)
    if (payload.returned_items !== results.length || totalItems < results.length) {
      throw new Error('invalid archive response')
    }
    const hasMore = payload.has_more === true || payload.hasMore === true
    const nextBefore = safeArchiveCursor(payload.next_before ?? payload.nextBefore)
    if (hasMore !== Boolean(nextBefore)) throw new Error('invalid archive response')
    return Object.freeze({
      results,
      totalItems,
      totalTextBytes: safeCount(
        payload.total_text_bytes ?? payload.total_body_bytes ??
          payload.totalTextBytes ?? payload.totalBodyBytes,
      ),
      hasMore,
      nextBefore,
    })
  }

  function archiveResultCard(result) {
    const card = element('li', 'archive-card')
    const heading = element('h3', 'archive-result-title', result.type === 'thing' && result.name
      ? result.name
      : 'Public note #' + String(result.id))
    if (result.type === 'thing' && result.name) {
      heading.prepend(portraitNode('thing', result.id, result.name, result.hasDrawing))
    }
    const recordLabel = result.type === 'thing'
      ? 'Thing #' + String(result.id)
      : 'Note #' + String(result.id)
    const details = [
      recordLabel,
      result.type === 'note' && result.actor ? 'by ' + result.actor : '',
      result.type === 'thing' && result.madeBy ? 'made by ' + result.madeBy : '',
      result.type === 'thing' && result.currentOwner
        ? 'currently owned by ' + result.currentOwner
        : '',
      result.placeId ? 'place #' + String(result.placeId) : '',
      dateLabel(result.createdAt),
      String(result.textBytes) + ' public text bytes',
    ].filter(Boolean)
    const meta = element('p', 'archive-result-meta', details.join(' · '))
    const link = openDetailLink(result.type, result.id, 'Open detail', 'archive-open')
    card.append(heading, meta, link)
    return card
  }

  function archiveRetryButton() {
    const retry = element('button', 'archive-retry', 'Retry search')
    retry.type = 'button'
    retry.addEventListener('click', () => void loadArchive(!state.archive.query))
    return retry
  }

  function renderArchivePage(archive) {
    if (!nodes.archivePage) return
    nodes.archivePage.hidden = true
    nodes.archivePage.replaceChildren()
    if (archive.loading && archive.results.length) {
      nodes.archivePage.hidden = false
      nodes.archivePage.replaceChildren(element('p', 'loading-row', 'Searching the archive for older matches…'))
      return
    }
    if (archive.error && archive.results.length) {
      nodes.archivePage.hidden = false
      nodes.archivePage.replaceChildren(
        element('p', 'error-row', archive.error),
        archiveRetryButton(),
      )
      return
    }
    if (!archive.hasMore || !archive.nextBefore) return
    const load = element('button', 'archive-load', 'Load older matches')
    load.type = 'button'
    load.addEventListener('click', () => void loadArchive(false))
    nodes.archivePage.hidden = false
    nodes.archivePage.replaceChildren(load)
  }

  function renderArchive() {
    if (!nodes.archiveResults) return
    const archive = state.archive
    if (nodes.archiveSearch) {
      nodes.archiveSearch.disabled = archive.loading
      nodes.archiveSearch.setAttribute('aria-busy', String(archive.loading))
    }
    nodes.archiveResults.setAttribute('aria-busy', String(archive.loading))
    if (archive.loading && !archive.results.length) {
      renderEmpty(nodes.archiveResults, 'loading-row', 'Searching the archive…')
      renderArchivePage(archive)
      return
    }
    if (archive.error && !archive.results.length) {
      const message = element('p', 'error-row', archive.error)
      nodes.archiveResults.replaceChildren(message, archiveRetryButton())
      renderArchivePage(archive)
      return
    }
    if (!archive.initialized) {
      renderEmpty(nodes.archiveResults, 'empty-row', 'Enter public words or an exact phrase to search.')
      renderArchivePage(archive)
      return
    }
    if (!archive.results.length) {
      renderEmpty(nodes.archiveResults, 'empty-row', 'No public notes or things matched this search.')
      renderArchivePage(archive)
      return
    }
    const summary = element(
      'p',
      'archive-summary',
      String(archive.totalItems) + (archive.totalItems === 1 ? ' exact match · ' : ' exact matches · ') +
        String(archive.totalTextBytes) + ' public text bytes total · bodies stay on their original records',
    )
    const list = element('ol', 'archive-list')
    list.append(...archive.results.map(archiveResultCard))
    nodes.archiveResults.replaceChildren(summary, list)
    renderArchivePage(archive)
  }

  async function loadArchive(reset, fromLocation = false) {
    if (state.archive.loading) return
    const requestAuthoredRevision = authoredRevision
    const mode = reset
      ? safeArchiveChoice(nodes.archiveMode?.value, ['words', 'phrase'], 'words')
      : state.archive.mode
    const type = reset
      ? safeArchiveChoice(nodes.archiveType?.value, ['all', 'note', 'thing'], 'all')
      : state.archive.type
    const candidateQuery = reset ? nodes.archiveQuery?.value : state.archive.query
    const validatedQuery = validateWindowArchiveQuery(candidateQuery, mode)
    if (!validatedQuery.ok) {
      const error = validatedQuery.reason === 'credential'
        ? 'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'
        : validatedQuery.reason === 'word_count'
          ? 'Words mode needs 1 to 16 word lexemes.'
          : 'Search must be one safe line of 1 to 256 UTF-8 bytes.'
      state = {
        ...state,
        archive: { ...state.archive, initialized: true, loading: false, error },
      }
      renderArchive()
      nodes.archiveQuery?.focus()
      return
    }
    const formQuery = validatedQuery.value
    if (!formQuery) {
      state = {
        ...state,
        archive: { ...state.archive, initialized: true, loading: false,
          error: 'Enter words or an exact phrase before searching.' },
      }
      renderArchive()
      nodes.archiveQuery?.focus()
      return
    }
    if (reset && nodes.archiveQuery) nodes.archiveQuery.value = formQuery
    const requestArchiveRevision = ++archiveRequestRevision
    const previous = state.archive
    state = {
      ...state,
      archive: {
        ...previous,
        query: formQuery,
        mode,
        type,
        results: reset ? [] : previous.results,
        loading: true,
        initialized: true,
        error: null,
      },
    }
    if (reset) writeLocation(!fromLocation)
    renderArchive()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/search', window.location.origin)
      url.searchParams.set('q', formQuery)
      url.searchParams.set('mode', mode)
      url.searchParams.set('type', type)
      url.searchParams.set('limit', '25')
      if (!reset && previous.nextBefore) url.searchParams.set('before', previous.nextBefore)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = new Error('archive unavailable')
        error.isBusy = response.status === 503
        throw error
      }
      const page = normalizeArchivePayload(await response.json())
      if (
        authoredRevision !== requestAuthoredRevision ||
        archiveRequestRevision !== requestArchiveRevision
      ) return
      const combined = new Map()
      for (const result of reset ? [] : previous.results) {
        combined.set(result.type + ':' + String(result.id), result)
      }
      for (const result of page.results) {
        combined.set(result.type + ':' + String(result.id), result)
      }
      state = {
        ...state,
        archive: {
          ...state.archive,
          results: [...combined.values()],
          totalItems: page.totalItems,
          totalTextBytes: page.totalTextBytes,
          nextBefore: page.nextBefore,
          hasMore: page.hasMore && Boolean(page.nextBefore),
          loading: false,
          error: null,
        },
      }
    } catch (error) {
      if (
        authoredRevision !== requestAuthoredRevision ||
        archiveRequestRevision !== requestArchiveRevision
      ) return
      state = {
        ...state,
        archive: {
          ...state.archive,
          loading: false,
          error: error && error.isBusy
            ? 'Search could not be loaded within the public reading limit.'
            : 'Search could not be loaded. Check the connection and try again.',
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderArchive()
    }
  }

`
