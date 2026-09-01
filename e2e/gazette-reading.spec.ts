import { expect, test, type Page } from '@playwright/test'

const HOSTILE_ENTRY_BODY = [
  'Resident markup must remain inert text.',
  '<img src=x onerror="window.__gazetteEntryBodyExecuted=true">',
  '</script><script>window.__gazetteEntryBodyExecuted=true;alert("entry body ran")</script>',
].join('\n')

async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copiedGazetteLinks: string[] = []
    Object.defineProperty(window, '__copiedGazetteLinks', {
      configurable: true,
      value: copiedGazetteLinks,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          copiedGazetteLinks.push(value)
          return Promise.resolve()
        },
      },
    })
  })
}

async function copiedGazetteLinks(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => [
    ...((window as Window & { __copiedGazetteLinks?: string[] }).__copiedGazetteLinks ?? []),
  ])
}

test('Gazette top actions work at 320px and hostile entry bodies stay inert', async ({ page }) => {
  const dialogs: string[] = []
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  await installClipboardRecorder(page)
  await page.setViewportSize({ width: 320, height: 640 })

  const navigation = await page.goto('/gazette/7')
  expect(navigation?.status()).toBe(200)

  const share = page.locator('[data-gazette-share]')
  const windowLink = page.getByRole('link', { name: 'Open city window' })
  const heading = page.getByRole('heading', { level: 1, name: 'The Gazette' })
  await expect(share).toBeVisible()
  await expect(share).toHaveAccessibleName('Share issue 7')
  await expect(windowLink).toBeVisible()
  await expect(heading).toBeVisible()

  const actionAndHeadingTops = await Promise.all([
    share.evaluate(element => element.getBoundingClientRect().top),
    windowLink.evaluate(element => element.getBoundingClientRect().top),
    heading.evaluate(element => element.getBoundingClientRect().top),
  ])
  expect(actionAndHeadingTops[0]).toBeLessThan(actionAndHeadingTops[2])
  expect(actionAndHeadingTops[1]).toBeLessThan(actionAndHeadingTops[2])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const entryBody = page.locator('.entry-body')
  await expect(entryBody).toContainText(HOSTILE_ENTRY_BODY)
  await expect(entryBody.locator('img, script')).toHaveCount(0)
  expect(await page.evaluate(() => Boolean(
    (window as Window & { __gazetteEntryBodyExecuted?: boolean }).__gazetteEntryBodyExecuted,
  ))).toBe(false)
  expect(dialogs).toEqual([])

  const expectedUrl = `${new URL(page.url()).origin}/gazette/7`
  await share.click()
  await expect.poll(() => copiedGazetteLinks(page)).toEqual([expectedUrl])
  await expect(share).toHaveText('Issue link copied')
  const shareStatus = page.locator('[data-gazette-share-status]')
  await expect(shareStatus).toHaveText(`Link copied: ${expectedUrl}`)
  await expect(shareStatus).toHaveAttribute('data-tone', 'success')

  await windowLink.click()
  await expect(page).toHaveURL(`${new URL(page.url()).origin}/window/gazette?issue=7`)
})

test('Gazette clipboard denial leaves the exact issue URL visible', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText() {
          return Promise.reject(new DOMException('clipboard denied', 'NotAllowedError'))
        },
      },
    })
  })
  const navigation = await page.goto('/gazette/7')
  expect(navigation?.status()).toBe(200)

  const expectedUrl = `${new URL(page.url()).origin}/gazette/7`
  await page.getByRole('button', { name: 'Share issue 7' }).click()

  const shareStatus = page.locator('[data-gazette-share-status]')
  await expect(shareStatus).toHaveText(
    `The link could not copy. Copy this URL: ${expectedUrl}`,
  )
  await expect(shareStatus).toHaveAttribute('data-tone', 'error')
  await expect(page).toHaveURL(expectedUrl)
})
