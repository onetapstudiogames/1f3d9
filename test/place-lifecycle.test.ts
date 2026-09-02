import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parsePlaceLifecycleRequest,
  placeLifecycleRefusal,
  type PlaceLifecycleFacts,
} from '../src/place-lifecycle.ts'

const CREDIT_REQUEST_ID = 'place-lifecycle-20260901-0001'

function facts(overrides: Partial<PlaceLifecycleFacts> = {}): PlaceLifecycleFacts {
  return Object.freeze({
    exists: true,
    ownerId: 7,
    actorId: 7,
    currentName: 'Old name',
    retiredAt: null,
    parentRetiredAt: null,
    subplaceCount: 0,
    thingCount: 0,
    residentCount: 0,
    nameTaken: false,
    ...overrides,
  })
}

test('paid place lifecycle requests accept rename, retire, and restore as separate exact acts', () => {
  assert.deepEqual(
    parsePlaceLifecycleRequest({ name: 'The quiet porch' }, CREDIT_REQUEST_ID, null),
    { action: 'rename', name: 'The quiet porch', requestId: CREDIT_REQUEST_ID },
  )
  assert.deepEqual(
    parsePlaceLifecycleRequest({ retired: true }, CREDIT_REQUEST_ID, null),
    { action: 'retire', requestId: CREDIT_REQUEST_ID },
  )
  assert.deepEqual(
    parsePlaceLifecycleRequest({ retired: false }, CREDIT_REQUEST_ID, null),
    { action: 'restore', requestId: CREDIT_REQUEST_ID },
  )
})

test('paid place lifecycle requests state invalid shape and fee refusals in caller words', () => {
  assert.deepEqual(
    parsePlaceLifecycleRequest({ name: 'New', retired: true }, CREDIT_REQUEST_ID, null),
    { error: 'rename, retire, or restore one place at a time; do not mix paid acts' },
  )
  assert.deepEqual(
    parsePlaceLifecycleRequest({ name: '' }, CREDIT_REQUEST_ID, null),
    { error: 'name must be one safe line of 1-120 characters' },
  )
  assert.deepEqual(
    parsePlaceLifecycleRequest({ name: 'bad\nname' }, CREDIT_REQUEST_ID, null),
    { error: 'name must be one safe line of 1-120 characters' },
  )
  assert.deepEqual(
    parsePlaceLifecycleRequest({ retired: 'yes' }, CREDIT_REQUEST_ID, null),
    { error: 'retired must be true to retire or false to restore' },
  )
  assert.deepEqual(
    parsePlaceLifecycleRequest({ name: 'New' }, null, null),
    { error: 'rename, retire, and restore each require one city fee credit; send X-1F3D9-FEE-CREDIT' },
  )
  assert.deepEqual(
    parsePlaceLifecycleRequest({ name: 'New' }, CREDIT_REQUEST_ID, 'x402-proof'),
    { error: 'rename, retire, and restore use city fee credit only; do not send X-PAYMENT' },
  )
})

test('rename refuses a missing place, non-owner, retired place, and taken name without changing it', () => {
  assert.equal(placeLifecycleRefusal(facts({ exists: false }), { action: 'rename', name: 'New' }), 'place not found')
  assert.equal(placeLifecycleRefusal(facts({ ownerId: 9 }), { action: 'rename', name: 'New' }), 'only the place owner may rename, retire, or restore it')
  assert.equal(placeLifecycleRefusal(facts({ retiredAt: '2026-09-01T00:00:00.000Z' }), { action: 'rename', name: 'New' }), 'place is retired; restore it before renaming')
  assert.equal(placeLifecycleRefusal(facts(), { action: 'rename', name: 'Old name' }), 'place already has that name')
  assert.equal(placeLifecycleRefusal(facts({ nameTaken: true }), { action: 'rename', name: 'New' }), 'that place name is already taken inside its parent')
  assert.equal(placeLifecycleRefusal(facts(), { action: 'rename', name: 'New' }), null)
})

test('retire refuses a missing place, non-owner, already retired place, or any live occupancy', () => {
  assert.equal(placeLifecycleRefusal(facts({ exists: false }), { action: 'retire' }), 'place not found')
  assert.equal(placeLifecycleRefusal(facts({ ownerId: 9 }), { action: 'retire' }), 'only the place owner may rename, retire, or restore it')
  assert.equal(placeLifecycleRefusal(facts({ retiredAt: '2026-09-01T00:00:00.000Z' }), { action: 'retire' }), 'place is already retired')
  assert.equal(placeLifecycleRefusal(facts({ subplaceCount: 1 }), { action: 'retire' }), 'place is not empty: move or retire its 1 subplace first')
  assert.equal(placeLifecycleRefusal(facts({ thingCount: 2 }), { action: 'retire' }), 'place is not empty: move or withdraw its 2 things first')
  assert.equal(placeLifecycleRefusal(facts({ residentCount: 1 }), { action: 'retire' }), 'place is not empty: 1 resident is standing there')
  assert.equal(placeLifecycleRefusal(facts(), { action: 'retire' }), null)
})

test('restore refuses a missing place, non-owner, active place, retired parent, or newly taken name', () => {
  const retired = facts({ retiredAt: '2026-09-01T00:00:00.000Z' })
  assert.equal(placeLifecycleRefusal(facts({ exists: false }), { action: 'restore' }), 'place not found')
  assert.equal(placeLifecycleRefusal({ ...retired, ownerId: 9 }, { action: 'restore' }), 'only the place owner may rename, retire, or restore it')
  assert.equal(placeLifecycleRefusal(facts(), { action: 'restore' }), 'place is already active')
  assert.equal(
    placeLifecycleRefusal({ ...retired, parentRetiredAt: '2026-09-01T00:00:01.000Z' }, { action: 'restore' }),
    'parent place is retired; restore it before restoring this place',
  )
  assert.equal(placeLifecycleRefusal({ ...retired, nameTaken: true }, { action: 'restore' }), 'that place name is already taken inside its parent')
  assert.equal(placeLifecycleRefusal(retired, { action: 'restore' }), null)
})
