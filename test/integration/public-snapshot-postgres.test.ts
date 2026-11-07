import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client } from 'pg'
import {
  exportPublicSnapshot,
  type SnapshotDatabaseClient,
} from '../../scripts/export-public-snapshot.ts'
import { PUBLIC_SNAPSHOT_CLASS_REGISTRY } from '../../src/public-snapshot-format.ts'
import { AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS } from '../fixtures/public-snapshot-event-detail-contract.ts'
import {
  FIVE_STATES_PAYMENT_CANARY,
  FIVE_STATES_WALLET,
  seedFiveStates,
} from '../helpers/thing-endings-fixtures/five-states.ts'

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'public_snapshot_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const eventDetailMigrationDdl = await readFile(
  new URL('../../db/migrations/20260901_public_snapshot_event_details.sql', import.meta.url),
  'utf8',
)

function schemaBeforeEventDetailMigration(): string {
  const fields = ['effects_applied', 'due_at', 'generation'] as const
  const previousSchema = fields.reduce(
    (sql, field) => sql.replace(
      new RegExp(`^\\s*'${field}', event\\.detail->'${field}',?\\r?$`, 'mu'),
      '',
    ),
    schemaDdl,
  )
  assert.notEqual(previousSchema, schemaDdl, 'fresh schema must contain the migrated event fields')
  return previousSchema
}

function docker(args: readonly string[], allowFailure = false): string {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`Docker public-snapshot fixture failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function connect(config: ConstructorParameters<typeof Client>[0]): Promise<Client> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    const client = new Client(config)
    try {
      await client.connect()
      return client
    } catch (error) {
      lastError = error
      await client.end().catch(() => undefined)
      await delay(200)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
}

test('the real snapshot role sees one frozen public allowlist and cannot reach base data', async t => {
  const runId = `${process.pid}-${randomBytes(5).toString('hex')}`
  const container = `1f3d9-public-snapshot-${runId}`
  const administratorPassword = randomBytes(24).toString('hex')
  const snapshotPassword = randomBytes(24).toString('hex')
  const outputRoot = await mkdtemp(join(tmpdir(), '1f3d9-public-snapshot-'))
  const outputDirectory = join(outputRoot, 'snapshot')
  let administrator: Client | undefined
  let reader: Client | undefined
  t.after(async () => {
    await reader?.end().catch(() => undefined)
    await administrator?.end().catch(() => undefined)
    await rm(outputRoot, { force: true, recursive: true })
    docker(['rm', '--force', container], true)
  })

  docker([
    'run', '--detach', '--name', container,
    '--label', `com.1f3d9.test=${runId}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${administratorPassword}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  const portText = docker(['port', container, '5432/tcp'])
  const port = Number(portText.match(/:(\d+)\s*$/u)?.[1])
  assert.ok(Number.isSafeInteger(port) && port > 0)

  administrator = await connect({
    host: '127.0.0.1', port, user: 'postgres', password: administratorPassword,
    database: POSTGRES_DATABASE, ssl: false,
  })
  await administrator.query(schemaBeforeEventDetailMigration())
  await administrator.query(eventDetailMigrationDdl)
  await administrator.query(`ALTER ROLE city_snapshot_export PASSWORD '${snapshotPassword}'`)
  await administrator.query(`
    INSERT INTO residents (id, handle, model, secret_hash, joined_at)
    VALUES
      (1, 'snapshot-keeper', 'safe model', $1, '2026-08-20T00:00:00Z'),
      (2, 'unicode-writer', $2, $3, '2026-08-20T00:00:01Z'),
      (5, 'after-landmark', 'safe model', $4, '2026-08-20T00:00:02Z'),
      (6, 'nonpublic-only', 'safe model', $5, '2026-07-01T00:00:00Z')
  `, [
    '1'.repeat(64),
    `historical 1f3d9_sk_${'ab'.repeat(24)}`,
    '2'.repeat(64),
    '5'.repeat(64),
    '6'.repeat(64),
  ])
  await administrator.query('UPDATE resident_id_allocator SET last_id = 6 WHERE singleton')
  const room = (await administrator.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, purpose, owner_id)
    SELECT id, 'continent', 'Snapshot Quarter', 'exact public room', 'Remember exactly.', 1
    FROM places WHERE place_kind = 'world'
    RETURNING id
  `)).rows[0]!
  const moderatedPlace = (await administrator.query<{ id: number }>(`
    INSERT INTO places (parent_id, place_kind, name, description, purpose, owner_id)
    VALUES ($1, 'place', 'unsafe founding place', 'removed place text', '', 1)
    RETURNING id
  `, [room.id])).rows[0]!
  await administrator.query('UPDATE places SET name = $1 WHERE id = $2', [
    'unsafe renamed place', moderatedPlace.id,
  ])
  const moderatedRenameEvent = (await administrator.query<{ id: number }>(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES (
      'place_renamed', 'snapshot-keeper',
      jsonb_build_object(
        'place_id', $1::integer,
        'name', 'unsafe renamed place',
        'former_name', 'unsafe founding place'
      ),
      '2026-08-20T00:00:30Z'
    )
    RETURNING id
  `, [moderatedPlace.id])).rows[0]!
  await administrator.query(`
    INSERT INTO place_name_history (place_id, name, started_at, event_id)
    VALUES ($1, 'unsafe renamed place', '2026-08-20T00:00:30Z', $2)
  `, [moderatedPlace.id, moderatedRenameEvent.id])
  await administrator.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES ('place', $1, 'remove', 1, 'fixture historical-name removal')
  `, [moderatedPlace.id])
  const exactBody = 'e\u0301 stays decomposed\r\nsecond line\nthird line'
  const visibleNote = (await administrator.query<{ id: number }>(`
    INSERT INTO notes (place_id, author_id, body, created_at)
    VALUES ($1, 2, $2, '2026-08-20T00:01:00Z') RETURNING id
  `, [room.id, exactBody])).rows[0]!
  const hiddenNote = (await administrator.query<{ id: number }>(`
    INSERT INTO notes (place_id, author_id, body, created_at)
    VALUES ($1, 2, 'private report body must not survive', '2026-08-20T00:02:00Z')
    RETURNING id
  `, [room.id])).rows[0]!
  await administrator.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES ('note', $1, 'remove', 1, 'fixture removal')
  `, [hiddenNote.id])
  const hiddenTrait = (await administrator.query<{ id: number }>(`
    INSERT INTO traits (name, description, coiner_id)
    VALUES ('hidden-trait', 'hidden trait description', 1) RETURNING id
  `)).rows[0]!
  const hiddenKind = (await administrator.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('hidden-kind', 1) RETURNING id
  `)).rows[0]!
  await administrator.query(`
    INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
    VALUES ($1, 1, 'hidden kind description', '{}', '[]')
  `, [hiddenKind.id])
  const visibleKind = (await administrator.query<{ id: number }>(`
    INSERT INTO kinds (name, owner_id) VALUES ('visible-kind', 1) RETURNING id
  `)).rows[0]!
  await administrator.query(`
    INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
    VALUES (
      $1, 1, 'safe definition', ARRAY['hidden-trait'],
      '[{"kind":"hidden-kind","quantity":1}]'::jsonb
    )
  `, [visibleKind.id])
  await administrator.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES
      ('trait', $1, 'remove', 1, 'fixture trait removal'),
      ('kind', $2, 'remove', 1, 'fixture kind removal')
  `, [hiddenTrait.id, hiddenKind.id])
  await administrator.query(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ('action', 'snapshot-keeper', $1::jsonb, '2026-08-20T00:02:30Z')
  `, [JSON.stringify({
    ...Object.fromEntries(AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS.map(field => [
      field,
      `omitted live detail fixture: ${field}`,
    ])),
    action_id: 7,
    action: 'move',
    status: 'applied',
    applied_public_activity: [{ actor: 'snapshot-keeper', operation: 'move', place_id: 2 }],
    effects_applied: 1,
    from_place_id: 1,
    to_place_id: 2,
    unsupported_private_field: 'must not be exported',
  })])
  const scheduledEffectEvent = (await administrator.query<{ id: number }>(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ('effect_scheduled', 'snapshot-keeper', $1::jsonb, '2026-08-20T00:02:31Z')
    RETURNING id
  `, [JSON.stringify({
    effect_id: 19,
    due_at: '2026-08-20T00:03:31.000Z',
    generation: 3,
    error: 'internal scheduled-effect error must not survive',
    unsupported_private_field: 'must not be exported',
  })])).rows[0]!
  const privateRuntimeEvent = (await administrator.query<{ id: number }>(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ('private_runtime_probe', 'nonpublic-only', '{}', transaction_timestamp())
    RETURNING id
  `)).rows[0]!
  await administrator.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      454, $1, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
  `, [room.id])
  await administrator.query(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES (
      'place_edited', 'the city',
      '{"place_id":454,"gazette_submission_room_opened":true}'::jsonb,
      '2026-08-30T00:00:00Z'
    )
  `)
  await administrator.query(`
    UPDATE places
    SET description = 'Leave a note here for The Gazette. Every Monday at 16:00 UTC, the automatic printer permanently assigns every unprinted note made before the cutoff to the next issue, verbatim with its author, note ID, and time. Printing never deletes, edits, moves, or copies the source note.',
      purpose = 'Residents may submit up to three notes per Gazette week (Monday 16:00 UTC to Monday 16:00 UTC); each submission also uses the ordinary daily note quota.',
      open_to_notes = TRUE
    WHERE id = 454
  `)
  await administrator.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_submission_limit')
  const { gazetteNote, withdrawalNote } = await (async (): Promise<Readonly<{
    gazetteNote: { id: number }
    withdrawalNote: { id: number; created_at: Date }
  }>> => {
    await administrator.query('ALTER TABLE notes DISABLE TRIGGER gazette_note_record_withdrawal')
    try {
      const gazetteNote = (await administrator.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 2, 'moderated Gazette body must not survive', '2026-08-31T15:59:59Z')
        RETURNING id
      `)).rows[0]!
      const withdrawalNote = (await administrator.query<{ id: number; created_at: Date }>(`
        INSERT INTO notes (place_id, author_id, body, created_at)
        VALUES (454, 2, $1, '2026-08-31T15:59:59.5Z')
        RETURNING id, created_at
      `, [`WITHDRAW #${gazetteNote.id}`])).rows[0]!
      return Object.freeze({ gazetteNote, withdrawalNote })
    } finally {
      await administrator.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_record_withdrawal')
      await administrator.query('ALTER TABLE notes ENABLE TRIGGER gazette_note_submission_limit')
    }
  })()
  await administrator.query('ALTER TABLE gazette_withdrawals DISABLE TRIGGER USER')
  try {
    await administrator.query(`
      INSERT INTO gazette_withdrawals (target_note_id, command_note_id, withdrawn_at)
      VALUES ($1, $2, $3)
    `, [gazetteNote.id, withdrawalNote.id, withdrawalNote.created_at])
  } finally {
    await administrator.query('ALTER TABLE gazette_withdrawals ENABLE TRIGGER USER')
  }
  await administrator.query('BEGIN')
  const gazetteEvent = (await administrator.query<{ id: number }>(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES (
      'gazette_printed', 'the Gazette printer',
      '{"issue_number":1,"place_id":454,"entry_count":1}'::jsonb,
      '2026-08-31T16:00:01Z'
    )
    RETURNING id
  `)).rows[0]!
  await administrator.query(`
    INSERT INTO gazette_issues (
      issue_number, scheduled_for, printed_at, header, entry_count, event_id
    ) VALUES (
      1, '2026-08-31T16:00:00Z', '2026-08-31T16:00:01Z',
      'THE GAZETTE — ISSUE 1', 1, $1
    )
  `, [gazetteEvent.id])
  await administrator.query(`
    INSERT INTO gazette_issue_entries (issue_number, ordinal, note_id)
    VALUES (1, 1, $1)
  `, [gazetteNote.id])
  await administrator.query('COMMIT')
  await administrator.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES ('note', $1, 'remove', 1, 'fixture Gazette removal')
  `, [gazetteNote.id])
  const withdrawnThing = (await administrator.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, withdrawn_at)
    VALUES ($1, 'Withdrawn fixture', 'withdrawn body must not survive', 2, 2, now())
    RETURNING id
  `, [room.id])).rows[0]!
  const hiddenWorldThing = (await administrator.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id)
    VALUES ($1, 'Hidden market fixture', 'hidden market body must not survive', 1, 1)
    RETURNING id
  `, [room.id])).rows[0]!
  const hiddenWorldOffer = (await administrator.query<{ id: number }>(`
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, price_usdc, seller_wallet,
      market_origin, market_draft_id
    ) VALUES (
      'world', 'thing', $1, 1, 2.000000, $2, 'https://1f3ea.com', 101
    )
    RETURNING id
  `, [hiddenWorldThing.id, `0x${'11'.repeat(20)}`])).rows[0]!
  await administrator.query('UPDATE things SET active_offer_id = $1 WHERE id = $2', [
    hiddenWorldOffer.id,
    hiddenWorldThing.id,
  ])
  await administrator.query(`
    INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
    VALUES ('thing', $1, 'remove', 1, 'fixture world-offer removal')
  `, [hiddenWorldThing.id])

  const snapshotUrl =
    `postgresql://city_snapshot_export:${snapshotPassword}@127.0.0.1:${port}/${POSTGRES_DATABASE}`
  const credentialOutput = join(outputRoot, 'credential-failure')
  const credentialReader = new Client({ connectionString: snapshotUrl, ssl: false })
  await assert.rejects(() => exportPublicSnapshot({
    outputDirectory: credentialOutput,
    databaseUrl: snapshotUrl,
    sourceCommit: 'f'.repeat(40),
    client: credentialReader,
  }), /credential/iu)
  assert.deepEqual(await readdir(outputRoot), [], 'credential evidence must leave no partial bundle')
  assert.equal(
    (await administrator.query<{ model: string }>('SELECT model FROM residents WHERE id = 2')).rows[0]?.model,
    `historical 1f3d9_sk_${'ab'.repeat(24)}`,
    'the export must never alter already-public source text',
  )
  await administrator.query("UPDATE residents SET model = 'exact public model' WHERE id = 2")

  reader = new Client({ connectionString: snapshotUrl, ssl: false })
  let insertedConcurrentRow = false
  const frozenReader: SnapshotDatabaseClient = {
    connect: () => reader!.connect(),
    end: () => reader!.end(),
    query: async (text, values) => {
      if (!insertedConcurrentRow && text.includes('snapshot-export:records')) {
        insertedConcurrentRow = true
        await administrator!.query(`
          INSERT INTO notes (place_id, author_id, body, created_at)
          VALUES ($1, 2, 'written after the frozen moment', '2026-08-20T00:03:00Z')
        `, [room.id])
      }
      return await reader!.query(text, values ? [...values] : undefined)
    },
  }

  const bundle = await exportPublicSnapshot({
    outputDirectory,
    databaseUrl: snapshotUrl,
    sourceCommit: 'a'.repeat(40),
    client: frozenReader,
  })
  reader = undefined
  const exportedClasses = PUBLIC_SNAPSHOT_CLASS_REGISTRY
    .filter(entry => entry.disposition === 'exported')
    .map(entry => entry.class_name)
    .sort()
  assert.deepEqual(Object.keys(bundle.counts), exportedClasses)
  assert.deepEqual(
    bundle.files.map(file => file.path),
    [...exportedClasses.map(className => `${className}.ndjson`), 'manifest.json'],
  )
  assert.equal(bundle.counts.lines, 0)
  assert.equal(bundle.counts.pings, 0)
  assert.equal(await readFile(join(outputDirectory, 'lines.ndjson'), 'utf8'), '\n')
  assert.equal(await readFile(join(outputDirectory, 'pings.ndjson'), 'utf8'), '\n')

  const noteLines = (await readFile(join(outputDirectory, 'notes.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  const exact = noteLines.find(line => line.record.id === visibleNote.id)?.record
  assert.equal(exact?.body, exactBody)
  assert.equal(Buffer.from(String(exact?.body), 'utf8').equals(Buffer.from(exactBody, 'utf8')), true)
  assert.equal(noteLines.some(line => line.record.body === 'written after the frozen moment'), false)
  const hidden = noteLines.find(line => line.record.id === hiddenNote.id)?.record
  assert.deepEqual(hidden, { id: hiddenNote.id, status: 'maintainer_hidden' })
  const hiddenGazetteNote = noteLines.find(line => line.record.id === gazetteNote.id)?.record
  assert.deepEqual(hiddenGazetteNote, { id: gazetteNote.id, status: 'maintainer_hidden' })

  const gazetteIssues = (await readFile(join(outputDirectory, 'gazette_issues.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  assert.deepEqual(gazetteIssues.map(line => line.record), [{
    id: 1,
    status: 'exported',
    issue_number: 1,
    scheduled_for: '2026-08-31T16:00:00+00:00',
    printed_at: '2026-08-31T16:00:01+00:00',
    header: 'THE GAZETTE — ISSUE 1',
    entry_count: 1,
    event_id: gazetteEvent.id,
  }])
  const gazetteEntries = (await readFile(
    join(outputDirectory, 'gazette_issue_entries.ndjson'),
    'utf8',
  )).trimEnd().split('\n').map(line => JSON.parse(line) as {
    record: Readonly<Record<string, unknown>>
  })
  assert.deepEqual(gazetteEntries.map(line => line.record), [{
    id: gazetteNote.id,
    status: 'exported',
    issue_number: 1,
    ordinal: 1,
    note_id: gazetteNote.id,
    author_id: 2,
    author: 'unicode-writer',
    created_at: '2026-08-31T15:59:59+00:00',
    withdrawn: true,
    withdrawal_note_id: withdrawalNote.id,
    withdrawn_at: '2026-08-31T15:59:59.5+00:00',
  }])
  assert.doesNotMatch(
    await readFile(join(outputDirectory, 'gazette_issue_entries.ndjson'), 'utf8'),
    /moderated Gazette body/iu,
  )
  const gazetteWithdrawals = (await readFile(
    join(outputDirectory, 'gazette_withdrawals.ndjson'),
    'utf8',
  )).trimEnd().split('\n').map(line => JSON.parse(line) as {
    record: Readonly<Record<string, unknown>>
  })
  assert.deepEqual(gazetteWithdrawals.map(line => line.record), [{
    id: gazetteNote.id,
    status: 'exported',
    target_note_id: gazetteNote.id,
    withdrawal_note_id: withdrawalNote.id,
    author_id: 2,
    author: 'unicode-writer',
    withdrawn_at: '2026-08-31T15:59:59.5+00:00',
  }])
  assert.doesNotMatch(
    await readFile(join(outputDirectory, 'gazette_withdrawals.ndjson'), 'utf8'),
    /moderated Gazette body|WITHDRAW #/iu,
  )

  const thingLines = (await readFile(join(outputDirectory, 'things.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  const withdrawn = thingLines.find(line => line.record.id === withdrawnThing.id)?.record
  assert.equal(withdrawn?.status, 'withdrawn')
  assert.equal(Object.hasOwn(withdrawn ?? {}, 'body'), false)

  const kindLines = (await readFile(join(outputDirectory, 'kinds.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  const visibleKindRecord = kindLines.find(line => line.record.id === visibleKind.id)?.record
  assert.deepEqual(visibleKindRecord?.traits, ['[removed by maintainer]'])
  assert.deepEqual(visibleKindRecord?.recipe, [{ kind: '[removed by maintainer]', quantity: 1 }])

  const eventLines = (await readFile(join(outputDirectory, 'events.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: {
        id?: unknown
        status?: unknown
        detail?: Readonly<Record<string, unknown>>
      }
    })
  const actionDetail = eventLines.find(line => line.record.detail?.action_id === 7)?.record.detail
  assert.deepEqual(actionDetail, {
    action_id: 7,
    action: 'move',
    status: 'applied',
    effects_applied: 1,
    from_place_id: 1,
    to_place_id: 2,
  })
  for (const field of AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS) {
    assert.equal(Object.hasOwn(actionDetail ?? {}, field), false, field)
  }
  const scheduledEffectDetail = eventLines.find(
    line => line.record.id === scheduledEffectEvent.id,
  )?.record.detail
  assert.deepEqual(scheduledEffectDetail, {
    effect_id: 19,
    due_at: '2026-08-20T00:03:31.000Z',
    generation: 3,
  })
  const moderatedRenameDetail = eventLines.find(
    line => line.record.id === moderatedRenameEvent.id,
  )?.record.detail
  assert.deepEqual(moderatedRenameDetail, {
    place_id: moderatedPlace.id,
  })
  const gazetteDetail = eventLines.find(
    line => line.record.detail?.issue_number === 1,
  )?.record.detail
  assert.deepEqual(gazetteDetail, {
    place_id: 454,
    issue_number: 1,
    entry_count: 1,
  })
  const privateRuntimeRecord = eventLines.find(
    line => line.record.id === privateRuntimeEvent.id,
  )?.record
  assert.deepEqual(privateRuntimeRecord, {
    id: privateRuntimeEvent.id,
    status: 'not_public_or_sequence_gap',
  })

  const moderationLines = (await readFile(join(outputDirectory, 'moderation.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  const hiddenNoteModeration = moderationLines.find(
    line => line.record.target_type === 'note' && line.record.target_id === hiddenNote.id,
  )?.record
  assert.equal(hiddenNoteModeration?.reason, 'fixture removal')

  const presenceLines = (await readFile(join(outputDirectory, 'public_presence.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  const nonpublicPresence = presenceLines.find(line => line.record.id === 6)?.record
  assert.equal(nonpublicPresence?.asleep, true)
  assert.equal(nonpublicPresence?.joined_at, '2026-07-01T00:00:00+00:00')

  const worldOfferLines = (await readFile(join(outputDirectory, 'world_market_offers.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  const hiddenWorldRecord = worldOfferLines
    .find(line => line.record.id === hiddenWorldOffer.id)?.record
  assert.deepEqual(hiddenWorldRecord, {
    id: hiddenWorldOffer.id,
    status: 'maintainer_hidden',
  })

  const residentText = await readFile(join(outputDirectory, 'residents.ndjson'), 'utf8')
  assert.match(residentText, /"id":4,"reason":"permanent_resident_landmark","status":"reserved"/u)
  assert.doesNotMatch(residentText, /1f3d9_sk_|secret_hash/iu)
  const placeLines = (await readFile(join(outputDirectory, 'places.ndjson'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line) as {
      record: Readonly<Record<string, unknown>>
    })
  const moderatedPlaceRecord = placeLines.find(
    line => line.record.id === moderatedPlace.id,
  )?.record
  assert.deepEqual(moderatedPlaceRecord, {
    id: moderatedPlace.id,
    status: 'maintainer_hidden',
  })
  const allPublicBytes = (await Promise.all(bundle.files.map(file =>
    readFile(join(outputDirectory, file.path), 'utf8'),
  ))).join('')
  assert.doesNotMatch(
    allPublicBytes,
    /private_runtime_probe|private report body|internal secret-like action failure|internal scheduled-effect error|withdrawn body|hidden market body|Hidden market fixture|unsafe founding place|unsafe renamed place|1{64}|2{64}|5{64}|6{64}/iu,
  )

  const deniedReader = await connect({ connectionString: snapshotUrl, ssl: false })
  try {
    await assert.rejects(
      () => deniedReader.query('SELECT secret_hash FROM public.residents'),
      /permission denied/iu,
    )
    await assert.rejects(
      () => deniedReader.query("UPDATE public.residents SET model = 'changed' WHERE id = 1"),
      /permission denied|read-only/iu,
    )
    await assert.rejects(
      () => deniedReader.query('SELECT * FROM public.gazette_issues'),
      /permission denied/iu,
    )
    await assert.rejects(
      () => deniedReader.query('SELECT * FROM public.gazette_withdrawals'),
      /permission denied/iu,
    )
    await assert.rejects(
      () => deniedReader.query('SELECT * FROM city_snapshot.public_records'),
      /permission denied/iu,
    )
  } finally {
    await deniedReader.end()
  }

  await t.test('v3 freezes active place label names at transaction start and omits them in the next snapshot after expiry', async () => {
    const labels = (await administrator!.query<{ id: string; expires_at: Date | null }>(`
      INSERT INTO active_labels (target_type, target_id, label, actor_id, expires_at)
      VALUES
        ('place', $1, 'snapshot-shared-condition', 1, clock_timestamp() + interval '2 seconds'),
        ('place', $1, 'snapshot-permanent', 1, NULL),
        ('resident', 2, 'snapshot-private-resident', 1, NULL)
      RETURNING id, expires_at
    `, [room.id])).rows
    const timed = labels[0]!
    assert.ok(timed.expires_at instanceof Date)
    const storedLabels = async () => (await administrator!.query(
      'SELECT * FROM active_labels WHERE id = ANY($1::bigint[]) ORDER BY id', [labels.map(label => label.id)],
    )).rows
    const stored = await storedLabels()
    const eventsBefore = (await administrator!.query('SELECT count(*)::int AS count FROM events')).rows
    const activeNames = ['snapshot-permanent', 'snapshot-shared-condition']
    const frozenDirectory = join(outputRoot, 'active-labels')
    const nextDirectory = join(outputRoot, 'expired-labels')
    const frozenClient = new Client({ connectionString: snapshotUrl, ssl: false })
    const placeLabelsSql = `
      SELECT payload->'labels' AS labels, transaction_timestamp() AS frozen_at
      FROM city_snapshot.public_records_v3 WHERE class_name = 'places' AND record_id = $1
    `
    let crossedExpiry = false
    const frozenClientWrapper: SnapshotDatabaseClient = {
      connect: () => frozenClient.connect(),
      end: () => frozenClient.end(),
      query: async (text, values) => {
        if (text.includes('snapshot-export:records')) {
          const before = (await frozenClient.query(placeLabelsSql, [String(room.id)])).rows[0]!
          assert.deepEqual(before.labels, activeNames)
          assert.ok(before.frozen_at < timed.expires_at!, 'the export transaction began before the stored expiry')
          await administrator!.query(`
            SELECT pg_sleep(GREATEST(0, extract(epoch FROM expires_at - clock_timestamp())) + 0.05)
            FROM active_labels WHERE id = $1
          `, [timed.id])
          const expired = (await administrator!.query(`
            SELECT expires_at <= clock_timestamp() AS expired FROM active_labels WHERE id = $1
          `, [timed.id])).rows[0]!
          assert.equal(expired.expired, true, 'real database time passed the stored expiry without another write')
          const after = (await frozenClient.query(placeLabelsSql, [String(room.id)])).rows[0]!
          assert.deepEqual(after, before, 'the already-open snapshot keeps its original time and labels')
          crossedExpiry = true
        }
        return frozenClient.query(text, values ? [...values] : undefined)
      },
    }
    const frozen = await exportPublicSnapshot({
      outputDirectory: frozenDirectory, databaseUrl: snapshotUrl,
      sourceCommit: 'b'.repeat(40), client: frozenClientWrapper,
    })
    assert.equal(crossedExpiry, true)
    const next = await exportPublicSnapshot({
      outputDirectory: nextDirectory, databaseUrl: snapshotUrl,
      sourceCommit: 'b'.repeat(40), client: new Client({ connectionString: snapshotUrl, ssl: false }),
    })
    for (const [directory, bundle, expected] of [
      [frozenDirectory, frozen, activeNames],
      [nextDirectory, next, ['snapshot-permanent']],
    ] as const) {
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { format_version: number }
      assert.equal(manifest.format_version, 4)
      const places = (await readFile(join(directory, 'places.ndjson'), 'utf8'))
        .trimEnd().split('\n').map(line => JSON.parse(line) as { record: Record<string, unknown> })
      assert.deepEqual(places.find(line => line.record.id === room.id)?.record.labels, expected,
        'v3 keeps an array of names, with no expiry objects')
      const publicBytes = (await Promise.all(bundle.files.map(file =>
        readFile(join(directory, file.path), 'utf8'),
      ))).join('')
      assert.doesNotMatch(publicBytes, /snapshot-private-resident/u, 'resident labels stay private in every exported class')
    }
    assert.deepEqual(await storedLabels(), stored, 'neither export deletes or rewrites an expired label')
    assert.deepEqual((await administrator!.query('SELECT count(*)::int AS count FROM events')).rows, eventsBefore)
  })
})

type V4Record = Readonly<{ class_name: string; record_id: string; payload: Record<string, unknown> }>
type Ending = Readonly<Record<string, unknown> & {
  status: string
  program: Readonly<Record<string, unknown>>
  conditions: readonly Record<string, unknown>[]
}>

const sameInstant = (actual: unknown, expected: unknown, message: string) => assert.equal(
  new Date(String(actual instanceof Date ? actual.toISOString() : actual)).getTime(),
  new Date(String(expected instanceof Date ? expected.toISOString() : expected)).getTime(),
  message,
)

test('format v4 carries ends, remnants, links and the thing_ended phase, computed at the export time', async t => {
  const runId = `${process.pid}-${randomBytes(5).toString('hex')}`
  const container = `1f3d9-public-snapshot-v4-${runId}`
  const administratorPassword = randomBytes(24).toString('hex')
  const snapshotPassword = randomBytes(24).toString('hex')
  const outputRoot = await mkdtemp(join(tmpdir(), '1f3d9-public-snapshot-v4-'))
  let administrator: Client | undefined
  t.after(async () => {
    await administrator?.end().catch(() => undefined)
    await rm(outputRoot, { force: true, recursive: true })
    docker(['rm', '--force', container], true)
  })
  docker([
    'run', '--detach', '--name', container,
    '--label', `com.1f3d9.test=${runId}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${administratorPassword}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  const port = Number(docker(['port', container, '5432/tcp']).match(/:(\d+)\s*$/u)?.[1])
  assert.ok(Number.isSafeInteger(port) && port > 0)
  administrator = await connect({
    host: '127.0.0.1', port, user: 'postgres', password: administratorPassword,
    database: POSTGRES_DATABASE, ssl: false,
  })
  await administrator.query(schemaDdl)
  await administrator.query(`ALTER ROLE city_snapshot_export PASSWORD '${snapshotPassword}'`)
  const admin = administrator
  const fixture = await seedFiveStates(admin)
  const things = fixture.things
  const snapshotUrl =
    `postgresql://city_snapshot_export:${snapshotPassword}@127.0.0.1:${port}/${POSTGRES_DATABASE}`

  // A thing whose date falls a moment after the export transaction opens reads as active
  // in that export and as due in the next one.
  const edge = Number((await admin.query<{ id: number }>(`
    INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, wake_enabled)
    VALUES ($1, 'edge lamp', 'falls due during the export', 2, 2, $2, 1, 1, TRUE) RETURNING id
  `, [fixture.rooms.home, fixture.kinds.lamp])).rows[0]!.id)
  await admin.query(`INSERT INTO active_labels (target_type, target_id, label, actor_id) VALUES ('thing', $1, 'lit', 2)`, [edge])
  await admin.query(`
    UPDATE things SET
      ending_rule = jsonb_build_object('any', jsonb_build_array(jsonb_build_object('at', now() + interval '3 seconds'))),
      ending_grant = jsonb_build_object('kind_id', kind_id, 'revision', 1, 'allowed', jsonb_build_array('at'),
        'limits', '{}'::jsonb, 'city_limits_version', 1),
      ending_set_by = 2, ending_set_at = now(), ending_deadline = now() + interval '3 seconds'
    WHERE id = $1
  `, [edge])
  const edgeDeadline = (await admin.query<{ at: Date }>('SELECT ending_deadline AS at FROM things WHERE id = $1', [edge])).rows[0]!.at

  const frozenClient = new Client({ connectionString: snapshotUrl, ssl: false })
  let crossed = false
  const frozenDirectory = join(outputRoot, 'frozen')
  const frozen = await exportPublicSnapshot({
    outputDirectory: frozenDirectory,
    databaseUrl: snapshotUrl,
    sourceCommit: 'c'.repeat(40),
    client: {
      connect: () => frozenClient.connect(),
      end: () => frozenClient.end(),
      query: async (text, values) => {
        if (text.includes('snapshot-export:records')) {
          const opened = (await frozenClient.query<{ at: Date }>('SELECT transaction_timestamp() AS at')).rows[0]!.at
          assert.ok(opened < edgeDeadline, 'the export opened before the edge lamp fell due')
          await admin.query(
            'SELECT pg_sleep(GREATEST(0, extract(epoch FROM $1::timestamptz - clock_timestamp())) + 0.05)',
            [edgeDeadline],
          )
          crossed = true
        }
        return frozenClient.query(text, values ? [...values] : undefined)
      },
    },
  })
  assert.equal(crossed, true)
  const nextDirectory = join(outputRoot, 'next')
  await exportPublicSnapshot({
    outputDirectory: nextDirectory,
    databaseUrl: snapshotUrl,
    sourceCommit: 'c'.repeat(40),
    client: new Client({ connectionString: snapshotUrl, ssl: false }),
  })

  const read = async (directory: string, className: string): Promise<Map<string, Record<string, unknown>>> => {
    const text = await readFile(join(directory, `${className}.ndjson`), 'utf8')
    const lines = text.trimEnd().split('\n').filter(line => line.length > 0)
      .map(line => JSON.parse(line) as { record: Record<string, unknown> })
    return new Map(lines.map(line => [String(line.record.id), line.record]))
  }
  const manifest = JSON.parse(await readFile(join(frozenDirectory, 'manifest.json'), 'utf8')) as {
    format_version: number
  }
  assert.equal(manifest.format_version, 4)
  assert.match(frozen.tag, /^city-snapshot-v4-/u)

  const thingRecords = await read(frozenDirectory, 'things')
  const ending = (id: number): Ending => thingRecords.get(String(id))?.ending as Ending
  const stored = async (id: number) => (await admin.query('SELECT * FROM things WHERE id = $1', [id])).rows[0]!

  await t.test('every exported thing carries its ending status', () => {
    const expected: Record<string, string> = {
      notPermitted: 'not_permitted_by_kind', unset: 'permitted_but_unset',
      kindlessUnset: 'permitted_but_unset', kindlessGiven: 'not_permitted_by_kind',
      active: 'active', activeTimed: 'active', due: 'due_waiting_settle', remnant: 'ended', ran: 'ended',
      wakeOff: 'permitted_but_unset', carried: 'permitted_but_unset', visiting: 'permitted_but_unset',
      blocked: 'permitted_but_unset', retiredRoom: 'permitted_but_unset',
    }
    for (const [name, status] of Object.entries(expected)) {
      const id = things[name as keyof typeof things]
      assert.equal(ending(id)?.status, status, name)
      assert.equal(ending(id)?.remains, 'remnant', name)
      assert.equal(Object.hasOwn(ending(id), 'end_program_summary'), false, `${name}: the summary sentence is a live-read field`)
    }
    assert.equal(ending(edge).status, 'active', 'the export judges the edge lamp at its own transaction time')
    assert.equal(ending(things.kindlessUnset).permission_source, 'kindless_owner')
    assert.deepEqual(ending(things.kindlessUnset).permitted_modes,
      ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'])
    assert.equal(ending(things.kindlessGiven).permission_source, null)
    assert.deepEqual(ending(things.kindlessGiven).permitted_modes, [])
    assert.equal(ending(things.unset).permission_source, 'kind')
    assert.deepEqual(ending(things.unset).permitted_modes,
      ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'], 'canonical mode order')
    assert.deepEqual(ending(things.notPermitted).conditions, [])
    assert.equal(ending(things.notPermitted).still_permitted, null)
    assert.equal(ending(things.notPermitted).renewable_before_end, null)
  })

  await t.test('an active end shows its conditions, counts and grant, and keeps its labels', async () => {
    const row = await stored(things.active)
    const active = ending(things.active)
    assert.deepEqual(active.conditions.map(condition => Object.keys(condition).sort()),
      [['at'], ['uses', 'uses_left'], ['label_added']])
    assert.equal(active.conditions[1]!.uses_left, 3)
    sameInstant(active.soonest_known_end, row.ending_deadline, 'soonest end is the date')
    assert.equal(active.uses_left, 3)
    assert.equal(active.label, 'spent')
    assert.deepEqual(active.grant, row.ending_grant)
    assert.deepEqual(active.still_permitted, { at: true, uses: true, label_added: true })
    assert.deepEqual(active.set_by, { id: 2, handle: 'ending-maker' })
    sameInstant(active.set_at, row.ending_set_at, 'set_at')
    assert.equal(active.renewable_before_end, true)
    assert.equal(active.copy_origin, null)
    assert.deepEqual(active.program, {
      state: 'none', result: null, has_end_trait: true, would_run: false, blocked_by: ['in_sale'],
    })
    assert.equal(thingRecords.get(String(things.active))?.labels_total, 1)

    const timedRow = await stored(things.activeTimed)
    const timed = ending(things.activeTimed)
    sameInstant(timed.conditions[0]!.ends_at, new Date(timedRow.ending_set_at.getTime() + 86_400_000), 'ends_at')
    const unused = new Date(timedRow.ending_idle_anchor.getTime() + 3_600_000)
    sameInstant(timed.conditions[1]!.unused_deadline, unused, 'unused deadline')
    sameInstant(timed.unused_deadline, unused, 'top-level unused deadline')
    sameInstant(timed.soonest_known_end, unused, 'the soonest of the two')
    assert.deepEqual(timed.program, { state: 'none', result: null, has_end_trait: true, would_run: true, blocked_by: [] })
  })

  await t.test('a due or ended thing shows no current labels while its label rows stay', async () => {
    const labelRows = (await admin.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM active_labels
      WHERE target_type = 'thing' AND target_id = ANY($1::int[]) GROUP BY target_id ORDER BY target_id
    `, [[things.due, things.remnant]])).rows
    assert.deepEqual(labelRows.map(row => row.count), [1, 1])
    for (const id of [things.due, things.remnant, things.ran]) {
      assert.deepEqual(thingRecords.get(String(id))?.labels, [], String(id))
      assert.equal(thingRecords.get(String(id))?.labels_total, 0, String(id))
    }
    const due = ending(things.due)
    sameInstant(due.soonest_known_end, (await stored(things.due)).ending_deadline, 'due at its date')
    assert.equal(due.ended_at, null)
    assert.deepEqual(due.permitted_modes, [])
    assert.equal(due.renewable_before_end, false)

    const remnantRow = await stored(things.remnant)
    const remnant = ending(things.remnant)
    sameInstant(remnant.ended_at, remnantRow.ended_at, 'ended_at')
    assert.equal(remnant.ended_cause, 'at')
    assert.deepEqual(remnant.owner_at_end, { id: 2, handle: 'ending-maker' })
    assert.deepEqual(remnant.grant, remnantRow.ending_grant)
    const origin = remnant.copy_origin as Record<string, unknown>
    assert.equal(origin.source_thing_id, things.active)
    sameInstant(origin.copied_at, remnantRow.ending_copied_at, 'copied_at')
    assert.equal(remnant.renewable_before_end, false)
    sameInstant(remnant.conditions[1]!.unused_deadline, remnant.conditions[1]!.until,
      'a copy keeps its fixed unused-for end')
    assert.deepEqual(remnant.program, {
      state: 'pending', result: null, has_end_trait: true, would_run: false, blocked_by: ['visitors_not_waking'],
    })
    assert.deepEqual(ending(things.ran).program, {
      state: 'ran', result: { effects_applied: 0 }, has_end_trait: true, would_run: null, blocked_by: null,
    })
  })

  await t.test('each closed end-try gate is named', () => {
    for (const [id, gate] of [
      [things.wakeOff, 'wake_off'], [things.carried, 'carried'], [things.visiting, 'visitors_not_waking'],
      [things.blocked, 'visitors_not_waking'], [things.retiredRoom, 'room_retired'], [things.due, 'in_sale'],
    ] as const) {
      assert.equal(ending(id).program.would_run, false, gate)
      assert.deepEqual(ending(id).program.blocked_by, [gate], gate)
    }
    assert.deepEqual(ending(things.unset).program,
      { state: 'none', result: null, has_end_trait: true, would_run: true, blocked_by: [] })
    assert.deepEqual(ending(things.notPermitted).program,
      { state: 'none', result: null, has_end_trait: false, would_run: null, blocked_by: null })
  })

  await t.test('kinds, agreements, offers and thing_ended events carry their v4 fields', async () => {
    const kinds = await read(frozenDirectory, 'kinds')
    assert.deepEqual(kinds.get(String(fixture.kinds.lamp))?.ending_policy, {
      allowed: ['uses', 'at', 'after_setting_seconds', 'idle_seconds', 'label_added'], labels: ['spent'],
    })
    assert.deepEqual(kinds.get(String(fixture.kinds.lamp))?.invented_by, { id: 2, handle: 'ending-maker' })
    assert.deepEqual(kinds.get(String(fixture.kinds.stone))?.ending_policy, { allowed: [] })
    assert.equal(kinds.get(String(fixture.kinds.stone))?.invented_by, null)

    const agreement = (await read(frozenDirectory, 'agreements')).get(String(fixture.agreementId))!
    const links = agreement.thing_links as Record<string, unknown>[]
    assert.deepEqual(links.map(link => [
      link.position, link.thing_id, (link.ends as Record<string, unknown> | undefined)?.state ?? null,
    ]), [
      [0, things.active, 'set'], [1, things.remnant, 'ended'], [2, things.notPermitted, null], [3, things.due, 'ended'],
    ])
    assert.equal(Object.hasOwn(links[2]!, 'ends'), false, 'no end set and never ended: the short status is omitted')

    const offers = await read(frozenDirectory, 'world_market_offers')
    const activeOffer = offers.get(String(fixture.offers.active))!
    assert.equal(activeOffer.phase, 'listed')
    assert.equal(activeOffer.asset_state, 'active')
    assert.equal((activeOffer.ending as Ending).status, 'active')
    assert.ok(activeOffer.ending_checked_at)
    const dueOffer = offers.get(String(fixture.offers.due))!
    assert.equal(dueOffer.phase, 'thing_ended')
    assert.equal(dueOffer.asset_state, 'remnant')
    assert.equal((dueOffer.ending as Ending).status, 'due_waiting_settle')
    assert.equal(dueOffer.seller_wallet, FIVE_STATES_WALLET, 'public receipts and locks stay')

    const events = await read(frozenDirectory, 'events')
    for (const eventId of fixture.endedEventIds) {
      const event = events.get(String(eventId))!
      assert.equal(event.status, 'exported')
      assert.equal(event.kind, 'thing_ended')
      assert.equal(event.actor, 'the city')
      assert.deepEqual(Object.keys(event.detail as object).sort(),
        ['cause', 'ended_at', 'owner', 'owner_id', 'place_id', 'program_state', 'thing_id'])
    }
  })

  await t.test('the next export judges the edge lamp due, and nothing private is exported', async () => {
    const next = await read(nextDirectory, 'things')
    assert.equal((next.get(String(edge))?.ending as Ending).status, 'due_waiting_settle')
    assert.deepEqual(next.get(String(edge))?.labels, [])
    assert.equal((await admin.query('SELECT ended_at FROM things WHERE id = $1', [edge])).rows[0]!.ended_at, null,
      'an export never records an end')
    const publicBytes = (await Promise.all(frozen.files.map(file =>
      readFile(join(frozenDirectory, file.path), 'utf8')))).join('')
    assert.doesNotMatch(publicBytes, new RegExp(FIVE_STATES_PAYMENT_CANARY, 'u'))
    // The later-holder mark on the plain stone, and the change history, leave no trace in
    // any database record (the manifest's registry names the tables, so it is set aside).
    assert.deepEqual(Object.keys(thingRecords.get(String(things.notPermitted))!).filter(key => /mark|holder/u.test(key)), [])
    const recordBytes = (await Promise.all(frozen.files
      .filter(file => file.path.endsWith('.ndjson') && !['official.ndjson', 'physics.ndjson'].includes(file.path))
      .map(file => readFile(join(frozenDirectory, file.path), 'utf8')))).join('')
    assert.doesNotMatch(recordBytes, /marked_at|thing_ending_changes|request_json|later_holder/u)
  })

  await t.test('v4 equals v3 outside its own fields, read by the export role in one snapshot', async () => {
    await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      await admin.query("SET LOCAL TIME ZONE 'UTC'")
      await admin.query('SET LOCAL ROLE city_snapshot_export')
      const select = (view: string) => admin.query<V4Record>(
        `SELECT class_name, record_id, payload FROM city_snapshot.${view}
         ORDER BY class_name COLLATE "C", sort_key, record_id COLLATE "C"`,
      )
      const v3 = (await select('public_records_v3')).rows
      const v4 = (await select('public_records_v4')).rows
      assert.deepEqual(
        v4.map(row => `${row.class_name}:${row.record_id}`),
        v3.map(row => `${row.class_name}:${row.record_id}`),
      )
      const own: Record<string, readonly string[]> = {
        things: ['ending', 'labels', 'labels_total'],
        world_market_offers: ['phase', 'asset_state', 'ending', 'ending_checked_at'],
        kinds: ['ending_policy', 'invented_by'],
        agreements: ['thing_links'],
      }
      const ended = new Set(fixture.endedEventIds.map(String))
      for (const [index, row] of v4.entries()) {
        const before = v3[index]!
        if (row.class_name === 'events' && ended.has(row.record_id)) {
          assert.deepEqual(before.payload, { id: Number(row.record_id), status: 'not_public_or_sequence_gap' })
          continue
        }
        const without = (payload: Record<string, unknown>) => Object.fromEntries(Object.entries(payload)
          .filter(([key]) => !(own[row.class_name] ?? []).includes(key)))
        assert.deepEqual(without(row.payload), without(before.payload), `${row.class_name}:${row.record_id}`)
        if (row.class_name === 'world_market_offers' && row.payload.phase !== 'thing_ended') {
          assert.equal(row.payload.phase, before.payload.phase)
        }
        if (row.class_name === 'things' && row.payload.status === 'exported'
          && !['due_waiting_settle', 'ended'].includes((row.payload.ending as Ending).status)) {
          assert.deepEqual(row.payload.labels, before.payload.labels, `${row.record_id}: labels kept`)
        }
      }
    } finally {
      await admin.query('ROLLBACK')
    }
  })
})
