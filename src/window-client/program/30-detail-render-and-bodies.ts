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
      if (!entry || entry.loading) {
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
        const body = element('p', 'record-detail-text public-body', record.body)
        nodes.detailBody.replaceChildren(element('p', 'record-detail-meta', meta), body)
        if (record.kind === 'thing') {
          nodes.detailBody.append(drawingDetailNode('thing', record.id, record.name))
        }
        if (record.moderated) {
          nodes.detailBody.append(element(
            'p', 'moderated-mark', 'Maintainer removal is shown as a current tombstone.',
          ))
        }
      }
    }
    if (!nodes.detail.open) nodes.detail.showModal()
    if (previousFocusKey) {
      window.queueMicrotask(() => nodes.detailBody?.querySelector(
        '[data-focus-key="' + CSS.escape(previousFocusKey) + '"]')?.focus())
    }
  }

  async function loadFullBody(kind, id) {
    if (kind !== 'note' && kind !== 'thing') return
    const bodyKey = kind + ':' + String(id)
    const current = state.fullBodies[bodyKey] || Object.freeze({
      body: null, loading: false, error: false,
    })
    if (current.loading || current.body !== null) return
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      fullBodies: {
        ...state.fullBodies,
        [bodyKey]: Object.freeze({ ...current, loading: true, error: false }),
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
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        expandedBodies: state.expandedBodies.includes(bodyKey)
          ? state.expandedBodies
          : [...state.expandedBodies, bodyKey],
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({ body: fullBody, loading: false, error: false }),
        },
      }
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({ body: null, loading: false, error: true }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderAll()
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

  function renderExpandableBody(kind, id, body, truncated) {
    const block = element('div', 'body-block')
    const bodyKey = kind + ':' + String(id)
    const fullEntry = state.fullBodies[bodyKey] || null
    const hasFullBody = typeof fullEntry?.body === 'string'
    const bodyNode = element('p', kind + '-body public-body',
      hasFullBody ? fullEntry.body : body + (truncated ? '…' : ''))
    const bodyId = 'public-body-' + kind + '-' + String(id) + '-' + String(++bodyIdSequence)
    const startExpanded = state.expandedBodies.includes(bodyKey)
    bodyNode.id = bodyId
    bodyNode.dataset.expanded = String(startExpanded)
    bodyNode.dataset.bodyKey = bodyKey
    bodyNode.dataset.bodyKind = kind
    bodyNode.dataset.truncated = String(truncated)
    block.append(bodyNode)

    let availability = null
    if (truncated && !hasFullBody) {
      // The bounded view caps every body: Excerpt only — this bounded view carries only the first part.
      // "Show more" first reveals that excerpt. The existing single-record endpoint is then one deliberate,
      // anonymous read whose result survives re-rendering in this browser session.
      availability = element('p', 'body-availability')
      const availabilityText = fullEntry?.loading
        ? 'Loading the complete public ' + kind + '… '
        : fullEntry?.error
          ? 'The complete public ' + kind + ' could not be read. '
          : 'Excerpt only — the full text is not included in this bounded view. '
      availability.append(document.createTextNode(availabilityText))
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
        void loadFullBody(kind, id)
        return
      }
      const nextExpanded = !expanded
      state = {
        ...state,
        expandedBodies: nextExpanded
          ? [...state.expandedBodies, bodyKey]
          : state.expandedBodies.filter(key => key !== bodyKey),
      }
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
      const bodyKey = bodyNode?.dataset.bodyKey
      const kind = bodyNode?.dataset.bodyKind
      if (!bodyNode || !disclosure || !bodyKey || !kind) continue
      bodyNode.dataset.expanded = 'false'
      entries.push({
        bodyNode,
        disclosure,
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
      const hasFullBody = typeof fullEntry?.body === 'string'
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
