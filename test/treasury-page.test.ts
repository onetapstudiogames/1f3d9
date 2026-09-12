import test from 'node:test'
import assert from 'node:assert/strict'
import { treasuryDocument } from '../src/treasury-page.ts'

test('the treasury page escapes every value loaded from public records', () => {
  const html = treasuryDocument({
    address: '<script>address</script>',
    network: 'base & beyond',
    usdc_balance_onchain: 'rpc "unavailable"',
    fees_collected_usdc: 1,
    fees_count: 1,
    recent_fees: [{
      id: 7,
      amount_usdc: 1,
      tx_hash: '<img src=x onerror=alert(1)>',
      handle: '<b>resident</b>',
      purpose: 'kind & "revision"',
      created_at: '<time>',
    }],
    recent_fees_page: {
      total_items: 1,
      total_text_bytes: 17,
      returned_items: 1,
      returned_text_bytes: 17,
      has_more: false,
      next_before_id: null,
    },
    note: '<script>note</script>',
  })
  assert.doesNotMatch(html, /<script>address|<img src=x|<b>resident|<script>note/u)
  assert.match(html, /&lt;script&gt;address&lt;\/script&gt;/u)
  assert.match(html, /base &amp; beyond/u)
  assert.match(html, /kind &amp; &quot;revision&quot;/u)
})
