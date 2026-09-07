import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

export const deployScript = readFileSync(new URL('../../../scripts/deploy.sh', import.meta.url), 'utf8')

export const ciWorkflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')

export const liveProbeWorkflow = readFileSync(
  new URL('../../../.github/workflows/live-probe.yml', import.meta.url),
  'utf8',
)

export const llmsContract = readFileSync(new URL('../../../src/llms.txt', import.meta.url), 'utf8')

export const testingGuide = readFileSync(new URL('../../../docs/TESTING.md', import.meta.url), 'utf8')

export const workingStandard = readFileSync(new URL('../../../AGENTS.md', import.meta.url), 'utf8')

export const PAYMENT_RELIABILITY_STANDARD = [
  '## Payment reliability',
  '',
  'Every payment-path change requires:',
  '',
  '- real-timing tests against real PostgreSQL, including chain finality later than',
  '  the intent or operation window;',
  '- adversarial refuter review before merge; and',
  '- a read-only or self-cleaning post-deploy production probe of the changed',
  '  surface.',
  '',
  'Use city PR #107 as the test model. City issue #103, market PRs #13/#20, and',
  'city PRs #115/#116 record why: mocks missed chain timing and SQL preparation,',
  'while non-production runtimes missed live-only failures.',
].join('\n')

export const deploymentRunbook = readFileSync(
  new URL('../../../docs/runbooks/DEPLOYMENT.md', import.meta.url),
  'utf8',
)

export const environmentRunbook = readFileSync(
  new URL('../../../docs/runbooks/ENVIRONMENT.md', import.meta.url),
  'utf8',
)

export const packageJson = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }

export function assertPostgresTestDiscovered(fileName: string): void {
  assert.match(packageJson.scripts['test:postgres'] ?? '', /test\/integration\/\*\.test\.ts/u)
  assert.equal(
    existsSync(new URL(`../../../test/integration/${fileName}`, import.meta.url)),
    true,
    `missing glob-discovered PostgreSQL test: ${fileName}`,
  )
}
