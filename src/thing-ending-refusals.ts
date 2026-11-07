import { postgresErrorConstraint } from './core.ts'

// The words a resident reads when a thing's end refuses a request. Each is written once
// here, so every door says the same thing and the refusal census has one home to read.
// E10 and E11 reuse existing words, E12 was cut with pause, and E18 changes the existing
// law refusal in place.

/** E1: invent_kind and revise_kind, a malformed ending_policy. */
export const ENDING_POLICY_REFUSAL =
  'Choose which endings owners may pick: a date (at), a time after setting (after_setting_seconds), uses, a time unused (idle_seconds), or a named label being added (label_added), each at most once, with 1 to 8 label names when label_added is allowed. Leave the list empty to forbid endings.'

/** E2: make, thing_edit, thing_upgrade, an ending the thing's kind does not allow. */
export const ENDING_NOT_ALLOWED_REFUSAL =
  "This thing's kind does not allow that ending. Read the kind to see which endings it allows, or upgrade the thing if a newer revision allows it."

/** E3: make, thing_edit, thing_upgrade, an ending outside the shape or the limits. */
export const ENDING_SHAPE_REFUSAL =
  'Choose 1 to 4 different conditions: a date within 366 days, a time from 60 seconds to 366 days, 1 to 10,000 uses, or a label this kind names. Its maker may have set smaller limits.'

/** E4: thing_edit, make, mark_for_later, an end and a later-holder mark on one thing. */
export const ENDING_MARKED_REFUSAL =
  'This thing has your private later-holder mark. Unmark it before setting an end, or clear its end before marking it.'

/** E5: thing_edit setting or clearing the end of a thing whose end has come. */
export const ENDING_REMNANT_CHANGE_REFUSAL =
  'This thing has ended and is a remnant, so its end cannot be changed.'

/** E6: thing_edit on a copy, anything but clearing its end. */
export const ENDING_COPY_FIXED_REFUSAL =
  "This copy's end was fixed when it was copied. You can clear it, but not move it earlier, lower its uses, or give the copy a new end."

/** E7: every other write naming a thing whose end has come. */
export const THING_REMNANT_REFUSAL =
  'This thing has ended and is now a remnant. Read it with look. Its owner can still carry, give or withdraw it; nothing else can be done to it.'

/** E8: claim, claim_world, a city reservation, market checkout and payment entry. */
export const ENDING_PURCHASE_REFUSAL =
  "This thing's end has come, or would come before payment could finish, so no new purchase can start. Read its city record."

/** E9: transfer give, act give, a transfer step, on a thing with an end set. */
export const ENDING_GIVE_REFUSAL =
  "Clear this thing's end with thing_edit before giving it, so nobody receives an end they did not choose."

/** E9b: accepting a held gift whose giver has since set an end. */
export const ENDING_GIFT_ACCEPT_REFUSAL =
  'This gift can no longer be accepted because its giver set an end on the thing. It stays with the giver.'

/** E13: coin_trait, an end key that breaks one of the end-only rules. */
export const END_KEY_REFUSAL =
  'An end key runs once with nobody acting. It cannot wait, hand anything over, name actor, or name target outside a reach, and it cannot destroy, move or label the thing that is ending.'

/** E14: make, thing_edit, an end on a kindless thing by anyone but its maker while owning it. */
export const KINDLESS_ENDING_REFUSAL =
  'Only the resident who made a thing with no kind can give it an end, and only while owning it.'

/** E15: agree, a malformed thing_links list. */
export const THING_LINKS_REFUSAL =
  'thing_links takes 0 to 16 different thing ids, each of a thing that exists and is not withdrawn.'

/** E16: the guard fallback on any door, when the database refused a write mid-request. */
export const THING_ENDING_CHANGED_REFUSAL =
  'This thing changed or reached its end while your request was running. Read it again before you retry.'

/** E17: invent_kind, revise_kind, two traits that each carry an end key. */
export function endTraitConflictRefusal(first: string, second: string): string {
  return `A kind may list only one trait with an end key; ${first} and ${second} both carry one, so keep one of them.`
}

/** E19: revise_kind by an owner who is not the kind's inventor, widening its endings. */
export const ENDING_POLICY_WIDEN_REFUSAL =
  'Only the resident who invented this kind, while owning it, can allow more endings or change its end trait. Keep them as they are, or allow fewer endings.'

/**
 * E11: not refusals but the reasons an end try records when a gate is closed, one per
 * gate in endTryGates. A retired room never settles, so its reason is for completeness.
 */
export const END_TRY_SKIP_REASONS = Object.freeze({
  wake_off: 'waking is off for this thing',
  visitors_not_waking: 'this room does not let it wake',
  carried: 'the thing was being carried',
  in_sale: 'the thing was in a sale',
  room_retired: 'the room was retired',
} as const)

/**
 * Not a refusal: the reason a program step records when it is skipped because its own
 * thing's end has come, including during the same use, and for each give-trait step of
 * a remnant that is given. Every brick that skips a due or ended thing uses these words.
 */
export const THING_ENDED_SKIP_REASON = 'this thing has reached its end' as const

/** The status a door answers with when the ending guard refused its write. */
export const THING_ENDING_GUARD_STATUS = 409

const THING_ENDING_GUARD_CONSTRAINT = 'thing_ending_guard'

/**
 * Turn the database's ending guard (SQLSTATE 23514, constraint thing_ending_guard) into
 * the caller's E16 words; any other error gives null. Shaped like gazetteRoomLifecycleRefusal.
 */
export function thingEndingGuardRefusal(error: unknown): string | null {
  return postgresErrorConstraint(error) === THING_ENDING_GUARD_CONSTRAINT
    ? THING_ENDING_CHANGED_REFUSAL
    : null
}
