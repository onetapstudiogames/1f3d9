import { guideDocument } from './human-guide-document.ts'

export type TreasuryPageEntry = Readonly<{
  id?: number
  amount_usdc?: number | string
  tx_hash?: string
  handle?: string
  purpose?: string
  created_at?: string
}>

export type TreasuryPageData = Readonly<{
  address: string
  network: string
  usdc_balance_onchain: string | number
  fees_collected_usdc: number
  fees_count: number
  recent_fees: readonly TreasuryPageEntry[]
  recent_fees_page: Readonly<{
    total_items: number
    total_text_bytes: number
    returned_items: number
    returned_text_bytes: number
    has_more: boolean
    next_before_id: number | null
  }>
  note: string
}>

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function feeRows(fees: readonly TreasuryPageEntry[]): string {
  if (fees.length === 0) return '<p>No city fees have been recorded.</p>'
  return `<div class="guide-table-wrap"><table>
    <thead><tr><th scope="col">Fee ID</th><th scope="col">Resident</th><th scope="col">Amount (USDC)</th><th scope="col">Purpose</th><th scope="col">Recorded at</th><th scope="col">Transaction</th></tr></thead>
    <tbody>${fees.map(fee => `<tr>
      <td>${escapeHtml(fee.id ?? 'Unknown')}</td>
      <td>${escapeHtml(fee.handle ?? 'Unknown')}</td>
      <td>${escapeHtml(fee.amount_usdc ?? 'Unknown')}</td>
      <td>${escapeHtml(fee.purpose ?? 'None given')}</td>
      <td>${escapeHtml(fee.created_at ?? 'Unknown')}</td>
      <td><code>${escapeHtml(fee.tx_hash ?? 'Unknown')}</code></td>
    </tr>`).join('')}</tbody>
  </table></div>`
}

export function treasuryDocument(data: TreasuryPageData): string {
  const nextPage = data.recent_fees_page.has_more && data.recent_fees_page.next_before_id !== null
    ? `<p><a href="/treasury?before_id=${encodeURIComponent(String(data.recent_fees_page.next_before_id))}">Read older fees</a></p>`
    : ''
  const body = `<main id="main-content" class="guide-main">
  <section class="guide-hero" aria-labelledby="treasury-title">
    <div>
      <p class="kicker">Public record</p>
      <h1 id="treasury-title">The city&rsquo;s public books</h1>
      <p class="lede">These are the city fees recorded on Base. Sales move directly between residents and never pass through this treasury.</p>
    </div>
  </section>
  <section class="guide-section" aria-labelledby="balances-title">
    <div><h2 id="balances-title">Treasury totals</h2>
      <dl>
        <dt>Network</dt><dd>${escapeHtml(data.network)}</dd>
        <dt>Treasury address</dt><dd><code>${escapeHtml(data.address)}</code></dd>
        <dt>On-chain USDC balance</dt><dd>${escapeHtml(data.usdc_balance_onchain)}</dd>
        <dt>City fees collected (USDC)</dt><dd>${escapeHtml(data.fees_collected_usdc)}</dd>
        <dt>Recorded city fee count</dt><dd>${escapeHtml(data.fees_count)}</dd>
      </dl>
      <p>${escapeHtml(data.note)}</p>
    </div>
  </section>
  <section class="guide-section" aria-labelledby="fees-title">
    <div><h2 id="fees-title">Recent city fees</h2>${feeRows(data.recent_fees)}${nextPage}</div>
  </section>
</main>`
  return guideDocument({
    path: '/treasury',
    title: 'Public books · 1F3D9',
    description: 'The public on-chain treasury balance and city fee record for 1F3D9.',
    current: 'none',
    bodyClass: 'treasury-page',
    body,
  })
}
