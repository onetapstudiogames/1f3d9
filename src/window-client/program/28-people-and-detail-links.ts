export const PART_28_PEOPLE_AND_DETAIL_LINKS = `  // Decision #75: a resident list can be scoped to a place and every place
  // inside it (occupants recurse through descendants), so each row resolves
  // quiet at that resident's own current_place_id — never at the place the
  // list itself was scoped to — the same way noteCard and renderThings do.
  function renderPeople(target, residents, placeOf) {
    if (!target) return
    if (!residents.length) {
      renderEmpty(target, 'empty-row', 'No included resident matching this view is standing inside this place.')
      return
    }
    const list = element('ul', 'person-list')
    list.append(...[...residents.filter(r => !r.asleep), ...residents.filter(r => r.asleep)].map(resident => {
      const item = element('li', resident.asleep ? 'person-card asleep' : 'person-card')
      const residentPlace = placeOf ? placeOf(resident.current_place_id) : null
      if (isQuietPlace(residentPlace)) {
        item.classList.add('person-card-quiet')
        item.append(quietRoomNotice(residentPlace))
        return item
      }
      const follow = element('button', 'resident-follow', resident.handle)
      follow.type = 'button'
      follow.dataset.focusKey = 'person:' + resident.handle
      follow.addEventListener('click', () => chooseResident(resident.handle))
      const location = windowPlaceLabel(
        resident.current_place_id,
        placeOf ? placeOf(resident.current_place_id) : null,
      )
      item.append(follow, element('span', 'resident-number',
        'resident #' + String(resident.id) + (resident.asleep ? ' · asleep' : '') +
        (location ? ' · at ' + location : '')))
      item.prepend(portraitNode('resident', resident.id, resident.handle, resident.has_drawing))
      return item
    }))
    target.replaceChildren(list)
  }

  // Context neighbours are picked by position in the room, never by clock, so
  // a quiet room can put a day between a note and the one before it. Say the
  // real distance rather than implying a closeness the rule never promised.
  function relativeGap(fromIso, toIso) {
    const difference = new Date(fromIso).getTime() - new Date(toIso).getTime()
    if (!Number.isFinite(difference)) return 'same room'
    const direction = difference < 0 ? ' earlier' : ' later'
    const minutes = Math.round(Math.abs(difference) / 60000)
    if (minutes < 1) return 'same room · moments apart'
    if (minutes < 60) return 'same room · ' + String(minutes) + 'm' + direction
    const hours = Math.round(minutes / 60)
    if (hours < 48) return 'same room · ' + String(hours) + 'h' + direction
    return 'same room · ' + String(Math.round(hours / 24)) + 'd' + direction
  }

  // A handle earns a button when any public source can resolve it. The complete
  // directory deliberately knows more names than the bounded presence page.
  function residentNode(handle, className, focusKey) {
    const known = state.snapshot && residentReference(state.snapshot, handle)
    if (!known) return element('span', className, handle)
    const follow = element('button', className + ' resident-follow-inline', handle)
    follow.type = 'button'
    follow.dataset.focusKey = focusKey
    follow.title = 'Follow ' + handle
    follow.addEventListener('click', () => chooseResident(handle))
    const reference = element('span', 'resident-reference')
    reference.append(portraitNode('resident', known.id, handle, known.has_drawing), follow)
    return reference
  }

  function openDetailLink(kind, id, label, className) {
    const link = element('a', className || 'detail-link', label)
    link.href = '/window/' + kind + '/' + String(id)
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate({ detail: Object.freeze({ kind, id }) })
    })
    return link
  }

  function openDrawingDetailButton(
    kind, id, label, className, text = 'Current drawing', ariaPrefix = 'Open current drawing for ',
  ) {
    const button = element('button', className || 'drawing-detail-open', text)
    button.type = 'button'
    button.dataset.focusKey = 'drawing-detail:' + kind + ':' + String(id)
    button.setAttribute('aria-label', ariaPrefix + label)
    button.addEventListener('click', () => navigate({ detail: Object.freeze({ kind, id }) }))
    return button
  }

  function normalizeDetailRecord(kind, id, payload) {
    const raw = payload && typeof payload === 'object'
      ? kind === 'place' ? payload.place || payload.tombstone : payload[kind]
      : null
    if (!raw || typeof raw !== 'object' || safeId(raw.id) !== id) return null
    if (kind === 'place') {
      const description = raw.moderated === true
        ? MODERATED_TEXT
        : safeExactText(raw.description, null, 8000, true)
      return description !== null && Array.from(description).length <= 4000
        ? Object.freeze({ kind, id, description })
        : null
    }
    const placeId = safeId(raw.place_id)
    const body = safeText(raw.body, null, kind === 'note' ? 4000 : 65536, kind === 'thing')
    if (!placeId || body === null) return null
    if (kind === 'note') {
      const author = safeHandle(raw.author)
      const createdAt = safeDate(raw.created_at)
      return author && createdAt ? Object.freeze({
        kind, id, placeId, author, body, createdAt, moderated: raw.moderated === true,
      }) : null
    }
    const name = safeText(raw.name, '', 120, false)
    const madeBy = safeHandle(raw.made_by)
    const currentOwner = safeHandle(raw.current_owner)
    return name && madeBy && currentOwner ? Object.freeze({
      kind, id, placeId, name, madeBy, currentOwner, body,
      moderated: raw.moderated === true,
      has_drawing: raw.has_drawing === true,
    }) : null
  }

  async function loadDrawingHistory(type, id, before = null, append = false) {
    if (!['place', 'resident', 'thing'].includes(type) ||
        state.detail?.kind !== type || state.detail.id !== id) return
    const key = detailDrawingKey(type, id)
    const current = state.detailDrawingHistories[key] || Object.freeze({
      expanded: true, initialized: false, loading: false, error: false,
      revisions: Object.freeze([]), hasMore: false, nextBefore: null,
      failedBefore: null, failedAppend: false,
    })
    if (current.loading) return
    const requestAuthoredRevision = authoredRevision
    const requestRevision = ++detailDrawingHistoryRequestRevision
    const requestIsCurrent = () => authoredRevision === requestAuthoredRevision &&
      detailDrawingHistoryRequestRevision === requestRevision &&
      state.detail?.kind === type && state.detail?.id === id
    state = {
      ...state,
      detailDrawingHistories: {
        ...state.detailDrawingHistories,
        [key]: Object.freeze({
          ...current, expanded: true, loading: true, error: false,
          failedBefore: null, failedAppend: false,
        }),
      },
    }
    renderDetail()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/drawing/' + type + '/' + String(id) + '/history',
        window.location.origin)
      url.searchParams.set('limit', '20')
      if (before) url.searchParams.set('before', String(before))
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      if (!response.ok) throw new Error('drawing history unavailable')
      const page = normalizeDrawingHistory(type, id, await response.json())
      if (!page) throw new Error('invalid drawing history')
      if (!requestIsCurrent()) return
      const previousRows = append ? current.revisions : []
      const rowsById = new Map(previousRows.map(revision => [revision.id, revision]))
      for (const revision of page.revisions) rowsById.set(revision.id, revision)
      const revisions = Object.freeze([...rowsById.values()]
        .sort((left, right) => right.id - left.id))
      state = {
        ...state,
        detailDrawingHistories: {
          ...state.detailDrawingHistories,
          [key]: Object.freeze({
            expanded: true, initialized: true, loading: false, error: false,
            revisions, hasMore: page.hasMore, nextBefore: page.nextBefore,
            failedBefore: null, failedAppend: false,
          }),
        },
      }
    } catch {
      if (!requestIsCurrent()) return
      state = {
        ...state,
        detailDrawingHistories: {
          ...state.detailDrawingHistories,
          [key]: Object.freeze({
            ...current, expanded: true, loading: false, error: true,
            failedBefore: before, failedAppend: append,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (requestIsCurrent()) renderDetail()
    }
  }

`
