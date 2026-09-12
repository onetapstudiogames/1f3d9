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

const ERROR_CLASS_BY_STATUS: Readonly<Record<number, string>> = Object.freeze({
  400: 'bad_input',
  401: 'auth_required',
  402: 'payment_required',
  403: 'forbidden',
  404: 'not_found',
  405: 'bad_input',
  409: 'conflict',
  413: 'bad_input',
  429: 'rate_limited',
  500: 'city_fault',
  502: 'city_fault',
  503: 'city_fault',
})

function contractCheckedResponse(response: Response, apiRequest: boolean): Response {
  if (!apiRequest || response.status < 400 || !/^application\/json\b/iu.test(
    response.headers.get('content-type') ?? '',
  )) return response

  return new Proxy(response, {
    get(target, property) {
      if (property === 'json') {
        return async () => {
          const body = await target.json() as Record<string, unknown>
          if (typeof body.error !== 'string') return body
          const requestId = target.headers.get('x-request-id')
          const errorClass = ERROR_CLASS_BY_STATUS[target.status]
          assert.match(requestId ?? '', /^[0-9a-f-]{36}$/iu)
          assert.equal(body.request_id, requestId)
          assert.equal(body.error_class, errorClass)
          assert.equal(body.http_status, target.status)
          assert.equal(body.front_door_tool, 'front_door')
          assert.equal(body.front_door, 'https://1f3d9.com/')
          assert.equal(target.headers.get('x-1f3d9-error-class'), errorClass)
          const {
            request_id: _requestId,
            error_class: _errorClass,
            http_status: _httpStatus,
            front_door_tool: _frontDoorTool,
            front_door: _frontDoor,
            ...routeFields
          } = body
          return routeFields
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function contractCheckedApp(app: App): App {
  return new Proxy(app, {
    get(target, property) {
      if (property === 'request') {
        return async (...args: Parameters<App['request']>) => {
          const requestTarget = args[0]
          const path = typeof requestTarget === 'string'
            ? requestTarget
            : requestTarget instanceof URL
              ? requestTarget.pathname
              : new URL(requestTarget.url).pathname
          return contractCheckedResponse(
            await target.request(...args),
            path.startsWith('/api/'),
          )
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

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
    app: contractCheckedApp(routesRuntime.app),
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
