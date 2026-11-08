// One city with a thing in each of the five ending states, an end trait, the end-try
// gates, a copy, an agreement naming things, an open world offer on a thing whose end is
// set and one on a thing whose end has come, and two private canaries. Every time is
// relative to the database clock, so the fixture never ages into a different state.
// The snapshot v4 test, the offer route test and the v4 parity test share it.
//
// It writes raw SQL under the thing endings guards: labels go on before an end falls
// due, a thing becomes due by an UPDATE while it is not yet due, the end is recorded with
// the recorder's writer in the same statement, and the thing_ended event is inserted
// directly, because the recorder does not exist yet.

export type FixtureQueryable = Readonly<{
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}>

export const FIVE_STATES_RESIDENTS = Object.freeze({
  founder: Object.freeze({ id: 1, handle: 'ending-founder' }),
  maker: Object.freeze({ id: 2, handle: 'ending-maker' }),
  visitor: Object.freeze({ id: 3, handle: 'ending-visitor' }),
  buyer: Object.freeze({ id: 5, handle: 'ending-buyer' }),
})

export const FIVE_STATES_PAYMENT_CANARY = 'FIVE_STATES_PRIVATE_PAYMENT_CANARY_7316'
export const FIVE_STATES_WALLET = `0x${'2a'.repeat(20)}`

export type FiveStatesFixture = Readonly<{
  rooms: Readonly<{ home: number; visitors: number; retired: number }>
  kinds: Readonly<{ lamp: number; stone: number }>
  endTraitId: number
  things: Readonly<{
    notPermitted: number
    unset: number
    kindlessUnset: number
    kindlessGiven: number
    active: number
    activeTimed: number
    due: number
    remnant: number
    ran: number
    wakeOff: number
    carried: number
    visiting: number
    blocked: number
    retiredRoom: number
  }>
  offers: Readonly<{ active: number; due: number }>
  agreementId: number
  endedEventIds: readonly number[]
}>

async function one(db: FixtureQueryable, text: string, values: unknown[] = []): Promise<number> {
  const row = (await db.query(text, values)).rows[0]
  if (!row || row.id === undefined) throw new Error(`fixture statement returned no id: ${text.slice(0, 80)}`)
  return Number(row.id)
}

type ThingOptions = Readonly<{
  room: number
  name: string
  kind?: number | null
  wake?: boolean
  heldBy?: number | null
  parent?: number | null
}>

async function thing(db: FixtureQueryable, options: ThingOptions): Promise<number> {
  const kind = options.kind ?? null
  return one(db, `
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision,
      wake_enabled, held_by, parent_thing_id, family_id, generation
    ) VALUES (
      $1, $2, $3, $4, $5, $6::integer, $7::integer, $7::integer, $8, $9::integer,
      $10::integer, $10::integer, CASE WHEN $10::integer IS NULL THEN 0 ELSE 1 END
    ) RETURNING id
  `, [
    options.room, options.name, `the body of ${options.name}`,
    FIVE_STATES_RESIDENTS.maker.id, FIVE_STATES_RESIDENTS.maker.id,
    kind, kind === null ? null : 1, options.wake ?? true, options.heldBy ?? null, options.parent ?? null,
  ])
}

async function label(db: FixtureQueryable, thingId: number, name: string): Promise<void> {
  await db.query(`
    INSERT INTO active_labels (target_type, target_id, label, actor_id)
    VALUES ('thing', $1, $2, $3)
  `, [thingId, name, FIVE_STATES_RESIDENTS.maker.id])
}

async function worldOffer(db: FixtureQueryable, thingId: number, draftId: number): Promise<number> {
  const offerId = await one(db, `
    INSERT INTO transfer_offers (
      channel, asset_type, asset_id, seller_id, price_usdc, seller_wallet, market_origin, market_draft_id
    ) VALUES ('world', 'thing', $1, $2, 3.000000, $3, 'https://1f3ea.com', $4)
    RETURNING id
  `, [thingId, FIVE_STATES_RESIDENTS.maker.id, FIVE_STATES_WALLET, draftId])
  await db.query('UPDATE things SET active_offer_id = $1 WHERE id = $2', [offerId, thingId])
  return offerId
}

const LAMP_GRANT = {
  kind_id: 0,
  revision: 1,
  allowed: ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'],
  limits: { max_seconds: 31_622_400, max_uses: 10_000, labels: ['spent'] },
  city_limits_version: 1,
}

/** A time relative to the database clock, as an ISO string, so a rule and its columns agree. */
async function dbTime(db: FixtureQueryable, offset: string): Promise<string> {
  const row = (await db.query(
    `SELECT to_char((now() + $1::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
    [offset],
  )).rows[0]
  return String(row!.at)
}

/** Give a thing that has no end the stored shape of an owner's end. */
async function setEnd(
  db: FixtureQueryable,
  thingId: number,
  rule: unknown,
  columns: Readonly<{
    grant: unknown
    setAt: string
    deadline?: string | null
    idleSeconds?: number | null
    idleAnchor?: string | null
    usesLeft?: number | null
    label?: string | null
    copiedFrom?: number | null
    copiedAt?: string | null
  }>,
): Promise<void> {
  await db.query(`
    UPDATE things SET
      ending_rule = $2::jsonb,
      ending_grant = $3::jsonb,
      ending_set_by = owner_id,
      ending_set_at = $4::timestamptz,
      ending_deadline = $5::timestamptz,
      ending_idle_seconds = $6::integer,
      ending_idle_anchor = $7::timestamptz,
      ending_uses_left = $8::integer,
      ending_label = $9::text,
      ending_copied_from = $10::integer,
      ending_copied_at = $11::timestamptz
    WHERE id = $1
  `, [
    thingId, JSON.stringify(rule), JSON.stringify(columns.grant), columns.setAt,
    columns.deadline ?? null, columns.idleSeconds ?? null, columns.idleAnchor ?? null,
    columns.usesLeft ?? null, columns.label ?? null, columns.copiedFrom ?? null, columns.copiedAt ?? null,
  ])
}

/** Record a due thing's end the way the recorder will: its own writer, in the same statement. */
async function recordEnd(db: FixtureQueryable, thingId: number, cause: string): Promise<number> {
  await db.query(`
    UPDATE things SET
      ended_at = thing_end_due_at(id),
      ended_cause = $2,
      ended_owner_id = owner_id,
      end_program_state = 'pending'
    WHERE id = $1
      AND (SELECT set_config('city.ending_writer', 'record:' || $1::text, true)) IS NOT NULL
  `, [thingId, cause])
  return one(db, `
    INSERT INTO events (kind, actor, detail)
    SELECT 'thing_ended', 'the city', jsonb_build_object(
      'thing_id', thing.id, 'place_id', thing.place_id, 'cause', thing.ended_cause,
      'ended_at', thing.ended_at, 'owner_id', owner.id, 'owner', owner.handle,
      'program_state', thing.end_program_state
    )
    FROM things thing JOIN residents owner ON owner.id = thing.ended_owner_id
    WHERE thing.id = $1
    RETURNING id
  `, [thingId])
}

async function residents(db: FixtureQueryable): Promise<void> {
  for (const resident of Object.values(FIVE_STATES_RESIDENTS)) {
    await db.query(`
      INSERT INTO residents (id, handle, model, secret_hash, joined_at)
      VALUES ($1, $2, 'five-states', $3, now() - interval '30 days')
    `, [resident.id, resident.handle, String(resident.id).repeat(64)])
  }
  await db.query('UPDATE resident_id_allocator SET last_id = 5 WHERE singleton')
}

async function rooms(db: FixtureQueryable): Promise<FiveStatesFixture['rooms']> {
  const worldId = Number((await db.query(`SELECT id FROM places WHERE place_kind = 'world'`)).rows[0]!.id)
  const continent = await one(db, `
    INSERT INTO places (parent_id, place_kind, name, description, owner_id)
    VALUES ($1, 'continent', 'Ending Continent', 'land for endings', 1) RETURNING id
  `, [worldId])
  const room = (name: string, owner: number) => one(db, `
    INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
    VALUES ($1, 'place', $2, 'a room for endings', $3, TRUE) RETURNING id
  `, [continent, name, owner])
  return Object.freeze({
    home: await room('Ending Home', FIVE_STATES_RESIDENTS.maker.id),
    visitors: await room('Ending Visitors', FIVE_STATES_RESIDENTS.founder.id),
    retired: await room('Ending Retired', FIVE_STATES_RESIDENTS.maker.id),
  })
}

async function kinds(db: FixtureQueryable): Promise<Readonly<{ lamp: number; stone: number; endTraitId: number }>> {
  const maker = FIVE_STATES_RESIDENTS.maker
  const endTraitId = await one(db, `
    INSERT INTO traits (name, description, recipe, coiner_id)
    VALUES ('end-glow', 'glows once at its end', '{"end": {"then": []}}'::jsonb, $1) RETURNING id
  `, [maker.id])
  const lamp = await one(db, `INSERT INTO kinds (name, owner_id) VALUES ('ending-lamp', $1) RETURNING id`, [maker.id])
  await db.query(`
    INSERT INTO kind_revisions (kind_id, revision, traits, ending_policy)
    VALUES ($1, 1, ARRAY['end-glow'], $2::jsonb)
  `, [lamp, JSON.stringify({
    allowed: ['uses', 'at', 'after_setting_seconds', 'idle_seconds', 'label_added'],
    labels: ['spent'],
  })])
  await db.query(`
    INSERT INTO events (kind, actor, detail, at)
    VALUES ('kind_invented', $1, jsonb_build_object('kind_id', $2::integer, 'name', 'ending-lamp', 'revision', 1),
      now() - interval '10 days')
  `, [maker.handle, lamp])
  await db.query('UPDATE kinds SET invented_by = $2 WHERE id = $1', [lamp, maker.id])
  const stone = await one(db, `INSERT INTO kinds (name, owner_id) VALUES ('plain-stone', $1) RETURNING id`, [maker.id])
  await db.query('INSERT INTO kind_revisions (kind_id, revision) VALUES ($1, 1)', [stone])
  return Object.freeze({ lamp, stone, endTraitId })
}

/** Seed the five-states city into a database built from db/schema.sql. */
export async function seedFiveStates(db: FixtureQueryable): Promise<FiveStatesFixture> {
  await residents(db)
  const room = await rooms(db)
  const kind = await kinds(db)
  const lampGrant = { ...LAMP_GRANT, kind_id: kind.lamp }
  const lamp = (name: string, extra: Partial<ThingOptions> = {}) =>
    thing(db, { room: room.home, name, kind: kind.lamp, ...extra })

  const notPermitted = await thing(db, { room: room.home, name: 'plain stone', kind: kind.stone })
  const unset = await lamp('quiet lamp')
  await label(db, unset, 'shiny')
  const kindlessUnset = await thing(db, { room: room.home, name: 'kindless pebble' })
  const kindlessGiven = await thing(db, { room: room.home, name: 'given pebble' })
  await db.query('UPDATE things SET owner_id = $2 WHERE id = $1', [kindlessGiven, FIVE_STATES_RESIDENTS.visitor.id])

  // An end set and not yet come: a date, a number of uses, and a watched label.
  const active = await lamp('counting lamp')
  await label(db, active, 'bright')
  const activeAt = await dbTime(db, '10 days')
  await setEnd(db, active, { any: [{ at: activeAt }, { uses: 5 }, { label_added: 'spent' }] }, {
    grant: lampGrant, setAt: await dbTime(db, '-1 hour'), deadline: activeAt, usesLeft: 3, label: 'spent',
  })
  const activeOffer = await worldOffer(db, active, 9101)

  // An end set for a day after setting and for an hour without use.
  const activeTimed = await lamp('timed lamp')
  const timedSetAt = await dbTime(db, '-2 hours')
  await setEnd(db, activeTimed, { any: [{ after_setting_seconds: 86_400 }, { idle_seconds: 3_600 }] }, {
    grant: lampGrant, setAt: timedSetAt,
    deadline: new Date(Date.parse(timedSetAt) + 86_400_000).toISOString(),
    idleSeconds: 3_600, idleAnchor: await dbTime(db, '-10 minutes'),
  })

  // Due and not recorded: its date passed an hour ago. Its labels stay as rows.
  const due = await lamp('due lamp')
  await label(db, due, 'worn')
  const dueOffer = await worldOffer(db, due, 9102)
  const dueAt = await dbTime(db, '-1 hour')
  await setEnd(db, due, { any: [{ at: dueAt }] }, {
    grant: lampGrant, setAt: await dbTime(db, '-3 hours'), deadline: dueAt,
  })

  // A recorded remnant that is also a copy of the counting lamp, in a room whose owner
  // is not its owner: its date passed half an hour ago, its unused-for end at a fixed time.
  const remnant = await lamp('copied lamp', { room: room.visitors, parent: active })
  await label(db, remnant, 'old')
  const remnantAt = await dbTime(db, '-30 minutes')
  // A copy's until is always written as copyRuleFrom writes it (toISOString, milliseconds).
  const remnantUntil = new Date(await dbTime(db, '-20 minutes')).toISOString()
  const copiedAt = await dbTime(db, '-2 hours')
  await setEnd(db, remnant, { any: [{ at: remnantAt }, { idle_seconds: 3_600, until: remnantUntil }] }, {
    grant: lampGrant, setAt: copiedAt, deadline: remnantAt, copiedFrom: active, copiedAt,
  })
  const remnantEvent = await recordEnd(db, remnant, 'at')

  // A remnant whose end program already ran.
  const ran = await lamp('spent lamp')
  await setEnd(db, ran, { any: [{ uses: 1 }] }, { grant: lampGrant, setAt: await dbTime(db, '-1 day'), usesLeft: 1 })
  await db.query(`
    UPDATE things SET ending_uses_left = 0, ending_uses_spent_at = now() - interval '5 hours' WHERE id = $1
  `, [ran])
  const ranEvent = await recordEnd(db, ran, 'uses')
  await db.query(`
    UPDATE things SET end_program_state = 'ran', end_program_result = '{"effects_applied": 0}'::jsonb
    WHERE id = $1
      AND (SELECT set_config('city.ending_writer', 'end_try:' || $1::text, true)) IS NOT NULL
  `, [ran])

  // One end-try gate closed on each of these lamps, which have no end set.
  const wakeOff = await lamp('sleeping lamp', { wake: false })
  const carried = await lamp('carried lamp', { heldBy: FIVE_STATES_RESIDENTS.maker.id })
  const visiting = await lamp('visiting lamp', { room: room.visitors })
  const blocked = await lamp('blocked lamp')
  await db.query('UPDATE places SET wake_block_thing_ids = ARRAY[$2::integer] WHERE id = $1', [room.home, blocked])
  const retiredRoom = await lamp('retired-room lamp', { room: room.retired })
  await db.query('UPDATE places SET retired_at = now() WHERE id = $1', [room.retired])

  const agreementId = await one(db, `
    INSERT INTO agreements (created_by_id, body) VALUES ($1, 'we name these things') RETURNING id
  `, [FIVE_STATES_RESIDENTS.maker.id])
  await db.query('INSERT INTO agreement_parties (agreement_id, resident_id) VALUES ($1, $2)', [
    agreementId, FIVE_STATES_RESIDENTS.maker.id,
  ])
  for (const [position, thingId] of [active, remnant, notPermitted, due].entries()) {
    await db.query('INSERT INTO agreement_thing_links (agreement_id, position, thing_id) VALUES ($1, $2, $3)', [
      agreementId, position, thingId,
    ])
  }

  await db.query(`
    INSERT INTO payment_attempts (public_id, actor_id, operation, status, request_json)
    VALUES ('five-states-private-attempt', $1, 'frontier', 'expired', jsonb_build_object('note', $2::text))
  `, [FIVE_STATES_RESIDENTS.buyer.id, FIVE_STATES_PAYMENT_CANARY])
  await db.query('INSERT INTO thing_later_holder_marks (resident_id, thing_id) VALUES ($1, $2)', [
    FIVE_STATES_RESIDENTS.maker.id, notPermitted,
  ])

  return Object.freeze({
    rooms: room,
    kinds: Object.freeze({ lamp: kind.lamp, stone: kind.stone }),
    endTraitId: kind.endTraitId,
    things: Object.freeze({
      notPermitted, unset, kindlessUnset, kindlessGiven, active, activeTimed, due, remnant, ran,
      wakeOff, carried, visiting, blocked, retiredRoom,
    }),
    offers: Object.freeze({ active: activeOffer, due: dueOffer }),
    agreementId,
    endedEventIds: Object.freeze([remnantEvent, ranEvent]),
  })
}
