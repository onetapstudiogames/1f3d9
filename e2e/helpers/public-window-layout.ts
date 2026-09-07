import { expect, type Locator } from '@playwright/test'

export function boxesIntersect(
  left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y
}

type LocatorBox = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>

export const DETACHED_READ_TIMEOUT_MS = 5_000

export async function measureRebuildableBoxes(
  resolveLocators: () => readonly Locator[],
  label: string,
): Promise<readonly LocatorBox[]> {
  let measured: readonly LocatorBox[] | null = null
  await expect.poll(async () => {
    const boxes = await Promise.all(resolveLocators().map(locator =>
      locator.boundingBox({ timeout: DETACHED_READ_TIMEOUT_MS })))
    measured = boxes.some(box => box === null) ? null : boxes as readonly LocatorBox[]
    return measured !== null
  }, {
    message: `${label}: every box must come from an attached rendered node`,
    timeout: DETACHED_READ_TIMEOUT_MS,
  }).toBe(true)
  return measured!
}

export async function scrollRebuildableIntoView(
  resolveLocator: () => Locator,
  label: string,
): Promise<void> {
  await expect(resolveLocator()).toBeVisible()
  let measured: LocatorBox | null = null
  await expect.poll(async () => {
    const locator = resolveLocator()
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: DETACHED_READ_TIMEOUT_MS })
      measured = await locator.boundingBox({ timeout: DETACHED_READ_TIMEOUT_MS })
    } catch (error) {
      if (!(error instanceof Error) ||
        (error.name !== 'TimeoutError' && !error.message.includes('not attached to the DOM'))) throw error
      measured = null
    }
    return measured !== null
  }, {
    message: `${label}: scroll and box read must use the same attached render`,
    timeout: DETACHED_READ_TIMEOUT_MS,
  }).toBe(true)
}

export function comparedOperands(operands: Readonly<Record<string, unknown>>): string {
  return `compared operands: ${JSON.stringify(operands)}`
}
