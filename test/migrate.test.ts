import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../scripts/migrate.ts'

const schemaDdl = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')

function schemaStatement(table: string): string {
  const statement = splitSqlStatements(schemaDdl).find(candidate =>
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i').test(candidate)
  )
  assert.ok(statement, `missing idempotent ${table} table`)
  return statement
}

test('PL/pgSQL dollar-quoted bodies stay inside one migration statement', () => {
  const ddl = `
    CREATE OR REPLACE FUNCTION keep_history() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'history; cannot be deleted';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TABLE audit_log (id integer);
  `

  const statements = splitSqlStatements(ddl)

  assert.equal(statements.length, 2)
  assert.match(statements[0]!, /RAISE EXCEPTION 'history; cannot be deleted';/)
  assert.match(statements[0]!, /END IF;/)
  assert.match(statements[0]!, /\$function\$/)
  assert.equal(statements[1], 'CREATE TABLE audit_log (id integer)')
})

test('schema migration reconnects valid legacy open offers to their asset mutex', () => {
  const statements = splitSqlStatements(schemaDdl)

  for (const [table, type] of [['places', 'place'], ['things', 'thing'], ['kinds', 'kind']] as const) {
    assert.ok(statements.some(statement =>
      new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(statement) &&
      /FROM\s+transfer_offers/i.test(statement) &&
      new RegExp(`asset_type\\s*=\\s*'${type}'`, 'i').test(statement) &&
      /status\s*=\s*'open'/i.test(statement) &&
      /active_offer_id\s+IS\s+NULL/i.test(statement)
    ), `missing legacy ${type} offer backfill`)
  }
})

test('world offers extend direct transfers without weakening their buyer binding', () => {
  const offers = schemaStatement('transfer_offers')

  assert.match(offers, /channel\s+TEXT\s+NOT NULL\s+DEFAULT\s+'direct'/i)
  assert.match(offers, /channel\s+IN\s*\(\s*'direct'\s*,\s*'world'\s*\)/i)
  assert.doesNotMatch(offers, /buyer_id\s+INTEGER\s+NOT NULL/i)
  assert.match(offers, /market_origin\s+TEXT\s+NOT NULL\s+DEFAULT\s+'https:\/\/1f3ea\.com'/i)
  for (const column of ['market_draft_id', 'market_listing_id', 'market_checkout_id']) {
    assert.match(offers, new RegExp(`\\b${column}\\b`, 'i'))
  }
  assert.match(offers, /channel\s*=\s*'direct'[\s\S]*buyer_id\s+IS\s+NOT\s+NULL/i)
  assert.match(offers, /channel\s*=\s*'world'[\s\S]*asset_type\s*=\s*'thing'/i)
  assert.match(schemaDdl, /ALTER\s+TABLE\s+transfer_offers\s+ALTER\s+COLUMN\s+buyer_id\s+DROP\s+NOT\s+NULL/i)
  assert.match(offers, /market_buyer\s+TEXT/i)
  assert.match(schemaDdl, /NEW\.market_buyer\s+IS\s+DISTINCT\s+FROM\s+OLD\.market_buyer/i)
})

test('world market identifiers are unique public bindings, not arbitrary origins', () => {
  assert.match(
    schemaDdl,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+transfer_offers_world_draft[\s\S]*market_draft_id[\s\S]*channel\s*=\s*'world'/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+transfer_offers_world_checkout[\s\S]*market_checkout_id[\s\S]*IS\s+NOT\s+NULL/i,
  )
  assert.match(schemaDdl, /market_origin\s*=\s*'https:\/\/1f3ea\.com'/i)
})

test('offer history trigger rejects claims without an active buyer reservation', () => {
  assert.match(
    schemaDdl,
    /NEW\.status\s*=\s*'claimed'[\s\S]*OLD\.reserved_by\s+IS\s+DISTINCT\s+FROM\s+OLD\.buyer_id[\s\S]*OLD\.reserved_until\s*<=\s*clock_timestamp\(\)/i,
  )
  assert.match(
    schemaDdl,
    /NEW\.status\s*=\s*'canceled'[\s\S]*OLD\.reserved_until\s*[^\n]*>\s*clock_timestamp\(\)/i,
  )
  assert.match(
    schemaDdl,
    /OLD\.pending_x402_tx_hash\s+IS\s+NOT\s+NULL\s+AND\s+reservation_changed[\s\S]*pending x402 reservation is immutable/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+TRIGGER\s+sale_payments_match_world_offer\s+BEFORE\s+INSERT\s+ON\s+sale_payments/i,
  )
  assert.match(
    schemaDdl,
    /NEW\.block_time\s+IS\s+NULL[\s\S]*NEW\.block_time\s+<\s+world_offer\.reserved_at[\s\S]*NEW\.block_time\s+>\s+world_offer\.reserved_until/i,
  )
})

test('fresh and upgraded world constraints use one stable set of names', () => {
  for (const name of [
    'transfer_offers_channel_allowed',
    'transfer_offers_market_origin_fixed',
    'transfer_offers_market_ids_positive',
    'transfer_offers_reservation_complete',
    'transfer_offers_distinct_parties',
    'transfer_offers_reserved_buyer',
    'transfer_offers_five_minute_reservation',
    'transfer_offers_status_timestamps',
    'transfer_offers_reservation_wallet_state',
    'transfer_offers_channel_state',
    'transfer_offers_pending_x402_state',
  ]) {
    assert.match(schemaDdl, new RegExp(`CONSTRAINT\\s+${name}\\b`, 'i'))
  }
})

test('round-two state tables are created idempotently', () => {
  for (const table of [
    'resident_presence',
    'place_law_changes',
    'active_labels',
    'active_blocks',
    'action_runs',
    'action_resolutions',
    'pending_effects',
    'effect_resolutions',
    'moderation_actions',
  ]) {
    schemaStatement(table)
  }
})

test('resident presence permits residents without a current place or home', () => {
  const presence = schemaStatement('resident_presence')

  assert.match(presence, /resident_id\s+INTEGER\s+PRIMARY KEY\s+REFERENCES\s+residents\s*\(id\)/i)
  assert.match(presence, /current_place_id\s+INTEGER\s+REFERENCES\s+places\s*\(id\)/i)
  assert.match(presence, /home_place_id\s+INTEGER\s+REFERENCES\s+places\s*\(id\)/i)
  assert.doesNotMatch(presence, /current_place_id\s+INTEGER\s+NOT NULL/i)
  assert.doesNotMatch(presence, /home_place_id\s+INTEGER\s+NOT NULL/i)
})

test('blocks expire and the database cannot represent a blocked go-home action', () => {
  const blocks = schemaStatement('active_blocks')

  assert.match(blocks, /action_name\s+TEXT\s+NOT NULL\s+CHECK\s*\([^)]*action_name\s+IN\s*\([^)]*'move'[^)]*\)\s*\)/is)
  assert.doesNotMatch(blocks, /action_name\s+IN\s*\([^)]*'go_home'/is)
  assert.match(blocks, /expires_at\s+TIMESTAMPTZ\s+NOT NULL/i)
  assert.match(blocks, /CHECK\s*\(expires_at\s*>\s*created_at\)/i)
  assert.match(blocks, /CHECK\s*\(expires_at\s*<=\s*created_at\s*\+\s*INTERVAL\s*'24 hours'\)/i)
})

test('laws and labels retain ordered, typed effect state', () => {
  const laws = schemaStatement('place_law_changes')
  const labels = schemaStatement('active_labels')

  assert.match(laws, /change_type\s+TEXT\s+NOT NULL\s+CHECK\s*\(change_type\s+IN\s*\('add',\s*'remove'\)\)/i)
  assert.match(laws, /position\s+SMALLINT/i)
  assert.match(laws, /change_type\s*=\s*'add'[\s\S]*position\s+IS\s+NOT\s+NULL[\s\S]*position\s*>=\s*0/i)
  assert.match(labels, /label\s+TEXT\s+NOT NULL/i)
  assert.match(labels, /target_type\s+IN\s*\('resident',\s*'place',\s*'thing',\s*'kind'\)/i)
})

test('scheduled effects carry immutable payload, due time, and bounded generation', () => {
  const pending = schemaStatement('pending_effects')

  assert.match(pending, /payload\s+JSONB\s+NOT NULL/i)
  assert.match(pending, /due_at\s+TIMESTAMPTZ\s+NOT NULL/i)
  assert.match(pending, /generation\s+SMALLINT\s+NOT NULL[^,]*CHECK\s*\(generation\s+BETWEEN\s+0\s+AND\s+8\)/i)
  assert.match(schemaDdl, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+pending_effects_due[\s\S]*?\(place_id,\s*due_at,\s*id\)/i)
})

test('effect generations start at zero and advance exactly once from their parent', () => {
  assert.match(
    schemaDdl,
    /CREATE\s+TRIGGER\s+pending_effects_check_generation\s+BEFORE\s+INSERT\s+ON\s+pending_effects/i,
  )
  assert.match(schemaDdl, /parent_effect_id\s+IS\s+NULL[\s\S]*NEW\.generation\s*<>\s*0/i)
  assert.match(schemaDdl, /NEW\.generation\s*<>\s*parent_generation\s*\+\s*1/i)
})

test('actions and effects separate immutable requests from one resolution', () => {
  const actions = schemaStatement('action_runs')
  const actionResolutions = schemaStatement('action_resolutions')
  const pending = schemaStatement('pending_effects')
  const effectResolutions = schemaStatement('effect_resolutions')

  for (const column of ['destination_place_id', 'recipient_id', 'payload']) {
    assert.match(actions, new RegExp(`\\b${column}\\b`, 'i'))
    assert.match(pending, new RegExp(`\\b${column}\\b`, 'i'))
  }
  assert.match(pending, /action_id\s+BIGINT\s+REFERENCES\s+action_runs\s*\(id\)/i)
  assert.match(pending, /parent_effect_id\s+BIGINT\s+REFERENCES\s+pending_effects\s*\(id\)/i)
  assert.match(actionResolutions, /action_run_id\s+BIGINT\s+NOT NULL\s+UNIQUE\s+REFERENCES\s+action_runs\s*\(id\)/i)
  assert.match(effectResolutions, /pending_effect_id\s+BIGINT\s+NOT NULL\s+UNIQUE\s+REFERENCES\s+pending_effects\s*\(id\)/i)
  assert.match(actionResolutions, /status\s+TEXT\s+NOT NULL/i)
  assert.match(effectResolutions, /status\s+TEXT\s+NOT NULL/i)
})

test('moderation is founder-only remove-or-restore history', () => {
  const moderation = schemaStatement('moderation_actions')

  assert.match(moderation, /actor_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+residents\s*\(id\)[^,]*CHECK\s*\(actor_id\s*=\s*1\)/i)
  assert.match(moderation, /action\s+TEXT\s+NOT NULL\s+CHECK\s*\(action\s+IN\s*\('remove',\s*'restore'\)\)/i)
  assert.doesNotMatch(moderation, /target_type\s+IN\s*\([^)]*'resident'/i)
})

test('thing withdrawal keeps the row and freezes it as history', () => {
  const things = schemaStatement('things')

  assert.match(things, /withdrawn_at\s+TIMESTAMPTZ/i)
  assert.match(schemaDdl, /CREATE\s+TRIGGER\s+things_keep_birth_history\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+things/i)
  assert.match(schemaDdl, /OLD\.withdrawn_at\s+IS\s+NOT\s+NULL\s+AND\s+NEW\s+IS\s+DISTINCT\s+FROM\s+OLD/i)
  assert.match(schemaDdl, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+things_place[\s\S]*WHERE\s+withdrawn_at\s+IS\s+NULL/i)
})

test('round-two records are append-only rather than deleted after resolution', () => {
  for (const table of [
    'place_law_changes',
    'active_labels',
    'active_blocks',
    'action_runs',
    'action_resolutions',
    'pending_effects',
    'effect_resolutions',
    'moderation_actions',
  ]) {
    assert.match(
      schemaDdl,
      new RegExp(
        `CREATE\\s+TRIGGER\\s+${table}_append_only\\s+BEFORE\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${table}\\b`,
        'i',
      ),
      `missing append-only trigger for ${table}`,
    )
  }
})

test('cursor-paged public history has matching keyset indexes', () => {
  assert.match(schemaDdl, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+notes_place_id\s+ON\s+notes\s*\(place_id,\s*id\s+DESC\)/i)
  assert.match(schemaDdl, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+events_kind_id\s+ON\s+events\s*\(kind,\s*id\s+DESC\)/i)
})

test('agreement accession is an append-only opt-in by the original author', () => {
  const agreements = schemaStatement('agreements')
  const parties = schemaStatement('agreement_parties')
  const openings = schemaStatement('agreement_accession_openings')

  assert.doesNotMatch(agreements, /\bsealed\b/i)
  assert.match(parties, /\bnamed\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+TRUE\b/i)
  assert.match(openings, /agreement_id\s+INTEGER\s+PRIMARY KEY/i)
  assert.match(openings, /opened_by_id\s+INTEGER\s+NOT NULL/i)
  assert.match(openings, /opened_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+now\(\)/i)
  assert.match(
    openings,
    /FOREIGN\s+KEY\s*\(agreement_id,\s*opened_by_id\)\s*REFERENCES\s+agreements\s*\(id,\s*created_by_id\)/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+agreements_id_creator\s+ON\s+agreements\s*\(id,\s*created_by_id\)/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+TRIGGER\s+agreement_accession_openings_append_only\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+agreement_accession_openings/i,
  )
  assert.doesNotMatch(schemaDdl, /INSERT\s+INTO\s+agreement_accession_openings/i)
})
