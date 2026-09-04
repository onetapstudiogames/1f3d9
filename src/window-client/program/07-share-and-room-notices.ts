export const PART_07_SHARE_AND_ROOM_NOTICES = `  function resetShareFeedback() {
    shareFeedbackRevision += 1
    for (const status of [nodes.shareStatus, nodes.detailShareStatus]) {
      if (!status) continue
      status.textContent = ''
      delete status.dataset.tone
    }
    for (const button of [...viewShareButtons, detailShareButton].filter(Boolean)) {
      button.textContent = button.dataset.shareLabel || (button.dataset.shareScope === 'detail'
        ? 'Share this detail'
        : 'Share this view')
    }
  }

  function setShareStatus(message, tone, button) {
    const status = button?.dataset.shareScope === 'detail'
      ? nodes.detailShareStatus
      : nodes.shareStatus
    if (!status) return
    status.textContent = message
    status.dataset.tone = tone
  }

  function currentSharePath(button) {
    const current = viewShareState()
    const shareState = button?.dataset.shareScope === 'detail'
      ? windowDetailShareState(current)
      : current
    return shareState ? windowShareTargetPath(shareState) : null
  }

  async function copyCurrentShareLink(button) {
    const requestShareFeedbackRevision = ++shareFeedbackRevision
    const path = currentSharePath(button)
    if (!path) {
      const values = [state.directorySearch, state.archive.query]
      const credentialPresent = values.some(value => (
        typeof value === 'string' && /1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)
      ))
      setShareStatus(credentialPresent
        ? 'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'
        : 'This view contains a filter that is not safe for a public URL. Clear that filter, then try sharing again.',
      'error', button)
      return
    }
    const absoluteUrl = new URL(path, window.location.origin).href
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(absoluteUrl)
      if (
        shareFeedbackRevision !== requestShareFeedbackRevision ||
        currentSharePath(button) !== path
      ) return
      setShareStatus('Link copied: ' + absoluteUrl, 'success', button)
      if (button) button.textContent = button.dataset.shareScope === 'detail'
        ? 'Detail link copied'
        : button === nodes.gazetteShare
          ? state.gazetteIssueId ? 'Issue link copied' : 'Gazette link copied'
          : 'View link copied'
    } catch {
      if (
        shareFeedbackRevision !== requestShareFeedbackRevision ||
        currentSharePath(button) !== path
      ) return
      setShareStatus('The link could not copy. Copy this URL: ' + absoluteUrl, 'error', button)
    }
  }

  function safePlacePurpose(value) {
    const purpose = safeText(value, '', 1000, true)
    return /[\\r\\n\\u2028\\u2029]/u.test(purpose) || Array.from(purpose).length > 280
      ? ''
      : purpose
  }

  function normalizeFrontMatterHeading(rawHeading) {
    if (!rawHeading || typeof rawHeading !== 'object' || rawHeading.type !== 'thing') return null
    const id = safeId(rawHeading.id)
    const name = safeText(rawHeading.name, '', 120, false)
    const bodyTextBytes = Number(rawHeading.body_text_bytes)
    const makerId = safeId(rawHeading.maker_id)
    const madeBy = safeHandle(rawHeading.made_by)
    const currentOwnerId = safeId(rawHeading.current_owner_id)
    const currentOwner = safeHandle(rawHeading.current_owner)
    const ownerId = safeId(rawHeading.owner_id)
    const owner = safeHandle(rawHeading.owner)
    if (
      !id || !name || !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0 ||
      !makerId || !madeBy || !currentOwnerId || !currentOwner ||
      ownerId !== currentOwnerId || owner !== currentOwner
    ) return null
    return Object.freeze({
      id,
      type: 'thing',
      name,
      body_text_bytes: bodyTextBytes,
      maker_id: makerId,
      made_by: madeBy,
      current_owner_id: currentOwnerId,
      current_owner: currentOwner,
      owner_id: ownerId,
      owner,
      has_drawing: rawHeading.has_drawing === true,
    })
  }

  function normalizeFrontMatter(values) {
    if (!Array.isArray(values)) return []
    const seen = new Set()
    return values.slice(0, 3).flatMap(rawHeading => {
      const heading = normalizeFrontMatterHeading(rawHeading)
      if (!heading || seen.has(heading.id)) return []
      seen.add(heading.id)
      return [heading]
    })
  }

  function setStatus(message, tone) {
    if (!nodes.status) return
    if (nodes.status.textContent !== message) nodes.status.textContent = message
    if (nodes.status.dataset.tone !== tone) nodes.status.dataset.tone = tone
    if (nodes.status.dataset.statusMessage) delete nodes.status.dataset.statusMessage
  }

  function renderGlobalReadRetry(message, tone) {
    if (nodes.status) {
      if (
        nodes.status.dataset.statusMessage === message &&
        nodes.status.dataset.tone === tone &&
        nodes.status.querySelector('.global-read-retry')
      ) return
      const retry = element('button', 'global-read-retry', 'Retry reading the public city view')
      retry.type = 'button'
      retry.dataset.focusKey = 'global-read-retry'
      retry.addEventListener('click', () => void refreshCity())
      nodes.status.dataset.tone = tone
      nodes.status.dataset.statusMessage = message
      nodes.status.replaceChildren(document.createTextNode(message + ' '), retry)
    }
  }

  function renderGlobalReadFailure() {
    const message = 'The current public city view could not be read.'
    renderGlobalReadRetry(message, 'error')
    if (nodes.counts) nodes.counts.textContent = message
    if (nodes.scope) nodes.scope.textContent = message
    for (const target of [nodes.map, nodes.roster, nodes.livePlates, nodes.liveRoster,
      nodes.placePurpose, nodes.placeFrontMatter,
      nodes.occupants, nodes.placeThings, nodes.placeConversation, nodes.conversations,
      nodes.agreements]) {
      renderEmpty(target, 'error-row', message)
    }
    if (nodes.liveLedger) {
      nodes.liveLedger.replaceChildren(element('li', 'error-row', message))
    }
    if (nodes.activity) {
      nodes.activity.replaceChildren(element('li', 'error-row', message))
    }
  }

  function renderEmpty(target, className, message) {
    if (!target) return
    target.replaceChildren(element('p', className, message))
  }

  // Decision #75: a quiet place still shows its name, owner, and counts, but
  // every window tab that would otherwise render its residents, things, or
  // notes prints this one honest line instead. Expanding it (hover or the
  // details toggle) states that the public record is unchanged.
  function quietRoomNotice(place) {
    const owner = (place && place.owner) || 'The owner'
    const notice = element('details', 'quiet-room-notice')
    const summary = element(
      'summary',
      'quiet-room-line',
      owner + ' prefers to keep this room private.',
    )
    summary.title = 'Quiet is a request the window honours, not a privacy guarantee.'
    notice.append(summary, element(
      'p',
      'quiet-room-expansion',
      'The public record stays public: notes and things here remain readable at their own address.',
    ))
    return notice
  }

  function renderQuietRoom(target, place) {
    if (!target) return
    target.replaceChildren(quietRoomNotice(place))
  }

`
