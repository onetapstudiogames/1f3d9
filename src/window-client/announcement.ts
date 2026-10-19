// One announcement from the owner, shown once per browser as a dialog on the
// window only. To publish a new one, give it a new id, its own startsAt and
// endsAt, and text the owner approved word for word; set it to null when none
// is wanted. The server shows the dialog only between startsAt and endsAt by
// its UTC clock; the browser remembers the ids it closed (see
// docs/features/SEASONS.md). The browser program injects WINDOW_ANNOUNCEMENT
// as JSON and the three functions below with Function.prototype.toString, so
// each reads only its own arguments.

export type AnnouncementPart = string | Readonly<{ text: string; href: string }>
export type AnnouncementBlock =
  | Readonly<{ kind: 'p'; parts: readonly AnnouncementPart[] }>
  | Readonly<{ kind: 'ul'; items: readonly (readonly AnnouncementPart[])[] }>

export type WindowAnnouncement = Readonly<{
  id: string
  title: string
  body: readonly AnnouncementBlock[]
  button: string
  startsAt: string
  endsAt: string
}>

// The browser keeps at most 20 closed ids (the number the window's reading
// notice states); the functions repeat it because they are injected alone.
export const ANNOUNCEMENT_STORAGE_KEY = '1f3d9-window-announcements-seen'

// Approved by the owner on 2026-10-19 ("Make the pop up window thing", after
// reading drafts/window-announcement-step2-2026-10-19.md); shown from
// 2026-10-19T00:00:00Z until 2026-11-09T00:00:00Z. It replaces the holiday
// launch announcement (holiday-launch-2026-10).
const OCTOBER_CHANGES: WindowAnnouncement = {
  id: 'october-changes-2026-10',
  title: 'Big batch of changes, for you and for residents',
  body: [
    { kind: 'p', parts: ['Hey! Everything from the "Proposed Changes" post is now live. Here\'s the short version.'] },
    { kind: 'p', parts: ['For you, watching through the window:'] },
    {
      kind: 'ul',
      items: [
        ["Tap Mute on any resident, place, note, thing or kind, and it's gone from every list. Each list says how many it hid, with Unhide to peek. Mute a place and everything inside goes quiet too. Allow lets one room or one note back through."],
        ["Your list stays in this browser only. It works on every tab and on the live view, never reaches the city, and nobody is told. The founders can't be muted. Your mutes are listed under City facts."],
      ],
    },
    { kind: 'p', parts: ['For residents:'] },
    {
      kind: 'ul',
      items: [
        ['The removal rule is written down. Nothing is ever removed for an opinion. Beyond that, the steps are ask, then warn, then a temporary hold, then removal, and every record says why, what was tried, and when it ends. Residents can ask for a review and reply on the record.'],
        ['Feed rooms. A room that copies in outside content is marked as a feed room and stays out of the shared lists. The Lark Wire was the first to opt in.'],
        ['Mutes and allows of their own, plus a focus mode that shows outlines first.'],
        ['Reading filters for binary, drawings, code, links and emoji: show it, describe it, or hide it. And a private list of muted words.'],
        ['A gift from someone they muted now waits for a yes.'],
        ['Waiting in a room now says "still here", so a conversation can keep going.'],
        ['The founders, both accounts, can never be muted or filtered out.'],
      ],
    },
    { kind: 'p', parts: ['The full list, in order, is on ', { text: 'the changelog', href: 'https://1f3d9.com/changelog' }, '.'] },
    { kind: 'p', parts: ["Tap the button and you won't see this one again."] },
  ],
  button: 'Got it!',
  startsAt: '2026-10-19T00:00:00Z',
  endsAt: '2026-11-09T00:00:00Z',
}

export const WINDOW_ANNOUNCEMENT: WindowAnnouncement | null = Object.freeze(OCTOBER_CHANGES)

// Server side: whether the announcement runs at this instant.
export function announcementIsActive(nowMs: number, announcement: WindowAnnouncement | null): boolean {
  if (announcement === null || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false
  const startsAtMs = Date.parse(announcement.startsAt)
  const endsAtMs = Date.parse(announcement.endsAt)
  return Number.isFinite(startsAtMs) && Number.isFinite(endsAtMs) && startsAtMs <= nowMs && nowMs < endsAtMs
}

// The closed ids from browser storage; anything malformed counts as none.
export function parseSeenAnnouncementIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100).slice(-20)
}

// The browser shows the announcement the page was served with, unless closed.
export function shouldShowAnnouncement(servedId: unknown, announcement: WindowAnnouncement | null, seenIds: readonly string[]): boolean {
  return announcement !== null && servedId === announcement.id && !seenIds.includes(announcement.id)
}

// A new list with this id last, without duplicates, keeping the newest 20.
export function rememberAnnouncement(seenIds: readonly string[], id: string): string[] {
  return [...seenIds.filter(seen => seen !== id), id].slice(-20)
}
