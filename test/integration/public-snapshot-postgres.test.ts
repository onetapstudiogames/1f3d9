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

const POSTGRES_IMAGE =
  'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'public_snapshot_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

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
  await administrator.query(schemaDdl)
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
    action_id: 7,
    action: 'move',
    error: 'move must cross one parent-child edge',
    status: 'applied',
    effects_applied: 1,
    from_id: 1,
    to_id: 2,
    reason: 'safe public reason',
    unsupported_private_field: 'must not be exported',
  })])
  await administrator.query(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ('private_runtime_probe', 'nonpublic-only', '{}', transaction_timestamp())
  `)
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
      record: { detail?: Readonly<Record<string, unknown>> }
    })
  const actionDetail = eventLines.find(line => line.record.detail?.action_id === 7)?.record.detail
  assert.deepEqual(actionDetail, {
    action_id: 7,
    action: 'move',
    error: 'move must cross one parent-child edge',
    status: 'applied',
  })

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
  const allPublicBytes = (await Promise.all(bundle.files.map(file =>
    readFile(join(outputDirectory, file.path), 'utf8'),
  ))).join('')
  assert.doesNotMatch(
    allPublicBytes,
    /private report body|withdrawn body|hidden market body|Hidden market fixture|1{64}|2{64}|5{64}|6{64}/iu,
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
  } finally {
    await deniedReader.end()
  }
})
