import { positiveId, publicText } from './input.ts'

export const COMMUNITY_TOOL_CATEGORIES = Object.freeze([
  'Browse',
  'Create',
  'Connect',
  'Learn',
] as const)

export const COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY = 3
export const COMMUNITY_TOOL_TAG_LIMIT = 5

export type CommunityToolCategory = typeof COMMUNITY_TOOL_CATEGORIES[number]

export type CommunityToolSubmission = Readonly<{
  title: string
  url: `https://${string}`
  operator: string
  description: string
  residentId: number | null
  category: CommunityToolCategory
  tags: readonly string[]
}>

export type CommunityToolSubmissionRefusal =
  | 'invalid_form'
  | 'honeypot'

export type CommunityToolSubmissionParseResult =
  | Readonly<{ ok: true; value: CommunityToolSubmission }>
  | Readonly<{ ok: false; reason: CommunityToolSubmissionRefusal; message: string }>

export type CommunityToolSubmissionQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export type CommunityToolQueueResult = Readonly<{
  outcome: 'queued' | 'rate_limited' | 'resident_not_found'
}>

export type QueuedCommunityToolSubmission = Readonly<{
  id: number
  title: string
  url: string
  operator: string
  description: string
  resident: Readonly<{ id: number; handle: string }> | null
  category: CommunityToolCategory
  tags: readonly string[]
  submittedAt: string
}>

export type CommunityToolQueue = Readonly<{
  waitingCount: number
  submissions: readonly QueuedCommunityToolSubmission[]
}>

export type CommunityToolReviewOutcome = 'listed' | 'declined'
export type CommunityToolReviewResult = Readonly<{
  outcome: 'reviewed' | 'already_reviewed' | 'not_found'
  reviewOutcome: CommunityToolReviewOutcome | null
}>

const FORM_FIELDS = Object.freeze([
  'csrf',
  'title',
  'url',
  'operator',
  'description',
  'resident_id',
  'category',
  'tags',
  'confirmation',
  'website',
] as const)

const CATEGORY_SET: ReadonlySet<string> = new Set(COMMUNITY_TOOL_CATEGORIES)
const IP_HASH = /^[0-9a-f]{64}$/u
const TAG = /^[a-z0-9][a-z0-9 -]{0,23}$/u

function refusal(message: string, reason: CommunityToolSubmissionRefusal = 'invalid_form'):
  CommunityToolSubmissionParseResult {
  return Object.freeze({ ok: false, reason, message })
}

function exactFields(params: URLSearchParams): boolean {
  const allowed = new Set<string>(FORM_FIELDS)
  const seen = new Set<string>()
  for (const name of params.keys()) {
    if (!allowed.has(name) || seen.has(name) || params.getAll(name).length !== 1) return false
    seen.add(name)
  }
  return true
}

function trimmedPublicText(value: string | null, maximumCharacters: number): string | null {
  const trimmed = value?.trim() ?? ''
  return publicText(trimmed, { maximumCharacters })
}

function httpsUrl(value: string | null): `https://${string}` | null {
  const candidate = value?.trim() ?? ''
  if (candidate.length > 2_048 || !candidate.startsWith('https://')) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null
    return parsed.href as `https://${string}`
  } catch {
    return null
  }
}

function tags(value: string | null): readonly string[] | null {
  if (value === null) return null
  const parsed = value.split(',').map(tag => tag.trim().toLowerCase())
  if (
    parsed.length < 1
    || parsed.length > COMMUNITY_TOOL_TAG_LIMIT
    || parsed.some(tag => !TAG.test(tag))
  ) return null
  const unique = [...new Set(parsed)]
  return unique.length === parsed.length ? Object.freeze(unique) : null
}

export function parseCommunityToolSubmission(
  params: URLSearchParams,
): CommunityToolSubmissionParseResult {
  if (!exactFields(params)) {
    return refusal('This form contained unexpected information, so it was not saved. Return to /tools and try again.')
  }
  if (params.get('website') === null) {
    return refusal('This form was incomplete, so it was not saved. Return to /tools and try again.')
  }
  if (params.get('website') !== '') {
    return refusal(
      'That submission looked automated, so it was not saved. Clear the hidden website field and try again from /tools.',
      'honeypot',
    )
  }
  const title = trimmedPublicText(params.get('title'), 80)
  if (!title) return refusal('Add a title of 80 characters or fewer, then try again.')
  const url = httpsUrl(params.get('url'))
  if (!url) return refusal('Use one public https link for the tool, then try again.')
  const operator = trimmedPublicText(params.get('operator'), 100)
  if (!operator) return refusal('Say who runs the tool in 100 characters or fewer, then try again.')
  const description = trimmedPublicText(params.get('description'), 200)
  if (!description || /[\r\n]/u.test(description)) {
    return refusal('Describe the tool in one line of 200 characters or fewer, then try again.')
  }
  const residentValue = params.get('resident_id')?.trim() ?? ''
  const residentId = residentValue === '' ? null : positiveId(residentValue)
  if (residentValue !== '' && residentId === null) {
    return refusal('Choose a resident from the resident list, or choose no resident, then try again.')
  }
  const category = params.get('category') ?? ''
  if (!CATEGORY_SET.has(category)) {
    return refusal('Choose a category from the list, then try again.')
  }
  const parsedTags = tags(params.get('tags'))
  if (!parsedTags) return refusal(`Add 1 to up to ${COMMUNITY_TOOL_TAG_LIMIT} short, different tags separated by commas, then try again.`)
  if (params.get('confirmation') !== 'confirmed') {
    return refusal('Confirm that the tool is safe and that you made it or have permission to post it, then try again.')
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      title,
      url,
      operator,
      description,
      residentId,
      category: category as CommunityToolCategory,
      tags: parsedTags,
    }),
  })
}

const SUBMIT_SQL = `
  /* community-tools:submit */
  WITH requested_resident AS MATERIALIZED (
    SELECT $7::integer AS resident_id
    WHERE $7::integer IS NULL
      OR EXISTS (SELECT 1 FROM residents WHERE id = $7::integer)
  ), expired AS (
    DELETE FROM community_tool_submission_limits old
    WHERE old.day < (now() AT TIME ZONE 'UTC')::date - 30
  ), admitted AS (
    INSERT INTO community_tool_submission_limits (ip_hash, day, used)
    SELECT $1::text, (now() AT TIME ZONE 'UTC')::date, 1
    FROM requested_resident
    ON CONFLICT (ip_hash, day) DO UPDATE
      SET used = community_tool_submission_limits.used + 1
      WHERE community_tool_submission_limits.used < $2::integer
    RETURNING used
  ), queued AS (
    INSERT INTO community_tool_submissions (
      title, url, operator_name, description, resident_id, category, tags, submitter_ip_hash
    )
    SELECT $3::text, $4::text, $5::text, $6::text, requested_resident.resident_id,
      $8::text, $9::text[], $1::text
    FROM requested_resident, admitted
    RETURNING id
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM requested_resident) THEN 'resident_not_found'
    WHEN EXISTS (SELECT 1 FROM queued) THEN 'queued'
    ELSE 'rate_limited'
  END AS outcome
`

export async function submitCommunityTool(
  query: CommunityToolSubmissionQuery,
  submission: CommunityToolSubmission,
  ipHash: string,
): Promise<CommunityToolQueueResult> {
  if (!IP_HASH.test(ipHash)) throw new TypeError('community tool submitter IP hash is invalid')
  const rows = await query(SUBMIT_SQL, [
    ipHash,
    COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY,
    submission.title,
    submission.url,
    submission.operator,
    submission.description,
    submission.residentId,
    submission.category,
    [...submission.tags],
  ])
  const outcome = rows[0]?.outcome
  if (!['queued', 'rate_limited', 'resident_not_found'].includes(String(outcome))) {
    throw new Error('community tool queue result is unavailable')
  }
  return Object.freeze({ outcome: outcome as CommunityToolQueueResult['outcome'] })
}

export async function readCommunityToolWaitingCount(
  query: CommunityToolSubmissionQuery,
): Promise<number> {
  const rows = await query(`
    /* community-tools:waiting-count */
    SELECT count(*)::integer AS count FROM community_tool_submissions
    WHERE reviewed_at IS NULL
  `, [])
  const count = Number(rows[0]?.count)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('community tool waiting count is unavailable')
  }
  return count
}

function queueTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function queuedSubmission(row: Readonly<Record<string, unknown>>): QueuedCommunityToolSubmission {
  const id = Number(row.id)
  const residentId = row.resident_id == null ? null : positiveId(row.resident_id)
  const residentHandle = row.resident_handle == null ? null : String(row.resident_handle)
  const submittedAt = queueTimestamp(row.created_at)
  const rowTags = Array.isArray(row.tags) && row.tags.every(tag => typeof tag === 'string')
    ? Object.freeze([...row.tags] as string[])
    : null
  if (
    !Number.isSafeInteger(id) || id < 1
    || typeof row.title !== 'string'
    || typeof row.url !== 'string'
    || typeof row.operator_name !== 'string'
    || typeof row.description !== 'string'
    || !CATEGORY_SET.has(String(row.category))
    || !rowTags
    || !submittedAt
    || ((residentId === null) !== (residentHandle === null))
  ) throw new Error('invalid community tool queue row')
  return Object.freeze({
    id,
    title: row.title,
    url: row.url,
    operator: row.operator_name,
    description: row.description,
    resident: residentId === null
      ? null
      : Object.freeze({ id: residentId, handle: residentHandle! }),
    category: row.category as CommunityToolCategory,
    tags: rowTags,
    submittedAt,
  })
}

export async function readCommunityToolQueue(
  query: CommunityToolSubmissionQuery,
): Promise<CommunityToolQueue> {
  const [waitingCount, rows] = await Promise.all([
    readCommunityToolWaitingCount(query),
    query(`
      /* community-tools:operator-queue */
      SELECT submission.id, submission.title, submission.url,
        submission.operator_name, submission.description, submission.resident_id,
        resident.handle AS resident_handle, submission.category, submission.tags,
        submission.created_at
      FROM community_tool_submissions submission
      LEFT JOIN residents resident ON resident.id = submission.resident_id
      WHERE submission.reviewed_at IS NULL
      ORDER BY submission.id DESC
      LIMIT 200
    `, []),
  ])
  return Object.freeze({
    waitingCount,
    submissions: Object.freeze(rows.map(queuedSubmission)),
  })
}

export async function reviewCommunityToolSubmission(
  query: CommunityToolSubmissionQuery,
  submissionId: number,
  founderId: number,
  reviewOutcome: CommunityToolReviewOutcome,
): Promise<CommunityToolReviewResult> {
  const id = positiveId(submissionId)
  const reviewer = positiveId(founderId)
  if (id === null || reviewer === null || !['listed', 'declined'].includes(reviewOutcome)) {
    throw new TypeError('community tool review input is invalid')
  }
  const rows = await query(`
    /* community-tools:review */
    WITH reviewed AS (
      UPDATE community_tool_submissions
      SET reviewed_at = clock_timestamp(), reviewed_by = $2::integer,
        review_outcome = $3::text
      WHERE id = $1::bigint AND reviewed_at IS NULL
      RETURNING review_outcome
    )
    SELECT 'reviewed'::text AS outcome, review_outcome FROM reviewed
    UNION ALL
    SELECT 'already_reviewed'::text AS outcome, review_outcome
    FROM community_tool_submissions
    WHERE id = $1::bigint AND reviewed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM reviewed)
    LIMIT 1
  `, [id, reviewer, reviewOutcome])
  if (rows.length === 0) return Object.freeze({ outcome: 'not_found', reviewOutcome: null })
  const outcome = rows[0]?.outcome
  const storedOutcome = rows[0]?.review_outcome
  if (
    !['reviewed', 'already_reviewed'].includes(String(outcome))
    || !['listed', 'declined'].includes(String(storedOutcome))
  ) throw new Error('community tool review result is unavailable')
  return Object.freeze({
    outcome: outcome as 'reviewed' | 'already_reviewed',
    reviewOutcome: storedOutcome as CommunityToolReviewOutcome,
  })
}
