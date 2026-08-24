/**
 * Stable machine-readable failure classes shared by the city's HTTP and MCP
 * doors. A class derives only from HTTP status or transport state, never from
 * error-body text, so it cannot expose private operational detail.
 */
export type ErrorClass =
  | 'bad_input'
  | 'not_found'
  | 'auth_required'
  | 'forbidden'
  | 'payment_required'
  | 'conflict'
  | 'rate_limited'
  | 'city_fault'
  | 'unreachable'

export function errorClassForStatus(status: number): ErrorClass {
  if (status === 401) return 'auth_required'
  if (status === 402) return 'payment_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'city_fault'
  return 'bad_input'
}
