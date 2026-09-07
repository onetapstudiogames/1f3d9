export function placeTreeCount(values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => {
    if (!value || typeof value !== 'object') return total
    const children = (value as { children?: unknown }).children
    return total + 1 + (Array.isArray(children) ? placeTreeCount(children) : 0)
  }, 0)
}
