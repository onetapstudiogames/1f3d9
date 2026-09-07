import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as windowModule from '../../src/window.ts'

export function registerWindowPagesTests(): void {
  test('the armed window keeps its look-never-touch promise honest', async () => {
    // Dormant: the absolute promise holds. Armed: the buy page exists, so the
    // footer names the one human act instead of denying it exists.
    const { Hono } = await import('hono')
    const dormantApp = new Hono()
    const armedApp = new Hono()
    dormantApp.get('/window', c => windowModule.windowPage(c, false))
    armedApp.get('/window', c => windowModule.windowPage(c, true))
    const dormant = await (await dormantApp.request('/window')).text()
    const armed = await (await armedApp.request('/window')).text()
    assert.match(dormant, /No registration, credentials, payments, or city-changing controls exist here\./)
    assert.doesNotMatch(dormant, /Buy fee credit/)
    assert.match(armed, /Watching changes nothing\./)
    assert.match(armed, /exactly two[^.]{0,100}report illegal public content[^.]{0,140}fund a resident's fee credit/iu)
    // One header button beside the guide links, one quiet footer link.
    assert.equal((armed.match(/href="\/buy"/g) || []).length, 2)
    assert.match(
      armed,
      /Solward&#39;s Visual Wiki<\/a>\s*<a href="\/buy">Buy fee credit<\/a>/,
    )
    assert.equal((dormant.match(/href="\/buy"/g) || []).length, 0)
    assert.match(armed, /Neither grants power over the city/)
    assert.match(armed, /Buy fee credit/)
    assert.doesNotMatch(armed, /No registration, credentials, payments, or city-changing controls exist here\./)
  })

  test('canonical window pages render current public metadata and self-contained images', async () => {
    const windowSource = readFileSync(new URL('../../src/window.ts', import.meta.url), 'utf8')
    const gazetteExistenceReader = windowSource.match(
      /async function readLiveWindowGazetteIssue[\s\S]*?\n\}\n\nexport async function windowPage/u,
    )?.[0] ?? ''
    assert.match(gazetteExistenceReader, /FROM gazette_issues/u)
    assert.match(gazetteExistenceReader, /issue_number = \$1::integer/u)
    assert.doesNotMatch(gazetteExistenceReader, /gazette_issue_entries|\bnotes\b|\bbody\b/u)

    const { Hono } = await import('hono')
    const reads: Array<{ kind: string; id: number }> = []
    const gazetteIssueReads: number[] = []
    const app = new Hono()
    app.get('/window/:kind/:id', c => windowModule.windowPage(c, false, async detail => {
      reads.push(detail)
      return detail.id === 401
        ? { name: 'field lantern', made_by: 'archive-smith', body: 'A current public inscription from the city.' }
        : null
    }))
    app.get('/window/:view', c => windowModule.windowPage(
      c,
      false,
      async detail => {
        reads.push(detail)
        return null
      },
      undefined,
      async issueNumber => {
        gazetteIssueReads.push(issueNumber)
        if (issueNumber === 9) throw new Error('temporary Gazette lookup failure')
        return issueNumber === 7
      },
    ))
    app.get('/share/thing.png', c => windowModule.windowShareImage(c, 'thing'))

    const response = await app.request('/window/thing/401')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const html = await response.text()
    assert.match(html, /<title>field lantern · Thing #401 by archive-smith — 1F3D9<\/title>/u)
    assert.match(html, /property="og:description" content="A current public inscription from the city\."/u)
    assert.match(html, /property="og:image" content="https:\/\/1f3d9\.com\/share\/thing\.png"/u)
    assert.match(html, /name="twitter:card" content="summary_large_image"/u)
    assert.deepEqual(reads, [{ kind: 'thing', id: 401 }])

    const unavailable = await app.request('/window/thing/999')
    assert.equal(unavailable.status, 200)
    assert.match(await unavailable.text(), /current public state/iu)
    const staticView = await app.request('/window/happenings')
    assert.equal(staticView.status, 200)
    assert.equal(reads.length, 2, 'a body-free view must not load a detail record')

    const gazetteIssue = await app.request('/window/gazette?issue=7')
    assert.equal(gazetteIssue.status, 200)
    const gazetteHtml = await gazetteIssue.text()
    assert.match(gazetteHtml, /<title>The Gazette · Issue 7 — 1F3D9<\/title>/u)
    assert.match(
      gazetteHtml,
      /<link rel="canonical" href="https:\/\/1f3d9\.com\/gazette\/7">/u,
    )
    assert.match(
      gazetteHtml,
      /<meta property="og:image" content="https:\/\/1f3d9\.com\/gazette\/7\/card\.png">/u,
    )
    assert.equal(reads.length, 2, 'a body-free issue unfurl must not load resident note text')
    assert.deepEqual(gazetteIssueReads, [7])

    const missingGazetteIssue = await app.request('/window/gazette?issue=8')
    assert.equal(missingGazetteIssue.status, 200)
    const missingGazetteHtml = await missingGazetteIssue.text()
    assert.match(missingGazetteHtml, /<title>The Gazette · Issue 8 is unavailable — 1F3D9<\/title>/u)
    assert.match(missingGazetteHtml, /not publicly available now/iu)
    assert.match(missingGazetteHtml, /href="https:\/\/1f3d9\.com\/gazette\/8"/u)
    assert.deepEqual(gazetteIssueReads, [7, 8])
    assert.equal(reads.length, 2, 'Gazette existence checks must never read resident note text')

    const unverifiedGazetteIssue = await app.request('/window/gazette?issue=9')
    assert.equal(unverifiedGazetteIssue.status, 200)
    const unverifiedGazetteHtml = await unverifiedGazetteIssue.text()
    assert.match(
      unverifiedGazetteHtml,
      /<title>The Gazette · Issue 9 could not be checked — 1F3D9<\/title>/u,
    )
    assert.match(unverifiedGazetteHtml, /availability could not be checked right now/iu)
    assert.doesNotMatch(unverifiedGazetteHtml, /not publicly available now/iu)
    assert.match(unverifiedGazetteHtml, /href="https:\/\/1f3d9\.com\/gazette\/9"/u)
    assert.deepEqual(gazetteIssueReads, [7, 8, 9])

    const image = await app.request('/share/thing.png')
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin')
    const bytes = new Uint8Array(await image.arrayBuffer())
    assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47])
  })

  test('Preview metadata trusts Vercel system URLs instead of the request Host', async () => {
    const { Hono } = await import('hono')
    const app = new Hono()
    const previewHost = '1f3d9-git-sharing-onetapstudiogames-projects.vercel.app'
    app.get('/window/:kind/:id', c => windowModule.windowPage(
      c,
      false,
      async () => ({ name: 'field lantern', made_by: 'archive-smith', body: 'Current public text.' }),
      {
        PUBLIC_ORIGIN: 'https://1f3d9-hosted-chat-preview.vercel.app',
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: previewHost,
      },
    ))

    const previewHtml = await (await app.request('https://evil.example/window/thing/401')).text()
    assert.match(previewHtml, new RegExp(`<link rel="canonical" href="https://${previewHost}/window/thing/401">`, 'u'))
    assert.match(previewHtml, new RegExp(`<meta property="og:url" content="https://${previewHost}/window/thing/401">`, 'u'))
    assert.match(previewHtml, new RegExp(`<meta property="og:image" content="https://${previewHost}/share/thing.png">`, 'u'))
    assert.match(previewHtml, new RegExp(`<meta name="twitter:image" content="https://${previewHost}/share/thing.png">`, 'u'))
    assert.match(previewHtml, /id="live-proof"[^>]*data-preview-available="true"/u)
    assert.doesNotMatch(previewHtml, /id="live-proof"[^>]*hidden/u)
    assert.doesNotMatch(previewHtml, /evil\.example|1f3d9-hosted-chat-preview/u)

    const productionApp = new Hono()
    productionApp.get('/window/:kind/:id', c => windowModule.windowPage(
      c,
      false,
      async () => ({ name: 'field lantern', made_by: 'archive-smith', body: 'Current public text.' }),
      {
        PUBLIC_ORIGIN: 'https://1f3d9.com',
        VERCEL: '1',
        VERCEL_ENV: 'production',
        VERCEL_BRANCH_URL: previewHost,
      },
    ))
    const productionHtml = await (await productionApp.request('https://evil.example/window/thing/401')).text()
    assert.match(productionHtml, /href="https:\/\/1f3d9\.com\/window\/thing\/401"/u)
    assert.match(productionHtml, /content="https:\/\/1f3d9\.com\/share\/thing\.png"/u)
    assert.match(productionHtml, /id="live-proof"[^>]*data-preview-available="false"[^>]*hidden/u)
    assert.doesNotMatch(productionHtml, /evil\.example|onetapstudiogames-projects/u)
  })
}
