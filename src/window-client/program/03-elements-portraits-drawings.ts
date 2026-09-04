export const PART_03_ELEMENTS_PORTRAITS_DRAWINGS = `  function element(tagName, className, text) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }

  let portraitObserver = null
  const observedPortraitShells = new Set()
  const pendingPortraitShells = new Set()
  let portraitObservationScheduled = false

  function portraitUrl(type, id) {
    const path = '/api/drawing/' + encodeURIComponent(type) + '/' + String(id) + '/thumb.png'
    const revision = state.changeMarker || state.snapshot?.changeMarker || null
    return revision ? path + '?rev=' + encodeURIComponent(revision) : path
  }

  function loadPortraitImage(shell) {
    if (!shell.isConnected || shell.dataset.loaded === 'true') return
    shell.dataset.loaded = 'true'
    const image = element('img', 'entity-portrait-image')
    image.alt = ''
    image.width = 32
    image.height = 32
    image.loading = 'lazy'
    image.decoding = 'async'
    image.dataset.portraitType = shell.dataset.portraitType
    image.dataset.portraitId = shell.dataset.portraitId
    image.addEventListener('load', () => { shell.dataset.portraitState = 'loaded' })
    image.addEventListener('error', () => {
      shell.dataset.portraitState = 'placeholder'
      image.remove()
    })
    shell.append(image)
    image.src = portraitUrl(shell.dataset.portraitType, shell.dataset.portraitId)
  }

  function observePortraitShell(shell) {
    if (!shell.isConnected) return
    if (!('IntersectionObserver' in window)) {
      loadPortraitImage(shell)
      return
    }
    if (!portraitObserver) {
      portraitObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          portraitObserver.unobserve(entry.target)
          observedPortraitShells.delete(entry.target)
          loadPortraitImage(entry.target)
        }
      }, { rootMargin: '48px' })
    }
    observedPortraitShells.add(shell)
    portraitObserver.observe(shell)
  }

  function schedulePortraitShell(shell) {
    pendingPortraitShells.add(shell)
    if (portraitObservationScheduled) return
    portraitObservationScheduled = true
    window.queueMicrotask(() => {
      portraitObservationScheduled = false
      const pending = [...pendingPortraitShells]
      pendingPortraitShells.clear()
      for (const shell of pending) observePortraitShell(shell)
    })
  }

  function resetPortraitImages() {
    pendingPortraitShells.clear()
    if (portraitObserver) portraitObserver.disconnect()
    observedPortraitShells.clear()
  }

  function portraitNode(type, id, label, hasDrawing, className = '') {
    if (!hasDrawing) return document.createDocumentFragment()
    const shell = element('span', 'entity-portrait' + (className ? ' ' + className : ''))
    shell.setAttribute('aria-hidden', 'true')
    shell.dataset.portraitType = type
    shell.dataset.portraitId = String(id)
    shell.append(element('span', 'entity-portrait-placeholder'))
    schedulePortraitShell(shell)
    return shell
  }

  // Decision #62 / step 2 ruling: the sprite on the ground is the drawing
  // alone -- an authored thumbnail when one exists, or a small neutral
  // marker when it does not. No state or provenance chip renders here;
  // step 4 makes that state and provenance reachable through the single
  // Live item popover (hover, keyboard focus, or the first touch tap) and
  // the unchanged drawing-detail button, not through a title attribute --
  // the shell above is aria-hidden and the marker below was reachable only
  // by mouse hover, so a title never actually carried this to keyboard or
  // touch users.
  function liveSpriteNode(type, id, label, hasDrawing) {
    if (hasDrawing) {
      return portraitNode(type, id, label, true, 'live-entity-portrait')
    }
    const marker = element('span',
      'drawing-grid drawing-undrawn live-neutral-marker live-entity-portrait')
    marker.setAttribute('role', 'img')
    marker.setAttribute('aria-label', label + ' has no drawing')
    return marker
  }

  function drawingRowsFor(drawing) {
    return Object.freeze(Array.from({ length: 8 }, (_, row) => drawing.indices
      .slice(row * 8, row * 8 + 8)
      .map(index => index === null ? '.' : String(index))
      .join(' ')))
  }

  function safeDrawingText(value, maximumBytes, allowEmpty) {
    const text = safeExactText(value, null, maximumBytes, allowEmpty)
    if (text === null) return null
    try {
      return new TextEncoder().encode(text).byteLength <= maximumBytes ? text : null
    } catch {
      return null
    }
  }

  function normalizeDrawingSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const state = ['undrawn', 'refused', 'in_progress', 'complete'].includes(raw.state)
      ? raw.state
      : null
    if (!state) return null
    const drawing = raw.drawing === null ? null : normalizeWindowDrawing(raw.drawing)
    if (raw.drawing !== null && !drawing) return null
    if ((state === 'undrawn' || state === 'refused') !== (drawing === null)) return null
    const presentationState = windowDrawingStateLabel(state, drawing).toLowerCase()
      .replace(' ', '_')
    if (raw.presentation_state !== presentationState) return null
    const description = state === 'undrawn'
      ? raw.description === null ? null : undefined
      : safeDrawingText(raw.description, 280, true)
    if (description === undefined || (state !== 'undrawn' && description === null)) return null
    const rows = drawing ? drawingRowsFor(drawing) : null
    if (rows) {
      if (!Array.isArray(raw.rows) || raw.rows.length !== 8 ||
          raw.rows.some((row, index) => row !== rows[index])) return null
    } else if (raw.rows !== null) return null
    const source = ['none', 'resident', 'place', 'thing', 'kind_base', 'kind_variant']
      .includes(raw.source) ? raw.source : null
    if (!source || (state === 'undrawn') !== (source === 'none')) return null
    const rawKindId = raw.kind_id ?? null
    const rawKindName = raw.kind_name ?? null
    const rawRevision = raw.revision ?? null
    const rawVariantName = raw.variant_name ?? null
    const kindId = rawKindId === null ? null : safeId(rawKindId)
    const kindName = rawKindName === null ? null : safeDrawingText(rawKindName, 64, false)
    const revision = rawRevision === null ? null : safeId(rawRevision)
    const variantName = rawVariantName === null
      ? null
      : safeDrawingText(rawVariantName, 64, false)
    if ((rawKindId !== null && !kindId) || (rawKindName !== null && !kindName) ||
        (rawRevision !== null && !revision) || (rawVariantName !== null && !variantName)) {
      return null
    }
    if (source === 'kind_base' || source === 'kind_variant') {
      if (!kindId || !kindName || !revision) return null
      if ((source === 'kind_variant') !== Boolean(variantName)) return null
    } else if (variantName) return null
    return Object.freeze({
      state,
      presentation_state: presentationState,
      description,
      drawing,
      rows,
      source,
      kind_id: kindId,
      kind_name: kindName,
      revision,
      variant_name: variantName,
    })
  }

  function normalizeDrawingRead(type, id, payload) {
    if (!payload || typeof payload !== 'object' || payload.type !== type ||
        safeId(payload.id) !== id) return null
    return normalizeDrawingSnapshot(payload)
  }

  function normalizeDrawingRevision(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = safeId(raw.id)
    const slotVariantName = raw.slot_variant_name === null
      ? null
      : safeDrawingText(raw.slot_variant_name, 64, false)
    const previous = normalizeDrawingSnapshot(raw.previous)
    const current = normalizeDrawingSnapshot(raw.current)
    const rawAuthorId = raw.author?.id ?? null
    const rawAuthorHandle = raw.author?.handle ?? null
    const authorId = rawAuthorId === null ? null : safeId(rawAuthorId)
    const authorHandle = rawAuthorHandle === null ? null : safeHandle(rawAuthorHandle)
    const authorRelation = safeDrawingText(raw.author?.relation, 64, false)
    const createdAt = safeDate(raw.created_at)
    if (!id || (raw.slot_variant_name !== null && !slotVariantName) || !previous || !current ||
        (rawAuthorId !== null && !authorId) || (rawAuthorHandle !== null && !authorHandle) ||
        Boolean(authorId) !== Boolean(authorHandle) || !authorRelation || !createdAt) return null
    return Object.freeze({
      id,
      slot_variant_name: slotVariantName,
      previous,
      current,
      author: Object.freeze({ id: authorId, handle: authorHandle, relation: authorRelation }),
      created_at: createdAt.toISOString(),
    })
  }

  function normalizeDrawingHistory(type, id, payload) {
    if (!payload || typeof payload !== 'object' || payload.type !== type ||
        safeId(payload.id) !== id || !Array.isArray(payload.revisions) ||
        payload.revisions.length > 20 || !payload.page || typeof payload.page !== 'object' ||
        payload.page.limit !== 20 || typeof payload.page.has_more !== 'boolean') return null
    const revisions = payload.revisions.map(normalizeDrawingRevision)
    if (revisions.some(revision => !revision) ||
        new Set(revisions.map(revision => revision.id)).size !== revisions.length) return null
    const nextBefore = payload.page.next_before === null ? null : safeId(payload.page.next_before)
    if (payload.page.has_more !== Boolean(nextBefore)) return null
    return Object.freeze({
      revisions: Object.freeze(revisions),
      hasMore: payload.page.has_more,
      nextBefore,
    })
  }

`
