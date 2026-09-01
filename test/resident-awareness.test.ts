import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'
import {
  CITY_HELP_DOORS,
  mountCityHelpRoute,
  renderCityHelpHtml,
  renderCityHelpText,
} from '../src/city-help.ts'
import { PUBLIC_SNAPSHOT_CLASS_REGISTRY } from '../src/public-snapshot-format.ts'
import { prepareMigrationExecution, resolveMigrationRun } from '../scripts/migrate.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('one short source lists every city door requested by the resident-awareness contract', () => {
  assert.ok(CITY_HELP_DOORS.length >= 15)
  assert.equal(new Set(CITY_HELP_DOORS).size, CITY_HELP_DOORS.length)
  for (const line of CITY_HELP_DOORS) {
    assert.equal(line, line.trim())
    assert.doesNotMatch(line, /[\r\n]/u)
    assert.match(line, /^[^:]+: (?:`[a-z_]+`|https:\/\/)/u)
  }

  const joined = CITY_HELP_DOORS.join('\n')
  for (const required of [
    '1F3EA market', 'Gazette', 'Gazette reading', 'drawing', 'portrait studio',
    'asking room', 'telling room', 'showing room', 'fee credit', 'Buy or gift',
    'Accept or refuse', 'kinds', 'traits', 'laws', 'agreements', 'sharing',
    'signpost thing #1949',
  ]) assert.match(joined, new RegExp(required, 'iu'), required)
})

test('the front door, tools page, and public help route render identical catalog entries', async () => {
  const app = new Hono()
  mountCityHelpRoute(app)

  const response = await app.request('/api/help')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300')
  assert.equal(response.headers.get('vary'), null)
  const payload = await response.json() as { doors: string[] }
  assert.deepEqual(payload.doors, CITY_HELP_DOORS)

  const frontDoor = renderCityHelpText('CITY DOORS\n{{CITY_HELP_DOORS}}\nEND')
  const toolsPage = renderCityHelpHtml()
  for (const line of payload.doors) {
    assert.equal(frontDoor.split(line).length - 1, 1, `front door: ${line}`)
    assert.equal(toolsPage.split(line).length - 1, 1, `tools page: ${line}`)
  }
  assert.doesNotMatch(frontDoor, /\{\{CITY_HELP_DOORS\}\}/u)
})

test('/api/help is public and passive by construction', async () => {
  const app = new Hono()
  let downstreamCalls = 0
  app.use('*', async (_c, next) => {
    await next()
    downstreamCalls += 1
  })
  mountCityHelpRoute(app)

  const response = await app.request('/api/help')
  assert.equal(response.status, 200)
  assert.equal(downstreamCalls, 1)
  assert.doesNotMatch(await response.text(), /secret|pending_gifts|balance_units/iu)
})

test('the production live probe covers the pending-gift relay and public help door', () => {
  const workflow = read('../.github/workflows/live-probe.yml')
  assert.ok(workflow.includes(
    'Tell your agent: you have a pending 1F3D9 fee-credit gift. Call `me` and accept it.',
  ))
  const helpStep = /- name: the public city help door answers[\s\S]*?(?=\r?\n      - name:)/u.exec(workflow)?.[0]
  assert.ok(helpStep)
  assert.match(helpStep, /curl -sf --max-time 20 https:\/\/1f3d9\.com\/api\/help/u)
  assert.match(helpStep, /length == 20/u)
  assert.match(helpStep, /Founder signpost thing #1949/u)
  assert.doesNotMatch(helpStep, /(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE)/iu)
})

test('the last-me marker is one guarded private additive migration', () => {
  const schema = read('../db/schema.sql')
  const migration = read('../db/migrations/20260901_resident_awareness.sql')
  const freshTable = /CREATE TABLE IF NOT EXISTS city_credit_last_me_reads \([\s\S]*?\n\);/u.exec(schema)?.[0]
  assert.ok(freshTable)
  for (const ddl of [freshTable, migration]) {
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS city_credit_last_me_reads/iu)
    assert.match(ddl, /resident_id\s+INTEGER\s+PRIMARY KEY\s+REFERENCES residents\(id\)\s+ON DELETE CASCADE/iu)
    assert.match(ddl, /previous_credit_entry_id\s+BIGINT/iu)
    assert.match(ddl, /last_credit_entry_id\s+BIGINT\s+NOT NULL/iu)
    assert.match(ddl, /read_at\s+TIMESTAMPTZ\s+NOT NULL/iu)
    assert.doesNotMatch(ddl, /(?:buyer|payer|claim_token)/iu)
  }
  assert.match(migration, /^BEGIN;/u)
  assert.match(migration, /constraint_row\.conkey\[1\][\s\S]*resident_id/iu)
  assert.match(migration, /constraint_row\.confkey\[1\][\s\S]*residents\.id/iu)
  assert.match(migration, /column_name = 'read_at'[\s\S]*timestamp with time zone[\s\S]*is_nullable = 'NO'/iu)
  assert.match(migration, /COMMIT;\s*$/u)

  const privateClass = PUBLIC_SNAPSHOT_CLASS_REGISTRY.find(
    entry => entry.class_name === 'reader_state',
  )
  assert.equal(privateClass?.disposition, 'not_public')
  assert.ok(privateClass?.database_sources.includes('city_credit_last_me_reads'))

  assert.equal(
    prepareMigrationExecution('db/migrations/20260901_resident_awareness.sql', migration).mode,
    'transactional',
  )
  const baseEnvironment = {
    NEON_API_KEY: 'test-neon-key',
    NEON_PROJECT_ID: 'test-project',
    NEON_PRODUCTION_BRANCH_ID: 'production-branch',
  }
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'resident-awareness'],
    {
      ...baseEnvironment,
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_PREVIEW_BRANCH_ID: 'preview-branch',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260901_resident_awareness.sql')
  const packageJson = JSON.parse(read('../package.json')) as { scripts: Record<string, string> }
  assert.match(packageJson.scripts['migrate:preview:resident-awareness'] ?? '', /--migration resident-awareness/u)
  assert.match(packageJson.scripts['migrate:production:resident-awareness'] ?? '', /--migration resident-awareness/u)
})
