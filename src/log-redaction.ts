const CITY_CREDENTIAL = /1f3(?:d9|ea)_(?:sk|at|rt|ac|rc|pc)_[A-Za-z0-9_-]{24,256}\b/giu
const GIFT_CLAIM = /gift_claim_[0-9a-f]{64}\b/giu
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,2048}/giu
const DATABASE_URL = /\b(?:postgres|postgresql):\/\/[^\s"'<>]+/giu
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]{1,512}:[^\s/@"'<>]{1,512}@/giu
const COMMON_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,512}|github_pat_[A-Za-z0-9_]{16,512}|gh[pousr]_[A-Za-z0-9]{16,512}|xox[baprs]-[A-Za-z0-9-]{16,512}|AKIA[A-Z0-9]{16})\b/gu
const SENSITIVE_HEADER = /(?:^|[^A-Za-z0-9_-])(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]|(?:^|[^A-Za-z0-9_-])(?:authorization|proxy-authorization)\s+(?:Basic|Bearer|Digest|ApiKey|Token)\b/iu
const ASSIGNED_KEY = /(?:^|[^A-Za-z0-9_-])["']?([A-Za-z][A-Za-z0-9_-]{0,511})["']?\s*[:=]/gu

export const REDACTED_LOG_TEXT = '[redacted: log text contained credential material]'

function containsSensitiveAssignment(value: string): boolean {
  for (const match of value.matchAll(ASSIGNED_KEY)) {
    const normalizedKey = (match[1] ?? '')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
      .replace(/-/gu, '_')
      .toLowerCase()
    const segments = normalizedKey.split('_').filter(Boolean)
    const compact = segments.join('')
    if (
      segments.some(segment => [
        'password', 'passwd', 'secret', 'token', 'session', 'sessionid', 'credential',
      ].includes(segment))
      || ['apikey', 'privatekey', 'accesskey', 'databaseurl'].some(
        suffix => compact.endsWith(suffix),
      )
    ) return true
  }
  return false
}

export function redactLogSecrets(value: string, logDrainSecret?: string): string {
  const normalized = value.replace(/\0/gu, '')
  if (SENSITIVE_HEADER.test(normalized) || containsSensitiveAssignment(normalized)) {
    return REDACTED_LOG_TEXT
  }
  const withoutDrainSecret = logDrainSecret
    ? normalized.split(logDrainSecret).join('[redacted log-drain secret]')
    : normalized
  return withoutDrainSecret
    .replace(CITY_CREDENTIAL, '[redacted city credential]')
    .replace(GIFT_CLAIM, '[redacted gift claim]')
    .replace(BEARER_CREDENTIAL, 'Bearer [redacted]')
    .replace(DATABASE_URL, '[redacted database URL]')
    .replace(CREDENTIAL_URL, '$1[redacted]@')
    .replace(COMMON_TOKEN, '[redacted token]')
}
