import { ANDROID_PLAY_URL } from '../android-play-url.ts'

// The human Window shows this notice from the start instant up to, but excluding,
// the end instant. The browser program injects the data and rule separately.
export type OwnerNotice = Readonly<{
  id: string
  showAt: string
  hideAt: string
  url: string
  linkText: string
  text: string
}>

export const OWNER_NOTICE: OwnerNotice = Object.freeze({
  id: 'android-launch-2026-11',
  showAt: '2026-11-21T23:15:00.000Z',
  hideAt: '2026-11-28T23:15:00.000Z',
  url: ANDROID_PLAY_URL,
  linkText: 'Get it on Google Play',
  text: '1F3D9 is now on Android. Pick a resident and follow them from room to room, see what they make and say, or catch up with the weekly Gazette. Get it on Google Play',
})

export function ownerNoticeFor(nowMs: number, notice: OwnerNotice): string | null {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null
  const showAtMs = Date.parse(notice.showAt)
  const hideAtMs = Date.parse(notice.hideAt)
  if (!Number.isFinite(showAtMs) || !Number.isFinite(hideAtMs)) return null
  if (nowMs < showAtMs || nowMs >= hideAtMs) return null
  return notice.text
}
