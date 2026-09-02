import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  COMMUNITY_TOOL_CATEGORIES,
  COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY,
  parseCommunityToolSubmission,
  readCommunityToolQueue,
  readCommunityToolWaitingCount,
  reviewCommunityToolSubmission,
  submitCommunityTool,
  type CommunityToolSubmissionQuery,
} from '../src/community-tool-submissions.ts'

const validFields = () => new URLSearchParams({
  csrf: 'a'.repeat(64),
  title: 'Pocket city atlas',
  url: 'https://tools.example/atlas',
  operator: 'Lantern Workshop',
  description: 'Finds public places by their street names.',
  resident_id: '46',
  category: COMMUNITY_TOOL_CATEGORIES[0],
  tags: 'maps, streets, public records',
  confirmation: 'confirmed',
  website: '',
})

test('community tool validation accepts only the small public form contract', () => {
  const parsed = parseCommunityToolSubmission(validFields())
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.value, {
    title: 'Pocket city atlas',
    url: 'https://tools.example/atlas',
    operator: 'Lantern Workshop',
    description: 'Finds public places by their street names.',
    residentId: 46,
    category: COMMUNITY_TOOL_CATEGORIES[0],
    tags: ['maps', 'streets', 'public records'],
  })
})

test('community tool validation refuses every unsupported or unsafe shape in caller words', () => {
  const cases: ReadonlyArray<readonly [string, (fields: URLSearchParams) => void, RegExp]> = [
    ['extra field', fields => fields.set('email', 'person@example.com'), /unexpected information.*return to \/tools/iu],
    ['non-HTTPS URL', fields => fields.set('url', 'http://tools.example'), /https link.*try again/iu],
    ['multi-line description', fields => fields.set('description', 'one\ntwo'), /one line.*try again/iu],
    ['unknown resident', fields => fields.set('resident_id', 'not-a-number'), /resident.*list.*try again/iu],
    ['unknown category', fields => fields.set('category', 'secret'), /category.*list.*try again/iu],
    ['too many tags', fields => fields.set('tags', 'one,two,three,four,five,six'), /up to 5.*try again/iu],
    ['missing confirmation', fields => fields.delete('confirmation'), /confirm.*safe.*permission.*try again/iu],
  ]
  for (const [name, change, message] of cases) {
    const fields = validFields()
    change(fields)
    const parsed = parseCommunityToolSubmission(fields)
    assert.equal(parsed.ok, false, name)
    if (!parsed.ok) assert.match(parsed.message, message, name)
  }
})

test('the hidden honeypot refuses bots before any database work', () => {
  const fields = validFields()
  fields.set('website', 'https://spam.example')
  const parsed = parseCommunityToolSubmission(fields)
  assert.deepEqual(parsed, {
    ok: false,
    reason: 'honeypot',
    message: 'That submission looked automated, so it was not saved. Clear the hidden website field and try again from /tools.',
  })
})

test('the queue admits three submissions per address per UTC day and explains the fourth', async () => {
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  const query: CommunityToolSubmissionQuery = async (text, params) => {
    calls.push({ text, params })
    return [{ outcome: calls.length <= COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY ? 'queued' : 'rate_limited' }]
  }
  const parsed = parseCommunityToolSubmission(validFields())
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return

  for (let attempt = 1; attempt <= COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY; attempt += 1) {
    assert.deepEqual(await submitCommunityTool(query, parsed.value, 'b'.repeat(64)), { outcome: 'queued' })
  }
  assert.deepEqual(await submitCommunityTool(query, parsed.value, 'b'.repeat(64)), { outcome: 'rate_limited' })
  assert.equal(calls.length, COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY + 1)
  assert.match(calls[0]!.text, /community_tool_submission_limits/iu)
  assert.match(calls[0]!.text, /community_tool_submissions/iu)
  assert.ok(calls.every(call => call.params.includes(COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY)))
})

test('the operator queue returns reviewed fields without the submitter address hash', async () => {
  const query: CommunityToolSubmissionQuery = async text => {
    if (text.includes('waiting-count')) return [{ count: 2 }]
    if (text.includes('operator-queue')) return [{
      id: 9,
      title: 'Pocket city atlas',
      url: 'https://tools.example/atlas',
      operator_name: 'Lantern Workshop',
      description: 'Finds public places by their street names.',
      resident_id: 46,
      resident_handle: 'solward',
      category: 'Browse',
      tags: ['maps', 'streets'],
      created_at: '2026-09-01T20:00:00.000Z',
      submitter_ip_hash: 'b'.repeat(64),
    }]
    throw new Error('unexpected query')
  }

  assert.equal(await readCommunityToolWaitingCount(query), 2)
  const queue = await readCommunityToolQueue(query)
  assert.deepEqual(queue, {
    waitingCount: 2,
    submissions: [{
      id: 9,
      title: 'Pocket city atlas',
      url: 'https://tools.example/atlas',
      operator: 'Lantern Workshop',
      description: 'Finds public places by their street names.',
      resident: { id: 46, handle: 'solward' },
      category: 'Browse',
      tags: ['maps', 'streets'],
      submittedAt: '2026-09-01T20:00:00.000Z',
    }],
  })
  assert.equal(JSON.stringify(queue).includes('submitter_ip_hash'), false)
})

test('operator review is retry-safe and distinguishes a missing submission', async () => {
  const query: CommunityToolSubmissionQuery = async (_text, params) => {
    if (params[0] === 9) return [{ outcome: 'reviewed', review_outcome: 'listed' }]
    if (params[0] === 10) return [{ outcome: 'already_reviewed', review_outcome: 'declined' }]
    return []
  }
  assert.deepEqual(await reviewCommunityToolSubmission(query, 9, 1, 'listed'), {
    outcome: 'reviewed', reviewOutcome: 'listed',
  })
  assert.deepEqual(await reviewCommunityToolSubmission(query, 10, 1, 'declined'), {
    outcome: 'already_reviewed', reviewOutcome: 'declined',
  })
  assert.deepEqual(await reviewCommunityToolSubmission(query, 11, 1, 'listed'), {
    outcome: 'not_found', reviewOutcome: null,
  })
  await assert.rejects(reviewCommunityToolSubmission(query, 0, 1, 'listed'), /review input is invalid/iu)
})

test('the queue stays a founder-root-key REST power and is absent from MCP', () => {
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const mcpSource = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8')
  for (const routePattern of [
    /app\.get\('\/api\/founder\/community-tool-submissions'[\s\S]{0,600}authRootKey[\s\S]{0,600}founder\.id !== 1/u,
    /app\.post\('\/api\/founder\/community-tool-submissions\/:id\/review'[\s\S]{0,700}authRootKey[\s\S]{0,700}founder\.id !== 1/u,
  ]) assert.match(indexSource, routePattern)
  assert.match(indexSource, /COMMUNITY_TOOL_REVIEW_BODY_BYTES = 256/u)
  assert.match(indexSource, /community-tool-submissions\/:id\/review'[\s\S]{0,2000}application\/json community tool review body/u)
  assert.doesNotMatch(mcpSource, /name:\s*['"][^'"]*community.tool/iu)
})
