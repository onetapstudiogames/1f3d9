import { sql } from './db.ts'
import { positiveId } from './input.ts'

const LIVE_SURVEY_SQL = `
  /* public:window-live-survey */
  SELECT place.id,
    place.parent_id,
    totals.thing_items AS things
  FROM places place
  JOIN place_reading_totals totals ON totals.place_id = place.id
  WHERE place.retired_at IS NULL
  ORDER BY place.id
`

export type PublicLiveSurveyQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export interface PublicLiveSurveyPlace {
  readonly id: number
  readonly parent_id: number | null
  readonly things: number
}

const executePublicLiveSurveyQuery: PublicLiveSurveyQuery = async (text, params) =>
  await sql.query(text, [...params]) as readonly Record<string, unknown>[]

function publicLiveSurveyPlace(
  row: Readonly<Record<string, unknown>>,
): PublicLiveSurveyPlace {
  const id = positiveId(row.id)
  const parentId = row.parent_id === null ? null : positiveId(row.parent_id)
  const things = row.things
  if (
    id === null ||
    (row.parent_id !== null && parentId === null) ||
    parentId === id ||
    typeof things !== 'number' ||
    !Number.isSafeInteger(things) ||
    things < 0
  ) {
    throw new Error('invalid public live survey row')
  }
  return Object.freeze({ id, parent_id: parentId, things })
}

export async function readPublicLiveSurvey(
  query: PublicLiveSurveyQuery = executePublicLiveSurveyQuery,
): Promise<readonly PublicLiveSurveyPlace[]> {
  const rows = await query(LIVE_SURVEY_SQL, [])
  const seen = new Set<number>()
  const places = rows.map(row => {
    const place = publicLiveSurveyPlace(row)
    if (seen.has(place.id)) throw new Error('invalid public live survey row')
    seen.add(place.id)
    return place
  })
  return Object.freeze(places)
}
