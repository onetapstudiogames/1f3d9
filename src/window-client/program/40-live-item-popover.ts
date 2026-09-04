// Step 4 of the Live-view rebuild: one reusable popover for the whole
// plate. See docs/DRAWING_AND_LIVE_VIEW.md's Live-view section and §9. This
// part MUST ship before PART_39_WIRING_AND_BOOT in
// src/window-client/program/index.ts -- part 39 closes the client IIFE with
// `})()`, so appending after it would emit this code outside the IIFE. The
// `40-` filename prefix is only so `ls` and the quiet-DOM-leak scanner's
// `/^\d\d-/` glob keep finding it; index.ts stays the real ship-order
// authority (see docs/DRAWING_AND_LIVE_VIEW.md §9).
export const PART_40_LIVE_ITEM_POPOVER = `  function liveItemPopoverIsOpen() {
    return Boolean(nodes.liveItemPopover && !nodes.liveItemPopover.hidden)
  }

  function liveItemPopoverIdLabel(kind, id) {
    if (kind === 'resident') return 'resident #' + String(id)
    if (kind === 'thing') return 'Thing #' + String(id)
    return 'Place #' + String(id)
  }

  function liveItemPopoverAnchorName(kind, item) {
    return kind === 'resident' ? item.handle : item.name
  }

  // The one place that resolves quiet for the popover -- isQuietPlace, at
  // the item's own row -- matching the rule every other Live listing path
  // follows (docs/DECISIONS.md row 75; test/quiet-rooms.test.ts's path
  // table names this function). A resident or thing bound to the popover
  // is already drawn only from a non-quiet render path (liveVisibleResidentsAt,
  // liveThingShelf), so the only place this can actually flip quiet is the
  // resident's OWN current place, which may differ from the plate being
  // viewed once Focus/Follow moves someone off-plate -- hence the explicit
  // check here rather than trusting the caller.
  function liveItemPopoverFacts(kind, item, snapshot) {
    if (kind === 'resident') {
      const place = placeReference(snapshot, item.current_place_id)
      const proofKey = liveDrawingKey('resident', item.id)
      const cachedDrawing = state.live.proofScene ? (state.live.drawings[proofKey] || null) : null
      return windowLiveItemFacts('resident', item, {
        locationName: place ? place.name : null,
        locationQuiet: isQuietPlace(place),
        cachedDrawing,
        focused: state.live.focusResident === item.handle,
      })
    }
    if (kind === 'thing') {
      const proofKey = liveDrawingKey('thing', item.id)
      const cachedDrawing = state.live.proofScene ? (state.live.drawings[proofKey] || null) : null
      return windowLiveItemFacts('thing', item, { cachedDrawing })
    }
    const exactThingTotal = liveExactThingTotal(snapshot, item.id, 0, true)
    const plot = document.querySelector(
      '.live-plot[data-place-id="' + String(item.id) + '"]',
    )
    const floorDrawn = plot?.dataset.undrawn === undefined
      ? null
      : plot.dataset.undrawn !== 'true'
    return windowLiveItemFacts('place', item, { exactThingTotal, floorDrawn })
  }

  // Body-free by construction: never calls loadLiveNote(noteId), which would
  // turn a hover into a network read.
  // A named place follows the same quiet rule as liveLedgerQuietPlace, so a
  // quiet room is never named in the phrase.
  function liveItemPopoverLastAction(kind, item) {
    if (kind === 'place') return null
    const key = kind === 'resident' ? item.handle : item.id
    return windowLiveItemLastAction(liveRecords(), kind, key, placeId => {
      const place = placeReference(state.snapshot, placeId)
      return place && !isQuietPlace(place) ? place.name : null
    })
  }

  // No place context of its own -- every caller already resolved quiet
  // through liveItemPopoverFacts before this ever runs, exactly like
  // livePortraitGrid and liveThingShelf (see ALLOW_LIST in
  // test/quiet-dom-leak-inventory.test.ts, which this function joins for
  // the same reason: it renders whatever caller-supplied facts and name it
  // is given).
  function liveItemPopoverContent(kind, id, name, result, lastAction, place) {
    const parts = [
      element('p', 'live-item-popover-title', name + ' · ' + liveItemPopoverIdLabel(kind, id)),
    ]
    const list = element('ul', 'live-item-popover-facts')
    for (const fact of result.facts) list.append(element('li', '', fact))
    parts.push(list)
    if (result.quiet && place) {
      parts.push(quietRoomNotice(place))
    } else if (kind !== 'place') {
      parts.push(element('p', 'live-item-popover-last-action',
        lastAction || 'no recorded action in the last 30 minutes'))
    }
    const actionLabel = kind === 'thing' ? 'Open the record' : 'Current drawing'
    const actionAriaPrefix = kind === 'thing'
      ? 'Open the public record for '
      : 'Open current drawing for '
    parts.push(openDrawingDetailButton(
      kind, id, name, 'live-item-popover-open drawing-detail-open',
      actionLabel, actionAriaPrefix,
    ))
    return parts
  }

  function positionLiveItemPopover() {
    if (!nodes.liveItemPopover || !nodes.liveViewport || !liveItemPopoverAnchor) return
    if (!liveItemPopoverAnchor.isConnected) {
      hideLiveItemPopover(false)
      return
    }
    const anchorBox = liveItemPopoverAnchor.getBoundingClientRect()
    const viewportBox = nodes.liveViewport.getBoundingClientRect()
    const popoverBox = nodes.liveItemPopover.getBoundingClientRect()
    const placement = windowLiveItemPopoverPlacement(
      Object.freeze({
        left: anchorBox.left, top: anchorBox.top,
        right: anchorBox.right, bottom: anchorBox.bottom,
      }),
      Object.freeze({
        width: popoverBox.width || 260,
        height: popoverBox.height || 96,
      }),
      Object.freeze({
        left: viewportBox.left, top: viewportBox.top,
        right: viewportBox.right, bottom: viewportBox.bottom,
      }),
      LIVE_ITEM_POPOVER_GAP,
      LIVE_ITEM_POPOVER_MARGIN,
    )
    if (!placement) {
      hideLiveItemPopover(false)
      return
    }
    nodes.liveItemPopover.style.left = String(placement.left) + 'px'
    nodes.liveItemPopover.style.top = String(placement.top) + 'px'
    nodes.liveItemPopover.dataset.livePopoverSide = placement.side
    liveItemPopoverRect = placement
  }

  function showLiveItemPopover(anchor, key, kind, resolve) {
    if (!nodes.liveItemPopover || !nodes.liveViewport || !state.snapshot) return
    const item = resolve()
    if (!item) return
    const result = liveItemPopoverFacts(kind, item, state.snapshot)
    const id = item.id
    const name = liveItemPopoverAnchorName(kind, item)
    const lastAction = liveItemPopoverLastAction(kind, item)
    liveItemPopoverAnchor = anchor
    liveItemPopoverKey = key
    nodes.liveItemPopover.dataset.livePopoverKind = kind
    nodes.liveItemPopover.dataset.livePopoverKey = key
    nodes.liveItemPopover.setAttribute('aria-label', name + ' details')
    nodes.liveItemPopover.replaceChildren(...liveItemPopoverContent(
      kind, id, name, result, lastAction, kind === 'place' ? item : null,
    ))
    nodes.liveItemPopover.hidden = false
    anchor.setAttribute('aria-describedby', 'live-item-popover')
    positionLiveItemPopover()
  }

  function hideLiveItemPopover(restoreFocus) {
    if (!nodes.liveItemPopover || nodes.liveItemPopover.hidden) return
    const anchor = liveItemPopoverAnchor
    nodes.liveItemPopover.hidden = true
    nodes.liveItemPopover.replaceChildren()
    delete nodes.liveItemPopover.dataset.livePopoverKind
    delete nodes.liveItemPopover.dataset.livePopoverKey
    delete nodes.liveItemPopover.dataset.livePopoverSide
    if (anchor) anchor.removeAttribute('aria-describedby')
    liveItemPopoverAnchor = null
    liveItemPopoverKey = null
    liveItemPopoverRect = null
    if (restoreFocus && anchor && anchor.isConnected) {
      // .focus() dispatches focusin synchronously, and bindLiveItemPopover's
      // own focusin listener would otherwise reopen the popover it was
      // just asked to close (Escape's whole point). This flag makes that
      // one focus() call inert for opening purposes without touching the
      // element's real focus state.
      liveItemPopoverSuppressOpen = true
      anchor.focus({ preventScroll: true })
      liveItemPopoverSuppressOpen = false
    }
  }

  // The static ground element carrying data-live-item-key differs by kind
  // (the resident's key lives on its .live-walker shell, the place's on its
  // .live-plot card; only the thing specimen is its own keyed anchor), so
  // resync must translate the keyed container back to the actual focusable
  // control bindLiveItemPopover attached to.
  function liveItemPopoverAnchorElement(container, kind) {
    if (!container) return null
    if (kind === 'resident') return container.querySelector('.live-portrait')
    if (kind === 'thing') return container
    return container.querySelector(':scope > .live-plot-open')
  }

  // Round-1 review finding #4: forward Tab out of the popover's action
  // button used to close the popover and land back on the anchor, costing
  // the keyboard user an extra Tab press to actually move on. The popover
  // sits outside #live-stage in the DOM (see the "dom" section above), so
  // it is not adjacent to the anchor in document order and the browser's
  // own default Tab handling cannot "continue in document order" on its
  // own -- this computes that continuation explicitly, against the
  // focusable elements that exist on the page right now, excluding the
  // popover's own contents.
  const LIVE_ITEM_POPOVER_FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

  function liveItemPopoverNextFocusable(anchor) {
    if (!anchor || !anchor.isConnected) return null
    const all = Array.from(document.querySelectorAll(LIVE_ITEM_POPOVER_FOCUSABLE_SELECTOR))
      .filter(el => !nodes.liveItemPopover?.contains(el))
    const index = all.indexOf(anchor)
    return index === -1 ? null : (all[index + 1] || null)
  }

  function liveItemPopoverResolveByKey(kind, key) {
    const raw = key.slice(key.indexOf(':') + 1)
    if (kind === 'resident') {
      return displayedResidents(state.snapshot).find(resident => resident.handle === raw) || null
    }
    if (kind === 'thing') {
      const id = safeId(raw)
      if (!id || !state.snapshot) return null
      const focus = liveFocusPlace(state.snapshot)
      if (!focus) return null
      return historyEntry('things', liveThingFilters(focus.id)).rows
        .find(thing => thing.id === id) || null
    }
    const id = safeId(raw)
    return id && state.snapshot ? placeReference(state.snapshot, id) : null
  }

  // Called after every renderLive plate replaceChildren: closes when the
  // open item's anchor left the plate (a resident who started a walk loses
  // their static .live-walker to a .live-replay-portrait, which is never a
  // bound anchor), and otherwise re-binds to the fresh node, rebuilds facts
  // from current state, and repositions -- a poll refresh must not blink
  // the popover away under a resting mouse.
  function syncLiveItemPopoverAnchor() {
    if (!liveItemPopoverIsOpen() || !liveItemPopoverKey) return
    const kind = nodes.liveItemPopover.dataset.livePopoverKind
    const container = nodes.livePlates?.querySelector(
      '[data-live-item-key="' + CSS.escape(liveItemPopoverKey) + '"]',
    )
    const anchor = liveItemPopoverAnchorElement(container, kind)
    if (!anchor || !anchor.isConnected) {
      hideLiveItemPopover(false)
      return
    }
    const key = liveItemPopoverKey
    showLiveItemPopover(anchor, key, kind, () => liveItemPopoverResolveByKey(kind, key))
  }

  function bindLiveItemPopover(control, key, kind, resolve) {
    const open = () => {
      if (liveItemPopoverSuppressOpen) return
      showLiveItemPopover(control, key, kind, resolve)
    }
    const closesFrom = event => {
      const related = event.relatedTarget
      if (related instanceof Node &&
          (control.contains(related) || nodes.liveItemPopover?.contains(related))) return
      if (liveItemPopoverKey === key) hideLiveItemPopover(false)
    }
    // A mousedown on the popover's own non-focusable content (a fact line,
    // its own text) blurs whatever was focused with relatedTarget === null
    // -- there being no next focusable target is not the same as focus
    // genuinely leaving both the anchor and the popover, so a null
    // relatedTarget here is left to the document-level outside-press
    // handler below, which correctly recognises a press inside the
    // popover and leaves it open. This still closes on a real keyboard
    // Shift+Tab away from the anchor, whose relatedTarget is the real
    // element focus lands on.
    const closesOnRealFocusMove = event => {
      // A mousedown anywhere inside the popover on its own non-focusable
      // content (a fact line, its own text) makes the browser walk up to
      // the nearest focusable ANCESTOR of the click target and focus that
      // -- #live-viewport itself, since the popover has no tabindex of
      // its own -- which is not focus genuinely leaving the popover. The
      // document-level pointerdown handler below already made the correct
      // open/close call for this exact press; liveItemPopoverPressWasInside
      // carries that same verdict here so a real keyboard Shift+Tab away
      // (relatedTarget is whatever real element focus lands on, and this
      // flag is false because no pointerdown preceded it) still closes.
      const pressWasInside = liveItemPopoverPressWasInside
      liveItemPopoverPressWasInside = false
      if (event.relatedTarget === null || pressWasInside) return
      closesFrom(event)
    }
    control.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return
      open()
    })
    control.addEventListener('pointerout', closesFrom)
    control.addEventListener('focusin', open)
    control.addEventListener('focusout', closesOnRealFocusMove)
    control.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.shiftKey || liveItemPopoverKey !== key) return
      const action = nodes.liveItemPopover?.querySelector('.live-item-popover-open')
      if (!action) return
      event.preventDefault()
      action.focus({ preventScroll: true })
    })
  }

  // Wired once from PART_39_WIRING_AND_BOOT: the popover's own pointer-out
  // and Tab bridge, plus the escape/outside-press/visibility closes that
  // belong beside the client's other document-level listeners.
  function wireLiveItemPopover() {
    nodes.liveItemPopover?.addEventListener('pointerleave', event => {
      const related = event.relatedTarget
      if (related instanceof Node && liveItemPopoverAnchor?.contains(related)) return
      hideLiveItemPopover(false)
    })
    nodes.liveItemPopover?.addEventListener('focusout', event => {
      // Same tolerance as bindLiveItemPopover's own focusout handler: a
      // mousedown on the popover's own non-focusable text (leaving the
      // action button) walks up to the nearest focusable ancestor of the
      // click target -- #live-viewport -- which is not focus genuinely
      // leaving the popover, and liveItemPopoverPressWasInside already
      // carries the document-level pointerdown handler's correct verdict
      // for that same press.
      const pressWasInside = liveItemPopoverPressWasInside
      liveItemPopoverPressWasInside = false
      if (event.relatedTarget === null || pressWasInside) return
      const related = event.relatedTarget
      if (related instanceof Node &&
          (liveItemPopoverAnchor?.contains(related) || nodes.liveItemPopover.contains(related))) {
        return
      }
      hideLiveItemPopover(false)
    })
    nodes.liveItemPopover?.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return
      if (event.shiftKey) {
        if (!liveItemPopoverAnchor) return
        event.preventDefault()
        liveItemPopoverAnchor.focus({ preventScroll: true })
        return
      }
      event.preventDefault()
      // Close and continue into the ordinary plate order (finding #4)
      // rather than closing and landing back on the anchor: compute the
      // next focusable element after the anchor BEFORE closing, since
      // closing clears liveItemPopoverAnchor. If that next element is
      // itself a bound Live item, its own focusin listener opens its
      // popover -- which is exactly "the next Tab continues the ordinary
      // plate order". When nothing follows the anchor, fall back to the
      // old behavior via hideLiveItemPopover(true)'s own suppress-guarded
      // restore, so a self-reopen loop on the anchor's own popover is
      // never possible.
      const next = liveItemPopoverNextFocusable(liveItemPopoverAnchor)
      if (next) {
        hideLiveItemPopover(false)
        next.focus({ preventScroll: true })
      } else {
        hideLiveItemPopover(true)
      }
    })
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !liveItemPopoverIsOpen()) return
      event.preventDefault()
      event.stopPropagation()
      hideLiveItemPopover(true)
    }, true)
    document.addEventListener('pointerdown', event => {
      if (!liveItemPopoverIsOpen()) {
        liveItemPopoverPressWasInside = false
        return
      }
      const target = event.target
      const inside = target instanceof Node &&
        (liveItemPopoverAnchor?.contains(target) || nodes.liveItemPopover.contains(target))
      // Recorded for the focusout handlers above, which run as a
      // synchronous side effect of this same press when it lands on
      // non-focusable popover content: pointerdown always precedes the
      // resulting blur/focusout, so the verdict made here is still fresh
      // when they read it. Cleared at the top of the very next pointerdown
      // so a later, unrelated focus change (Shift+Tab away) is never
      // mistaken for following an inside press.
      liveItemPopoverPressWasInside = Boolean(inside)
      if (inside) return
      hideLiveItemPopover(false)
    }, true)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && liveItemPopoverIsOpen()) hideLiveItemPopover(false)
    })
  }

`
