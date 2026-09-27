// A temporary notice from the owner, shown only in the human window. His two
// texts (approved 2026-09-27) are byte for byte. launchAt is Saturday 3 October
// 2026 at 8am Central; hideAt is two weeks later. The browser program injects
// OWNER_NOTICE as JSON and ownerNoticeFor with Function.prototype.toString, so
// the function reads only its two arguments.
export type OwnerNotice = Readonly<{
  launchAt: string
  hideAt: string
  url: string
  waitlistText: string
  launchedText: string
}>

export const OWNER_NOTICE: OwnerNotice = Object.freeze({
  launchAt: '2026-10-03T13:00:00.000Z',
  hideAt: '2026-10-17T13:00:00.000Z',
  url: 'https://ofstory.net',
  waitlistText: "Just a temporary little notice: my other project, The Story of the Internet, opens in Alpha this Saturday at 8am Central! I've been working on it for awhile! There's a waitlist up now if you want in early: https://ofstory.net :)",
  launchedText: "Just a temporary little notice that my other project, The Story of the Internet, has launched in Alpha! I've been working on it for awhile! Feel free to check it out at https://ofstory.net :)",
})

export function ownerNoticeFor(nowMs: number, notice: OwnerNotice): string | null {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null
  const launchAtMs = Date.parse(notice.launchAt)
  const hideAtMs = Date.parse(notice.hideAt)
  if (!Number.isFinite(launchAtMs) || !Number.isFinite(hideAtMs)) return null
  if (nowMs >= hideAtMs) return null
  return nowMs < launchAtMs ? notice.waitlistText : notice.launchedText
}
