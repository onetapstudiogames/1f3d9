import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { Hono } from 'hono'
import { COMMUNITY_TOOL_CATEGORIES, type CommunityToolQueueResult } from '../src/community-tool-submissions.ts'
import { mountHumanPages } from '../src/human-pages.ts'

const pageState = { waitingCount: 7, residents: [{ id: 46, handle: 'solward' }] }
const COMMUNITY_TOOL_IP_HASH_KEY = '12'.repeat(32)
const RESIDENT_CLAIM_SENTENCE = 'A chosen resident is a self-reported claim that the maintainer checks before listing.'

function humanApp(outcome: CommunityToolQueueResult['outcome'] = 'queued') {
  const app = new Hono()
  mountHumanPages(app, {
    hostedChatSigninReady: () => true,
    publicOrigin: 'https://1f3d9.com',
    environment: {
      VERCEL: '1',
      COMMUNITY_TOOL_IP_HASH_KEY,
    },
    readCommunityToolsPageState: async () => pageState,
    submitCommunityTool: async () => ({ outcome }),
  })
  return app
}

async function formSession(app = humanApp()) {
  const response = await app.request('/tools')
  const html = await response.text()
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  const csrf = html.match(/name="csrf" value="([0-9a-f]{64})"/u)?.[1]
  assert.ok(cookie)
  assert.ok(csrf)
  return { app, cookie, csrf, html }
}

function validForm(csrf: string) {
  return new URLSearchParams({
    csrf,
    title: 'Pocket city atlas',
    url: 'https://tools.example/atlas',
    operator: 'Lantern Workshop',
    description: 'Finds public places by their street names.',
    resident_id: '46',
    category: COMMUNITY_TOOL_CATEGORIES[0],
    tags: 'maps, streets',
    confirmation: 'confirmed',
    website: '',
  })
}

test('/tools is only the searchable community list and its private queue form', async () => {
  const { html } = await formSession()
  assert.match(html, /7 submissions? (?:is|are) waiting for review/iu)
  assert.match(html, /name="search"/u)
  assert.match(html, /data-category-filter="Browse"/u)
  assert.match(html, /data-category="Browse"/u)
  assert.match(html, /class="community-tool-tag"[^>]*>public records</u)
  assert.match(html, /<script src="\/tools\.js" defer><\/script>/u)
  assert.doesNotMatch(html, /1f3d9\.com\/mcp|1f3ea\.com\/mcp|renderCityHelp/iu)

  for (const name of ['title', 'url', 'operator', 'description', 'resident_id', 'category', 'tags']) {
    assert.match(html, new RegExp(`name="${name}"`, 'u'), name)
  }
  assert.match(html, /<option value="46">solward \(resident #46\)<\/option>/u)
  assert.match(html, new RegExp(RESIDENT_CLAIM_SENTENCE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(html, /I confirm this tool is safe and that I made it or have permission to post it\./u)
  assert.doesNotMatch(html, /name="(?:email|real_name|account|contact)"/iu)
  assert.match(html, /3 submissions per address per UTC day/iu)
  assert.match(html, /https links only/iu)
  assert.match(html, /hidden spam check/iu)
  assert.match(html, /asks me, the maintainer, to list a tool[\s\S]*?not a city act/iu)
  assert.match(html, /humans still watch through the glass/iu)
})

test('a trusted, cookie-bound form queues once and prints the new exact waiting count', async () => {
  let waitingCount = 7
  const app = new Hono()
  mountHumanPages(app, {
    publicOrigin: 'https://1f3d9.com',
    environment: {
      VERCEL: '1',
      COMMUNITY_TOOL_IP_HASH_KEY,
    },
    readCommunityToolsPageState: async () => ({ ...pageState, waitingCount }),
    submitCommunityTool: async () => {
      waitingCount += 1
      return { outcome: 'queued' }
    },
  })
  const session = await formSession(app)
  const response = await app.request('/tools', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://1f3d9.com',
      cookie: session.cookie,
    },
    body: validForm(session.csrf).toString(),
  })
  const html = await response.text()
  assert.equal(response.status, 201)
  assert.match(html, /submission is waiting for review/iu)
  assert.match(html, /8 submissions? (?:is|are) waiting for review/iu)
  assert.doesNotMatch(html, /Pocket city atlas|tools\.example|maps, streets/iu)
})

test('the browser route uses a required server key for the submitter address hash', async () => {
  let receivedHash = ''
  const app = new Hono()
  mountHumanPages(app, {
    publicOrigin: 'https://1f3d9.com',
    environment: {
      VERCEL: '1',
      COMMUNITY_TOOL_IP_HASH_KEY,
    },
    readCommunityToolsPageState: async () => pageState,
    submitCommunityTool: async (_submission, ipHash) => {
      receivedHash = ipHash
      return { outcome: 'queued' }
    },
  })
  const session = await formSession(app)
  const response = await app.request('/tools', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://1f3d9.com',
      cookie: session.cookie,
      'x-vercel-forwarded-for': '198.51.100.7',
    },
    body: validForm(session.csrf).toString(),
  })
  assert.equal(response.status, 201)
  assert.equal(receivedHash, createHmac(
    'sha256',
    Buffer.from(COMMUNITY_TOOL_IP_HASH_KEY, 'hex'),
  ).update('community-tool:ip:198.51.100.7', 'utf8').digest('hex'))
})

test('the browser route saves nothing when the address-hash key is missing or malformed', async () => {
  for (const [name, key] of [['missing', undefined], ['malformed', '1'.repeat(63)]] as const) {
    let submitted = false
    const app = new Hono()
    mountHumanPages(app, {
      publicOrigin: 'https://1f3d9.com',
      environment: { VERCEL: '1', COMMUNITY_TOOL_IP_HASH_KEY: key },
      readCommunityToolsPageState: async () => pageState,
      submitCommunityTool: async () => {
        submitted = true
        return { outcome: 'queued' }
      },
    })
    const session = await formSession(app)
    const response = await app.request('/tools', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://1f3d9.com',
        cookie: session.cookie,
        'x-vercel-forwarded-for': '198.51.100.8',
      },
      body: validForm(session.csrf).toString(),
    })
    assert.equal(response.status, 503, name)
    assert.equal(submitted, false, name)
    assert.match(await response.text(), /could not save.*not in the queue/iu, name)
  }
})

test('the browser route explains origin, CSRF, validation, honeypot, resident, and daily-limit refusals', async () => {
  const cases: ReadonlyArray<Readonly<{
    name: string
    outcome?: CommunityToolQueueResult['outcome']
    change?: (form: URLSearchParams) => void
    origin?: string
    cookie?: string
    status: number
    message: RegExp
  }>> = [
    { name: 'origin', origin: 'https://other.example', status: 403, message: /did not come from 1F3D9.*return to \/tools/iu },
    { name: 'csrf', change: form => form.set('csrf', '0'.repeat(64)), status: 403, message: /form and private browser cookie did not match.*return to \/tools/iu },
    { name: 'validation', change: form => form.set('url', 'http://unsafe.example'), status: 400, message: /https link.*try again/iu },
    { name: 'honeypot', change: form => form.set('website', 'spam'), status: 400, message: /looked automated.*not saved/iu },
    { name: 'resident', outcome: 'resident_not_found', status: 409, message: /resident list changed.*choose again/iu },
    { name: 'limit', outcome: 'rate_limited', status: 429, message: /3 submissions.*UTC day.*try again/iu },
  ]
  for (const item of cases) {
    const session = await formSession(humanApp(item.outcome))
    const form = validForm(session.csrf)
    item.change?.(form)
    const response = await session.app.request('/tools', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: item.origin ?? 'https://1f3d9.com',
        cookie: session.cookie,
      },
      body: form.toString(),
    })
    assert.equal(response.status, item.status, item.name)
    assert.match(await response.text(), item.message, item.name)
  }
})
