import type { TaggedSql } from './engine.ts'
import { publicText } from './input.ts'
import {
  planShowingResultParts,
  renderShowingOpeningReport,
  renderShowingResult,
  renderShowingRules,
  type ShowingResultCopy,
  type ShowingRulesCopy,
} from './showing-room-copy.ts'

export type ShowingRoomPublication = Readonly<{
  purpose: 'count' | 'winners' | 'next_rules' | 'gazette' | 'square'
  part: number
  noteId: number
  placeId: 438 | 454 | 3
  createdAt: string
}>

export type ShowingRoomPublicationInput = Readonly<{
  runId: number
  result: ShowingResultCopy | null
  nextQuestion: ShowingRulesCopy | null
  square: boolean
}>

type PlannedPublication = Readonly<{
  purpose: ShowingRoomPublication['purpose']
  part: number
  placeId: ShowingRoomPublication['placeId']
}>
type ReservedPublication = PlannedPublication & Readonly<{ noteId: number }>
type Query = NonNullable<TaggedSql['query']>

function publicationPlan(input: ShowingRoomPublicationInput): readonly PlannedPublication[] {
  if (!Number.isSafeInteger(input.runId) || input.runId < 1 || (!input.result && !input.nextQuestion)) {
    throw new TypeError('the showing room publication needs a recorded run and a count or next question')
  }
  const details = input.result ? planShowingResultParts(input.result) : 0
  return [
    ...(input.result ? [
      { purpose: 'count' as const, part: 1, placeId: 438 as const },
      ...Array.from({ length: details }, (_, index) => ({
        purpose: 'count' as const, part: index + 2, placeId: 438 as const,
      })),
      { purpose: 'winners' as const, part: 1, placeId: 438 as const },
    ] : []),
    ...(input.nextQuestion ? [{ purpose: 'next_rules' as const, part: 1, placeId: 438 as const }] : []),
    { purpose: 'gazette' as const, part: 1, placeId: 454 as const },
    ...(input.square ? [{ purpose: 'square' as const, part: 1, placeId: 3 as const }] : []),
  ]
}

async function reservePublications(
  query: Query,
  runId: number,
  plan: readonly PlannedPublication[],
): Promise<readonly ReservedPublication[]> {
  const rows = await query(`
    SELECT nextval(pg_get_serial_sequence('notes','id'))::integer AS id
    FROM generate_series(1,$1::integer)
  `, [plan.length]) as { id: number }[]
  if (rows.length !== plan.length) throw new Error('the showing room could not reserve every publication; retry the same Monday slot')
  const reserved = plan.map((item, index) => ({ ...item, noteId: rows[index]!.id }))
  for (const item of reserved) {
    await query(`
      INSERT INTO showing_room_publications(run_id,purpose,part,note_id,place_id)
      VALUES($1,$2,$3,$4,$5)
    `, [runId, item.purpose, item.part, item.noteId, item.placeId])
  }
  return reserved
}

function renderPublications(
  input: ShowingRoomPublicationInput,
  reserved: readonly ReservedPublication[],
): readonly string[] {
  const nextRules = reserved.find(item => item.purpose === 'next_rules')?.noteId ?? null
  const rendered = input.result ? renderShowingResult(input.result, {
    count: reserved.find(item => item.purpose === 'count' && item.part === 1)!.noteId,
    winners: reserved.find(item => item.purpose === 'winners')!.noteId,
    details: reserved.filter(item => item.purpose === 'count' && item.part > 1).map(item => item.noteId),
    nextRules,
  }) : null
  const opening = input.result === null && input.nextQuestion && nextRules !== null
    ? renderShowingOpeningReport(input.nextQuestion.questionNumber, nextRules) : null
  const bodies = reserved.map(item => item.purpose === 'next_rules'
    ? renderShowingRules(input.nextQuestion!)
    : item.purpose === 'count'
      ? item.part === 1 ? rendered!.count : rendered!.details[item.part - 2]!
      : item.purpose === 'winners' ? rendered!.winners
        : item.purpose === 'gazette' ? rendered?.gazette ?? opening!
          : rendered?.square ?? opening!)
  if (bodies.some(body => publicText(body, { maximumCharacters: 4000 }) === null)) {
    throw new TypeError('each showing room publication must fit the ordinary 4000 character note limit and public text rules')
  }
  return bodies
}

async function writePublication(
  query: Query,
  item: ReservedPublication,
  body: string,
  founderHandle: string,
): Promise<ShowingRoomPublication> {
  const rows = await query(`
    WITH new_note AS (
      INSERT INTO notes(id,place_id,author_id,body,walk_to_read,created_at)
      VALUES($1,$2,1,$3,FALSE,clock_timestamp())
      RETURNING id,place_id,created_at
    ), new_event AS (
      INSERT INTO events(at,kind,actor,detail)
      SELECT created_at,'note',$4,jsonb_build_object('note_id',id,'place_id',place_id)
      FROM new_note
      RETURNING id
    )
    SELECT note.id,to_char(note.created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM new_note note CROSS JOIN new_event
  `, [item.noteId, item.placeId, body, founderHandle]) as { id: number; created_at: string }[]
  if (rows.length !== 1 || rows[0]!.id !== item.noteId) {
    throw new Error('the showing room could not record a note and its event together; retry the same Monday slot')
  }
  return { ...item, createdAt: rows[0]!.created_at }
}

/** The caller owns the transaction and the service, founder, Gazette and admission locks. */
export async function publishShowingRoomNotes(
  database: TaggedSql,
  input: ShowingRoomPublicationInput,
): Promise<readonly ShowingRoomPublication[]> {
  const query = database.query
  if (!query) throw new Error('the showing room cannot publish until its database can keep the whole run together')
  const plan = publicationPlan(input)
  const founders = await query('SELECT handle FROM residents WHERE id=1') as { handle: string }[]
  if (founders.length !== 1 || !founders[0]!.handle) throw new Error('founder resident #1 must exist before the showing room can publish')
  const reserved = await reservePublications(query, input.runId, plan)
  const bodies = renderPublications(input, reserved)
  let publications: readonly ShowingRoomPublication[] = []
  for (const [index, item] of reserved.entries()) {
    publications = [...publications, await writePublication(query, item, bodies[index]!, founders[0]!.handle)]
  }
  return publications
}
