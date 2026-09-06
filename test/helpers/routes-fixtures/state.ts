import { SELLER_WALLET, TREASURY } from './environment.ts'



interface DbCall { url: string; query?: string; params?: unknown[] }
interface OfferState {
  id: number
  channel?: 'direct' | 'world'
  status: 'open' | 'canceled' | 'claimed'
  reservedAt?: string | null
  reservedUntil: string | null
  buyerWallet?: string | null
}
interface FakePaymentAttempt {
  public_id: string
  actor_id: number
  counterparty_id: number | null
  operation: string
  target_key: string | null
  offer_id: number | null
  asset_type: string | null
  asset_id: number | null
  request_hash: string
  method: string | null
  network: string | null
  token: string | null
  payer_wallet: string | null
  payee_wallet: string | null
  amount_units: string | null
  x402_nonce: string | null
  x402_payload_digest: string | null
  x402_valid_after: string | null
  x402_valid_before: string | null
  start_block: string | null
  start_time: string | null
  end_time: string | null
  status: 'settling' | 'payment_pending' | 'completed' | 'credit_returned' | 'invalid' | 'expired' | 'needs_review' | 'founder_review'
  lease_owner: string | null
  lease_expires_at: string | null
  recovery_started_at?: string | null
  recovery_deadline_at?: string | null
  tx_hash: string | null
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  invalid_reason: string | null
  result_json: Record<string, unknown> | null
  response_status: number | null
  response_json: Record<string, unknown> | null
  response_body_bytes?: Buffer | null
  created_at: string
  updated_at: string
  completed_at: string | null
  request_json?: Record<string, unknown> | null
}
interface FakeCityCreditEntry {
  id: string
  resident_id: number
  entry_kind: 'founder_issue' | 'spend' | 'return'
  amount_units: string
  founder_id: number | null
  source_key: string | null
  request_id: string | null
  payment_attempt_id: string | null
  related_spend_id: string | null
  reason: string | null
  created_at: string
}
interface FakeLaterHolderItem {
  mark_id: string
  id: number
  title: string
  place_id: number
  place_title: string
  date: string
  body_text_bytes: number
}
interface FakeRecentNote {
  id: number
  place_id: number
  author_id: number
  author: string
  body: string
  created_at: string
}
interface FakeResidentRefusalState {
  httpStatus: number
  causeHash: string
  repetitionCount: number
}
interface FakeFounderPayPalDispute {
  dispute_id: string
  state: 'open' | 'resolved_seller' | 'resolved_against_seller' | 'resolution_review'
  decision: 'seller_favour' | 'buyer_favour' | null
}
interface FakeFounderPayPalDisputeEvent {
  kind: 'payment_repair'
  actor: string
  detail: Readonly<{
    action: 'credit_dispute_seller_favour' | 'credit_dispute_buyer_favour'
  }>
}
interface FakeCommunityToolSubmission {
  id: number
  title: string
  url: string
  operator_name: string
  description: string
  resident_id: number | null
  resident_handle: string | null
  category: 'Browse' | 'Create' | 'Connect' | 'Learn'
  tags: string[]
  submitter_ip_hash: string | null
  created_at: string
  reviewed_at: string | null
  reviewed_by: number | null
  review_outcome: 'listed' | 'declined' | null
}
interface FakePaidCompletionFailure {
  message: string
  code?: string
  constraint?: string
}
const paidCompletionError = (failure: FakePaidCompletionFailure) => Object.assign(
  new Error(failure.message),
  {
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.constraint ? { constraint: failure.constraint } : {}),
  },
)
type LawRecipe = Record<string, unknown>
interface FakeState {
  scenario: string
  calls: DbCall[]
  authValid: boolean
  actorId: number
  actorHandle: string
  currentPlaceId: number | null
  homePlaceId: number | null
  placeOwnerId: number
  openToBuilding: boolean
  openToThings: boolean
  openToNotes: boolean
  quiet: boolean
  gazetteActivated: boolean
  gazetteWithdrawalsOpen: boolean
  quota: { things: boolean; notes: boolean; agreements: boolean }
  agreementParties: string[]
  agreementAcceded: string[]
  agreementAccessionOpen: boolean
  agreementCreatorId: number
  agreementExists: boolean
  thingOwnerId: number
  thingKindId: number | null
  thingCurrentRevision: number | null
  thingDrawingVariant: string | null
  thingOpenToUse: boolean
  thingWithdrawn: boolean
  targetThingOwnerId: number
  targetThingPlaceId: number
  targetThingKindId: number | null
  targetThingOpenToUse: boolean
  targetThingWithdrawn: boolean
  kindOwnerId: number
  kindRevision: number
  kindDrawing: unknown
  kindDrawingState: 'in_progress' | 'complete' | null
  kindDrawingDescription: string | null
  kindDrawingVariants: unknown[]
  kindRecipe: unknown
  traitHasRecipe: boolean
  kindTraitNames: string[]
  thingTraitRecipe: unknown
  lawTraitName: string
  lawTraitRecipe: LawRecipe | null
  placeLawNames: string[]
  actorLabels: string[]
  placeLabels: string[]
  actionBlocked: boolean
  damageAllowed: boolean
  scheduledLabelAt: number | null
  pendingResolved: boolean
  noteRemoved: boolean
  notePinned: boolean
  moderatedPlaceIds: number[]
  moderatedKindIds: number[]
  moderatedKindNames: string[]
  moderatedTraitIds: number[]
  moderatedTraitNames: string[]
  offer: OfferState
  chainFrom: string
  chainTo: string
  chainAgeSeconds: number
  paymentHashes: Set<string>
  paymentAttempts: Map<string, FakePaymentAttempt>
  cityCreditBalances: Map<number, bigint>
  cityCreditEntries: FakeCityCreditEntry[]
  nextCityCreditEntryId: number
  attentionPendingGiftsCount: number
  founderPayPalDisputes: Map<string, FakeFounderPayPalDispute>
  founderPayPalDisputeEvents: FakeFounderPayPalDisputeEvent[]
  nextFounderPayPalDisputeEventId: number
  communityToolSubmissions: FakeCommunityToolSubmission[]
  paypalCreditRateSlotsUsed: number
  paymentReplaySchemaReady: boolean
  facilitatorVerify: boolean
  facilitatorSettle: boolean
  flagSlotsUsed: Record<string, number>
  failPaidWriteOnce: boolean
  failCreditReturnOnce: boolean
  failFounderReviewOnce: boolean
  paidCompletionFailure: FakePaidCompletionFailure | null
  interruptTreasuryCompletionOnce: boolean
  treasuryCompletionHeader?: string
  placeDescription: string
  roomPurpose: string
  frontMatterThingIds: number[]
  frontMatterMovedThingIds: number[]
  frontMatterHiddenThingIds: number[]
  frontMatterRaceLost: boolean
  noteBody: string
  exactTotalsBusy: boolean
  exactTotalsBusyAfter: number | null
  exactTotalsSuccessfulReads: number
  publicChangeMarker: string
  publicReadMarkerRaces: number
  publicReadMarkerRaceNeedle: string | null
  laterHolderItems: FakeLaterHolderItem[]
  recentNote: FakeRecentNote | null
  gazetteWithdrawalCommandIds: Set<number>
  nextNoteId: number
  residentRefusalStates: Map<number, FakeResidentRefusalState>
  actionResolved?: boolean
}

const initialState = (): FakeState => ({
  scenario: '',
  calls: [],
  authValid: true,
  actorId: 7,
  actorHandle: 'tiny-lantern',
  currentPlaceId: 2,
  homePlaceId: 3,
  placeOwnerId: 7,
  openToBuilding: false,
  openToThings: false,
  openToNotes: false,
  quiet: false,
  gazetteActivated: false,
  gazetteWithdrawalsOpen: false,
  quota: { things: true, notes: true, agreements: true },
  agreementParties: ['tiny-lantern', 'neighbor'],
  agreementAcceded: [],
  agreementAccessionOpen: false,
  agreementCreatorId: 7,
  agreementExists: true,
  thingOwnerId: 7,
  thingKindId: 3,
  thingCurrentRevision: 1,
  thingDrawingVariant: null,
  thingOpenToUse: false,
  thingWithdrawn: false,
  targetThingOwnerId: 8,
  targetThingPlaceId: 2,
  targetThingKindId: 3,
  targetThingOpenToUse: false,
  targetThingWithdrawn: false,
  kindOwnerId: 7,
  kindRevision: 1,
  kindDrawing: null,
  kindDrawingState: null,
  kindDrawingDescription: null,
  kindDrawingVariants: [],
  kindRecipe: [],
  traitHasRecipe: false,
  kindTraitNames: ['glowing'],
  thingTraitRecipe: null,
  lawTraitName: 'quiet-hours',
  lawTraitRecipe: null,
  placeLawNames: [],
  actorLabels: [],
  placeLabels: [],
  actionBlocked: false,
  damageAllowed: false,
  scheduledLabelAt: null,
  pendingResolved: false,
  noteRemoved: false,
  notePinned: false,
  moderatedPlaceIds: [],
  moderatedKindIds: [],
  moderatedKindNames: [],
  moderatedTraitIds: [],
  moderatedTraitNames: [],
  offer: { id: 90, status: 'canceled', reservedAt: null, reservedUntil: null, buyerWallet: null },
  chainFrom: SELLER_WALLET,
  chainTo: TREASURY,
  chainAgeSeconds: 60,
  paymentHashes: new Set<string>(),
  paymentAttempts: new Map(),
  cityCreditBalances: new Map(),
  cityCreditEntries: [],
  nextCityCreditEntryId: 1,
  attentionPendingGiftsCount: 0,
  founderPayPalDisputes: new Map(),
  founderPayPalDisputeEvents: [],
  nextFounderPayPalDisputeEventId: 1,
  communityToolSubmissions: [{
    id: 9,
    title: 'Pocket city atlas',
    url: 'https://tools.example/atlas',
    operator_name: 'Lantern Workshop',
    description: 'Finds public places by their street names.',
    resident_id: 7,
    resident_handle: 'tiny-lantern',
    category: 'Browse',
    tags: ['maps', 'streets'],
    submitter_ip_hash: 'b'.repeat(64),
    created_at: '2026-09-01T20:00:00.000Z',
    reviewed_at: null,
    reviewed_by: null,
    review_outcome: null,
  }],
  paypalCreditRateSlotsUsed: 0,
  paymentReplaySchemaReady: true,
  facilitatorVerify: false,
  facilitatorSettle: false,
  flagSlotsUsed: {},
  failPaidWriteOnce: false,
  failCreditReturnOnce: false,
  failFounderReviewOnce: false,
  paidCompletionFailure: null,
  interruptTreasuryCompletionOnce: false,
  placeDescription: 'a place made from words',
  roomPurpose: '',
  frontMatterThingIds: [],
  frontMatterMovedThingIds: [],
  frontMatterHiddenThingIds: [],
  frontMatterRaceLost: false,
  noteBody: 'hello from the square',
  exactTotalsBusy: false,
  exactTotalsBusyAfter: null,
  exactTotalsSuccessfulReads: 0,
  publicChangeMarker: '9',
  publicReadMarkerRaces: 0,
  publicReadMarkerRaceNeedle: null,
  laterHolderItems: [{
    mark_id: '2', id: 41, title: 'porch lantern', place_id: 2,
    place_title: 'Lantern Town', date: '2026-08-11T00:00:00.000000Z',
    body_text_bytes: Buffer.byteLength('warm light', 'utf8'),
  }],
  recentNote: null,
  gazetteWithdrawalCommandIds: new Set(),
  nextNoteId: 52,
  residentRefusalStates: new Map(),
})

export const fixtureState: { current: FakeState } = { current: initialState() }

export { initialState, paidCompletionError }
export type {
  DbCall,
  FakeCityCreditEntry,
  FakeCommunityToolSubmission,
  FakeFounderPayPalDispute,
  FakeFounderPayPalDisputeEvent,
  FakeLaterHolderItem,
  FakePaidCompletionFailure,
  FakePaymentAttempt,
  FakeRecentNote,
  FakeResidentRefusalState,
  FakeState,
  LawRecipe,
  OfferState,
}
