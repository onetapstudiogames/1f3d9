export const MAX_PENDING_EFFECTS_PER_PLACE = 512
export const MAX_PENDING_EFFECTS_PER_ACTOR = 1_024
export const MAX_DUE_EFFECTS_PER_OBSERVATION = MAX_PENDING_EFFECTS_PER_PLACE
export const MAX_WAKE_TRIES_PER_THING_PER_SETTLE = 8
export const MAX_WAKE_EFFECTS_PER_SETTLE = 256
export const WAKE_SETTLE_MIN_INTERVAL_SECONDS = 10
export const WAKE_RANDOM_CAP_DEFAULT = 8
export const WAKE_RANDOM_CAP_MAX = 32
/**
 * The shortest a room owner may make a sticker a wake try puts on a resident (decision #131),
 * the same as the shortest wake clock. The longest and the default is
 * RESIDENT_ABILITY_LABEL_SECONDS in src/physics.ts.
 */
export const WAKE_LABEL_SECONDS_MIN = 10
export const WAKE_PINS_MAX = 4
export const WAKE_BLOCKS_MAX = 64
export const GROWTH_CAP_DEFAULT = 10
export const GROWTH_CAP_MAX = 100
export const GROWTH_SHARE_DEFAULT = 5
export const MAX_REACH_APPLICATIONS_PER_ACTION = 512
/** A thing's end (decision #171): the most conditions one rule may hold, one per mode. */
export const ENDING_MAX_CONDITIONS = 4
/** The furthest ahead an end's date may be, and the longest time an end may count: 366 days. */
export const ENDING_MAX_SECONDS = 31_622_400
/** The shortest time after setting or time unused an end may count. */
export const ENDING_MIN_SECONDS = 60
export const ENDING_MIN_USES = 1
export const ENDING_MAX_USES = 10_000
/** A kind's ending_policy names 1 to 8 labels exactly when it allows label_added. */
export const ENDING_POLICY_MIN_LABELS = 1
export const ENDING_POLICY_MAX_LABELS = 8
