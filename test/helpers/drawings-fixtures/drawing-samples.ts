export const rowsFor = (value: { indices: readonly (number | null)[] }): string[] =>
  Array.from({ length: 8 }, (_, row) => value.indices
    .slice(row * 8, row * 8 + 8)
    .map(index => index == null ? '.' : String(index))
    .join(' '))
export const founderWorldDrawing = Object.freeze({
  palette: Object.freeze(['#0b1714', '#123026', '#1c4434']),
  indices: Object.freeze([
    0, 0, 0, 0, 0, 0, 0, 0,
    null, 0, 1, 0, 0, 0, 0, 0,
    null, 0, 0, 0, 0, 0, 1, 0,
    0, null, 0, 0, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 0, null, 0, 1, 0, 0, 0,
    0, 0, null, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 1, 0, 0,
  ]),
})
