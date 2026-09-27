// Decision 129 fails closed in the window. A room's own read that said quiet stays in force
// when a newer change marker makes it stale, until the window reads that room again: the
// picked place and a followed resident's current place on every refresh that moves the
// marker, and any other room at the refresh whose changes name a place edit of it, or at a
// later one if that read fails, does not fit, or is put off while the room is selected
// (placesToReadAtRefresh). Quiet changes only through place_edit, so nothing can open the
// room in between. A room in the view's loaded places (the outline and any loaded branch)
// gives way, because the view brings its fresh mark on every such refresh. The browser
// program injects this with Function.prototype.toString, so it reads no import or module
// constant.
export function staleFocusedPlaceStaysQuiet({
  place,
  inLoadedPlaces,
}: {
  place: Readonly<{ quiet?: unknown }> | null
  inLoadedPlaces: boolean
}): boolean {
  return !inLoadedPlaces && place !== null && place.quiet === true
}

// A city refresh reads at most this many rooms on their own; the rest wait for the next
// refresh that moves the change marker.
export const EDITED_PLACE_READS_PER_REFRESH = 10

// Decision 129: the rooms a city refresh that moves the window's change marker reads on their
// own, at the new marker, before it draws the new view. Quiet changes only through place_edit,
// so these are the rooms a place_edited change since the last marker names, newest first,
// then the rooms whose read failed, did not fit, or was put off last time. When the changes
// are not known all the way to the new marker (complete is false), every room whose own read
// said quiet is read as well, since any of them may have opened. A room in the loaded places
// comes fresh with the view, so it is left out. The picked place and a followed resident's
// current place (selectedIds) are read on every such refresh anyway, so they are not read
// here but put off in later, and read at the first refresh after they stop being selected.
// At most limit are read now. The browser program injects this with
// Function.prototype.toString, so it reads no import or module constant.
export function placesToReadAtRefresh({
  changes,
  complete,
  heldQuietIds,
  retryIds,
  loadedIds,
  selectedIds,
  limit,
}: {
  changes: readonly Readonly<{ kind?: unknown; detail?: Readonly<{ place_id?: unknown }> | null }>[]
  complete: boolean
  heldQuietIds: readonly number[]
  retryIds: readonly number[]
  loadedIds: readonly number[]
  selectedIds: readonly number[]
  limit: number
}): Readonly<{ now: readonly number[]; later: readonly number[] }> {
  const edited = changes.flatMap(change => {
    const placeId = change.detail?.place_id
    return change.kind === 'place_edited' && typeof placeId === 'number' &&
      Number.isSafeInteger(placeId) && placeId > 0
      ? [placeId]
      : []
  })
  const loaded = new Set(loadedIds)
  const selected = new Set(selectedIds)
  const ids = [...new Set(complete ? [...edited, ...retryIds] : [...edited, ...heldQuietIds, ...retryIds])]
    .filter(placeId => !loaded.has(placeId))
  const readable = ids.filter(placeId => !selected.has(placeId))
  return Object.freeze({
    now: Object.freeze(readable.slice(0, limit)),
    later: Object.freeze([...readable.slice(limit), ...ids.filter(placeId => selected.has(placeId))]),
  })
}
