// The numbers the human talk views run on (decisions 129 and 130). This file imports
// nothing, so the city's routes, the window's browser program, and the served reference
// all read one home. The live page and the terminal follow view live in their own
// repositories: they read check_interval_ms from GET /api/talk/now and keep their own
// copies of the other numbers they use.

// How often a human view may check GET /api/talk/now. It is served to every view as
// check_interval_ms, so one city change turns it down without redeploying the live page
// or releasing the plugin. A whole number of seconds, because the shared cache below lasts
// exactly this long.
export const TALK_CHECK_MS = 2_000
// Every polled talk read keeps one shared edge copy for exactly one check interval, so all
// watchers in one edge region share at most one function run per interval.
export const TALK_SHARED_CACHE_SECONDS = TALK_CHECK_MS / 1_000
export const TALK_SHARED_CACHE_CONTROL = `public, max-age=0, s-maxage=${TALK_SHARED_CACHE_SECONDS}`
// A request that carries a credential header may be answered with private data (the
// pending-ping summary), so no shared cache may keep it.
export const TALK_PRIVATE_CACHE_CONTROL = 'private, no-store'
// At most this many listening residents in one answer, like the looking cue's limit.
export const TALK_NOW_LISTENING_LIMIT = 200
// The line marker looks at this many of the newest line events and line moderation events,
// because event ids are taken before commit.
export const TALK_LINE_MARKER_SCAN = 20

// The window's Talk tab. It never checks more often than TALK_CHECK_MIN_MS, whatever the
// city serves, and reads a served interval above TALK_CHECK_MAX_MS as that.
export const TALK_CHECK_MIN_MS = 2_000
export const TALK_CHECK_MAX_MS = 600_000
// A new line shows within this while reads succeed: one cache age plus one check interval
// must stay under it.
export const TALK_TARGET_MS = 5_000
export const TALK_RETRY_MAX_MS = 30_000
export const TALK_PAGE_LINES = 50
export const TALK_PANE_HOURS = 24

// A Talk tab nobody has used for this long checks less often (owner's answer to Q3).
export const TALK_IDLE_MS = 30 * 60_000
export const TALK_IDLE_CHECK_MS = 30_000
