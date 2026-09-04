export type WindowDrawing = Readonly<{
  palette: readonly string[]
  indices: readonly (number | null)[]
}>

export type WindowDrawingState = 'undrawn' | 'refused' | 'in_progress' | 'complete'

export type WindowDrawingSource = Readonly<{
  source: 'none' | 'resident' | 'place' | 'thing' | 'kind_base' | 'kind_variant'
  kind_id?: number
  kind_name?: string
  revision?: number
  variant_name?: string
}>

export function normalizeWindowDrawing(value: unknown): WindowDrawing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const fields = Object.keys(candidate).sort()
  if (fields.length !== 2 || fields[0] !== 'indices' || fields[1] !== 'palette') return null
  if (!Array.isArray(candidate.palette) || candidate.palette.length > 64 ||
      !candidate.palette.every(colour => typeof colour === 'string' && /^#[0-9a-f]{6}$/u.test(colour))) {
    return null
  }
  if (!Array.isArray(candidate.indices) || candidate.indices.length !== 64 ||
      !candidate.indices.every(index => index === null || (
        typeof index === 'number' && Number.isInteger(index) && index >= 0 &&
        index < (candidate.palette as unknown[]).length
      ))) return null
  try {
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 2_048) return null
  } catch {
    return null
  }
  return Object.freeze({
    palette: Object.freeze([...(candidate.palette as string[])]),
    indices: Object.freeze([...(candidate.indices as Array<number | null>)]),
  })
}

export function windowDrawingStateLabel(
  state: WindowDrawingState,
  drawing: WindowDrawing | null,
): 'Undrawn' | 'Refused' | 'In progress' | 'Blank' | 'Complete' {
  if (state === 'undrawn') return 'Undrawn'
  if (state === 'refused') return 'Refused'
  if (state === 'in_progress') return 'In progress'
  return drawing?.indices.every(index => index === null) ? 'Blank' : 'Complete'
}

export function windowDrawingSourceLabel(source: WindowDrawingSource | null): string {
  if (!source || source.source === 'none') return ''
  if (['resident', 'place', 'thing'].includes(source.source)) return 'Own drawing'
  if (!source.kind_name || !Number.isSafeInteger(source.revision) ||
      (source.revision ?? 0) <= 0) return ''
  const prefix = `Kind ${source.kind_name} · revision ${String(source.revision)} · `
  if (source.source === 'kind_base') return prefix + 'base'
  return source.variant_name ? prefix + `variant ${source.variant_name}` : ''
}
