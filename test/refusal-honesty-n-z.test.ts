import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
}

function expects(name: string, messages: readonly string[]): void {
  const text = source(name)
  for (const message of messages) assert.ok(text.includes(message), `${name}: ${message}`)
}

test('note and payment refusals state a safe retry', () => {
  expects('note-action.ts', [
    'database returned an invalid ${field}; retry once, then contact the city operator',
    'database returned an invalid result; retry once, then contact the city operator',
    'database returned ambiguous Gazette withdrawal facts; re-read the submission, then contact the city operator if the records remain ambiguous',
    'database returned mismatched Gazette withdrawal facts; re-read the submission, then contact the city operator if the records still disagree',
    'transaction query support is unavailable; contact the city operator to restore transaction support before retrying',
    'database returned an invalid Gazette command state; re-read the Gazette submission, then contact the city operator',
    'database did not record the Gazette withdrawal; re-read the submission before deciding whether to retry',
  ])
  expects('pay.ts', [
    'X-PAYMENT header exceeds ${MAX_PAYMENT_HEADER_BYTES} bytes; resend a header no larger than ${MAX_PAYMENT_HEADER_BYTES} bytes',
    'X-PAYMENT contains an invalid payer; resend a 20-byte Base wallet address',
    'X-PAYMENT contains an invalid nonce; resend a 32-byte hexadecimal nonce',
    'X-PAYMENT contains an invalid authorization window; resend integer validAfter and validBefore timestamps with validBefore later than validAfter',
    '${label} response exceeded ${MAX_FACILITATOR_RESPONSE_BYTES} bytes; retry this same request later and do not pay again',
    '${label} response could not be read; retry this same request later and do not pay again',
    'facilitator rejected the payment; re-read the current 402 terms and send a matching authorization',
    'facilitator verification is unavailable; retry this same request later',
    'settlement outcome is unknown; do not pay again; recheck the original payment attempt',
  ])
})

test('PayPal route refusals name the usable source or retry', () => {
  expects('paypal-credit-routes.ts', [
    'The PayPal request Content-Type is not application/json. Send one application/json body. No payment was started.',
    'The PayPal request JSON is invalid. Send one valid JSON object. No payment was started.',
    '${label} does not match a PayPal identifier; resend the exact identifier returned by PayPal. No new payment was started.',
    'That resident number was not found. Use a current number from GET /api/residents. No payment was started.',
    'PayPal callbacks are unavailable. Retry later with the same request_id. No payment was started.',
    'PayPal purchase id is invalid. Use the purchase_id from the original city response. No payment was started.',
    'PayPal allowance setup is temporarily unavailable. Retry later with the same request_id. No payment was started.',
    'This weekly allowance is already active. Use the existing active allowance; do not create another subscription.',
    'PayPal purchase id is invalid. Use the purchase_id from the original city response. No new payment was started.',
    'That PayPal purchase was not found. Inspect the original city response and resend its purchase_id; do not start another payment.',
    'The PayPal order does not match this purchase. Reload the return page with the matching purchase_id and paypal_order_id; do not start another payment.',
  ])
})

test('gift, pagination, and transfer refusals name accepted state', () => {
  expects('prepaid-credit.ts', [
    'gift id is invalid; use one pending gift_id from GET /api/me',
    'gift status is invalid; re-read /api/me and use a pending or refused gift as allowed by this action',
    'gift claim token is invalid; use the exact one-time claim_token from the original gift response',
  ])
  expects('public-pagination.ts', [
    "unsupported query option${unsupported.length === 1 ? '' : 's'}: ${shown}; remove the shown option${unsupported.length === 1 ? '' : 's'} and retry",
  ])
  expects('society.ts', [
    'transaction query support is unavailable; contact the city operator to restore transaction support before retrying',
  ])
})

test('world body refusals name the rejected field(s) by name and the accepted fields', () => {
  expects('world.ts', [
    'place body does not accept ${describeUnsupportedFields(rejected)}; send only parent_id, name, description, open_to_building, open_to_things, and open_to_notes',
    'place edit does not accept ${describeUnsupportedFields(rejected)}; place_edit takes description, purpose, front_matter_thing_ids, drawing, quiet, or a permission switch. Set a place\'s laws with PUT /api/place/:id/laws {"traits":[names]} or the laws tool.',
    'place edit body is empty; edit description, purpose, front matter, drawing, quiet, or a permission switch',
    'kind body does not accept ${describeUnsupportedFields(rejected)}; send only name, description, traits, recipe, drawing, drawing_state, drawing_description, and drawing_variants',
    'kind names an unknown or duplicate trait; coin each trait first with POST /api/trait',
    'kind revision does not accept ${describeUnsupportedFields(rejected)}; send only description, traits, recipe, drawing, drawing_state, drawing_description, and drawing_variants',
    'kind revision names an unknown or duplicate trait; coin each trait first with POST /api/trait',
    'trait body does not accept ${describeUnsupportedFields(rejected)}; send only name, description, and an optional inert recipe',
    'thing body does not accept ${describeUnsupportedFields(rejected)}; send only place_id, name, body, optional open_to_use, optional kind_id, and ingredient_ids',
    'thing upgrade body does not accept ${describeUnsupportedFields(rejected)}; send only optional drawing_variant_name',
  ])
  assert.doesNotMatch(source('world.ts'), /`kind(?: revision)? \$\{unknownTrait\}`/u)
})

test('founder dispute errors keep their exact cause and recovery', () => {
  expects('paypal-credit-dispute.ts', [
    'This PayPal dispute was not found. Re-read the current dispute list before retrying.',
    'This PayPal dispute already has the opposite founder decision. Re-read the dispute and use its current decision; nothing changed.',
    'stored PayPal dispute ${label} is invalid; re-read the dispute, then ask the city operator to repair its stored record',
  ])
})
