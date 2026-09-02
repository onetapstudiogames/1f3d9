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

test('community tool validation refuses every unsupported or unsafe shape in caller words', async t => {
  const cases: ReadonlyArray<readonly [string, (fields: URLSearchParams) => void, RegExp]> = [
    ['extra field', fields => fields.set('email', 'person@example.com'), /unexpected information.*return to \/tools/iu],
    ['non-HTTPS URL', fields => fields.set('url', 'http://tools.example'), /https link.*try again/iu],
    ['localhost URL', fields => fields.set('url', 'https://localhost/tool'), /public https link.*public host.*try again/iu],
    ['loopback URL', fields => fields.set('url', 'https://127.0.0.1/tool'), /public https link.*public host.*try again/iu],
    ['link-local URL', fields => fields.set('url', 'https://169.254.169.254/latest/meta-data'), /public https link.*public host.*try again/iu],
    ['10/8 URL', fields => fields.set('url', 'https://10.0.0.1/tool'), /public https link.*public host.*try again/iu],
    ['172.16/12 lower URL', fields => fields.set('url', 'https://172.16.0.1/tool'), /public https link.*public host.*try again/iu],
    ['172.16/12 upper URL', fields => fields.set('url', 'https://172.31.255.255/tool'), /public https link.*public host.*try again/iu],
    ['192.168/16 URL', fields => fields.set('url', 'https://192.168.1.1/tool'), /public https link.*public host.*try again/iu],
    ['dot-local URL', fields => fields.set('url', 'https://printer.local/tool'), /public https link.*public host.*try again/iu],
    ['internal DNS URL', fields => fields.set('url', 'https://metadata.google.internal/tool'), /public https link.*public host.*try again/iu],
    ['LAN DNS URL', fields => fields.set('url', 'https://router.lan/tool'), /public https link.*public host.*try again/iu],
    ['home ARPA URL', fields => fields.set('url', 'https://server.home.arpa/tool'), /public https link.*public host.*try again/iu],
    ['bare home ARPA URL', fields => fields.set('url', 'https://home.arpa/tool'), /public https link.*public host.*try again/iu],
    ['localdomain URL', fields => fields.set('url', 'https://localhost.localdomain/tool'), /public https link.*public host.*try again/iu],
    ['embedded private IPv4 URL', fields => fields.set('url', 'https://127.0.0.1.nip.io/tool'), /public https link.*public host.*try again/iu],
    ['dash-embedded private IPv4 URL', fields => fields.set('url', 'https://127-0-0-1.nip.io/tool'), /public https link.*public host.*try again/iu],
    ['public bare IPv4 URL', fields => fields.set('url', 'https://8.8.8.8/tool'), /public https link.*public host.*try again/iu],
    ['bare IPv6 URL', fields => fields.set('url', 'https://[::1]/tool'), /public https link.*public host.*try again/iu],
    ['title tab', fields => fields.set('title', 'Pocket\tcity atlas'), /title.*one line.*try again/iu],
    ['title newline', fields => fields.set('title', 'Pocket\ncity atlas'), /title.*one line.*try again/iu],
    ['operator tab', fields => fields.set('operator', 'Lantern\tWorkshop'), /runs.*one line.*try again/iu],
    ['operator newline', fields => fields.set('operator', 'Lantern\nWorkshop'), /runs.*one line.*try again/iu],
    ['multi-line description', fields => fields.set('description', 'one\ntwo'), /one line.*try again/iu],
    ['unknown resident', fields => fields.set('resident_id', 'not-a-number'), /resident.*list.*try again/iu],
    ['unknown category', fields => fields.set('category', 'secret'), /category.*list.*try again/iu],
    ['too many tags', fields => fields.set('tags', 'one,two,three,four,five,six'), /up to 5.*try again/iu],
    ['missing confirmation', fields => fields.delete('confirmation'), /confirm.*safe.*permission.*try again/iu],
  ]
  for (const [name, change, message] of cases) {
    await t.test(name, () => {
      const fields = validFields()
      change(fields)
      const parsed = parseCommunityToolSubmission(fields)
      assert.equal(parsed.ok, false)
      if (!parsed.ok) assert.match(parsed.message, message)
    })
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
      submitted_at: '2026-09-01T20:00:00.000Z',
    }],
  })
  assert.equal(JSON.stringify(queue).includes('submitter_ip_hash'), false)
})

test('operator review is retry-safe and distinguishes a missing submission', async () => {
  const reviewQueries: string[] = []
  const query: CommunityToolSubmissionQuery = async (text, params) => {
    reviewQueries.push(text)
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
  assert.ok(reviewQueries.every(text => /SET[\s\S]*submitter_ip_hash\s*=\s*NULL/iu.test(text)))
})

test('the community tool queue is absent from MCP', () => {
  const mcpSource = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(mcpSource, /name:\s*['"][^'"]*community.tool/iu)
})
