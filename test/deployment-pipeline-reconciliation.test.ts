import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const deployScript = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8')

test('the retired deploy script cannot upload a local worktree or mutate production providers', () => {
  assert.doesNotMatch(deployScript, /\bVC\s+deploy\b|\bvercel(?:@latest)?\s+deploy\b/i)
  assert.doesNotMatch(deployScript, /--prod\b|--target(?:=|\s+)production\b/i)
  assert.doesNotMatch(deployScript, /\bVC\s+env\s+add\b|\bVAPI\s+(?:POST|PATCH|PUT|DELETE)\b|\bPB\s+/i)
})

test('the retired deploy script directs releases through GitHub main and Vercel', () => {
  assert.match(deployScript, /merge[^\n]*\bmain\b/i)
  assert.match(deployScript, /GitHub[^\n]*Vercel|Vercel[^\n]*GitHub/i)
})
