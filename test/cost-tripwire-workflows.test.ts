import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('cost tripwire runs every day or manually from reviewed code with least privilege', () => {
  const workflow = source('.github/workflows/cost-tripwire.yml')

  assert.match(workflow, /schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron:\s*'23 14 \* \* \*'/u)
  assert.match(workflow, /pull-requests:\s*read/u)
  assert.equal(workflow.match(/GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/gu)?.length, 2,
    'both the normal and the dry-run step read open pull requests')
  assert.match(workflow, /workflow_dispatch:[\s\S]*dry-run/iu)
  assert.match(workflow, /^permissions:\s*\{\}\s*$/mu)
  assert.match(workflow, /contents:\s*read/u)
  assert.match(workflow, /issues:\s*write/u)
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/u)
  assert.match(workflow, /persist-credentials:\s*false/u)
  assert.match(workflow, /VERCEL_TOKEN:\s*\$\{\{ secrets\.VERCEL_TOKEN \}\}/u)
  assert.match(workflow, /NEON_API_KEY:\s*\$\{\{ secrets\.NEON_API_KEY \}\}/u)
  assert.doesNotMatch(workflow, /run:[^\n]*(?:secrets\.|VERCEL_TOKEN|NEON_API_KEY)/u)
  assert.match(workflow, /cost-tripwire -- --dry-run/u)
  assert.match(workflow, /concurrency:[\s\S]*cancel-in-progress:\s*false/u)
})

test('the runbook gives the dated observed 1f3d9-live starting baseline without making it a promise', () => {
  const costs = source('docs/runbooks/COSTS.md')

  assert.match(costs, /2026-09-06[^\n]*2026-09-12/u)
  assert.match(costs, /\$0\.00[^\n]*\$0\.71/u)
  assert.match(costs, /starting baseline/iu)
  assert.match(costs, /not[^\n]*(?:promise|alert threshold)/iu)
  assert.match(costs, /issues\/282#issuecomment-5669545906/u)
})

test('preview cleanup runs only for closed PRs and keeps secrets out of shell text', () => {
  const workflow = source('.github/workflows/neon-preview-cleanup.yml')

  assert.match(workflow, /pull_request_target:\s*\n\s*types:\s*\[closed\]/u)
  assert.match(workflow, /if:\s*github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u)
  assert.match(workflow, /^permissions:\s*\{\}\s*$/mu)
  assert.match(workflow, /NEON_API_KEY:\s*\$\{\{ secrets\.NEON_API_KEY \}\}/u)
  assert.match(workflow, /GITHUB_EVENT_PATH/u)
  assert.match(workflow, /neon-preview-cleanup/u)
  assert.doesNotMatch(workflow, /neon-preview-cleanup[^\n]*--dry-run/u)
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.ref/u)
  assert.doesNotMatch(workflow, /run:[^\n]*(?:secrets\.|NEON_API_KEY)/u)
})

test('CI pins actionlint and requires ShellCheck for workflow scripts', () => {
  const workflow = source('.github/workflows/ci.yml')
  assert.match(workflow, /ACTIONLINT_VERSION:\s*1\.7\.12/u)
  assert.match(workflow, /ACTIONLINT_SHA256:\s*[0-9a-f]{64}/u)
  assert.match(workflow, /command -v shellcheck/u)
  assert.match(workflow, /actionlint.*-shellcheck/u)
  assert.match(workflow, /-ignore ['"]SC2016['"]/u)
})

test('CI installs Chromium alone when its system packages cannot be fetched, then still runs end-to-end', () => {
  const workflow = source('.github/workflows/ci.yml')
  const step = /- name: Install Chromium\r?\n([\s\S]*?)\r?\n      - name: Run end-to-end tests\r?\n([\s\S]*?)(?:\r?\n      - name:|$)/u.exec(workflow)
  assert.ok(step, 'Install Chromium is followed directly by the end-to-end step')
  const [, install = '', e2e = ''] = step
  assert.match(install, /set -euo pipefail/u)
  assert.match(install, /if ! npx playwright install --with-deps chromium; then/u)
  assert.match(install, /::warning title=Chromium system packages::/u)
  assert.match(install, /\n\s+npx playwright install chromium\r?\n\s+fi/u)
  assert.doesNotMatch(install, /\|\|\s*true|continue-on-error/u)
  assert.match(e2e, /run: npm run test:e2e/u)
  assert.doesNotMatch(e2e, /continue-on-error/u)
})
