import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('cost tripwire runs weekly or manually from reviewed code with least privilege', () => {
  const workflow = source('.github/workflows/cost-tripwire.yml')

  assert.match(workflow, /schedule:\s*\n\s*- cron:\s*['"][^'"]+['"]/u)
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
