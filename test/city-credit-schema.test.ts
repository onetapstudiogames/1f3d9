import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../scripts/migrate.ts'

const schemaDdl = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = readFileSync(
  new URL('../db/migrations/20260822_city_credit.sql', import.meta.url),
  'utf8',
)
const paymentRecoveryMigrationDdl = readFileSync(
  new URL('../db/migrations/20260822_payment_recovery.sql', import.meta.url),
  'utf8',
)
const migrateSource = readFileSync(new URL('../scripts/migrate.ts', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}

function normalizedStatement(ddl: string, pattern: RegExp, missing: string): string {
  const statement = splitSqlStatements(ddl).find(candidate => pattern.test(candidate))
  assert.ok(statement, missing)
  return statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()
}

function table(ddl: string, name: string): string {
  return normalizedStatement(
    ddl,
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${name}\\b`, 'iu'),
    `missing ${name}`,
  )
}

test('rerunning city credit cannot replace the newer payment recovery rules', () => {
  const guard = (ddl: string): string => normalizedStatement(
    ddl,
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/iu,
    'missing payment history guard',
  )
  assert.equal(guard(migrationDdl), guard(paymentRecoveryMigrationDdl))
})

test('fresh and upgraded schemas install the same private credit tables', () => {
  for (const name of ['city_credit_accounts', 'city_credit_entries']) {
    assert.equal(table(migrationDdl, name), table(schemaDdl, name))
  }

  assert.match(
    table(schemaDdl, 'city_credit_accounts'),
    /resident_id\s+INTEGER\s+PRIMARY\s+KEY\s+REFERENCES\s+residents\s*\(id\)\s+ON\s+DELETE\s+RESTRICT/iu,
  )
  assert.match(table(schemaDdl, 'city_credit_accounts'), /balance_units\s+BIGINT\s+NOT\s+NULL\s+DEFAULT\s+0/iu)
  assert.match(table(schemaDdl, 'city_credit_accounts'), /CHECK\s*\(balance_units\s*>=\s*0\)/iu)
})

test('ledger rows encode only founder issue, spend, exact return, or founder correction', () => {
  const entries = table(schemaDdl, 'city_credit_entries')

  assert.match(entries, /entry_kind[\s\S]*'founder_issue'[\s\S]*'spend'[\s\S]*'return'[\s\S]*'admin_credit'[\s\S]*'admin_debit'/iu)
  assert.match(entries, /amount_units\s+BIGINT\s+NOT\s+NULL[\s\S]*amount_units\s*=\s*1000000/iu)
  assert.match(entries, /founder_id[\s\S]*founder_id\s*=\s*1/iu)
  assert.match(entries, /payment_attempt_id\s+TEXT[\s\S]*REFERENCES\s+payment_attempts\s*\(public_id\)/iu)
  assert.match(entries, /related_spend_id\s+BIGINT[\s\S]*REFERENCES\s+city_credit_entries\s*\(id\)/iu)
  assert.match(entries, /request_id[\s\S]*octet_length\s*\(request_id\)\s+BETWEEN\s+8\s+AND\s+128/iu)
  assert.match(entries, /source_key[\s\S]*octet_length\s*\(source_key\)\s+BETWEEN\s+8\s+AND\s+160/iu)

  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(ddl, /CREATE\s+UNIQUE\s+INDEX[\s\S]*city_credit_entries_source_key[\s\S]*\(source_key\)/iu)
    assert.match(ddl, /CREATE\s+UNIQUE\s+INDEX[\s\S]*city_credit_entries_spend_request[\s\S]*\(resident_id,\s*request_id\)/iu)
    assert.match(ddl, /CREATE\s+UNIQUE\s+INDEX[\s\S]*city_credit_entries_one_spend_per_attempt[\s\S]*\(payment_attempt_id\)/iu)
    assert.match(ddl, /CREATE\s+UNIQUE\s+INDEX[\s\S]*city_credit_entries_one_return_per_spend[\s\S]*\(related_spend_id\)/iu)
  }
})

test('database triggers own the balance projection and forbid direct repair', () => {
  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+apply_city_credit_entry/iu)
    assert.match(ddl, /UPDATE\s+city_credit_accounts[\s\S]*balance_units\s*=\s*balance_units\s*\+[\s\S]*balance_units\s*\+[\s\S]*>=\s*0/iu)
    assert.match(ddl, /insufficient city fee credit/iu)
    assert.match(ddl, /CREATE\s+TRIGGER\s+city_credit_entries_apply_balance/iu)
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_city_credit_account/iu)
    assert.match(ddl, /city credit account is a ledger projection/iu)
    assert.match(ddl, /CREATE\s+TRIGGER\s+city_credit_accounts_projection_only/iu)
    assert.match(ddl, /CREATE\s+TRIGGER\s+city_credit_entries_append_only/iu)
  }
})

test('returns are database-bound to one exact same-resident spend', () => {
  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+validate_city_credit_entry/iu)
    assert.match(ddl, /related_spend\.entry_kind\s*<>\s*'spend'/iu)
    assert.match(ddl, /related_spend\.resident_id\s*<>\s*NEW\.resident_id/iu)
    assert.match(ddl, /related_spend\.amount_units\s*<>\s*NEW\.amount_units/iu)
    assert.match(ddl, /related_spend\.payment_attempt_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.payment_attempt_id/iu)
    assert.match(ddl, /attempt\.method\s*<>\s*'credit'/iu)
    assert.match(ddl, /attempt\.actor_id\s*<>\s*NEW\.resident_id/iu)
  }
})

test('credit completion and return are credit-only terminal transitions', () => {
  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(ddl, /method[\s\S]*IN\s*\([\s\S]*'credit'/iu)
    assert.match(ddl, /status[\s\S]*IN\s*\([\s\S]*'credit_returned'/iu)
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+complete_city_credit_attempt/iu)
    assert.match(ddl, /method\s*=\s*'credit'/iu)
    assert.match(ddl, /EXISTS\s*\([\s\S]*city_credit_entries[\s\S]*entry_kind\s*=\s*'spend'/iu)
    assert.match(ddl, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+return_city_credit_spend/iu)
    assert.match(ddl, /status\s*=\s*'credit_returned'/iu)
    assert.match(ddl, /entry_kind[\s\S]*'return'/iu)
  }
})

test('credit attempts bind kind revisions to one immutable kind asset', () => {
  for (const ddl of [schemaDdl, migrationDdl]) {
    assert.match(
      ddl,
      /operation\s*=\s*'kind_revision'[\s\S]{0,300}asset_type\s*=\s*'kind'[\s\S]{0,120}asset_id\s+IS\s+NOT\s+NULL/iu,
    )
    assert.match(
      ddl,
      /operation\s+IN\s*\(\s*'frontier'\s*,\s*'kind_invention'\s*\)[\s\S]{0,200}asset_type\s+IS\s+NULL[\s\S]{0,100}asset_id\s+IS\s+NULL/iu,
    )
  }
})

test('credit is an explicit additive migration target', () => {
  assert.match(migrateSource, /'city-credit'\s*:\s*'20260822_city_credit\.sql'/u)
  assert.match(migrateSource, /CITY_CREDIT/u)
  assert.doesNotMatch(migrationDdl, /INSERT\s+INTO\s+city_credit_entries[\s\S]*'founder_issue'/iu)
  assert.match(migrationDdl, /^BEGIN;/u)
  assert.match(migrationDdl, /COMMIT;\s*$/u)
  assert.doesNotMatch(migrationDdl, /DROP\s+TABLE[\s\S]{0,100}city_credit/iu)
  assert.match(packageJson.scripts['migrate:preview:city-credit'] ?? '', /--target preview --migration city-credit$/u)
  assert.match(packageJson.scripts['migrate:production:city-credit'] ?? '', /--target production --migration city-credit$/u)
  assert.match(packageJson.scripts['test:postgres'] ?? '', /city-credit-postgres\.test\.ts/u)
})
