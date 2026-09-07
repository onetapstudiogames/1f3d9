import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { setEngineTransactionRunnerForTests, type TaggedSql } from '../../src/engine.ts'
import { runTalkNoteAction } from '../../src/note-action.ts'
import { activationDdl, assertGazetteRoomWriteRejected, gazetteRuntime, schemaDdl, startPostgres, taggedFor, withdrawalActivationDdl, withdrawalMigrationDdl } from '../helpers/gazette-fixtures/postgres.ts'
import { registerActivationTests } from './gazette-tests/activation.ts'
import { registerCutoffClockTests } from './gazette-tests/cutoff-clock.ts'
import { registerDatabaseClockTests } from './gazette-tests/database-clock.ts'
import { registerIngressTests } from './gazette-tests/ingress.ts'
import { registerMembershipLockTests } from './gazette-tests/membership-lock.ts'
import { registerPrintingTests } from './gazette-tests/printing.ts'
import { registerQuotaTests } from './gazette-tests/quota.ts'
import { registerUpgradeTests } from './gazette-tests/upgrade.ts'
import { registerWithdrawalLockTests } from './gazette-tests/withdrawal-lock.ts'
import { registerWithdrawalTests } from './gazette-tests/withdrawal.ts'
import { registerWriteTimeTests } from './gazette-tests/write-time.ts'

test('an old open Gazette upgrades through dormant withdrawal installation and activation', async t => {
  const { database, containerName } = await startPostgres()
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  setEngineTransactionRunnerForTests(async (_ignored, work) => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  await registerUpgradeTests(database)
})

test('Gazette prints and weekly submissions hold under real PostgreSQL', async t => {
  const postgres = await startPostgres()
  const { database, containerName } = postgres
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-alpha', 'integration-test', repeat('1', 64)),
      (2, 'gazette-beta', 'integration-test', repeat('2', 64)),
      (3, 'gazette-capped', 'integration-test', repeat('3', 64)),
      (5, 'gazette-neighbor', 'integration-test', repeat('5', 64)),
      (6, 'gazette-racer', 'integration-test', repeat('6', 64)),
      (8, 'gazette-cutoff', 'integration-test', repeat('8', 64)),
      (9, 'gazette-precutoff', 'integration-test', repeat('9', 64)),
      (10, 'gazette-clock', 'integration-test', repeat('a', 64)),
      (11, 'gazette-boundary', 'integration-test', repeat('b', 64)),
      (12, 'gazette-write-time', 'integration-test', repeat('c', 64)),
      (13, 'note-replay-inside', 'integration-test', repeat('d', 64)),
      (14, 'note-replay-outside', 'integration-test', repeat('e', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette test continent',
      'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world'
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      454, parent.id, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    FROM places parent
    WHERE parent.id = 2
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    VALUES (
      455, 2, 'place', 'write-time test room',
      'Integration-only room for note write-time and replay proofs.', 12,
      FALSE, FALSE, TRUE
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES
      (1, 454, 454),
      (2, 454, 454),
      (3, 454, 454),
      (5, 454, 454),
      (6, 454, 454),
      (8, 454, 454),
      (9, 454, 454),
      (10, 454, 454),
      (11, 454, 454),
      (12, 455, 455),
      (13, 455, 455),
      (14, 455, 455)
    ON CONFLICT (resident_id) DO UPDATE SET current_place_id = 454;
  `)

  const sql = taggedFor(database)
  const postgresTransactionRunner = async (
    _ignored: TaggedSql,
    work: (transaction: TaggedSql, transactionOwned: boolean) => Promise<unknown>,
  ): Promise<unknown> => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  setEngineTransactionRunnerForTests(postgresTransactionRunner)

  await database.query(activationDdl)

  await registerWriteTimeTests(t, database, sql, postgresTransactionRunner)
  await registerIngressTests(t, database)
  await registerPrintingTests(t, database, sql)
  await registerQuotaTests(t, database, sql)
  await registerCutoffClockTests(t, database, sql)
  await registerMembershipLockTests(t, database)
  await registerDatabaseClockTests(t, database)
})

test('Gazette withdrawal is author-only, keeps its weekly slot, and prints a notice', async t => {
  const { database, containerName } = await startPostgres()
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-founder', 'integration-test', repeat('1', 64)),
      (2, 'gazette-author', 'integration-test', repeat('2', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette withdrawal test continent',
      'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world';

    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    );

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (1, 454, 454), (2, 454, 454);
  `)
  await database.query(withdrawalMigrationDdl)
  await database.query(activationDdl)
  await database.query(withdrawalActivationDdl)

  const sql = taggedFor(database)
  const publicDatabase = Object.freeze({
    query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows,
  })
  const transactionRunner = async (
    _ignored: TaggedSql,
    work: (transaction: TaggedSql, atomic: boolean) => Promise<unknown>,
  ): Promise<unknown> => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  setEngineTransactionRunnerForTests(transactionRunner)
  const submit = (residentId: number, residentHandle: string, text: string) => (
    runTalkNoteAction({ placeId: 454, residentId, residentHandle, text }, sql)
  )

  await registerWithdrawalTests(database, sql, publicDatabase, submit, transactionRunner)
})

test('Gazette withdrawal and printing serialize on the shared weekly lock', async t => {
  const { database, containerName } = await startPostgres()
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-founder', 'integration-test', repeat('1', 64)),
      (2, 'gazette-withdrawal-first', 'integration-test', repeat('2', 64)),
      (3, 'gazette-printer-first', 'integration-test', repeat('3', 64)),
      (12, 'gazette-tick-boundary', 'integration-test', repeat('4', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette lock test continent',
      'Integration-only parent for Gazette lock-order tests.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world';

    INSERT INTO places (
      id, parent_id, place_kind, name, description, purpose, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '', 1, FALSE, FALSE, FALSE
    );

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (1, 454, 454), (2, 454, 454), (3, 454, 454), (12, 454, 454);
  `)
  await database.query(withdrawalMigrationDdl)
  await database.query(activationDdl)
  await database.query(withdrawalActivationDdl)
  setEngineTransactionRunnerForTests(null)

  const printGazetteIssuesDue = gazetteRuntime.printGazetteIssuesDue!
  const cycle = gazetteRuntime.gazetteCycleFor(new Date())
  const publicDatabase = Object.freeze({
    query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows,
  })
  const waitState = async (operation: Promise<unknown>): Promise<'settled' | 'waiting'> => (
    Promise.race([
      operation.then(() => 'settled' as const, () => 'settled' as const),
      delay(100).then(() => 'waiting' as const),
    ])
  )

  await registerWithdrawalLockTests(t, database, printGazetteIssuesDue, cycle, publicDatabase, waitState)
})

test('Gazette schema stays dormant until the post-deploy room activation and both rerun cleanly', async t => {
  const { database, containerName } = await startPostgres()
  t.after(async () => {
    setEngineTransactionRunnerForTests(null)
    await database.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', containerName], {
      encoding: 'utf8',
      windowsHide: true,
    })
  })

  await database.query(schemaDdl)
  await database.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    VALUES
      (1, 'gazette-founder', 'integration-test', repeat('1', 64)),
      (2, 'gazette-neighbor', 'integration-test', repeat('2', 64));

    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    )
    SELECT
      2, world.id, 'continent', 'gazette test continent',
      'Integration-only parent for the Gazette room.', 1,
      FALSE, FALSE, FALSE
    FROM places world
    WHERE world.place_kind = 'world';
  `)
  await assertGazetteRoomWriteRejected(database, `
    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      1, FALSE, FALSE, TRUE
    );
  `)
  await database.query(`
    INSERT INTO places (
      id, parent_id, place_kind, name, description, owner_id,
      open_to_building, open_to_things, open_to_notes
    ) VALUES (
      454, 2, 'place', 'the gazette submission room',
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      1, FALSE, FALSE, FALSE
    );

    INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
    VALUES (1, 454, 454);
  `)

  const sql = taggedFor(database)
  const publicDatabase = Object.freeze({
    query: async (text: string, params: readonly unknown[] = []) => (
      await database.query(text, [...params])
    ).rows,
  })
  setEngineTransactionRunnerForTests(async (_ignored, work) => {
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      const result = await work(taggedFor(client), true)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  })

  await database.query(
    'GRANT SELECT ON city_snapshot.public_records TO city_snapshot_export',
  )

  await registerActivationTests(t, database, sql, publicDatabase)
})
