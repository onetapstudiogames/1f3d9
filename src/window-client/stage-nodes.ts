export type StageNodeKind = 'place' | 'resident' | 'thing'

export type StageNodeDiff = Readonly<{
  keep: readonly string[]
  create: readonly string[]
  retire: readonly string[]
}>

export function stageNodeKey(kind: StageNodeKind, id: string | number): string {
  return `${kind}:${String(id)}`
}

export function reconcileStageNodeKeys(
  currentKeys: readonly string[],
  nextKeys: readonly string[],
): StageNodeDiff {
  const current = new Set(currentKeys)
  const next = new Set(nextKeys)
  return Object.freeze({
    // Step 2 seam: later registry lanes consume keep/create; this lane consumes retire.
    keep: Object.freeze([...next].filter(key => current.has(key))),
    create: Object.freeze([...next].filter(key => !current.has(key))),
    retire: Object.freeze([...current].filter(key => !next.has(key))),
  })
}

export function stageDrawnNodeKeys(keys: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(keys)])
}

export function stageFacing(fromX: number, toX: number, currentFacing: 1 | -1 = 1): 1 | -1 {
  if (toX < fromX) return -1
  if (toX > fromX) return 1
  return currentFacing
}

export function stageTransform(
  x: number,
  y: number,
  anchor: 'resident' | 'thing' | 'route' = 'resident',
): string {
  const translation = `translate(${String(x)}px, ${String(y)}px)`
  if (anchor === 'route') return translation
  return translation + (anchor === 'thing'
    ? ' translate(-50%, -50%)'
    : ' translate(-50%, -100%)')
}
