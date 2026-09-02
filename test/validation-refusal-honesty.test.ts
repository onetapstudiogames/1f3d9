import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
}

test('public validation refusals name the rejected shape and a concrete retry', () => {
  const society = source('society.ts')
  assert.doesNotMatch(society, /'bad (?:agreement id|offer id|party handle)'/u)
  assert.match(society, /agreement id was rejected because it must be a positive whole number; retry with the agreement id from GET \/api\/agreements/u)
  assert.match(society, /party was rejected because it must be a resident handle; retry with a handle from GET \/api\/census/u)

  const worldMarket = source('world-market.ts')
  assert.doesNotMatch(worldMarket, /'bad world offer id'/u)
  assert.match(worldMarket, /world offer id was rejected because it must be a positive whole number; retry with an offer_id from GET \/api\/world-market/u)

  const crafting = source('crafting.ts')
  assert.doesNotMatch(crafting, /'invalid crafting request'/u)
  assert.match(crafting, /crafting request was rejected because its resident, kind, place, body, or open_to_use value is invalid; retry with the documented craft fields and limits/u)

  const paymentRecovery = source('payment-recovery-routes.ts')
  assert.doesNotMatch(paymentRecovery, /'invalid payment attempt id'|'payment recovery authorization failed'/u)
  assert.match(paymentRecovery, /payment attempt id was rejected because it does not match a city payment attempt id; retry with the id returned by the original payment request/u)
  assert.match(paymentRecovery, /payment recovery authorization was rejected because the cron bearer token is missing or incorrect; retry with Authorization: Bearer <CRON_SECRET>/u)

  const window = source('window.ts')
  assert.doesNotMatch(window, /'invalid public window(?: history)? query'/u)
  assert.match(window, /public window query was rejected because its fields or values are not supported; retry with view=full, view=directory, view=outline(?:&amp;|&)after_change_marker=<marker>, or view=history/u)
  assert.match(window, /public window history query was rejected because its fields or values are not supported; retry with the documented history filters and an optional after_change_marker/u)
})

test('repeated numeric and provider validation families state cause and next step', () => {
  for (const file of ['public-pagination.ts', 'reading-cost.ts']) {
    const text = source(file)
    assert.doesNotMatch(text, /`\$\{field\} is invalid`/u)
    assert.match(text, /was rejected because it must be a non-negative safe integer; retry with zero or a positive whole number/u)
  }

  for (const file of [
    'city-credit-purchase.ts',
    'later-holder.ts',
    'payment-sale-operations.ts',
    'paypal-credit-store.ts',
    'paypal-credit.ts',
    'prepaid-credit.ts',
  ]) {
    assert.doesNotMatch(source(file), /`\$\{label\} is invalid`/u, file)
  }

  assert.match(source('payment-sale-operations.ts'), /was rejected because it does not match the required payment identifier format; retry with the identifier returned by the original payment request/u)
  assert.match(source('paypal-credit-store.ts'), /was rejected because it does not match the stored PayPal identifier format; retry with the exact identifier returned by PayPal/u)
  assert.match(source('paypal-credit.ts'), /was rejected because it does not match the required PayPal value; retry with the exact value returned by PayPal/u)
})

test('route, stored-record, operator, and internal refusals give a safe recovery', () => {
  const giftRoutes = source('prepaid-credit-routes.ts')
  assert.doesNotMatch(giftRoutes, /'gift id is invalid'/u)
  assert.match(giftRoutes, /gift id was rejected because it does not match a city gift id; retry with the gift id from GET \/api\/me/u)

  const world = source('world.ts')
  assert.doesNotMatch(world, /'place text, front matter, or permissions are invalid'|'stored kind drawing(?: variants)? are? invalid'/u)
  assert.match(world, /place edit was rejected because its text, front_matter_thing_ids, quiet, or permission switches have an invalid type or value; retry with safe text, an array of thing ids, and boolean switches/u)
  assert.match(world, /saved kind drawing cannot be read because its stored record is invalid; the kind owner should save a valid drawing again or contact the city operator/u)

  const drawings = source('drawings.ts')
  assert.doesNotMatch(drawings, /'stored drawing(?: revision)? is invalid'/u)
  assert.match(drawings, /saved drawing cannot be read because its stored record is invalid; the record owner should save a valid drawing again or contact the city operator/u)

  const logDrain = source('log-drain-routes.ts')
  assert.doesNotMatch(logDrain, /'log drain (?:verification query is invalid|verification challenge is invalid|signature verification failed)'/u)
  assert.match(logDrain, /log drain signature was rejected because X-Vercel-Signature is missing or does not match the request body; retry with Vercel's HMAC-SHA1 signature/u)

  const gazette = source('gazette-routes.ts')
  assert.doesNotMatch(gazette, /'Gazette print authorization failed'/u)
  assert.match(gazette, /Gazette print authorization was rejected because the cron bearer token is missing or incorrect; retry with Authorization: Bearer <CRON_SECRET>/u)

  const index = source('index.ts')
  assert.doesNotMatch(index, /error: 'internal'/u)
  assert.match(index, /the city could not complete the request because of an unexpected internal failure; retry once, then give request_id to the city operator if it fails again/u)
})
