export const PART_30_DETAIL_RENDER_AND_BODIES = `  function renderDetail() {
    const previousFocusKey = nodes.detailBody?.contains(document.activeElement)
      ? document.activeElement?.dataset?.focusKey || null
      : null
    const target = state.detail
    if (detailShareButton) {
      const shareLabel = target?.kind === 'place' ? 'Share this place' : 'Share this detail'
      detailShareButton.hidden = !target || target.kind === 'resident'
      if (detailShareButton.dataset.shareLabel !== shareLabel) {
        detailShareButton.dataset.shareLabel = shareLabel
        detailShareButton.textContent = shareLabel
      }
    }
    if (!nodes.detail) return
    if (!target) {
      if (nodes.detail.open) nodes.detail.close()
      return
    }
    if (target.kind === 'place' || target.kind === 'resident') {
      const subject = currentDrawingDetailSubject(target)
      if (nodes.detailKind) nodes.detailKind.textContent = target.kind === 'place'
        ? 'Public place · live current drawing'
        : 'Public resident · live current drawing'
      if (nodes.detailTitle) nodes.detailTitle.textContent = subject?.title || (
        target.kind === 'place' ? 'Place #' + String(target.id) : 'Resident #' + String(target.id)
      )
      if (nodes.detailBody) {
        if (!subject) {
          nodes.detailBody.replaceChildren(element(
            'p',
            'empty-row',
            'This public ' + target.kind + ' is not available now.',
          ))
        } else {
          nodes.detailBody.replaceChildren(
            element('p', 'record-detail-meta', subject.meta),
            drawingDetailNode(target.kind, target.id, subject.title),
          )
        }
      }
      if (!nodes.detail.open) nodes.detail.showModal()
      if (previousFocusKey) {
        window.queueMicrotask(() => nodes.detailBody?.querySelector(
          '[data-focus-key="' + CSS.escape(previousFocusKey) + '"]')?.focus())
      }
      return
    }
    const key = target.kind + ':' + String(target.id)
    const entry = state.details[key]
    if (nodes.detailKind) nodes.detailKind.textContent = target.kind === 'thing'
      ? 'Public thing · live current record'
      : 'Public note · live current record'
    if (nodes.detailTitle) {
      if (target.kind === 'thing') {
        const title = entry?.record?.name || 'Thing #' + String(target.id)
        nodes.detailTitle.replaceChildren(
          portraitNode('thing', target.id, title, entry?.record?.has_drawing === true),
          document.createTextNode(title),
        )
      } else {
        nodes.detailTitle.textContent = 'Public note #' + String(target.id)
      }
    }
    if (nodes.detailBody) {
      const heldRecord = nodes.detailBody.querySelector(
        ':scope > [data-viewer-record-key="' + CSS.escape(key) + '"]')
      if (viewerReadingViewIsActive() && (!entry || entry.loading) && heldRecord &&
          !heldRecord.closest('[hidden]') && !viewerInvalidatedRecordKeys.has(key)) {
        // Keep the completed record connected while its current form is revalidated.
      } else if (!entry || entry.loading) {
        nodes.detailBody.replaceChildren(element('p', 'loading-row', 'Reading the live public record…'))
      } else if (entry.notFound) {
        nodes.detailBody.replaceChildren(element(
          'p', 'empty-row', 'This public ' + target.kind + ' is not available now.',
        ))
      } else if (entry.error || !entry.record) {
        const message = element('p', 'error-row', 'This public detail could not be read.')
        const retry = element('button', 'detail-retry', 'Retry reading this detail')
        retry.type = 'button'
        retry.addEventListener('click', () => void ensureDetail(true))
        nodes.detailBody.replaceChildren(message, retry)
      } else {
        const record = entry.record
        const meta = record.kind === 'thing'
          ? 'made by ' + record.madeBy + ' · currently owned by ' + record.currentOwner +
            ' · place #' + String(record.placeId)
          : 'by ' + record.author + ' · place #' + String(record.placeId) + ' · ' +
            new Date(record.createdAt).toLocaleString()
        const body = viewerRecordNode(
          element('p', 'record-detail-text public-body', record.body),
          record.kind,
          record,
          meta,
        )
        const parts = [element('p', 'record-detail-meta', meta), body]
        if (record.kind === 'thing') {
          parts.push(drawingDetailNode('thing', record.id, record.name))
        }
        if (record.moderated) {
          parts.push(element(
            'p', 'moderated-mark', 'Maintainer removal is shown as a current tombstone.',
          ))
        }
        reconcileViewerRows(nodes.detailBody, parts)
      }
    }
    if (!nodes.detail.open) nodes.detail.showModal()
    if (previousFocusKey) {
      window.queueMicrotask(() => nodes.detailBody?.querySelector(
        '[data-focus-key="' + CSS.escape(previousFocusKey) + '"]')?.focus())
    }
  }

  async function loadFullBody(kind, id, recordVersion = null, revalidate = false) {
    if (kind !== 'note' && kind !== 'thing') return
    const bodyKey = kind + ':' + String(id)
    const current = state.fullBodies[bodyKey] || Object.freeze({
      body: null, recordVersion: null, loading: false, error: false, requestRevision: null,
    })
    const requestAuthoredRevision = authoredRevision
    if ((current.loading && current.requestRevision === requestAuthoredRevision) ||
        (!revalidate && current.body !== null)) return
    const pending = Object.freeze({
      ...current,
      loading: true,
      error: false,
      requestRevision: requestAuthoredRevision,
    })
    const requestIsCurrent = () => authoredRevision === requestAuthoredRevision &&
      state.fullBodies[bodyKey] === pending
    let replaceRenderedBody = false
    let completed = false
    state = {
      ...state,
      fullBodies: {
        ...state.fullBodies,
        [bodyKey]: pending,
      },
    }
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/' + kind + '/' + String(id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('complete public body unavailable')
      const payload = await response.json()
      const record = payload && typeof payload === 'object' ? payload[kind] : null
      const recordId = record && typeof record === 'object' ? safeId(record.id) : null
      const fullBody = record && typeof record === 'object'
        ? safeText(record.body, null, kind === 'note' ? 4000 : 65536, kind === 'thing')
        : null
      if (recordId !== id || fullBody === null) throw new Error('invalid complete public body')
      if (!requestIsCurrent()) return
      replaceRenderedBody = current.body !== fullBody ||
        current.recordVersion !== recordVersion
      state = {
        ...state,
        expandedBodies: revalidate || state.expandedBodies.includes(bodyKey)
          ? state.expandedBodies
          : storeViewerOpenKeys([...state.expandedBodies, bodyKey]),
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({
            body: fullBody, recordVersion, loading: false, error: false,
            requestRevision: null,
          }),
        },
      }
      completed = true
    } catch {
      if (!requestIsCurrent()) return
      replaceRenderedBody = current.body !== null
      state = {
        ...state,
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({
            body: null, recordVersion, loading: false, error: true,
            requestRevision: null,
          }),
        },
      }
      completed = true
    } finally {
      window.clearTimeout(timeout)
      if (!completed) {
        if (state.fullBodies[bodyKey] === pending) {
          state = {
            ...state,
            fullBodies: {
              ...state.fullBodies,
              [bodyKey]: Object.freeze({
                ...current, loading: false, requestRevision: null,
              }),
            },
          }
          syncBodyDisclosures()
        }
        return
      }
      if (replaceRenderedBody) viewerInvalidatedRecordKeys.add(bodyKey)
      try {
        const visibleBody = viewerReadingViewIsActive() &&
          [...document.querySelectorAll(
            '[data-body-key="' + CSS.escape(bodyKey) + '"]')]
            .some(body => !body.closest('[hidden]'))
        if (!revalidate || visibleBody) renderAll()
      } finally {
        if (replaceRenderedBody) viewerInvalidatedRecordKeys.delete(bodyKey)
      }
    }
  }

  function revalidateViewerFullBodies(bodyKeys) {
    if (!viewerReadingViewIsActive()) return
    const batchAuthoredRevision = authoredRevision
    const batchNavigationRevision = navigationRevision
    let nextIndex = 0
    async function work() {
      while (nextIndex < bodyKeys.length) {
        if (authoredRevision !== batchAuthoredRevision ||
            navigationRevision !== batchNavigationRevision ||
            !viewerReadingViewIsActive()) return
        const bodyKey = bodyKeys[nextIndex]
        nextIndex += 1
        const separator = bodyKey.indexOf(':')
        const kind = bodyKey.slice(0, separator)
        const id = safeId(bodyKey.slice(separator + 1))
        const node = [...document.querySelectorAll(
          '[data-viewer-record-key="' + CSS.escape(bodyKey) + '"]')]
          .find(candidate => viewerNodeIsHeld(candidate) && candidate.querySelector(
            '[data-body-key="' + CSS.escape(bodyKey) + '"]'))
        if (!id || !node) continue
        await loadFullBody(kind, id, node.__viewerRecordDataVersion || null, true)
      }
    }
    const workerCount = Math.min(4, bodyKeys.length)
    for (let index = 0; index < workerCount; index += 1) {
      void work()
    }
  }

  function bodyDisclosureLabel(kind, truncated, expanded, hasFullBody, fullEntry) {
    const canComplete = truncated && !hasFullBody && (kind === 'note' || kind === 'thing')
    if (canComplete && expanded) {
      if (fullEntry?.loading) return 'Loading the whole ' + kind + '…'
      if (fullEntry?.error) return 'Retry reading the whole ' + kind
      return 'Read the whole ' + kind
    }
    return expanded ? 'Show less' : 'Show more'
  }

  function bodyAvailabilityMessage(kind, fullEntry) {
    return fullEntry?.loading
      ? 'Loading the complete public ' + kind + '… '
      : fullEntry?.error
        ? 'The complete public ' + kind + ' could not be read. '
        : 'Excerpt only — the full text is not included in this bounded view. '
  }

  function renderExpandableBody(kind, id, body, truncated, recordVersion = null) {
    const block = element('div', 'body-block')
    const bodyKey = kind + ':' + String(id)
    const fullEntry = state.fullBodies[bodyKey] || null
    const hasFullBody = typeof fullEntry?.body === 'string' &&
      fullEntry.recordVersion === recordVersion
    const bodyNode = element('p', kind + '-body public-body',
      hasFullBody ? fullEntry.body : body + (truncated ? '…' : ''))
    const bodyId = 'public-body-' + kind + '-' + String(id) + '-' + String(++bodyIdSequence)
    const startExpanded = state.expandedBodies.includes(bodyKey)
    bodyNode.id = bodyId
    bodyNode.dataset.expanded = String(startExpanded)
    bodyNode.dataset.bodyKey = bodyKey
    bodyNode.dataset.bodyKind = kind
    bodyNode.dataset.truncated = String(truncated)
    Object.defineProperty(bodyNode, '__viewerRecordVersion', {
      configurable: true,
      value: recordVersion,
    })
    block.append(bodyNode)

    let availability = null
    if (truncated && !hasFullBody) {
      // The bounded view caps every body: Excerpt only — this bounded view carries only the first part.
      // "Show more" first reveals that excerpt. The existing single-record endpoint is then one deliberate,
      // anonymous read whose result survives re-rendering in this browser session.
      availability = element('p', 'body-availability')
      availability.append(document.createTextNode(bodyAvailabilityMessage(kind, fullEntry)))
      if (kind === 'agreement') {
        availability.append(document.createTextNode(
          'The full text is not served through the glass.'))
      }
      availability.id = bodyId + '-availability'
      block.append(availability)
    }

    // The browser decides whether the five-line clamp actually hides text.
    // Keep the control hidden until the connected element can be measured.
    const disclosure = element('button', truncated && (kind === 'note' || kind === 'thing')
      ? 'body-disclosure body-full-link'
      : 'body-disclosure',
      bodyDisclosureLabel(kind, truncated, startExpanded, hasFullBody, fullEntry))
    disclosure.type = 'button'
    disclosure.hidden = true
    disclosure.setAttribute('aria-expanded', String(startExpanded))
    disclosure.setAttribute('aria-busy', String(fullEntry?.loading === true))
    disclosure.setAttribute('aria-controls', bodyId)
    disclosure.dataset.focusKey = 'body:' + bodyKey
    if (availability) disclosure.setAttribute('aria-describedby', availability.id)
    disclosure.addEventListener('click', () => {
      const expanded = state.expandedBodies.includes(bodyKey)
      const canComplete = truncated && !hasFullBody &&
        (kind === 'note' || kind === 'thing') && expanded
      if (canComplete) {
        void loadFullBody(kind, id, recordVersion)
        return
      }
      const nextExpanded = !expanded
      setViewerBodyExpanded(bodyKey, nextExpanded)
      bodyNode.dataset.expanded = String(nextExpanded)
      disclosure.setAttribute('aria-expanded', String(nextExpanded))
      disclosure.textContent = bodyDisclosureLabel(
        kind, truncated, nextExpanded, hasFullBody, fullEntry)
    })
    block.append(disclosure)
    return block
  }

  function syncBodyDisclosures() {
    const entries = []
    for (const block of document.querySelectorAll('.body-block')) {
      if (block.closest('[hidden]')) continue
      const bodyNode = block.querySelector('.public-body')
      const disclosure = block.querySelector('.body-disclosure')
      const availability = block.querySelector('.body-availability')
      const bodyKey = bodyNode?.dataset.bodyKey
      const kind = bodyNode?.dataset.bodyKind
      if (!bodyNode || !disclosure || !bodyKey || !kind) continue
      bodyNode.dataset.expanded = 'false'
      entries.push({
        bodyNode,
        disclosure,
        availability,
        bodyKey,
        kind,
        truncated: bodyNode.dataset.truncated === 'true',
      })
    }

    const collapsedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)
    for (const entry of entries) entry.bodyNode.dataset.expanded = 'true'
    const expandedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)

    entries.forEach((entry, index) => {
      const collapsible = expandedHeights[index] > collapsedHeights[index] + 1
      const fullEntry = state.fullBodies[entry.bodyKey] || null
      const hasFullBody = typeof fullEntry?.body === 'string' &&
        fullEntry.recordVersion === entry.bodyNode.__viewerRecordVersion
      const requiresCompletion = entry.truncated && !hasFullBody &&
        (entry.kind === 'note' || entry.kind === 'thing')
      const expanded = (collapsible || requiresCompletion) &&
        state.expandedBodies.includes(entry.bodyKey)
      entry.bodyNode.dataset.expanded = String(!collapsible || expanded)
      entry.disclosure.hidden = !collapsible && !requiresCompletion
      entry.disclosure.setAttribute('aria-expanded', String(expanded))
      entry.disclosure.setAttribute('aria-busy', String(fullEntry?.loading === true))
      entry.disclosure.textContent = bodyDisclosureLabel(
        entry.kind, entry.truncated, expanded, hasFullBody, fullEntry)
      if (entry.availability) {
        entry.availability.replaceChildren(document.createTextNode(
          bodyAvailabilityMessage(entry.kind, fullEntry)))
        if (entry.kind === 'agreement') {
          entry.availability.append(document.createTextNode(
            'The full text is not served through the glass.'))
        }
      }
    })
  }

  let bodyDisclosureFrame = 0
  function scheduleBodyDisclosureSync() {
    if (bodyDisclosureFrame) return
    bodyDisclosureFrame = window.requestAnimationFrame(() => {
      bodyDisclosureFrame = 0
      syncBodyDisclosures()
    })
  }

`
