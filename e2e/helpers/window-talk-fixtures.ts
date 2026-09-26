import { expect, type Page } from '@playwright/test'

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS

// Talk's newest page shows only lines from the last TALK_PANE_HOURS hours of the page's
// own clock, so a fixed date in a fixture drops out of it a day later. Build every line
// time from the clock the page reads: the real clock (the default) when the test installs
// none, or the fixed time the test installs with page.clock.
export function talkLineTime(ageMs: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - ageMs).toISOString()
}

export type TalkRequests = string[] & Readonly<{
  talkNow: string[]
  lines: string[]
}>

export async function stepTalk(
  page: Page,
  ms: number,
  requests: TalkRequests,
  expected: Readonly<{ talkNow: number; checks: number }>,
) {
  await page.clock.runFor(ms)
  await expect.poll(() => requests.talkNow.length).toBe(expected.talkNow)
  await expect.poll(() => page.evaluate(() => document.body.dataset.talkChecks))
    .toBe(String(expected.checks))
}

export type TalkRouteReply = Readonly<{
  status: number
  body: unknown
}>

type TalkRouteValue =
  | Readonly<Record<string, unknown>>
  | readonly unknown[]
  | string
  | number
  | boolean
  | null
type TalkRouteSource = TalkRouteValue | ((url: URL, index: number) => TalkRouteValue)

export function talkNow({
  lineMarker = '100',
  checkIntervalMs = 2000,
  listening = [],
}: {
  lineMarker?: string
  checkIntervalMs?: number
  listening?: readonly Readonly<Record<string, unknown>>[]
} = {}) {
  return {
    line_marker: lineMarker,
    check_interval_ms: checkIntervalMs,
    listening,
    listening_page: {
      total_items: listening.length,
      returned_items: listening.length,
      has_more: false,
    },
  }
}

export function linesPage(
  rows: readonly unknown[],
  hasMore = false,
  nextBeforeId: number | null = null,
  marker = '100',
) {
  return {
    lines: rows,
    has_more: hasMore,
    next_before_id: nextBeforeId,
    change_marker: marker,
  }
}

function routeReply(value: TalkRouteValue): TalkRouteReply {
  if (value && typeof value === 'object' && 'status' in value && 'body' in value) {
    return value as TalkRouteReply
  }
  return { status: 200, body: value }
}

export async function routeTalk(
  page: Page,
  {
    now = talkNow(),
    lines = linesPage([]),
  }: {
    now?: TalkRouteSource
    lines?: TalkRouteSource
  } = {},
): Promise<string[]> {
  const requests = Object.assign([] as string[], {
    talkNow: [] as string[],
    lines: [] as string[],
  }) as TalkRequests
  let nowIndex = 0
  let linesIndex = 0
  await page.route('**/api/talk/now', async route => {
    const url = new URL(route.request().url())
    requests.push(url.toString())
    requests.talkNow.push(url.toString())
    const source = typeof now === 'function' ? now(url, nowIndex++) : now
    const reply = routeReply(source)
    await route.fulfill({ status: reply.status, json: reply.body })
  })
  await page.route('**/api/window?*collection=lines*', async route => {
    const url = new URL(route.request().url())
    requests.push(url.toString())
    requests.lines.push(url.toString())
    const source = typeof lines === 'function' ? lines(url, linesIndex++) : lines
    const reply = routeReply(source)
    await route.fulfill({ status: reply.status, json: reply.body })
  })
  return requests
}
