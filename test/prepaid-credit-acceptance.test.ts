import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { splitSqlStatements } from '../scripts/migrate.ts'
import { readDirTree as readDirTreeFrom } from './helpers/read-dir-tree.ts'

const read = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
)

const readDirTree = (relativeDir: string): string => readDirTreeFrom(relativeDir, import.meta.url)

const readIfPresent = (relativePath: string): string => {
  try {
    return read(relativePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

const schemaDdl = read('../db/schema.sql')
const prepaidMigrationPath = new URL(
  '../db/migrations/20260826_prepaid_city_credit.sql',
  import.meta.url,
)
const prepaidMigrationDdl = readIfPresent('../db/migrations/20260826_prepaid_city_credit.sql')
const prepaidSource = readIfPresent('../src/prepaid-credit.ts')
const cityCreditSource = read('../src/city-credit.ts')
const indexSource = read('../src/index.ts')
const mcpSource = read('../src/mcp.ts')
const frontDoor = read('../src/frontdoor.txt')
const llms = read('../src/llms.txt')
const generatedDoor = read('../src/door.ts')
const publishedFrontDoor = read('../docs/published/FRONTDOOR.md')
const systemDesign = read('../docs/SYSTEM_DESIGN.md')
const decisions = read('../docs/DECISIONS.md')
const architecture = read('../docs/ARCHITECTURE.md')
const prd = read('../docs/PRD.md')
const environmentRunbook = read('../docs/runbooks/ENVIRONMENT.md')
const legal = read('../src/legal.ts')

type PrepaidCreditModule = Readonly<{
  parseCreditDollars(value: unknown): bigint
  parseGiftClaimToken(value: unknown): string
}>

async function loadPrepaidCredit(): Promise<PrepaidCreditModule> {
  const moduleUrl = new URL('../src/prepaid-credit.ts', import.meta.url).href
  return await import(moduleUrl) as PrepaidCreditModule
}

function tableStatement(ddl: string, name: string): string {
  const statement = splitSqlStatements(ddl).find(candidate => (
    new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b`, 'iu').test(candidate)
  ))
  assert.ok(statement, `missing ${name}`)
  return statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()
}

function routeSource(method: 'get' | 'post', path: string): string {
  const start = indexSource.indexOf(`app.${method}('${path}'`)
  assert.ok(start >= 0, `${method.toUpperCase()} ${path} is missing`)
  const end = indexSource.indexOf('\napp.', start + 10)
  return indexSource.slice(start, end < 0 ? undefined : end)
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

test('whole-dollar credit parsing is exact and never rounds', async () => {
  const { parseCreditDollars } = await loadPrepaidCredit()

  assert.equal(parseCreditDollars('1'), 1_000_000n)
  assert.equal(parseCreditDollars('3'), 3_000_000n)
  assert.equal(parseCreditDollars(12), 12_000_000n)

  for (const value of [
    '', '0', '-1', '01', '1.0', '1.00', '1.5', ' 2', '2 ', 0, -1, 1.5,
    Number.NaN, Number.POSITIVE_INFINITY, {}, null,
  ]) {
    assert.throws(
      () => parseCreditDollars(value),
      /whole|dollar|positive|integer|exact/iu,
      `must reject ${String(value)} instead of rounding it`,
    )
  }
})

test('gift claim tokens are bounded opaque credentials, not resident keys or free text', async () => {
  const { parseGiftClaimToken } = await loadPrepaidCredit()
  const token = `gift_claim_${'ab'.repeat(32)}`

  assert.equal(parseGiftClaimToken(token), token)
  for (const value of [
    '', 'short', `1f3d9_sk_${'ab'.repeat(24)}`, 'gift claim with spaces',
    'gift_claim_line\nbreak', {}, null,
  ]) {
    assert.throws(() => parseGiftClaimToken(value), /gift|claim|token|credential/iu)
  }
})

test('the additive schema stores variable exact purchases and durable gift receipts', () => {
  assert.equal(
    existsSync(prepaidMigrationPath),
    true,
    'add db/migrations/20260826_prepaid_city_credit.sql',
  )
  assert.match(prepaidMigrationDdl, /^BEGIN;/u)
  assert.match(prepaidMigrationDdl, /COMMIT;\s*$/u)

  const freshEntries = tableStatement(schemaDdl, 'city_credit_entries')
  assert.match(prepaidMigrationDdl, /ALTER\s+TABLE\s+city_credit_entries/iu)
  assert.doesNotMatch(prepaidMigrationDdl, /DROP\s+TABLE[\s\S]{0,120}city_credit/iu)
  assert.match(freshEntries, /amount_units\s+BIGINT\s+NOT\s+NULL/iu, 'fresh schema: integer units only')

  for (const [name, entries] of [
    ['fresh schema', freshEntries],
    ['additive migration', prepaidMigrationDdl],
  ] as const) {
    assert.match(entries, /entry_kind[\s\S]*'purchase'/iu, `${name}: purchase receipt kind`)
    for (const receiptKind of [
      'gift_pending', 'gift_accept', 'gift_refuse', 'gift_redirect', 'spend', 'return',
    ]) {
      assert.match(entries, new RegExp(`'${receiptKind}'`, 'u'), `${name}: ${receiptKind} receipt kind`)
    }
    assert.match(entries, /amount_units\s*>\s*0/iu, `${name}: positive receipt amounts`)
    assert.match(
      entries,
      /(?:amount_units\s*%\s*1000000|mod\s*\(\s*amount_units\s*,\s*1000000\s*\))\s*=\s*0/iu,
      `${name}: whole-dollar exactness`,
    )
    assert.match(entries, /amount_units\s*=\s*1000000/iu, `${name}: historical fixed-dollar entries`)
    assert.doesNotMatch(
      entries,
      /amount_units\s+BIGINT\s+NOT\s+NULL\s+CHECK\s*\(\s*amount_units\s*=\s*1000000\s*\)/iu,
      `${name}: purchases and gift receipts are not globally fixed to one dollar`,
    )
    assert.doesNotMatch(entries, /\b(?:expires_at|expiry|deadline_at)\b/iu, `${name}: receipts never expire`)
  }

  for (const [name, ddl] of [
    ['fresh schema', schemaDdl],
    ['additive migration', prepaidMigrationDdl],
  ] as const) {
    const gifts = tableStatement(ddl, 'city_credit_gifts')

    assert.match(gifts, /\bpublic_id\b[\s\S]{0,220}\^?city_gift_/iu, `${name}: opaque resident-facing gift id`)
    assert.match(gifts, /\brecipient_id\b/iu, `${name}: recipient binding`)
    assert.match(gifts, /\bamount_units\b/iu, `${name}: exact gift amount`)
    assert.match(gifts, /\bsource_entry_id\b/iu, `${name}: purchase receipt binding`)
    assert.match(gifts, /\bclaim_token_hash\b/iu, `${name}: only a protected claim token is stored`)
    assert.match(gifts, /\bstatus\b[\s\S]*'pending'[\s\S]*'accepted'[\s\S]*'refused'/iu)
    assert.doesNotMatch(gifts, /\b(?:expires_at|expiry|deadline_at)\b/iu, `${name}: gifts never expire`)
    assert.doesNotMatch(gifts, /\b(?:buyer_id|buyer_handle|payer_email|payer_name)\b/iu, `${name}: buyer anonymity`)
    assert.doesNotMatch(gifts, /\bclaim_token\s+TEXT\b/iu, `${name}: raw claim token is never stored`)
  }

  assert.match(schemaDdl, /city_credit_entries_source_key/iu)
  assert.match(schemaDdl, /UNIQUE[\s\S]{0,240}\bsource_key\b|source_key[\s\S]{0,240}UNIQUE/iu)
  assert.match(schemaDdl, /city_credit_entries_append_only/iu)
  assert.match(prepaidMigrationDdl, /balance_units\s*\+[\s\S]{0,120}>=\s*0/iu)
})

test('/api/me exposes pending gifts and sanitized durable receipts only to that resident', () => {
  const meRoute = routeSource('get', '/api/me')
  const privateImplementation = `${meRoute}\n${cityCreditSource}\n${prepaidSource}`

  assert.match(meRoute, /privateResidentHeaders/iu)
  assert.match(meRoute, /resident\.id/iu)
  assert.match(meRoute, /pending_gifts/iu)
  assert.match(meRoute, /before_gift_id/iu)
  assert.match(meRoute, /gift_limit/iu)
  assert.match(meRoute, /pending_gifts:\s*pendingCreditGifts\.page/iu)
  assert.match(meRoute, /receipts/iu)
  assert.match(privateImplementation, /gift_pending/iu)
  assert.match(privateImplementation, /gift_accept/iu)
  assert.match(privateImplementation, /gift_refuse/iu)
  assert.match(privateImplementation, /gift_redirect/iu)
  assert.match(privateImplementation, /purchase/iu)
  assert.match(privateImplementation, /return/iu)
  assert.doesNotMatch(
    meRoute,
    /["']?(?:buyer_id|buyer_handle|payer_email|payer_name|claim_token_hash)["']?\s*:/iu,
    'the /api/me response must not serialize purchaser or claim-token fields',
  )

  const meToolStart = mcpSource.indexOf("name: 'me'")
  assert.ok(meToolStart >= 0, 'MCP me tool is missing')
  const meToolEnd = mcpSource.indexOf("\n    name: '", meToolStart + 10)
  const meTool = mcpSource.slice(meToolStart, meToolEnd < 0 ? undefined : meToolEnd)
  assert.match(meTool, /pending gift/iu)
  assert.match(meTool, /receipt/iu)
  assert.match(meTool, /before_gift_id/iu)
  assert.match(meTool, /gift_limit/iu)

  const publicSources = [
    '../src/public-events.ts',
    '../src/public-map.ts',
    '../src/public-residents.ts',
    '../src/public-search.ts',
    '../src/public-snapshot-format.ts',
    '../src/window.ts',
    '../src/window-client.ts',
  ].map(read).join('\n') + '\n' + readDirTree('../src/window-client')
  assert.doesNotMatch(
    publicSources,
    /claim_token_hash|buyer_handle|payer_email|pending_gifts|city_credit_gifts/iu,
    'private gift and payment facts must stay out of every public projection',
  )
})

function startupProbe(overrides: Record<string, string | undefined>) {
  const projectRoot = new URL('..', import.meta.url)
  const script = String.raw`
    globalThis.fetch = async () => new Response(JSON.stringify({
      command: 'SELECT', rowCount: 0, fields: [], rows: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const { default: app } = await import('./src/index.ts')
    const [front, window, buy, buyReturn, allowanceReturn, giftRedirect] = await Promise.all([
      app.request('/'), app.request('/window'), app.request('/buy'),
      app.request('/buy?paypal=return&purchase_id=city_paypal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token=5O190127TN364715T'),
      app.request('/buy?paypal=allowance-return&purchase_id=city_paypal_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      app.request('/gift-redirect'),
    ])
    process.stdout.write(JSON.stringify({
      frontStatus: front.status,
      frontText: await front.text(),
      windowStatus: window.status,
      windowText: await window.text(),
      buyStatus: buy.status,
      buyText: await buy.text(),
      buyReturnStatus: buyReturn.status,
      buyReturnText: await buyReturn.text(),
      allowanceReturnStatus: allowanceReturn.status,
      allowanceReturnText: await allowanceReturn.text(),
      giftRedirectStatus: giftRedirect.status,
      giftRedirectText: await giftRedirect.text(),
    }))
  `
  const environment = { ...process.env }
  environment.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
  environment.PUBLIC_ORIGIN = 'https://1f3d9.com'
  environment.HOSTED_CHAT_SIGNIN_ENABLED = 'false'
  for (const name of [
    'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_ENV', 'PAYPAL_WEBHOOK_ID',
  ]) delete environment[name]
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name]
    else environment[name] = value
  }
  return spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

type BuyProbe = Readonly<{
  frontStatus: number
  frontText: string
  windowStatus: number
  windowText: string
  buyStatus: number
  buyText: string
  buyReturnStatus: number
  buyReturnText: string
  allowanceReturnStatus: number
  allowanceReturnText: string
  giftRedirectStatus: number
  giftRedirectText: string
}>

function probe(overrides: Record<string, string | undefined>): BuyProbe {
  const result = startupProbe(overrides)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as BuyProbe
}

const PAYPAL_UNAVAILABLE = 'Credit purchases are unavailable because PayPal is not configured. No payment was started. Ask the city owner to connect PayPal.'
const READY_PAYPAL = Object.freeze({
  PAYPAL_CLIENT_ID: 'sandbox-client-id',
  PAYPAL_CLIENT_SECRET: 'sandbox-client-secret',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_WEBHOOK_ID: 'sandbox-webhook-id',
})

test('the dormant buy page is an honest 503 and is absent from public discovery', () => {
  const incomplete = [
    {},
    ...Object.keys(READY_PAYPAL).map(missing => Object.fromEntries(
      Object.entries(READY_PAYPAL).filter(([name]) => name !== missing),
    )),
    { ...READY_PAYPAL, PAYPAL_ENV: 'production' },
  ]

  for (const environment of incomplete) {
    const result = probe(environment)
    assert.equal(result.frontStatus, 200)
    assert.equal(result.windowStatus, 200)
    assert.equal(result.buyStatus, 503)
    assert.equal(result.buyReturnStatus, 503)
    assert.equal(result.allowanceReturnStatus, 503)
    assert.equal(result.giftRedirectStatus, 200)
    assert.match(result.giftRedirectText, /redirect/iu)
    assert.doesNotMatch(result.giftRedirectText, /PAYPAL_CLIENT|paypal\/orders/iu)
    assert.ok(result.buyText.includes(PAYPAL_UNAVAILABLE), result.buyText)
    for (const continuationText of [result.buyReturnText, result.allowanceReturnText]) {
      assert.match(continuationText, /cannot be checked[\s\S]*keep this exact return URL/iu)
      assert.match(continuationText, /do not start or approve another payment/iu)
      assert.doesNotMatch(continuationText, /no payment was started/iu)
    }
    assert.equal(result.frontText.includes('/buy'), false)
    assert.doesNotMatch(result.frontText, /PayPal|hosted[- ]purchase|weekly allowance/iu)
    assert.match(
      result.frontText,
      /verified payment notice[\s\S]{0,180}open dispute[\s\S]{0,180}gift[\s\S]{0,180}frozen/iu,
    )
    assert.equal(result.windowText.includes('href="/buy"'), false)
  }
})

test('complete PayPal configuration adds quiet buy links to each public door', () => {
  for (const paypalEnvironment of ['sandbox', 'live'] as const) {
    const result = probe({ ...READY_PAYPAL, PAYPAL_ENV: paypalEnvironment })
    assert.equal(result.buyStatus, 200, result.buyText)
    assert.equal(countMatches(result.frontText, /\/buy\b/gu), 1)
    // The window carries exactly two: one header button, one footer link.
    assert.equal(countMatches(result.windowText, /href="\/buy"/gu), 2)
    assert.match(result.frontText, /fund a\s+resident's fee credit at \/buy\. The hosted purchase door is available\./u)
    assert.match(result.frontText, /report illegal public content with POST \/api\/flag/iu)
    assert.doesNotMatch(result.frontText, /PREPAID FEE CREDIT\s*-{3,}/u)
    assert.match(result.windowText, /credit/iu)
    assert.match(result.buyText, /resident (?:number|#)/iu)
    assert.match(result.buyText, /handle/iu)
    assert.match(result.buyText, /confirm/iu)
    assert.match(result.buyText, /PayPal/iu)
    assert.doesNotMatch(result.buyText, /card number|security code|\bCVV\b|\bCVC\b/iu)
  }
})

test('all resident-facing contract mirrors carry the consultation promises', () => {
  const row40 = decisions.split(/\r?\n/u).find(line => /^\|\s*40\s*\|/u.test(line)) ?? ''
  const row41 = decisions.split(/\r?\n/u).find(line => /^\|\s*41\s*\|/u.test(line)) ?? ''
  assert.match(row40, /SUPERSEDED/iu)
  assert.match(row41, /SUPERSEDED/iu)
  assert.match(
    decisions,
    /unlocked by the owner 2026-08-26, resident consultation notes #7568-#7748/iu,
  )

  const fullContract = `${decisions}\n${systemDesign}`
  for (const [label, pattern] of [
    ['credit purchase', /purchase/iu],
    ['exact units', /whole dollar|exact dollar|no round|never round/iu],
    ['no expiry', /never expire|no expiry/iu],
    ['nonnegative balance', /never (?:go )?negative|nonnegative/iu],
    ['recipient acceptance', /gift[\s\S]{0,320}accept/iu],
    ['recipient refusal', /refus/iu],
    ['buyer redirect', /redirect/iu],
    ['buyer privacy', /(?:buyer|purchaser)[\s\S]{0,180}(?:private|hidden|never exposed|not exposed)/iu],
    ['durable receipts', /receipt/iu],
    ['existing crypto rail', /x402|crypto/iu],
  ] as const) assert.match(fullContract, pattern, `decisions/system design: ${label}`)

  for (const [name, text] of [
    ['llms.txt', llms],
    ['MCP descriptions', mcpSource],
  ] as const) {
    assert.match(text, /purchase/iu, `${name}: credit purchase`)
    assert.match(text, /whole dollar|exact dollar|no round|never round/iu, `${name}: exact units`)
    assert.match(text, /never expire|no expiry/iu, `${name}: no expiry`)
    assert.match(text, /gift[\s\S]{0,320}accept/iu, `${name}: recipient acceptance`)
    assert.match(text, /refus/iu, `${name}: recipient refusal`)
    assert.match(text, /redirect/iu, `${name}: buyer redirect`)
    assert.match(text, /receipt/iu, `${name}: durable receipts`)
    assert.match(text, /x402|crypto/iu, `${name}: existing crypto rail`)
  }
  assert.match(llms, /gift redirect[\s\S]{0,240}30[\s\S]{0,120}(?:caller|hour)/iu)
  assert.match(systemDesign, /gift redirect[\s\S]{0,240}30[\s\S]{0,120}(?:caller|hour)/iu)

  assert.match(architecture, /append-only|durable[\s\S]{0,120}receipt/iu)
  assert.match(architecture, /nonnegative/iu)
  assert.match(architecture, /never expire|no expiry/iu)
  assert.match(architecture, /(?:buyer|purchaser)[\s\S]{0,180}(?:private|hidden|never exposed|not exposed)/iu)
  assert.match(prd, /prepaid[\s\S]{0,160}(?:credit|fee)|(?:credit|fee)[\s\S]{0,160}prepaid/iu)
  assert.match(prd, /gift[\s\S]{0,320}accept/iu)
  assert.match(prd, /x402/iu)

  for (const [name, text] of [
    ['front door', frontDoor],
    ['generated door', generatedDoor],
    ['published front door', publishedFrontDoor],
  ] as const) {
    assert.match(text, /purchase|\/buy/iu, `${name}: actionable prepaid credit`)
    assert.match(text, /gift[\s\S]{0,320}accept/iu, `${name}: gift acceptance`)
    assert.match(text, /redirect[\s\S]{0,240}30[\s\S]{0,120}(?:caller|hour)/iu,
      `${name}: redirect rate contract`)
    assert.doesNotMatch(text, /founder-issued city fee credit is one fixed \$1|only the founder (?:creates|can issue)/iu)
  }

  assert.match(environmentRunbook, /PAYPAL_CLIENT_ID/iu)
  assert.match(environmentRunbook, /PAYPAL_CLIENT_SECRET/iu)
  assert.match(environmentRunbook, /PAYPAL_ENV[\s\S]{0,120}sandbox[\s\S]{0,80}live/iu)
  assert.match(environmentRunbook, /PAYPAL_WEBHOOK_ID/iu)
  assert.match(environmentRunbook,
    /CONFIRM_PREPAID_CITY_CREDIT=INSTALL_PREPAID_CITY_CREDIT_AND_PAYPAL_CUSTODY/iu)
  assert.match(environmentRunbook, /CONFIRM_PREVIEW_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW[\s\S]{0,120}npm run migrate:preview:prepaid-city-credit/iu)
  assert.match(environmentRunbook, /CONFIRM_PRODUCTION_MIGRATION=APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION[\s\S]{0,120}npm run migrate:production:prepaid-city-credit/iu)
  assert.match(legal, /PayPal[\s\S]{0,300}(?:card|payment data)[\s\S]{0,300}(?:not|never)[\s\S]{0,120}(?:store|public)/iu)

})
