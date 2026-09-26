// A picked place outside the city view is read on its own at the view's change marker, and
// the window accepts that read only at exactly that marker. The read is overtaken when the
// city moved while it was in flight: its reply carries a newer marker than it asked at, or
// the window's own city view moved on before the reply came back. The window does not show
// an overtaken read as a failure; it reads the place again once its city view covers a newer
// marker, up to FOCUSED_READ_OVERTAKEN_LIMIT times in a row, and the next overtaken read
// shows the failure with its Retry. Markers are decimal change marker strings; anything else
// counts as absent. The browser program injects these functions with
// Function.prototype.toString, so they read no import or module constant.
export const FOCUSED_READ_OVERTAKEN_LIMIT = 3

export function focusedReadOvertaken({
  requestMarker,
  replyMarker,
  viewMarker,
}: {
  requestMarker: string | null
  replyMarker: string | null
  viewMarker: string | null
}): boolean {
  const decimal = /^(?:0|[1-9][0-9]{0,18})$/u
  if (typeof requestMarker !== 'string' || !decimal.test(requestMarker)) return false
  if (viewMarker !== requestMarker) return true
  if (typeof replyMarker !== 'string' || !decimal.test(replyMarker)) return false
  return BigInt(replyMarker) > BigInt(requestMarker)
}

export function overtakenReadIsDue({
  entry,
  viewMarker,
}: {
  entry: Readonly<{ loading?: unknown; overtakenAt?: unknown }> | null | undefined
  viewMarker: string | null
}): boolean {
  const decimal = /^(?:0|[1-9][0-9]{0,18})$/u
  if (!entry || entry.loading === true) return false
  const overtakenAt = entry.overtakenAt
  if (typeof overtakenAt !== 'string' || !decimal.test(overtakenAt)) return false
  if (typeof viewMarker !== 'string' || !decimal.test(viewMarker)) return false
  return BigInt(viewMarker) > BigInt(overtakenAt)
}
