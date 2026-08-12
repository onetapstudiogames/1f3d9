export const WINDOW_CLIENT_SAFETY_JS = `
  function safeId(value) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }

  function safeCount(value) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }

  function hasUnsafeText(value) {
    for (const character of value) {
      const code = character.codePointAt(0)
      if (code === undefined) return true
      const unsafeControl = (code >= 0 && code <= 8) || code === 11 || code === 12 ||
        (code >= 14 && code <= 31) || (code >= 127 && code <= 159)
      const unsafeDirection = (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      const malformed = code === 0xfffd || code === 0x061c || code === 0x200e ||
        code === 0x200f || code === 0x2028 || code === 0x2029
      if (unsafeControl || unsafeDirection || malformed) return true
    }
    return false
  }

  function safeText(value, fallback, maximum, allowEmpty) {
    if (typeof value !== 'string') return fallback
    let trimmed
    try {
      trimmed = value.normalize('NFC').trim()
    } catch {
      return fallback
    }
    if ((!allowEmpty && !trimmed) || hasUnsafeText(trimmed)) return fallback
    return trimmed.slice(0, maximum || 120)
  }

  function safeHandle(value) {
    return typeof value === 'string' && SAFE_HANDLE.test(value) ? value : null
  }

  function safeWorldName(value) {
    return typeof value === 'string' && (SAFE_WORLD_NAME.test(value) || value === MODERATED_TEXT)
      ? value
      : null
  }

  function safeDate(value) {
    if (typeof value !== 'string') return null
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date : null
  }

  function safeHandles(value) {
    return Array.isArray(value)
      ? [...new Set(value.map(safeHandle).filter(Boolean))].slice(0, 32)
      : []
  }
`
