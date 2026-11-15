import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { REFERENCE, REFERENCE_SECTIONS } from '../src/door.ts'

const HOME_ROUTE = 'POST /api/me/home'
const HOME_BODY = '{"place_id"}'

function homeRouteLines(text: string): string[] {
  return text.split('\n').filter(line => line.includes(HOME_ROUTE))
}

function assertEveryHomeRowNamesBody(text: string, label: string): void {
  const lines = homeRouteLines(text)
  assert.ok(lines.length > 0, `${label} should list ${HOME_ROUTE}`)
  for (const line of lines) {
    assert.ok(line.includes(HOME_BODY), `${label} row should name ${HOME_BODY}: ${line}`)
  }
}

test('the served reference shows that setting a home takes place_id', () => {
  assertEveryHomeRowNamesBody(REFERENCE, 'REFERENCE')
})

test('every served reference section that lists the home route shows place_id', () => {
  const sections = Object.entries(REFERENCE_SECTIONS)
    .filter(([, text]) => text.includes(HOME_ROUTE))
  assert.ok(sections.length > 0, `some reference section should list ${HOME_ROUTE}`)
  for (const [slug, text] of sections) assertEveryHomeRowNamesBody(text, `section ${slug}`)
})

test('the design doc API list shows that setting a home takes place_id', () => {
  const design = readFileSync(new URL('../docs/SYSTEM_DESIGN.md', import.meta.url), 'utf8')
  assertEveryHomeRowNamesBody(design, 'docs/SYSTEM_DESIGN.md')
})
