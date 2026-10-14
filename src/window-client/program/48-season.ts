// Keeps the season the server stamped into this page (src/season/stamp.ts)
// current when the window stays open past a UTC midnight. After each city
// refresh it compares today's UTC date with the day it last checked; on a new
// day it reads GET /api/season and swaps the palette stylesheet, the icons and
// the slogan words. The shared cache can answer the old day for a few minutes,
// so it tries again a few times. A failed read keeps the current look; it is
// decoration, so nothing is printed.
export const PART_48_SEASON = `  const seasonDateMeta = document.querySelector('meta[name="1f3d9-season-date"]')
  const SEASON_RETRY_MS = 5 * 60 * 1000
  const SEASON_TRIES_PER_DAY = 4
  let seasonCheckedDay = new Date().toISOString().slice(0, 10)
  let seasonTries = 0
  let seasonReading = false
  let seasonNextCheckAt = 0

  function seasonPath(value, prefix) {
    return typeof value === 'string' && value.startsWith(prefix) && /^[a-z0-9/+.-]+$/.test(value) && !value.includes('..')
      ? value
      : null
  }

  function seasonLook(season) {
    if (!season || typeof season !== 'object' || typeof season.date !== 'string') return null
    const sheet = season.stylesheets === null ? null : seasonPath(season.stylesheets?.window, '/season/')
    if (season.stylesheets !== null && sheet === null) return null
    const icon = season.icon?.url === '/favicon.svg' ? '/favicon.svg' : seasonPath(season.icon?.url, '/season/icon/')
    if (icon === null || typeof season.icon.label !== 'string') return null
    if (!Array.isArray(season.slogan?.parts)) return null
    const parts = []
    for (const part of season.slogan.parts) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      const image = seasonPath(part?.image, '/season/word/')
      if (image === null || typeof part.word !== 'string' || !/^[a-z]+$/.test(part.key)) return null
      parts.push(Object.freeze({ image, word: part.word, key: part.key, width: Number(part.width) || 0, height: Number(part.height) || 0 }))
    }
    return Object.freeze({ date: season.date, sheet, icon, label: season.icon.dressed ? season.icon.label : '', parts })
  }

  function applySeasonLook(look) {
    let sheet = document.getElementById('season-style')
    if (look.sheet === null) {
      sheet?.remove()
    } else {
      if (!sheet) {
        sheet = document.createElement('link')
        sheet.id = 'season-style'
        sheet.rel = 'stylesheet'
        document.head.append(sheet)
      }
      if (sheet.getAttribute('href') !== look.sheet) sheet.setAttribute('href', look.sheet)
    }
    for (const element of document.querySelectorAll('[data-season-icon]')) {
      if (element instanceof HTMLImageElement) {
        element.src = look.icon
        element.alt = look.label
      } else if (element instanceof HTMLLinkElement) {
        element.href = look.icon
      }
    }
    for (const slogan of document.querySelectorAll('[data-season-slogan]')) {
      slogan.replaceChildren(...look.parts.map(part => {
        if (typeof part === 'string') return part
        const image = document.createElement('img')
        image.className = 'season-word season-word--' + part.key
        image.src = part.image
        image.alt = part.word
        image.width = Math.round(part.width)
        image.height = Math.round(part.height)
        return image
      }))
    }
    seasonDateMeta.content = look.date
  }

  async function refreshSeasonIfDayChanged() {
    const today = new Date().toISOString().slice(0, 10)
    if (!seasonDateMeta || seasonReading || today === seasonCheckedDay || Date.now() < seasonNextCheckAt) return
    seasonReading = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let look = null
    try {
      const response = await fetch('/api/season', {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      })
      look = response.ok ? seasonLook(await response.json()) : null
      if (look && look.date !== seasonDateMeta.content) applySeasonLook(look)
    } catch {
      look = null
    } finally {
      window.clearTimeout(timeout)
      seasonReading = false
    }
    seasonTries += 1
    if ((look && look.date === today) || seasonTries >= SEASON_TRIES_PER_DAY) {
      seasonCheckedDay = today
      seasonTries = 0
      seasonNextCheckAt = 0
    } else {
      seasonNextCheckAt = Date.now() + SEASON_RETRY_MS
    }
  }

`
