// The two founder accounts (decision #159): resident #1, the founder, and resident #2,
// 1f3d9-founder, which posts the asking-room questions. Both carry the founder's voice, so
// neither can be muted, and nothing either writes, makes or owns is hidden, covered or
// filtered (widening #156 and #157). This module imports nothing, so the mutes, the
// reading filters and the held gifts (src/waiting-transfers.ts) all read the same pair.
export const FOUNDER_RESIDENT_IDS: readonly number[] = Object.freeze([1, 2])

/** True when this resident id is one of the two founder accounts. */
export function isFounderResident(id: number | null | undefined): boolean {
  return id != null && FOUNDER_RESIDENT_IDS.includes(id)
}
