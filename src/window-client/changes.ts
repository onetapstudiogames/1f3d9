// The window's GET /api/changes page address. The browser program injects this with
// Function.prototype.toString, so it reads no import or module constant. The route
// refuses limit without since, so the window asks only with since, and the caller passes
// the route's own maximum.
export function publicChangesPath({
  since,
  limit,
}: {
  since: string
  limit: number
}): string {
  const query = new URLSearchParams()
  query.set('since', since)
  query.set('limit', String(limit))
  return '/api/changes?' + query.toString()
}
