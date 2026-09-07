function drawing(colour: string): Readonly<{ palette: readonly string[]; indices: readonly (number | null)[] }> {
  return Object.freeze({
    palette: Object.freeze([colour]),
    indices: Object.freeze(Array.from({ length: 64 }, (_, index) => (index === 0 ? 0 : null))),
  })
}

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
export const legacyResidentDrawing = drawing('#ad3f25')
export const legacyKindDrawing = drawing('#f0c95f')
export const legacyUntypedThingDrawing = drawing('#9d9276')
export const legacyTypedThingDrawing = drawing('#384f7d')
export const authoredResidentDrawing = drawing('#245f4b')
export const authoredPlaceDrawing = drawing('#8e4b32')
export const authoredThingDrawing = drawing('#516a91')
export const authoredKindDrawing = drawing('#b48b35')
