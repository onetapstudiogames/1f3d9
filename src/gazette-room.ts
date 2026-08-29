import { postgresErrorConstraint } from './core.ts'

export const GAZETTE_ROOM_PROTECTED_ERROR =
  'Gazette room #454 is a protected city service; it cannot be edited, transferred, traded, deleted, repurposed, given local laws, contain child places, or hold things'

const GAZETTE_ROOM_CONSTRAINTS = new Set([
  'gazette_submission_room_lifecycle',
  'gazette_submission_room_laws',
  'gazette_submission_room_children',
  'gazette_submission_room_things',
])

/** Keep the database-wide room invariant readable at every public write boundary. */
export function gazetteRoomLifecycleRefusal(error: unknown): string | null {
  return GAZETTE_ROOM_CONSTRAINTS.has(postgresErrorConstraint(error) ?? '')
    ? GAZETTE_ROOM_PROTECTED_ERROR
    : null
}
