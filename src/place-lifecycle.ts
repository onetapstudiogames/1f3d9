import { parseCityCreditRequestId } from './city-credit.ts'
import { publicLabel } from './input.ts'

export type PlaceLifecycleAction =
  | Readonly<{ action: 'rename'; name: string }>
  | Readonly<{ action: 'retire' }>
  | Readonly<{ action: 'restore' }>

export type PlaceLifecycleRequest = PlaceLifecycleAction & Readonly<{ requestId: string }>

export interface PlaceLifecycleFacts {
  readonly exists: boolean
  readonly ownerId: number | null
  readonly actorId: number
  readonly currentName: string | null
  readonly retiredAt: string | null
  readonly subplaceCount: number
  readonly thingCount: number
  readonly residentCount: number
  readonly nameTaken: boolean
}

export function parsePlaceLifecycleRequest(
  body: Readonly<Record<string, unknown>>,
  creditHeader: string | null,
  paymentHeader: string | null,
): PlaceLifecycleRequest | Readonly<{ error: string }> | null {
  const hasName = Object.hasOwn(body, 'name')
  const hasRetired = Object.hasOwn(body, 'retired')
  if (!hasName && !hasRetired) return null
  if (hasName && hasRetired) {
    return { error: 'rename, retire, or restore one place at a time; do not mix paid acts' }
  }
  if (paymentHeader !== null) {
    return { error: 'rename, retire, and restore use city fee credit only; do not send X-PAYMENT' }
  }
  if (creditHeader === null) {
    return { error: 'rename, retire, and restore each require one city fee credit; send X-1F3D9-FEE-CREDIT' }
  }
  let requestId: string | null
  try {
    requestId = parseCityCreditRequestId(creditHeader)
  } catch {
    return { error: 'X-1F3D9-FEE-CREDIT must be one safe non-secret ASCII request id' }
  }
  if (requestId === null) {
    return { error: 'rename, retire, and restore each require one city fee credit; send X-1F3D9-FEE-CREDIT' }
  }
  if (hasName) {
    const name = publicLabel(body.name)
    return name === null
      ? { error: 'name must be one safe line of 1-120 characters' }
      : { action: 'rename', name, requestId }
  }
  if (typeof body.retired !== 'boolean') {
    return { error: 'retired must be true to retire or false to restore' }
  }
  return { action: body.retired ? 'retire' : 'restore', requestId }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

export function placeLifecycleRefusal(
  facts: PlaceLifecycleFacts,
  action: PlaceLifecycleAction,
): string | null {
  if (!facts.exists) return 'place not found'
  if (facts.ownerId !== facts.actorId) return 'only the place owner may rename, retire, or restore it'
  if (action.action === 'rename') {
    if (facts.retiredAt !== null) return 'place is retired; restore it before renaming'
    if (facts.currentName === action.name) return 'place already has that name'
    return facts.nameTaken ? 'that place name is already taken inside its parent' : null
  }
  if (action.action === 'restore') {
    if (facts.retiredAt === null) return 'place is already active'
    return facts.nameTaken ? 'that place name is already taken inside its parent' : null
  }
  if (facts.retiredAt !== null) return 'place is already retired'
  if (facts.subplaceCount > 0) {
    return `place is not empty: move or retire its ${facts.subplaceCount} ${plural(facts.subplaceCount, 'subplace')} first`
  }
  if (facts.thingCount > 0) {
    return `place is not empty: move or withdraw its ${facts.thingCount} ${plural(facts.thingCount, 'thing')} first`
  }
  if (facts.residentCount > 0) {
    return `place is not empty: ${facts.residentCount} ${plural(facts.residentCount, 'resident')} ${facts.residentCount === 1 ? 'is' : 'are'} standing there`
  }
  return null
}
