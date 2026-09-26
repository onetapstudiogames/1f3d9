// Decision 129 fails closed in the window. A picked place whose own last read said quiet
// stays quiet when a newer change marker makes that read stale, until the read that every
// marker-moving refresh forces for the picked place replaces it. Any other stale read still
// gives way, because nothing reads it again. The browser program injects this with
// Function.prototype.toString, so it reads no import or module constant.
export function staleFocusedPlaceStaysQuiet({
  placeId,
  pickedPlaceId,
  place,
}: {
  placeId: number | string
  pickedPlaceId: number | string | null
  place: Readonly<{ quiet?: unknown }> | null
}): boolean {
  if (pickedPlaceId === null || String(placeId) !== String(pickedPlaceId)) return false
  return place !== null && place.quiet === true
}
