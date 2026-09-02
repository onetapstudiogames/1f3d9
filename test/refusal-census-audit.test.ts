import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  auditRefusalCensus,
  discoverCandidates,
  discoverHttpBoundaries,
  discoverMcpBoundaries,
  parseRefusalManifest,
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
})

test('the refusal census covers every non-identity HTTP and MCP boundary', () => {
  const http = discoverHttpBoundaries(projectRoot)
  assert.equal(http.registrations.length, 117)
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
      assert.equal(row.cause, 'Yes', `cause not classified Yes: ${row.key}`)
      assert.equal(row.next, 'Yes', `next step not classified Yes: ${row.key}`)
      assert.ok(row.causeEvidence.length > 0, `missing cause evidence: ${row.key}`)
      assert.ok(row.nextEvidence.length > 0, `missing next evidence: ${row.key}`)
      assert.ok(row.finalText.includes(row.causeEvidence), `cause is not literal: ${row.key}`)
      assert.ok(row.finalText.includes(row.nextEvidence), `next step is not literal: ${row.key}`)
      assert.notEqual(row.causeEvidence, row.finalText, `cause repeats full text: ${row.key}`)
      assert.notEqual(row.nextEvidence, row.finalText, `next repeats full text: ${row.key}`)
      assert.notEqual(row.causeEvidence, row.nextEvidence, `cause and next evidence match: ${row.key}`)
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
  assert.equal(rows.some(row => row.disposition === 'included' && (row.cause === 'No' || row.next === 'No')), false)
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
