import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Client } from 'pg'
import { readResidentLooking, recordResidentLooking } from '../../src/resident-looking.ts'

const image = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const migration = await readFile(new URL('../../db/migrations/20260907_resident_looking.sql', import.meta.url), 'utf8')

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) throw new Error(
    result.stderr.trim() || result.stdout.trim() ||
    (result.error?.message ?? `docker ${args[0] ?? ''} exited ${result.status ?? 'without status'}`),
  )
  return result.stdout.trim()
}

test('PostgreSQL combines repeats, restarts after movement, and suppresses expiry', { timeout: 45_000 }, async t => {
  const name = `1f3d9-looking-${process.pid}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(16).toString('hex')
  docker(['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`, image])
  t.after(() => { spawnSync('docker', ['stop', '--time', '0', name], { encoding: 'utf8', timeout: 10_000 }) })
  const port = Number(docker(['port', name, '5432/tcp']).match(/:(\d+)\s*$/)?.[1])
  let client: Client | null = null
  for (let attempt = 0; attempt < 100 && !client; attempt += 1) {
    const candidate = new Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' })
    try { await candidate.connect(); client = candidate } catch { await candidate.end().catch(() => {}); await delay(100) }
  }
  assert.ok(client)
  t.after(() => client?.end())
  await client.query(`CREATE TABLE residents(id integer primary key); CREATE TABLE places(id integer primary key);
    CREATE TABLE resident_presence(resident_id integer primary key references residents(id), current_place_id integer references places(id));
    INSERT INTO residents VALUES (1); INSERT INTO places VALUES (2),(3); INSERT INTO resident_presence VALUES (1,2);`)
  await client.query(migration)
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? ''
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ''}`
    return (await client!.query(text, values)).rows
  }) as unknown as typeof import('../../src/db.ts').sql

  await recordResidentLooking({ id: 1 }, tagged)
  const first = (await readResidentLooking([1], tagged)).get(1)!
  await delay(10)
  await recordResidentLooking({ id: 1 }, tagged)
  const combined = (await readResidentLooking([1], tagged)).get(1)!
  assert.equal(combined.started_at, first.started_at)
  assert.equal(combined.expires_at, first.expires_at, 'repeat inside five seconds makes no write')

  await client.query("UPDATE resident_looking SET expires_at = clock_timestamp() + interval '54 seconds'")
  const aged = (await readResidentLooking([1], tagged)).get(1)!
  await recordResidentLooking({ id: 1 }, tagged)
  const extended = (await readResidentLooking([1], tagged)).get(1)!
  assert.equal(extended.started_at, first.started_at, 'refresh keeps the burst start')
  assert.ok(Date.parse(extended.expires_at) > Date.parse(aged.expires_at), 'refresh beyond five seconds extends expiry')

  await client.query('UPDATE resident_presence SET current_place_id = 3 WHERE resident_id = 1')
  await recordResidentLooking({ id: 1 }, tagged)
  const moved = (await readResidentLooking([1], tagged)).get(1)!
  assert.equal(moved.place_id, 3)
  assert.notEqual(moved.started_at, first.started_at)
  await client.query("UPDATE resident_looking SET expires_at = clock_timestamp() - interval '1 second'")
  assert.equal((await readResidentLooking([1], tagged)).size, 0)
})
