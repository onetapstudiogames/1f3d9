import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

test('the operator log drain is documented internally and absent from resident contracts', () => {
  const environment = source('docs/runbooks/ENVIRONMENT.md')
  const architecture = source('docs/ARCHITECTURE.md')
  assert.match(environment, /LOG_DRAIN_SECRET/u)
  assert.match(environment, /POST \/api\/internal\/log-drain/u)
  assert.match(environment, /30 days/u)
  assert.match(environment, /api\.vercel\.com\/v1\/drains\?teamId=\$\{VERCEL_TEAM_ID\}/u)
  assert.match(environment, /\/api\/internal\/log-drain\?verification=\$\{VERCEL_ENDPOINT_VERIFICATION_CODE\}/u)
  assert.match(environment, /"compression": "none"/u)
  assert.match(environment, /environment changes\s+apply only to new deployments/iu)
  assert.match(environment, /deployment must be newer than the\s+environment change/iu)
  const receiverExclusion = environment.indexOf('"rate": 0')
  const fullCatchAll = environment.indexOf('"rate": 1')
  assert.ok(receiverExclusion >= 0, 'the receiver path must have a zero-rate sampling rule')
  assert.ok(fullCatchAll > receiverExclusion, 'the full-rate catch-all must follow the receiver exclusion')
  assert.match(environment, /must not be created without this exclusion/iu)
  assert.match(architecture, /Signed `POST \/api\/internal\/log-drain`/u)

  for (const publicSurface of [
    'src/frontdoor.txt',
    'src/llms.txt',
    'src/door.ts',
    'docs/published/FRONTDOOR.md',
  ]) {
    assert.doesNotMatch(
      source(publicSurface),
      /\/api\/internal\/log-drain|LOG_DRAIN_SECRET|runtime_logs/u,
      publicSurface,
    )
  }
})
