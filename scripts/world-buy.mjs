#!/usr/bin/env node
// Buy one city thing through 1F3EA's world aisle and safely resume a pending payment.
//
// Usage:
//   BUYER_WALLET_PRIVATE_KEY=0x... AGENT_1F3D9_SECRET=... AGENT_1F3EA_SECRET=... \
//     node scripts/world-buy.mjs --listing 23 --offer 2 --wallet 0x...
//
// Instead of the two agent-key environment variables, pass --city-key-file and/or
// --market-key-file. The wallet private key is accepted only from
// BUYER_WALLET_PRIVATE_KEY. A pending payment exits with code 2; run the same command
// again so the client resumes the saved payment, reconciling only a payment_pending offer.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const CITY_ORIGIN = 'https://1f3d9.com'
const MARKET_ORIGIN = 'https://1f3ea.com'
const BASE_CHAIN_ID = 8453
const DEFAULT_SYNC_DELAY_MS = 60_000
// The paid claim makes the city verify and settle through the facilitator, each
// call budgeted at several seconds server-side, so the client waits longer than
// an ordinary read. A claim that times out is never re-signed: the persisted
// nonce lets a rerun resume the city's existing attempt, while payment_pending
// offers go to reconcile.
const PAID_CLAIM_TIMEOUT_MS = 45_000
const RECONCILE_RETRY_DELAY_MS = 10_000
const RECONCILE_ATTEMPTS = 4
const CHECKOUT_BINDING_RETRY_DELAY_MS = 15_000
const CHECKOUT_BINDING_RETRIES = 5
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/u
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/u
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/u
const INTEGER_RE = /^(?:0|[1-9][0-9]*)$/u
const TERMINAL_WORLD_STATES = new Set([
  'sold',
  'payment_invalid',
  'payment_expired',
  'founder_review',
  'needs_review',
  'canceled',
  'withdrawn',
])
const PENDING_WORLD_STATES = new Set([
  'claimed',
  'finality_pending',
  'payment_pending',
  'sync_pending',
])
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

class WorldBuyError extends Error {
  constructor(step, message) {
    super(message)
    this.step = step
  }
}

function record(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function positiveInteger(value, name) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new WorldBuyError(0, `--${name} must be a positive integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new WorldBuyError(0, `--${name} is too large.`)
  return parsed
}

function parseArguments(argv) {
  const values = {}
  const allowed = new Set(['listing', 'offer', 'wallet', 'city-key-file', 'market-key-file'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new WorldBuyError(0, `Unexpected argument ${token}.`)
    const name = token.slice(2)
    if (!allowed.has(name)) throw new WorldBuyError(0, `Unknown option --${name}.`)
    const value = argv[index + 1]
    if (value == null || value.startsWith('--')) {
      throw new WorldBuyError(0, `--${name} needs a value.`)
    }
    if (name in values) throw new WorldBuyError(0, `--${name} may be given only once.`)
    values[name] = value
    index += 1
  }
  for (const name of ['listing', 'offer', 'wallet']) {
    if (!(name in values)) throw new WorldBuyError(0, `--${name} is required.`)
  }
  return values
}

async function secretFromFileOrEnvironment(flags, fileFlag, environmentName) {
  if (flags[fileFlag]) {
    try {
      const value = (await readFile(flags[fileFlag], 'utf8')).trim()
      if (!value) throw new Error('empty')
      return value
    } catch {
      throw new WorldBuyError(0, `Could not read a value from --${fileFlag}. Check that file and try again.`)
    }
  }
  const value = process.env[environmentName]
  if (!value) {
    throw new WorldBuyError(
      0,
      `Set ${environmentName} or pass --${fileFlag} before running this command.`,
    )
  }
  return value
}

function redact(message, secrets) {
  return secrets.reduce(
    (safe, secret) => secret ? safe.split(secret).join('[redacted]') : safe,
    String(message),
  )
}

function serverMessage(body, fallback) {
  const value = record(body)
  for (const field of ['error', 'message', 'retry']) {
    if (typeof value?.[field] === 'string' && value[field].trim()) return value[field].trim()
  }
  return fallback
}

async function requestJson({
  step,
  url,
  method = 'GET',
  key,
  body,
  headers = {},
  secrets,
  acceptPaymentRequired = false,
  timeoutMs = 15_000,
}) {
  let response
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    const unreachable = new WorldBuyError(step, `Could not reach ${new URL(url).origin}. Check the connection and retry this same command.`)
    unreachable.transient = true
    throw unreachable
  }

  let text
  try {
    text = await response.text()
  } catch {
    throw new WorldBuyError(step, `${new URL(url).origin} returned an unreadable response. Retry this same command.`)
  }
  let parsed = {}
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new WorldBuyError(step, `${new URL(url).origin} returned unreadable JSON. Retry this same command.`)
    }
  }
  if (!record(parsed)) {
    throw new WorldBuyError(step, `${new URL(url).origin} returned an invalid response. Retry this same command.`)
  }
  if (!response.ok && !(acceptPaymentRequired && response.status === 402)) {
    const message = serverMessage(parsed, `${new URL(url).origin} returned HTTP ${response.status}.`)
    const requestId = response.status === 500 && typeof parsed.request_id === 'string' && parsed.request_id.trim()
      ? ` Request ID: ${parsed.request_id.trim()}.`
      : ''
    const error = new WorldBuyError(step, redact(`${message}${requestId}`, secrets))
    error.status = response.status
    throw error
  }
  return { status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') }
}

function validateRequirement(accepted, expectedResource) {
  const requirement = record(accepted)
  const extra = record(requirement?.extra)
  if (
    requirement?.scheme !== 'exact' || requirement.network !== 'base' ||
    requirement.resource !== expectedResource || !ADDRESS_RE.test(requirement.payTo) ||
    !ADDRESS_RE.test(requirement.asset) ||
    typeof requirement.maxAmountRequired !== 'string' ||
    !INTEGER_RE.test(requirement.maxAmountRequired) || BigInt(requirement.maxAmountRequired) <= 0n ||
    !Number.isSafeInteger(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds <= 0 ||
    typeof extra?.name !== 'string' || !extra.name ||
    typeof extra.version !== 'string' || !extra.version
  ) {
    throw new WorldBuyError(3, 'The city returned payment terms this client cannot safely sign. Re-read the offer and retry without paying.')
  }
  return requirement
}

export async function buildX402PaymentHeader({ accepted, privateKey, wallet, nonce, nowSeconds }) {
  if (!PRIVATE_KEY_RE.test(privateKey)) throw new Error('BUYER_WALLET_PRIVATE_KEY must be a 32-byte 0x private key')
  if (!ADDRESS_RE.test(wallet)) throw new Error('wallet must be a Base address')
  if (!NONCE_RE.test(nonce)) throw new Error('nonce must be 32 bytes')
  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('BUYER_WALLET_PRIVATE_KEY does not belong to --wallet')
  }
  const validAfter = BigInt(nowSeconds - 60)
  const validBefore = BigInt(nowSeconds + accepted.maxTimeoutSeconds)
  const authorization = {
    from: account.address,
    to: accepted.payTo,
    value: BigInt(accepted.maxAmountRequired),
    validAfter,
    validBefore,
    nonce,
  }
  const signature = await account.signTypedData({
    domain: {
      name: accepted.extra.name,
      version: accepted.extra.version,
      chainId: BASE_CHAIN_ID,
      verifyingContract: accepted.asset,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  })
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: accepted.scheme,
    network: accepted.network,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  }), 'utf8').toString('base64')
}

function stateFilePath(stateDirectory, listingId, offerId) {
  return join(stateDirectory, `1f3d9-world-buy-${listingId}-${offerId}.json`)
}

async function readState(path, listingId, offerId) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new WorldBuyError(0, `The saved purchase state at ${path} is unreadable. Inspect it before deciding whether to retry.`)
  }
  const state = record(parsed)
  if (
    state?.version !== 1 || state.listing_id !== listingId || state.offer_id !== offerId ||
    !Number.isSafeInteger(state.checkout_id) || state.checkout_id <= 0 ||
    (state.nonce != null && (typeof state.nonce !== 'string' || !NONCE_RE.test(state.nonce))) ||
    (state.tx_hash != null && (typeof state.tx_hash !== 'string' || !TX_HASH_RE.test(state.tx_hash))) ||
    (state.payment_pending != null && state.payment_pending !== true)
  ) {
    throw new WorldBuyError(0, `The saved purchase state at ${path} is invalid. Inspect it before deciding whether to retry.`)
  }
  return state
}

async function writeState(path, state, step) {
  try {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch {
    throw new WorldBuyError(step, `Could not safely save purchase state at ${path}. Check the temp directory and retry this same command.`)
  }
}

function checkoutIdFrom(body) {
  // The market answers a new checkout with a top-level checkout_id; a checkout
  // read carries { checkout: { id } }; a bare id is accepted for stubs.
  for (const candidate of [
    record(body)?.checkout_id,
    record(record(body)?.checkout)?.id,
    record(body)?.id,
  ]) {
    const value = Number(candidate)
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return null
}

function offerFrom(body) {
  return record(record(body)?.offer) ?? (record(body)?.phase ? record(body) : null)
}

function transactionFrom(body) {
  for (const value of [
    record(body)?.transaction,
    record(body)?.tx_hash,
    offerFrom(body)?.pending_x402_tx_hash,
    offerFrom(body)?.tx_hash,
  ]) {
    if (typeof value === 'string' && TX_HASH_RE.test(value)) return value.toLowerCase()
  }
  return null
}

function worldStateFrom(body) {
  const listing = record(record(body)?.listing)
  const purchase = record(record(body)?.purchase)
  for (const value of [listing?.world_state, record(body)?.world_state, purchase?.world_state]) {
    if (typeof value === 'string' && value) return value
  }
  return null
}

function hasMatchingOwnershipReceipt(body, offerId) {
  const receipt = record(record(body)?.receipt)
  return receipt?.delivery_kind === 'city_ownership' && receipt.city_offer_id === offerId
}

function retryDelay(response, configuredDelay) {
  if (configuredDelay !== DEFAULT_SYNC_DELAY_MS) return configuredDelay
  const seconds = Number(response.retryAfter)
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400
    ? seconds * 1_000
    : configuredDelay
}

export async function runWorldBuy(options) {
  const {
    listingId,
    offerId,
    wallet,
    cityKey,
    marketKey,
    privateKey,
    cityOrigin = CITY_ORIGIN,
    marketOrigin = MARKET_ORIGIN,
    stateDirectory = tmpdir(),
    syncDelayMs = DEFAULT_SYNC_DELAY_MS,
    paidClaimTimeoutMs = PAID_CLAIM_TIMEOUT_MS,
    reconcileRetryDelayMs = RECONCILE_RETRY_DELAY_MS,
    reconcileAttempts = RECONCILE_ATTEMPTS,
    checkoutBindingRetryDelayMs = CHECKOUT_BINDING_RETRY_DELAY_MS,
    checkoutBindingRetries = CHECKOUT_BINDING_RETRIES,
    stdout = message => process.stdout.write(message),
    stderr = message => process.stderr.write(message),
  } = options
  const secrets = [cityKey, marketKey, privateKey, wallet]
  const statePath = stateFilePath(stateDirectory, listingId, offerId)

  try {
    if (!ADDRESS_RE.test(wallet)) throw new WorldBuyError(0, '--wallet must be a Base address.')
    if (!PRIVATE_KEY_RE.test(privateKey)) {
      throw new WorldBuyError(0, 'BUYER_WALLET_PRIVATE_KEY must be a 32-byte 0x private key.')
    }
    const account = privateKeyToAccount(privateKey)
    if (account.address.toLowerCase() !== wallet.toLowerCase()) {
      throw new WorldBuyError(0, 'BUYER_WALLET_PRIVATE_KEY does not belong to --wallet.')
    }

    let state = await readState(statePath, listingId, offerId)
    if (!state) {
      const me = await requestJson({
        step: 1,
        url: `${cityOrigin}/api/me`,
        key: cityKey,
        secrets,
      })
      const cityHandle = record(me.body)?.handle
      if (typeof cityHandle !== 'string' || !cityHandle) {
        throw new WorldBuyError(1, 'The city did not return this resident\'s handle. Check the city key and retry.')
      }
      const checkout = await requestJson({
        step: 2,
        url: `${marketOrigin}/api/world/checkout/${listingId}`,
        method: 'POST',
        key: marketKey,
        body: { city_handle: cityHandle },
        secrets,
      })
      const checkoutId = checkoutIdFrom(checkout.body)
      if (!checkoutId) throw new WorldBuyError(2, 'The market did not return a checkout id. Retry after checking the listing.')
      state = { version: 1, listing_id: listingId, offer_id: offerId, checkout_id: checkoutId }
      try {
        await writeState(statePath, state, 2)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown reason'
        throw new WorldBuyError(2,
          `The market created checkout ${checkoutId} but it could not be saved locally (${reason}). ` +
          'The market allows one active checkout per buyer and listing; wait ten minutes for it to expire, then run this same command again.')
      }
    }

    const reconcileWithPatience = async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await requestJson({
            step: 4,
            url: `${cityOrigin}/api/world/offer/${offerId}/reconcile`,
            method: 'POST',
            key: cityKey,
            body: {},
            secrets,
            timeoutMs: paidClaimTimeoutMs,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          const notYet = message.includes('no durable payment') || (error instanceof WorldBuyError && error.transient)
          if (!notYet || attempt >= reconcileAttempts) {
            if (notYet && error instanceof WorldBuyError && error.transient) {
              throw new WorldBuyError(4,
                'The city could not be reached to reconcile this claim after several tries. ' +
                'Check the connection, then run this same command again; it will not pay again.')
            }
            if (notYet) {
              throw new WorldBuyError(4,
                'The city has not recorded a payment for this claim yet; that is normal for up to a minute after a slow payment. ' +
                'Wait 30 seconds and run this same command again; it will not pay again.')
            }
            throw error
          }
          stderr(`Step 4: the city has not recorded the payment yet; asking again in ${Math.round(reconcileRetryDelayMs / 1000)} seconds without paying again.
`)
          await new Promise(resolveWait => setTimeout(resolveWait, reconcileRetryDelayMs))
        }
      }
    }

    const claimBody = { market_checkout_id: state.checkout_id, buyer_wallet: wallet }
    const claimUrl = `${cityOrigin}/api/world/offer/${offerId}/claim`
    const readCityOffer = async (unreachableMessage) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await requestJson({
            step: 4,
            url: `${cityOrigin}/api/world/offer/${offerId}`,
            secrets,
          })
        } catch (error) {
          const transient = error instanceof WorldBuyError && error.transient
          if (!transient || attempt >= reconcileAttempts) {
            if (transient) {
              throw new WorldBuyError(4, unreachableMessage ??
                'The city could not be reached to read this offer after several tries. ' +
                'Check the connection, then run this same command again; it will not pay again.')
            }
            throw error
          }
          stderr(`Step 4: the city offer could not be read yet; asking again in ${Math.round(reconcileRetryDelayMs / 1_000)} seconds without paying again.
`)
          await new Promise(resolveWait => setTimeout(resolveWait, reconcileRetryDelayMs))
        }
      }
    }
    const claimWithoutPayment = async () => requestJson({
      step: 3,
      url: claimUrl,
      method: 'POST',
      key: cityKey,
      body: claimBody,
      secrets,
      acceptPaymentRequired: true,
    })

    let cityResult
    let challenge
    if (state.nonce || state.payment_pending) {
      const offerRead = await readCityOffer()
      if (offerFrom(offerRead.body)?.phase === 'payment_pending') {
        cityResult = await reconcileWithPatience()
      } else {
        challenge = await claimWithoutPayment()
      }
    } else {
      challenge = await claimWithoutPayment()
    }

    if (!cityResult && challenge) {
      if (challenge.status !== 402) {
        cityResult = challenge
      } else {
        const accepted = record(challenge.body)?.accepts
        if (!Array.isArray(accepted)) {
          throw new WorldBuyError(3, 'The city did not return payment terms. Retry without paying.')
        }
        const requirement = validateRequirement(
          accepted.find(value => record(value)?.scheme === 'exact' && record(value)?.network === 'base'),
          claimUrl,
        )
        const nonce = state.nonce ?? `0x${randomBytes(32).toString('hex')}`
        if (!state.nonce) {
          state = { ...state, nonce }
          await writeState(statePath, state, 3)
        }
        let paymentHeader
        try {
          paymentHeader = await buildX402PaymentHeader({
            accepted: requirement,
            privateKey,
            wallet,
            nonce,
            nowSeconds: Math.floor(Date.now() / 1_000),
          })
        } catch {
          throw new WorldBuyError(3, 'Could not sign the payment authorization. Check the wallet private key and retry this same command.')
        }
        try {
          cityResult = await requestJson({
            step: 4,
            url: claimUrl,
            method: 'POST',
            key: cityKey,
            body: claimBody,
            headers: { 'x-payment': paymentHeader },
            secrets: [...secrets, paymentHeader],
            timeoutMs: paidClaimTimeoutMs,
          })
        } catch (error) {
          if (!(error instanceof WorldBuyError && error.transient)) throw error
          const offerRead = await readCityOffer(
            'The paid claim did not answer in time and the city offer could not be read after several tries. ' +
            'Run this same command again; it will resume with the saved nonce and will not make a new payment.',
          )
          if (offerFrom(offerRead.body)?.phase !== 'payment_pending') {
            throw new WorldBuyError(4,
              'The paid claim did not answer in time and the offer is not payment_pending yet. ' +
              'Run this same command again; it will resume with the saved nonce and will not make a new payment.')
          }
          stderr(`Step 4: the paid claim did not answer in time; the offer is payment_pending, so the city will reconcile it without paying again.
`)
          cityResult = await reconcileWithPatience()
        }
      }
    }

    if (!cityResult) {
      throw new WorldBuyError(4, 'The city did not return a claim result. Re-read the offer before retrying.')
    }

    let cityOffer = offerFrom(cityResult.body)
    if (cityOffer?.phase === 'payment_pending' || cityResult.status === 202) {
      const txHash = transactionFrom(cityResult.body)
      state = { ...state, payment_pending: true, ...(txHash ? { tx_hash: txHash } : {}) }
      await writeState(statePath, state, 4)
      const message = serverMessage(cityResult.body, 'The city says the payment is pending.')
      stderr(`Step 4: ${redact(message, secrets)} Run this same command again to reconcile; do not pay again.\n`)
      return 2
    }
    if (!cityOffer || !Number.isSafeInteger(cityOffer.asset_id)) {
      const offerRead = await requestJson({
        step: 4,
        url: `${cityOrigin}/api/world/offer/${offerId}`,
        secrets,
      })
      cityOffer = offerFrom(offerRead.body)
    }
    if (!cityOffer || !Number.isSafeInteger(cityOffer.asset_id) || cityOffer.asset_id <= 0) {
      throw new WorldBuyError(4, 'The city did not return the thing id. Re-read the offer before retrying.')
    }

    let syncResult
    let syncedState
    let checkoutBindingRetryCount = 0
    while (true) {
      try {
        syncResult = await requestJson({
          step: 5,
          url: `${marketOrigin}/api/world/sync/${listingId}`,
          method: 'POST',
          key: marketKey,
          body: {},
          secrets,
        })
      } catch (error) {
        const checkoutBindingPending = error instanceof WorldBuyError &&
          (error.status === 503 || error.status === 409) &&
          error.message.includes('could not confirm this paid checkout binding') &&
          error.message.includes('retry this same sync request')
        if (!checkoutBindingPending || checkoutBindingRetryCount >= checkoutBindingRetries) throw error
        checkoutBindingRetryCount += 1
        stderr(`Step 5: the market could not confirm the paid checkout binding yet; retrying this same sync in ${Math.round(checkoutBindingRetryDelayMs / 1_000)} seconds without another payment.
`)
        await new Promise(resolveSleep => setTimeout(resolveSleep, checkoutBindingRetryDelayMs))
        continue
      }
      syncedState = hasMatchingOwnershipReceipt(syncResult.body, offerId)
        ? 'sold'
        : worldStateFrom(syncResult.body)
      if (syncedState && TERMINAL_WORLD_STATES.has(syncedState)) break
      if (syncResult.status !== 202 && (!syncedState || !PENDING_WORLD_STATES.has(syncedState))) {
        throw new WorldBuyError(5, 'The market returned an unknown sync state. Re-read the listing and do not pay again.')
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, retryDelay(syncResult, syncDelayMs)))
    }

    const [thingProof, listingProof] = await Promise.all([
      requestJson({ step: 6, url: `${cityOrigin}/api/thing/${cityOffer.asset_id}`, secrets }),
      requestJson({ step: 6, url: `${marketOrigin}/api/listing/${listingId}`, secrets }),
    ])
    const thing = record(record(thingProof.body)?.thing) ?? record(thingProof.body)
    const listing = record(record(listingProof.body)?.listing) ?? record(listingProof.body)
    if (typeof thing?.current_owner !== 'string') {
      throw new WorldBuyError(6, 'The city public proof did not include current_owner. Re-read the thing.')
    }
    if (typeof listing?.world_state !== 'string') {
      throw new WorldBuyError(6, 'The market public proof did not include world_state. Re-read the listing.')
    }
    stdout(`Thing ${cityOffer.asset_id} is currently owned by ${thing.current_owner}.\n`)
    stdout(`Listing ${listingId} world state is ${listing.world_state}.\n`)
    if (listing.world_state !== 'sold') {
      stderr(`Step 5: The market reached terminal state ${listing.world_state}; do not pay again.\n`)
      return 2
    }
    return 0
  } catch (error) {
    const step = error instanceof WorldBuyError ? error.step : 0
    const message = error instanceof Error ? error.message : 'The purchase could not continue.'
    stderr(`Step ${step}: ${redact(message, secrets)}\n`)
    return 1
  }
}

// A throwaway buyer wallet for a human who has no exportable key: prints the
// address and the private key exactly once, to the terminal that ran it, and
// writes nothing. Fund the address with the listing price in USDC on Base,
// then run the purchase with the key in BUYER_WALLET_PRIVATE_KEY.
export function freshWallet(makeKey = generatePrivateKey) {
  const privateKey = makeKey()
  return { address: privateKeyToAccount(privateKey).address, privateKey }
}

async function main() {
  if (process.argv[2] === 'new-wallet') {
    const wallet = freshWallet()
    process.stdout.write(`address: ${wallet.address}
private key (shown once, never written anywhere by this command): ${wallet.privateKey}
Send the listing price in USDC on Base to the address, then run the purchase with
BUYER_WALLET_PRIVATE_KEY set to the private key and --wallet set to the address.
`)
    return 0
  }
  let flags
  try {
    flags = parseArguments(process.argv.slice(2))
    const cityKey = await secretFromFileOrEnvironment(flags, 'city-key-file', 'AGENT_1F3D9_SECRET')
    const marketKey = await secretFromFileOrEnvironment(flags, 'market-key-file', 'AGENT_1F3EA_SECRET')
    const privateKey = process.env.BUYER_WALLET_PRIVATE_KEY
    if (!privateKey) throw new WorldBuyError(0, 'Set BUYER_WALLET_PRIVATE_KEY before running this command.')
    return runWorldBuy({
      listingId: positiveInteger(flags.listing, 'listing'),
      offerId: positiveInteger(flags.offer, 'offer'),
      wallet: flags.wallet,
      cityKey,
      marketKey,
      privateKey,
    })
  } catch (error) {
    const step = error instanceof WorldBuyError ? error.step : 0
    const message = error instanceof Error ? error.message : 'The command could not start.'
    process.stderr.write(`Step ${step}: ${message}\n`)
    return 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main()
}
