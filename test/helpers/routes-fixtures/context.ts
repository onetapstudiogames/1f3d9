import {
  Hono,
  PUBLIC_CREDENTIAL_REDACTION,
  PUBLIC_PAGE_DEFAULT,
  PUBLIC_PAGE_MAX,
  PUBLIC_SEARCH_RATE_CAPACITY,
  allowedPublicQuery,
  assert,
  canonicalPaymentRequest,
  createHash,
  createLaterHolderCursorCodec,
  encodePublicSearchCursor,
  finalizePublicPage,
  isLaterHolderCursor,
  mcp,
  parsePublicPage,
  setOAuthResidentResolver,
  test,
  utf8TextBytes,
} from './source-imports.ts'
import {
  AUTHORIZATION_NOW,
  BUYER_WALLET,
  CONTRACT_DRAWING,
  CONTRACT_DRAWING_DESCRIPTION,
  LATER_HOLDER_CURSOR_KEY,
  OTHER_SECRET,
  SALE_X_PAYMENT,
  SECRET,
  SELLER_WALLET,
  STRANGER_SALE_X_PAYMENT,
  STRANGER_WALLET,
  TREASURY,
  TX1,
  TX2,
  TX_CASE_UPPER,
  USDC,
  X_PAYMENT,
  X_PAYMENT_NO_ID,
} from './environment.ts'
import { fixtureState, initialState } from './state.ts'
import {
  mapOutlineRows,
  paginationEvents,
  recentIds,
  remainingPaginationRows,
} from './rows.ts'
import { reset, setActor, withVercelForwarding } from './state-tools.ts'

type App = (typeof import('../../../src/index.ts'))['default']
type PublicRecords = typeof import('../../../src/public-records.ts')
type Engine = typeof import('../../../src/engine.ts')

type RoutesRuntime = Readonly<{
  app: App
  loadPublicNoteRecord: PublicRecords['loadPublicNoteRecord']
  loadPublicPlaceRecord: PublicRecords['loadPublicPlaceRecord']
  loadPublicThingRecord: PublicRecords['loadPublicThingRecord']
  CommitOutcomeUnknownError: Engine['CommitOutcomeUnknownError']
  setEngineTransactionRunnerForTests: Engine['setEngineTransactionRunnerForTests']
}>

let routesRuntime: RoutesRuntime | null = null

export function initializeRoutesTestContext(runtime: RoutesRuntime): void {
  routesRuntime = runtime
}

const authHeaders = (secret = SECRET) => ({
  Authorization: `Bearer ${secret}`,
  'Content-Type': 'application/json',
})
const sqlCalls = () => fixtureState.current.calls.filter(call => call.query)
const inserted = (table: string) => sqlCalls().filter(call =>
  new RegExp(`insert\\s+into\\s+${table}\\b`, 'i').test(call.query ?? '')).length
const networkCalled = (fragment: string) => fixtureState.current.calls.some(call => call.url.includes(fragment))

function assertPhaseAwareGazetteReplayReads(): void {
  const duplicateReads = sqlCalls().filter(call => (
    /\/\* note-action:recent-duplicate \*\//iu.test(call.query ?? '')
  ))
  assert.ok(duplicateReads.length > 0, 'the request must classify its bounded duplicate in PostgreSQL')
  for (const read of duplicateReads) {
    assert.match(read.query ?? '', /gazette_withdrawals_are_open\(\)/iu)
    assert.match(read.query ?? '', /gazette_withdrawal_command_reserved\(note\.body\)/iu)
    assert.match(
      read.query ?? '',
      /FROM\s+gazette_withdrawals\s+withdrawal[\s\S]*withdrawal\.command_note_id\s*=\s*note\.id/iu,
    )
  }
}

export function getRoutesTestContext() {
  if (!routesRuntime) throw new Error('routes test context was read before bootstrap completed')
  return {
    AUTHORIZATION_NOW,
    BUYER_WALLET,
    CONTRACT_DRAWING,
    CONTRACT_DRAWING_DESCRIPTION,
    CommitOutcomeUnknownError: routesRuntime.CommitOutcomeUnknownError,
    Hono,
    LATER_HOLDER_CURSOR_KEY,
    OTHER_SECRET,
    PUBLIC_CREDENTIAL_REDACTION,
    PUBLIC_PAGE_DEFAULT,
    PUBLIC_PAGE_MAX,
    PUBLIC_SEARCH_RATE_CAPACITY,
    SALE_X_PAYMENT,
    SECRET,
    SELLER_WALLET,
    STRANGER_SALE_X_PAYMENT,
    STRANGER_WALLET,
    TREASURY,
    TX1,
    TX2,
    TX_CASE_UPPER,
    USDC,
    X_PAYMENT,
    X_PAYMENT_NO_ID,
    allowedPublicQuery,
    app: routesRuntime.app,
    assert,
    assertPhaseAwareGazetteReplayReads,
    authHeaders,
    canonicalPaymentRequest,
    createHash,
    createLaterHolderCursorCodec,
    encodePublicSearchCursor,
    finalizePublicPage,
    fixtureState,
    initialState,
    inserted,
    isLaterHolderCursor,
    loadPublicNoteRecord: routesRuntime.loadPublicNoteRecord,
    loadPublicPlaceRecord: routesRuntime.loadPublicPlaceRecord,
    loadPublicThingRecord: routesRuntime.loadPublicThingRecord,
    mapOutlineRows,
    mcp,
    networkCalled,
    paginationEvents,
    parsePublicPage,
    recentIds,
    remainingPaginationRows,
    reset,
    setActor,
    setEngineTransactionRunnerForTests: routesRuntime.setEngineTransactionRunnerForTests,
    setOAuthResidentResolver,
    sqlCalls,
    test,
    utf8TextBytes,
    withVercelForwarding,
  }
}
