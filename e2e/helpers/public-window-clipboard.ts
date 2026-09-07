import { type Page } from '@playwright/test'

export async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copiedShareLinks: string[] = []
    Object.defineProperty(window, '__copiedShareLinks', {
      configurable: true,
      value: copiedShareLinks,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          copiedShareLinks.push(value)
          return Promise.resolve()
        },
      },
    })
  })
}
