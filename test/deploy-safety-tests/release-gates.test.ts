import test from 'node:test'
import assert from 'node:assert/strict'
import { deployScript, ciWorkflow, liveProbeWorkflow, testingGuide, workingStandard, PAYMENT_RELIABILITY_STANDARD, environmentRunbook, packageJson } from '../helpers/deploy-safety-fixtures/release-documents.ts'

export function registerReleaseGatesTests(): void {
  test('the retired deploy helper is read-only outside local verification', () => {
    assert.doesNotMatch(deployScript, /RUN_MIGRATE|scripts\/migrate\.ts|npm run migrate/i)
    assert.doesNotMatch(deployScript, /\bVC\s+deploy\b|\bvercel(?:@latest)?\s+deploy\b/i)
    assert.doesNotMatch(deployScript, /\bVC\s+env\s+add\b|\bVAPI\s+(?:POST|PATCH|PUT|DELETE)\b|\bPB\s+/i)
    assert.doesNotMatch(deployScript, /VERCEL_TOKEN|PORKBUN_API_KEY|PORKBUN_SECRET_KEY/)
  })

  test('every release test gate remains part of explicit branch preparation', () => {
    for (const command of [
      'npm test',
      'npm run typecheck',
      'npm run test:postgres',
      'npm run test:e2e',
    ]) {
      const position = deployScript.indexOf(command)
      assert.ok(position > 0, `missing preparation gate: ${command}`)
    }
    assert.match(deployScript, /--prepare/)
    assert.match(deployScript, /merge[^\n]*\bmain\b/i)
  })

  test('payment reliability is fail-hard in required checks and documented where it binds', () => {
    assert.ok(workingStandard.includes(PAYMENT_RELIABILITY_STANDARD))
    assert.match(workingStandard, /scheduled `live-probe` workflow/iu)
    assert.match(ciWorkflow, /^jobs:\r?\n  checks:\r?\n    runs-on:/mu)
    assert.match(
      ciWorkflow,
      /- name: Run PostgreSQL integration tests\r?\n\s+run: npm run test:postgres/u,
    )
    assert.doesNotMatch(ciWorkflow, /continue-on-error:\s*true/iu)

    const postgresCommand = packageJson.scripts['test:postgres'] ?? ''
    assert.match(postgresCommand, /--test-concurrency=1/u)
    assert.match(postgresCommand, /test\/integration\/\*\.test\.ts/u)
    assert.doesNotMatch(postgresCommand, /test\/integration\/[\w-]+-postgres\.test\.ts/u)

    assert.match(
      testingGuide,
      /CI \(`\.github\/workflows\/ci\.yml`\)[\s\S]{0,300}PostgreSQL/iu,
    )
    assert.doesNotMatch(testingGuide, /postgres suites run locally/iu)

    assert.match(liveProbeWorkflow, /CUSTOMER\.DISPUTE\.CREATED/u)
    assert.match(liveProbeWorkflow, /unsigned dispute events stop at the signature wall/iu)
    assert.match(liveProbeWorkflow, /founder dispute review stops without a root key/iu)
    assert.match(
      liveProbeWorkflow,
      /city-credit\/disputes\/PP-D-LIVE-PROBE\/resolve[\s\S]{0,500}\[ "\$CODE" = "401" \]/u,
    )
    assert.match(liveProbeWorkflow, /\[ "\$CODE" = "401" \]/u)
    assert.doesNotMatch(liveProbeWorkflow, /PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID/u)

    for (const eventType of [
      'PAYMENT.CAPTURE.COMPLETED',
      'PAYMENT.SALE.COMPLETED',
      'CUSTOMER.DISPUTE.CREATED',
      'CUSTOMER.DISPUTE.UPDATED',
      'CUSTOMER.DISPUTE.RESOLVED',
    ]) {
      assert.match(environmentRunbook, new RegExp(eventType.replaceAll('.', '\\.'), 'u'))
    }
  })

  test('the read-only live probe enforces the public kind drawing contract', () => {
    const probe = liveProbeWorkflow.match(
      /- name: paid kind drawings resolve without spending[\s\S]*?(?=\r?\n      - name:)/u,
    )?.[0]
    assert.ok(probe, 'missing paid kind drawing live-probe step')

    const contractAssertions = [...probe.matchAll(
      /echo "\$CONTRACT" \| grep -Fq "([^"]+)"/gu,
    )].map(match => match[1])
    assert.deepEqual(contractAssertions, [
      'A kind revision publishes at most eight variants drawn and described by that exact revision owner.',
      'frontier founding, kind invention, and kind revision accept either rail, while place rename, retirement, and restoration require exactly one prepaid city fee credit',
    ])
    assert.match(probe, /curl -sf --max-time 20 "https:\/\/1f3d9\.com\/api\/drawing\/kind\/\$KIND_ID"/u)
    assert.doesNotMatch(probe, /(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE)/iu)
    assert.match(probe, /\.state == "undrawn"/u)
    assert.match(probe, /\.state == "refused"/u)
    assert.match(probe, /\.state == "in_progress"/u)
    assert.match(probe, /\.state == "complete"/u)
    assert.match(probe, /\.presentation_state == "blank"/u)
    assert.match(probe, /\.source == "none"/u)
    assert.match(probe, /\.source == "kind_base"/u)
    assert.match(probe, /\.drawing\.indices\s*\|\s*type == "array" and length == 64/u)
    assert.match(probe, /\.rows\s*\|\s*type == "array"\s*and length == 8/u)
    assert.match(probe, /all\(\.\[\]; type == "string" and test\(/u)
    assert.match(probe, /\.kind_name \| type == "string" and length > 0/u)
    assert.doesNotMatch(probe, /\.source == null|kind_revision/u)
  })
}
