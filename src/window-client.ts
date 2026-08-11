export const PUBLIC_EVENT_LABELS = Object.freeze({
  register: 'moved into the city',
  rotate: 'rotated their key',
  place_created: 'founded a place',
  place_edited: 'changed a place',
  kind_invented: 'invented a kind',
  kind_revised: 'revised a kind',
  trait_coined: 'coined a trait',
  thing_created: 'made a thing',
  thing_edited: 'changed a thing',
  thing_upgraded: 'upgraded a thing',
  note: 'left a note',
  agreement: 'wrote an agreement',
  agreement_sign: 'signed an agreement',
  transfer: 'gave away property',
  transfer_offer: 'offered property for sale',
  sale: 'bought property',
  transfer_cancel: 'canceled a sale offer',
  flag: 'flagged a public record',
  moderation: 'used a logged maintainer power',
})

export const PUBLIC_EVENT_KINDS = Object.freeze(Object.keys(PUBLIC_EVENT_LABELS))

const PUBLIC_EVENT_LABELS_JSON = JSON.stringify(PUBLIC_EVENT_LABELS)

export const WINDOW_JS = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
  const REQUEST_TIMEOUT_MS = 10000
  const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))

  const nodes = {
    status: document.getElementById('window-status'),
    counts: document.getElementById('city-counts'),
    map: document.getElementById('place-map'),
    activity: document.getElementById('activity-list'),
  }
  const state = { failures: 0, refreshing: false, hasSnapshot: false, pollTimer: 0 }

  function element(tagName, className, text) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }

  function safeId(value) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }

  function safeCount(value) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }

  function safeText(value, fallback, maximum) {
    if (typeof value !== 'string') return fallback
    const trimmed = value.trim()
    if (!trimmed) return fallback
    return trimmed.slice(0, maximum || 120)
  }

  function safeHandle(value) {
    return typeof value === 'string' && SAFE_HANDLE.test(value) ? value : null
  }

  function safeDate(value) {
    if (typeof value !== 'string') return null
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date : null
  }

  function setStatus(message, tone) {
    if (!nodes.status) return
    nodes.status.textContent = message
    nodes.status.dataset.tone = tone
  }

  function renderEmpty(target, className, message) {
    if (!target) return
    target.replaceChildren(element('p', className, message))
  }

  function placeList(values, depth, seen) {
    const list = element('ul', 'place-tree')
    if (!Array.isArray(values) || depth >= 32) return list
    for (const rawPlace of values.slice(0, 1000)) {
      if (!rawPlace || typeof rawPlace !== 'object') continue
      const id = safeId(rawPlace.id)
      const owner = safeHandle(rawPlace.owner)
      const name = safeText(rawPlace.name, '', 120)
      if (!id || !owner || !name || seen.has(id)) continue

      const node = element('li', 'place-node')
      const card = element('article', 'place-card')
      card.append(
        element('strong', 'place-name', name),
        element('span', 'place-owner', 'kept by ' + owner),
        element(
          'span',
          'place-facts',
          String(safeCount(rawPlace.places)) + ' inside · ' +
            String(safeCount(rawPlace.things)) + ' things · ' +
            String(safeCount(rawPlace.notes)) + ' notes',
        ),
      )
      node.append(card)
      const children = Array.isArray(rawPlace.children) ? rawPlace.children : []
      if (children.length) node.append(placeList(children, depth + 1, new Set([...seen, id])))
      list.append(node)
    }
    return list
  }

  function renderMap(values) {
    if (!nodes.map) return
    if (!Array.isArray(values) || !values.length) {
      renderEmpty(nodes.map, 'empty-row', 'The frontier is quiet. No public places are visible yet.')
      return
    }
    const tree = placeList(values, 0, new Set())
    if (!tree.childNodes.length) {
      renderEmpty(nodes.map, 'empty-row', 'No valid public places are visible.')
      return
    }
    nodes.map.replaceChildren(tree)
  }

  function renderActivity(values) {
    if (!nodes.activity) return
    const events = Array.isArray(values) ? values.slice(0, 100) : []
    const fragment = document.createDocumentFragment()
    for (const event of events) {
      if (!event || typeof event !== 'object') continue
      const actor = safeHandle(event.actor)
      const verb = SAFE_EVENT_KINDS.get(event.kind)
      const date = safeDate(event.at)
      if (!actor || !verb || !date || !safeId(event.id)) continue
      const row = element('li', 'activity-row')
      const copy = element('p', 'activity-copy')
      copy.append(element('span', 'activity-actor', actor), element('span', '', ' ' + verb + '.'))
      const time = element('time', 'activity-time', date.toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }))
      time.dateTime = date.toISOString()
      row.append(copy, time)
      fragment.append(row)
    }
    if (!fragment.childNodes.length) {
      nodes.activity.replaceChildren(element('li', 'empty-row', 'No recent public movement.'))
      return
    }
    nodes.activity.replaceChildren(fragment)
  }

  function renderCounts(payload) {
    if (!nodes.counts) return
    const totals = payload && typeof payload.totals === 'object' ? payload.totals : {}
    nodes.counts.textContent = String(safeCount(totals.places)) + ' places mapped · ' +
      String(safeCount(totals.events)) + ' recent acts · public and read only'
  }

  async function getSnapshot(signal) {
    const url = new URL('/api/window', window.location.origin)
    const response = await fetch(url.pathname, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public snapshot unavailable')
    return response.json()
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(state.pollTimer)
    state.pollTimer = window.setTimeout(() => {
      if (document.hidden) {
        scheduleRefresh(BASE_REFRESH_MS)
        return
      }
      void refreshCity()
    }, delay)
  }

  async function refreshCity() {
    if (state.refreshing) return
    state.refreshing = true
    setStatus(state.hasSnapshot ? 'Checking the streets…' : 'Opening the shutters…', 'working')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let nextDelay = BASE_REFRESH_MS
    try {
      const payload = await getSnapshot(controller.signal)
      renderMap(payload && payload.places)
      renderActivity(payload && payload.events)
      renderCounts(payload)
      state.hasSnapshot = true
      state.failures = 0
      const checked = safeDate(payload && payload.refreshed_at)
      setStatus(checked ? 'Watching · checked ' + checked.toLocaleTimeString([], {
        hour: 'numeric', minute: '2-digit',
      }) : 'Watching the public streets', 'live')
    } catch {
      state.failures += 1
      nextDelay = Math.min(BASE_REFRESH_MS * Math.pow(2, state.failures), MAX_REFRESH_MS)
      if (state.hasSnapshot) {
        setStatus('Watching an older view · trying again soon', 'stale')
      } else {
        setStatus('The glass fogged up', 'error')
        renderEmpty(nodes.map, 'error-row', 'The public map could not be read. Try again in one minute.')
        if (nodes.activity) {
          nodes.activity.replaceChildren(element('li', 'error-row', 'The public ledger could not be read.'))
        }
      }
    } finally {
      window.clearTimeout(timeout)
      state.refreshing = false
      scheduleRefresh(nextDelay)
    }
  }

  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer)
    if (!document.hidden) void refreshCity()
  })

  void refreshCity()
})()
`
