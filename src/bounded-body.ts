// One reading of a request's Content-Length declaration for every bounded
// body read. The production edge forwards bodies without a usable
// Content-Length header (and a proxy may fold duplicate declarations into one
// comma-joined value), so an absent declaration must never refuse a request;
// the enforced bound is always the actual byte count checked after the
// framework read. A declaration that is present but unusable is refused
// before the body is read.
export type DeclaredBodyLength = 'absent' | 'usable' | 'unusable'

export function declaredBodyLength(
  header: string | undefined,
  maximumBytes: number,
): DeclaredBodyLength {
  if (header === undefined) return 'absent'
  const distinct = [...new Set(header.split(',').map(part => part.trim()))]
  const declared = distinct.length === 1 ? distinct[0]! : ''
  return /^\d+$/u.test(declared) && BigInt(declared) <= BigInt(maximumBytes)
    ? 'usable'
    : 'unusable'
}
