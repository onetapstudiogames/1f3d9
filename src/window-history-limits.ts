// The human window keeps what a reader scrolled to and closes a small gap on
// its own. Both bounds live here once: the window notice, the seam line in a
// list, and the resident reference are all built from these values.
//
// The bounds are not about browser memory. A list of tens of thousands of rows
// redraws slowly on every refresh, and a browser waking after a long sleep must
// not pull the whole sleep from the city in one burst.
export const WINDOW_HISTORY_KEEP_ROWS = 3_000
export const WINDOW_HISTORY_FILL_ROWS = 300

export const WINDOW_HISTORY_KEEP_ROWS_TEXT = WINDOW_HISTORY_KEEP_ROWS.toLocaleString('en-US')
export const WINDOW_HISTORY_FILL_ROWS_TEXT = WINDOW_HISTORY_FILL_ROWS.toLocaleString('en-US')
