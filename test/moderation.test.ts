import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODERATED_TEXT,
  MODERATION_ACTIONS,
  MODERATION_REASON_MAX_BYTES,
  MODERATION_TARGET_TYPES,
  deriveModerationStates,
  isModerated,
  latestModerationAction,
  moderationAction,
  moderationInput,
  moderationReason,
  moderationStateFromActions,
  moderationTargetType,
  redactAgreement,
  redactKind,
  redactModeratedTarget,
  redactNote,
  redactPlace,
  redactThing,
  redactTrait,
  type ModerationActionRow,
} from '../src/moderation.ts'

test('the moderation vocabulary is frozen and has no governance powers', () => {
  assert.deepEqual(MODERATION_TARGET_TYPES, [
    'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement',
  ])
  assert.deepEqual(MODERATION_ACTIONS, ['remove', 'restore'])
  assert.equal(Object.isFrozen(MODERATION_TARGET_TYPES), true)
  assert.equal(Object.isFrozen(MODERATION_ACTIONS), true)

  for (const targetType of MODERATION_TARGET_TYPES) {
    assert.equal(moderationTargetType(targetType), targetType)
  }
  for (const action of MODERATION_ACTIONS) assert.equal(moderationAction(action), action)

  for (const value of ['event', ' place', 'PLACE', '', null, 1]) {
    assert.equal(moderationTargetType(value), null)
  }
  for (const value of ['pin', 'unpin', 'delete', ' remove', 'REMOVE', '', null, 1]) {
    assert.equal(moderationAction(value), null)
  }
})

test('public moderation reasons are safe, nonempty, and capped at 4000 UTF-8 bytes', () => {
  assert.equal(MODERATION_REASON_MAX_BYTES, 4_000)
  assert.equal(moderationReason('public reason'), 'public reason')
  assert.equal(moderationReason('line one\nline two'), 'line one\nline two')
  assert.equal(moderationReason('x'.repeat(MODERATION_REASON_MAX_BYTES)), 'x'.repeat(4_000))
  assert.equal(moderationReason('\u{1f3d9}'.repeat(1_000)), '\u{1f3d9}'.repeat(1_000))

  for (const value of [
    '',
    ' \r\n\t ',
    'x'.repeat(MODERATION_REASON_MAX_BYTES + 1),
    '\u{1f3d9}'.repeat(1_001),
    'unsafe\u0000text',
    'spoof\u202Etext',
    42,
    null,
  ]) {
    assert.equal(moderationReason(value), null)
  }
})

test('a moderation request has an exact shape and never coerces IDs or verbs', () => {
  const parsed = moderationInput({
    action: 'remove',
    target_type: 'thing',
    target_id: 41,
    reason: 'illegal public content',
  })

  assert.deepEqual(parsed, {
    action: 'remove',
    target_type: 'thing',
    target_id: 41,
    reason: 'illegal public content',
  })
  assert.equal(Object.isFrozen(parsed), true)

  const invalid = [
    null,
    [],
    { action: 'remove', target_type: 'thing', target_id: '41', reason: 'reason' },
    { action: 'remove', target_type: 'thing', target_id: 0, reason: 'reason' },
    { action: 'remove', target_type: 'thing', target_id: 1.5, reason: 'reason' },
    { action: 'pin', target_type: 'note', target_id: 1, reason: 'reason' },
    { action: 'remove', target_type: 'thing', target_id: 1, reason: '' },
    { action: 'remove', target_type: 'thing', target_id: 1, reason: 'reason', owner_id: 9 },
  ]
  for (const value of invalid) assert.equal(moderationInput(value), null)

  const decorated = {
    action: 'remove', target_type: 'thing', target_id: 1, reason: 'reason',
  } as Record<PropertyKey, unknown>
  decorated[Symbol('hidden')] = true
  assert.equal(moderationInput(decorated), null)
})

test('resident moderation keeps public identity but clears its drawing', () => {
  const source = {
    id: 7,
    handle: 'tiny-lantern',
    drawing: { palette: ['#ad3f25'], indices: Array.from({ length: 64 }, () => 0) },
  }
  const redacted = redactModeratedTarget('resident', source)

  assert.deepEqual(redacted, {
    id: 7,
    handle: 'tiny-lantern',
    drawing: null,
    moderated: true,
  })
  assert.notEqual(redacted, source)
  assert.notEqual(source.drawing, null)
})

test('target redactors remove authored payloads and retain public history', () => {
  const records = [
    {
      targetType: 'place' as const,
      record: {
        id: 2, parent_id: 1, owner_id: 7, owner: 'keeper', created_at: '2026-08-11T01:00:00Z',
        name: 'unsafe place name', description: 'unsafe place description', open_to_notes: true,
      },
      redact: redactPlace,
      displayFields: ['name', 'description'],
    },
    {
      targetType: 'thing' as const,
      record: {
        id: 3, place_id: 2,
        maker_id: 6, made_by: 'first-maker',
        current_owner_id: 7, current_owner: 'keeper', owner_id: 7, owner: 'keeper',
        created_at: '2026-08-11T01:01:00Z',
        name: 'unsafe thing name', body: 'unsafe thing body', kind_id: 4,
      },
      redact: redactThing,
      displayFields: ['name', 'body'],
    },
    {
      targetType: 'kind' as const,
      record: {
        id: 4, owner_id: 7, owner: 'keeper', created_at: '2026-08-11T01:02:00Z',
        name: 'unsafe_kind', description: 'unsafe kind description', recipe: [{ kind: 'wood', quantity: 1 }],
      },
      redact: redactKind,
      displayFields: ['name', 'description'],
    },
    {
      targetType: 'trait' as const,
      record: {
        id: 5, coiner_id: 7, coiner: 'keeper', created_at: '2026-08-11T01:03:00Z',
        name: 'unsafe_trait', description: 'unsafe trait description', recipe: null,
      },
      redact: redactTrait,
      displayFields: ['name', 'description'],
    },
    {
      targetType: 'note' as const,
      record: {
        id: 6, place_id: 2, author_id: 7, author: 'keeper', created_at: '2026-08-11T01:04:00Z',
        body: 'unsafe note body',
      },
      redact: redactNote,
      displayFields: ['body'],
    },
    {
      targetType: 'agreement' as const,
      record: {
        id: 8, created_by_id: 7, created_by: 'keeper', created_at: '2026-08-11T01:05:00Z',
        body: 'unsafe agreement body', parties: ['keeper', 'neighbor'], signatures: ['keeper'],
      },
      redact: redactAgreement,
      displayFields: ['body'],
    },
  ]

  for (const { targetType, record, redact, displayFields } of records) {
    const original = structuredClone(record)
    const redacted = redact(record)
    const dispatched = redactModeratedTarget(targetType, record)

    assert.notEqual(redacted, record)
    assert.deepEqual(record, original)
    assert.equal(redacted.moderated, true)
    assert.equal(Object.isFrozen(redacted), true)
    assert.deepEqual(dispatched, redacted)
    const redactedRecord: Readonly<Record<string, unknown>> = redacted
    const sourceRecord: Readonly<Record<string, unknown>> = record
    for (const field of displayFields) assert.equal(redactedRecord[field], MODERATED_TEXT)
    for (const field of [
      'id', 'maker_id', 'made_by', 'current_owner_id', 'current_owner',
      'owner_id', 'owner', 'coiner_id', 'coiner', 'author_id', 'author',
      'created_by_id', 'created_by', 'created_at',
    ]) {
      if (field in sourceRecord) assert.equal(redactedRecord[field], sourceRecord[field])
    }
    if (targetType === 'kind') {
      assert.deepEqual(redactedRecord.traits, [])
      assert.equal(redactedRecord.recipe, null)
    }
    if (targetType === 'trait') {
      assert.equal(redactedRecord.recipe, null)
      assert.equal(redactedRecord.mechanical, false)
    }
  }
})

test('kind tombstones erase nested public data without changing the source row', () => {
  const source = {
    id: 4,
    owner_id: 7,
    owner: 'keeper',
    created_at: '2026-08-11T01:02:00Z',
    name: 'unsafe_kind',
    description: 'unsafe kind description',
    recipe: [{ kind: 'wood', quantity: 1 }],
    traits: ['carved'],
  }

  const redacted = redactKind(source)

  assert.equal(redacted.recipe, null)
  assert.deepEqual(redacted.traits, [])
  assert.equal(Object.isFrozen(redacted.traits), true)
  assert.equal(source.recipe[0]?.quantity, 1)
  assert.deepEqual(source.traits, ['carved'])
})

test('the latest append-only action decides each target state independent of row order', () => {
  const rows: ModerationActionRow[] = [
    {
      id: 13, target_type: 'thing', target_id: 41, action: 'remove', actor_id: 1,
      reason: 'removed again', created_at: '2026-08-11T03:00:00.000Z',
    },
    {
      id: 10, target_type: 'thing', target_id: 41, action: 'remove', actor_id: 1,
      reason: 'first removal', created_at: '2026-08-11T01:00:00.000Z',
    },
    {
      id: 12, target_type: 'note', target_id: 51, action: 'remove', actor_id: 1,
      reason: 'note removal', created_at: '2026-08-11T02:00:00.000Z',
    },
    {
      id: 11, target_type: 'thing', target_id: 41, action: 'restore', actor_id: 1,
      reason: 'first restoration', created_at: '2026-08-11T02:00:00.000Z',
    },
    {
      id: 14, target_type: 'thing', target_id: 41, action: 'restore', actor_id: 1,
      reason: 'latest wins by id when timestamps tie', created_at: '2026-08-11T03:00:00.000Z',
    },
  ]

  assert.equal(latestModerationAction(rows, 'thing', 41)?.id, 14)
  assert.equal(latestModerationAction(rows, 'place', 41), null)
  assert.equal(isModerated(rows, 'thing', 41), false)
  assert.equal(isModerated(rows, 'note', 51), true)
  assert.deepEqual(moderationStateFromActions(rows, 'thing', 41), {
    target_type: 'thing',
    target_id: 41,
    moderated: false,
    latest_action: rows[4],
  })
  assert.deepEqual(moderationStateFromActions(rows, 'agreement', 99), {
    target_type: 'agreement',
    target_id: 99,
    moderated: false,
    latest_action: null,
  })

  const states = deriveModerationStates(rows)
  assert.deepEqual(states.map(state => [state.target_type, state.target_id, state.moderated]), [
    ['thing', 41, false],
    ['note', 51, true],
  ])
  assert.equal(Object.isFrozen(states), true)
  assert.equal(states.every(Object.isFrozen), true)
})

test('BIGSERIAL text IDs break timestamp ties without unsafe number conversion', () => {
  const rows: ModerationActionRow[] = [
    {
      id: '9007199254740992', target_type: 'place', target_id: 2, action: 'remove', actor_id: 1,
      reason: 'remove', created_at: '2026-08-11T03:00:00.000Z',
    },
    {
      id: '9007199254740993', target_type: 'place', target_id: 2, action: 'restore', actor_id: 1,
      reason: 'restore', created_at: '2026-08-11T03:00:00.000Z',
    },
  ]

  assert.equal(latestModerationAction(rows, 'place', 2)?.action, 'restore')
})
