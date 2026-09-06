export const PART_42_VIEWER_READING_STATE = `  const viewerInvalidatedRecordKeys = new Set()

  function readViewerOpenKeys() {
    try {
      return parseWindowViewerOpenKeys(localStorage.getItem(WINDOW_VIEWER_OPEN_STORAGE_KEY))
    } catch {
      return []
    }
  }

  function storeViewerOpenKeys(keys) {
    const bounded = keys.slice(-200)
    try {
      if (bounded.length) {
        localStorage.setItem(WINDOW_VIEWER_OPEN_STORAGE_KEY, JSON.stringify(bounded))
      } else {
        localStorage.removeItem(WINDOW_VIEWER_OPEN_STORAGE_KEY)
      }
    } catch {
      // Opening choices still work in memory when browser storage is unavailable.
    }
    return bounded
  }

  function setViewerBodyExpanded(bodyKey, expanded) {
    const withoutKey = state.expandedBodies.filter(key => key !== bodyKey)
    const expandedBodies = expanded ? [...withoutKey, bodyKey] : withoutKey
    state = { ...state, expandedBodies: storeViewerOpenKeys(expandedBodies) }
  }

  function viewerRecordVersion(record, presentation = null) {
    return JSON.stringify([record, presentation])
  }

  function viewerRecordDataVersion(record) {
    return JSON.stringify(record)
  }

  function viewerRecordNode(node, kind, record, presentation = null) {
    const key = kind + ':' + String(record.id)
    node.dataset.viewerRecordKey = key
    Object.defineProperty(node, '__viewerRecordVersion', {
      configurable: true,
      value: viewerRecordVersion(record, presentation),
    })
    Object.defineProperty(node, '__viewerRecordDataVersion', {
      configurable: true,
      value: viewerRecordDataVersion(record),
    })
    return node
  }

  function viewerPlacePresentation(place) {
    return place ? Object.freeze({
      id: place.id,
      name: place.name,
      path: place.path,
      quiet: place.quiet === true,
      owner: place.owner || null,
    }) : null
  }

  function viewerResidentPresentation(resident) {
    return resident ? Object.freeze({
      id: resident.id,
      handle: resident.handle,
      hasDrawing: resident.has_drawing === true,
    }) : null
  }

  function viewerNodeIsOpen(node) {
    return node.matches('[aria-expanded="true"], details[open], dialog[open]') ||
      Boolean(node.querySelector('[aria-expanded="true"], details[open], dialog[open]'))
  }

  function viewerNodeIsInView(node) {
    if (!node.isConnected || node.closest('[hidden]')) return false
    const box = node.getBoundingClientRect()
    return box.bottom > 0 && box.top < window.innerHeight &&
      box.right > 0 && box.left < window.innerWidth
  }

  function viewerNodeIsSelected(node) {
    if (!state.detail) return false
    if (node.dataset.viewerRecordKey ===
        state.detail.kind + ':' + String(state.detail.id)) return true
    const detailPath = '/window/' + state.detail.kind + '/' + String(state.detail.id)
    return [...node.querySelectorAll('.detail-link[href]')].some(link =>
      link.getAttribute('href') === detailPath)
  }

  function viewerReadingViewIsActive() {
    return ['conversations', 'happenings', 'place', 'things', 'agreements']
      .includes(state.view)
  }

  function viewerNodeIsHeld(node) {
    const recordKey = node.dataset.viewerRecordKey
    const rememberedOpen = recordKey && state.expandedBodies.includes(recordKey)
    return viewerReadingViewIsActive() && !node.closest('[hidden]') &&
      (rememberedOpen || viewerNodeIsOpen(node) || viewerNodeIsInView(node) ||
        viewerNodeIsSelected(node))
  }

  function viewerHeldRecordKeys() {
    if (!viewerReadingViewIsActive()) return new Set()
    return new Set([...document.querySelectorAll('[data-viewer-record-key]')]
      .filter(viewerNodeIsHeld)
      .map(node => node.dataset.viewerRecordKey))
  }

  function retainedViewerFullBodies(fullBodies, invalidatedKeys) {
    if (!viewerReadingViewIsActive()) return {}
    const heldKeys = viewerHeldRecordKeys()
    return Object.fromEntries(Object.entries(fullBodies).filter(([key, entry]) =>
      heldKeys.has(key) && !invalidatedKeys.has(key) && typeof entry?.body === 'string'))
  }

  function refreshViewerPortraits() {
    for (const shell of document.querySelectorAll(
      '[data-viewer-record-key] .entity-portrait[data-portrait-type][data-portrait-id]')) {
      const source = portraitUrl(shell.dataset.portraitType, shell.dataset.portraitId)
      const image = shell.querySelector(':scope > .entity-portrait-image')
      if (image && image.getAttribute('src') !== source) {
        shell.dataset.portraitUrl = source
        shell.dataset.portraitState = 'loading'
        image.src = source
      } else if (!image && shell.dataset.portraitUrl !== source) {
        shell.dataset.loaded = 'false'
        shell.dataset.portraitUrl = source
        schedulePortraitShell(shell)
      } else if (shell.dataset.loaded !== 'true') {
        schedulePortraitShell(shell)
      }
    }
  }

  function viewerRenderedBodiesMatch(current, incoming) {
    const currentBodies = [...current.querySelectorAll('[data-body-key]')]
    const incomingBodies = [...incoming.querySelectorAll('[data-body-key]')]
    if (currentBodies.length !== incomingBodies.length) return false
    return currentBodies.every(body => {
      const bodyKey = body.dataset.bodyKey
      const incomingBody = incoming.querySelector(
        '[data-body-key="' + CSS.escape(bodyKey) + '"]')
      return incomingBody && incomingBody.textContent === body.textContent
    })
  }

  function viewerNodeCanStay(current, incoming) {
    const key = current.dataset.viewerRecordKey
    const held = Boolean(key && key === incoming.dataset.viewerRecordKey &&
      !viewerInvalidatedRecordKeys.has(key) &&
      viewerNodeIsHeld(current))
    if (!held) return false
    if (!viewerRenderedBodiesMatch(current, incoming)) return false
    if (current.__viewerRecordVersion === incoming.__viewerRecordVersion) return true
    if (current.__viewerRecordDataVersion !== incoming.__viewerRecordDataVersion ||
        !syncViewerRecordPresentation(current, incoming)) return false
    Object.defineProperty(current, '__viewerRecordVersion', {
      configurable: true,
      value: incoming.__viewerRecordVersion,
    })
    return true
  }

  function replaceViewerChildrenWithoutDetaching(target, rows) {
    const retained = new Set(rows)
    for (const current of [...target.children]) {
      if (!retained.has(current)) current.remove()
    }
    let cursor = target.firstElementChild
    for (const row of rows) {
      if (row === cursor) {
        cursor = cursor.nextElementSibling
      } else {
        target.insertBefore(row, cursor)
      }
    }
  }

  function syncViewerElementAttributes(current, incoming) {
    for (const attribute of [...current.attributes]) {
      if (!incoming.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
    }
    for (const attribute of [...incoming.attributes]) {
      current.setAttribute(attribute.name, attribute.value)
    }
  }

  function syncViewerRecordPresentation(current, incoming) {
    const currentBody = current.querySelector('.body-block [data-body-key]')
    const incomingBodyCandidate = incoming.querySelector('.body-block [data-body-key]')
    if (!currentBody && !incomingBodyCandidate) {
      syncViewerElementAttributes(current, incoming)
      current.replaceChildren(...incoming.childNodes)
      return true
    }
    if (!currentBody || !incomingBodyCandidate) return false
    const bodyKey = currentBody.dataset.bodyKey
    const incomingBody = incoming.querySelector(
      '.body-block [data-body-key="' + CSS.escape(bodyKey) + '"]')
    if (!incomingBody) return false
    let currentBranch = currentBody.closest('.body-block')
    let incomingBranch = incomingBody.closest('.body-block')
    while (currentBranch && incomingBranch && currentBranch !== current &&
        incomingBranch !== incoming) {
      const currentParent = currentBranch.parentElement
      const incomingParent = incomingBranch.parentElement
      if (!currentParent || !incomingParent) return false
      const rows = [...incomingParent.children].map(child =>
        child === incomingBranch ? currentBranch : child)
      replaceViewerChildrenWithoutDetaching(currentParent, rows)
      currentBranch = currentParent
      incomingBranch = incomingParent
    }
    syncViewerElementAttributes(current, incoming)
    return currentBranch === current && incomingBranch === incoming
  }

  function reconcileViewerRows(target, incomingRows) {
    const currentByKey = new Map([...target.children].flatMap(node => {
      const key = node.dataset?.viewerRecordKey
      return key ? [[key, node]] : []
    }))
    const rows = incomingRows.map(incoming => {
      const current = currentByKey.get(incoming.dataset?.viewerRecordKey)
      return current && viewerNodeCanStay(current, incoming) ? current : incoming
    })
    const anchor = rows.find(node => node.isConnected && viewerNodeIsInView(node)) || null
    const anchorTop = anchor?.getBoundingClientRect().top ?? null
    replaceViewerChildrenWithoutDetaching(target, rows)
    if (anchor && anchorTop !== null && anchor.isConnected) {
      const movement = anchor.getBoundingClientRect().top - anchorTop
      if (Math.abs(movement) > 0.5) window.scrollBy(0, movement)
    }
  }

  function renderViewerRows(target, scopeKey, rows) {
    if (target.__viewerListKey !== scopeKey) {
      target.__viewerListKey = scopeKey
      target.replaceChildren(...rows)
      return
    }
    reconcileViewerRows(target, rows)
  }

  function renderViewerList(target, list, scopeKey) {
    list.__viewerListKey = scopeKey
    const current = [...target.children].find(child =>
      child.__viewerListKey === scopeKey && child.tagName === list.tagName)
    if (!current) {
      target.replaceChildren(list)
      return list
    }
    reconcileViewerRows(current, [...list.children])
    return current
  }

  function changedViewerRecordKeys(changes) {
    const keys = new Set()
    for (const change of changes || []) {
      const detail = change.detail || {}
      if (change.kind === 'moderation' && detail.target_id &&
          ['note', 'thing', 'agreement'].includes(detail.target_type)) {
        keys.add(detail.target_type + ':' + String(detail.target_id))
      }
      if (['thing_edited', 'thing_moved', 'thing_upgraded', 'thing_withdrawn']
        .includes(change.kind) && detail.thing_id) {
        keys.add('thing:' + String(detail.thing_id))
      }
      if (['agreement_accession', 'agreement_sign'].includes(change.kind) &&
          detail.agreement_id) {
        keys.add('agreement:' + String(detail.agreement_id))
      }
    }
    return keys
  }

  function renderWithViewerInvalidations(changes, render) {
    const keys = changedViewerRecordKeys(changes)
    for (const key of keys) viewerInvalidatedRecordKeys.add(key)
    try {
      render()
    } finally {
      for (const key of keys) viewerInvalidatedRecordKeys.delete(key)
    }
  }

`
