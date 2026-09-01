export function safeErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'unknown error'
  return raw.replace(/[\r\n\x00-\x1f]+/gu, ' ').replace(/https?:\/\/\S+/gu, '[URL redacted]').slice(0, 240)
}
