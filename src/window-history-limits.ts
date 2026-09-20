// The human window keeps the older records a reader loaded, and spends one
// refresh-wide row budget closing gaps from those same lists. Both bounds live
// here once: the window notice, browser program, and resident reference are all
// built from these values.
//
// The bounds are not about browser memory. A list of tens of thousands of rows
// redraws slowly on every refresh, and a browser waking after a long sleep must
// not pull the whole sleep from the city in one burst. The fill bound is one
// total across every list checked by one changed refresh, never a per-list cap.
export const WINDOW_HISTORY_KEEP_ROWS = 3_000
export const WINDOW_HISTORY_FILL_ROWS = 300

// Keeping older records is only honest while the window can still see what the
// city changed. When that check could not be completed, the window cannot tell a
// record the city took down from one it left alone, so it keeps none. This is
// the privacy exception to the keep bound, and every served surface states it
// in these words rather than writing its own.
export const WINDOW_HISTORY_UNCHECKED_REFRESH_TEXT =
  'A refresh that cannot check what the city changed keeps no older records and starts again from the newest page.'

export const WINDOW_HISTORY_KEEP_ROWS_TEXT = WINDOW_HISTORY_KEEP_ROWS.toLocaleString('en-US')
export const WINDOW_HISTORY_FILL_ROWS_TEXT = WINDOW_HISTORY_FILL_ROWS.toLocaleString('en-US')
