import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  auditRefusalCensus,
  discoverCandidates,
  discoverHttpBoundaries,
  discoverMcpBoundaries,
  discoverUnresolvedProducers,
  parseRefusalManifest,
  parseUnresolvedProducers,
} from '../scripts/check-refusal-census.ts'

const projectRoot = new URL('../', import.meta.url)
const auditText = readFileSync(
  new URL('../docs/audits/2026-09-refusal-census.md', import.meta.url),
  'utf8',
)

test('the refusal manifest has exact set equality with source producers', () => {
  const result = auditRefusalCensus(projectRoot, auditText)
  assert.deepEqual(result.errors, [])
  assert.equal(result.candidateKeys.size, result.manifestKeys.size)
  assert.deepEqual(
    parseUnresolvedProducers(auditText),
    discoverUnresolvedProducers(projectRoot),
  )
})

test('the source scan resolves constants, imported messages, templates, and local boundary helpers', () => {
  const candidates = discoverCandidates(projectRoot)
  const rows = (producer: string, finalText: string) => candidates.filter(row => (
    row.producer === producer && row.finalText === finalText
  ))

  const residentAuth = 'resident sign-in failed because Authorization: Bearer is missing or does not contain a current city key; send your saved current key as Authorization: Bearer <key>'
  assert.ok(rows('src/actions.ts', residentAuth).length > 0)
  assert.ok(rows(
    'src/paypal-credit-routes.ts',
    'Credit purchases are unavailable because PayPal is not configured. No payment was started. Ask the city owner to connect PayPal.',
  ).length > 0)
  assert.ok(rows(
    'src/crafting.ts',
    'the world is transit only; move through it, claim a frontier continent, or use an owned place instead',
  ).length > 0)
  assert.ok(rows(
    'src/agreement-action.ts',
    '5 agreement actions per UTC day; retry after the next UTC day begins',
  ).length > 0)
  assert.ok(rows(
    'src/gazette-reading.ts',
    'Gazette issue number must be a positive integer',
  ).length === 2)
  assert.ok(rows(
    'src/gazette-reading.ts',
    'Gazette issue_number ${issueNumber} was not found; use GET /api/gazette and send a current issue_number',
  ).length === 2)
  assert.ok(rows(
    'src/world-market.ts',
    `${residentAuth}, then move into the city before paying`,
  ).length > 0)
  assert.equal(candidates.some(row => row.finalText.includes('${RESIDENT_AUTH_REFUSAL}')), false)
  assert.equal(candidates.some(row => row.finalText.includes('resident handle  was not found')), false)
  assert.ok(candidates.some(row => row.finalText.includes(
    'You are at the public 1F3D9 MCP door: ${publicOrigin()}/mcp.',
  )))
  assert.ok(candidates.some(row => row.finalText.includes(
    'Wrong 1F3D9 connector address. ${publicOrigin()}/mcp is only for key-capable local clients.',
  )))
})

test('the source scan follows typed error builders whose result is thrown', () => {
  const candidates = discoverCandidates(projectRoot)
  const rows = candidates.filter(row => row.producer === 'src/note-action.ts')

  for (const expected of [
    {
      status: '404',
      finalText: 'Gazette submission note #${target} was not found in room #454; freshly browse view=gazette and use a current note id from submission room #454',
    },
    {
      status: '409',
      finalText: 'Gazette submission note #${target} was already withdrawn by its author; choose another active submission because withdrawal is permanent',
    },
  ]) {
    assert.ok(rows.some(row => (
      row.adapter === 'EngineError returned builder adapter'
      && row.status === expected.status
      && row.finalText === expected.finalText
    )), expected.finalText)
  }
})

test('the source scan covers every branch of function and arrow typed error builders', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'refusal-builder-census-'))
  mkdirSync(join(fixtureRoot, 'src'))
  writeFileSync(join(fixtureRoot, 'src', 'fixture.ts'), `
    class EngineError extends Error {
      constructor(readonly status: number, message: string) { super(message) }
    }
    class RouteFailure extends Error {
      constructor(readonly status: number, message: string) { super(message) }
    }
    function engineBuilder(kind: string): EngineError | null {
      if (kind === 'missing') return new EngineError(404, 'fixture engine missing')
      if (kind === 'busy') return new EngineError(409, \`fixture engine \${kind}\`)
      if (kind === 'runtime') return new EngineError(400, String(kind))
      return null
    }
    const routeBuilder = () => new RouteFailure(503, 'fixture route unavailable')
    function aliasedBuilder(): EngineError {
      const refusal = new EngineError(409, 'fixture aliased builder refusal')
      return refusal
    }
    function sideValueBuilder(): EngineError {
      return new EngineError(418, 'fixture side value is not thrown')
    }
    export function throwEngine(kind: string): never {
      throw engineBuilder(kind) ?? new Error('fallback')
    }
    export function throwRoute(): never {
      throw routeBuilder()
    }
    export function throwAlias(): never {
      const refusal = aliasedBuilder()
      throw refusal
    }
    export function throwDifferentError(): never {
      throw new EngineError(sideValueBuilder().status, 'fixture different thrown refusal')
    }
  `)

  try {
    const fixtureUrl = new URL(`${pathToFileURL(fixtureRoot).href}/`)
    const candidates = discoverCandidates(fixtureUrl)
    assert.deepEqual(
      candidates.map(row => ({ adapter: row.adapter, status: row.status, text: row.finalText })),
      [
        { adapter: 'EngineError returned builder adapter', status: '404', text: 'fixture engine missing' },
        { adapter: 'EngineError returned builder adapter', status: '409', text: 'fixture engine ${kind}' },
        { adapter: 'RouteFailure returned builder adapter', status: '503', text: 'fixture route unavailable' },
        { adapter: 'EngineError returned builder adapter', status: '409', text: 'fixture aliased builder refusal' },
        { adapter: 'EngineError typed adapter', status: 'expression:sideValueBuilder().status', text: 'fixture different thrown refusal' },
      ],
    )
    assert.deepEqual(
      discoverUnresolvedProducers(fixtureUrl),
      ['src/fixture.ts::String(kind)::1'],
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('the source scan includes place lifecycle helper refusals added on main', () => {
  const worldTexts = new Set(
    discoverCandidates(projectRoot)
      .filter(row => row.producer === 'src/world.ts')
      .map(row => row.finalText),
  )
  for (const expected of [
    'place is protected and cannot be renamed, retired, or restored',
    'only the place owner may rename, retire, or restore it',
    'place is retired; restore it before renaming',
    'parent place is retired; restore it before restoring this place',
    "place is not empty: move or retire its ${facts.subplaceCount} ${plural(facts.subplaceCount, 'subplace')} first",
  ]) assert.ok(worldTexts.has(expected), expected)
  assert.equal([...worldTexts].some(text => /residents is|resident are/u.test(text)), false)
})

test('the refusal census covers every non-identity HTTP and MCP boundary', () => {
  const http = discoverHttpBoundaries(projectRoot)
  // Decision row 74 security fix: pair.ts is no longer excluded from this
  // census (see IDENTITY_MODULES in check-refusal-census.ts), so its two
  // POST /api/pair registrations -- mountPairRoutes and the new
  // mountPairDisabledRoute -- are now counted here too.
  assert.equal(http.registrations.length, 121)
  assert.deepEqual(http.globals, ['onError', 'notFound'])

  const mcp = discoverMcpBoundaries(projectRoot)
  assert.equal(mcp.tools.length, 41)
  assert.deepEqual(mcp.protocol, [
    'invalid-json',
    'invalid-message',
    'initialize',
    'ping',
    'tools/list',
    'method-not-found',
    'tool-not-found',
    'tool-arguments',
    'tool-forwarded-response',
  ])
})

test('included rows carry literal evidence and complete provenance', () => {
  const manifest = parseRefusalManifest(auditText)
  assert.ok(manifest.length > 0)

  for (const row of manifest) {
    assert.doesNotMatch(row.key, /^src\/[^:]+:\d+/u, `line number used as identity: ${row.key}`)
    assert.ok(row.producer.length > 0, `missing producer: ${row.key}`)
    assert.ok(row.adapter.length > 0, `missing adapter: ${row.key}`)
    assert.ok(row.finalBoundary.length > 0, `missing final boundary: ${row.key}`)

    if (row.disposition === 'included') {
      assert.match(row.status, /^(?:[1-5]\d\d|expression:)/u, `bad status: ${row.key}`)
      assert.ok(row.finalText.length > 0, `missing exact final text: ${row.key}`)
      assert.match(row.cause, /^(?:Yes|No)$/u, `cause not reviewed: ${row.key}`)
      assert.match(row.next, /^(?:Yes|No)$/u, `next step not reviewed: ${row.key}`)
      for (const [classification, evidence, label] of [
        [row.cause, row.causeEvidence, 'cause'],
        [row.next, row.nextEvidence, 'next step'],
      ] as const) {
        if (classification === 'Yes') {
          assert.ok(evidence.length > 0, `missing ${label} evidence: ${row.key}`)
          assert.ok(row.finalText.includes(evidence), `${label} is not literal: ${row.key}`)
          assert.notEqual(evidence, row.finalText, `${label} repeats full text: ${row.key}`)
        } else {
          assert.equal(evidence, '', `${label} evidence must be empty when classified No: ${row.key}`)
        }
      }
      if (row.cause === 'Yes' && row.next === 'Yes') {
        assert.notEqual(row.causeEvidence, row.nextEvidence, `cause and next evidence match: ${row.key}`)
      }
      assert.ok(row.testProof.length > 0, `missing test proof: ${row.key}`)
      assert.equal(row.exclusionReason, '')
    } else {
      assert.equal(row.cause, 'n/a')
      assert.equal(row.next, 'n/a')
      assert.ok(row.exclusionReason.length > 0, `missing exclusion reason: ${row.key}`)
      if (row.adapter === 'generic HTTP error adapter') {
        assert.equal(row.finalBoundary, 'HTTP onError -> 500 JSON')
      }
    }
  }
})

test('reviewed rows reject generated attestations and invented assertion paths', () => {
  const rows = parseRefusalManifest(auditText)
  const reviewed = rows.find(row => row.disposition === 'included' && row.testProof.startsWith('assertion:'))
  assert.ok(reviewed)

  const tautology = auditText.replace(
    JSON.stringify(reviewed),
    JSON.stringify({ ...reviewed, causeEvidence: reviewed.finalText }),
  )
  assert.match(auditRefusalCensus(projectRoot, tautology).errors.join('\n'), /cause evidence repeats the full text/u)

  const invented = auditText.replace(
    JSON.stringify(reviewed),
    JSON.stringify({ ...reviewed, testProof: 'assertion:test/does-not-exist.test.ts' }),
  )
  assert.match(auditRefusalCensus(projectRoot, invented).errors.join('\n'), /claimed assertion file does not exist/u)
})

test('typed error.message adapters and named boundary proofs are explicit', () => {
  const rows = parseRefusalManifest(auditText)
  const cityConflict = rows.find(row => row.finalText.startsWith('city credit source key is already bound'))
  assert.deepEqual(cityConflict && {
    status: cityConflict.status,
    adapter: cityConflict.adapter,
    proof: cityConflict.testProof,
  }, {
    status: '409',
    adapter: 'founder city-credit conflict adapter',
    proof: 'assertion:test/city-credit.test.ts',
  })
  const logDrain = rows.find(row => row.finalText.startsWith('log drain signature was rejected'))
  assert.equal(logDrain?.testProof, 'assertion:test/log-drain-http.test.ts')
})

test('expression-level provenance separates caller refusals from internal discriminators', () => {
  const candidates = discoverCandidates(projectRoot)
  const byKey = new Map(candidates.map(row => [row.key, row]))

  for (const key of [
    'src/city-credit.ts::city credit account is unavailable::1',
    'src/payment-sale-operations.ts::payment sale attempt is unavailable::1',
    'src/payment-treasury-operations.ts::treasury payment completion result is invalid::1',
    'src/paypal-credit-dispute.ts::not_found::1',
    'src/world-market.ts::invalid::1',
  ]) {
    assert.equal(byKey.get(key)?.disposition, 'excluded', key)
    assert.equal(byKey.get(key)?.finalBoundary, 'not returned at a caller boundary', key)
  }

  const storedPayPal = byKey.get(
    'src/paypal-credit-dispute.ts::stored PayPal dispute ${label} is invalid; re-read the dispute, then ask the city operator to repair its stored record::1',
  )
  assert.deepEqual(storedPayPal && {
    disposition: storedPayPal.disposition,
    status: storedPayPal.status,
    adapter: storedPayPal.adapter,
  }, {
    disposition: 'included',
    status: '400',
    adapter: 'founder PayPal dispute TypeError adapter',
  })

  assert.equal(byKey.get(
    'src/paypal-credit-dispute.ts::This PayPal dispute was not found. Re-read the current dispute list before retrying.::1',
  )?.disposition, 'included')
  assert.equal(byKey.get(
    'src/paypal-credit-dispute.ts::This PayPal dispute is not awaiting founder review. Nothing changed.::1',
  )?.disposition, 'excluded')
})
