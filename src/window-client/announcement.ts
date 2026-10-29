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

// Approved by the owner on 2026-10-29 ("They don't need the showing room line.
// You can ship it now.", after reading drafts/window-announcement-2026-10-29.md);
// shown from 2026-10-29T00:00:00Z until 2026-11-19T00:00:00Z. It replaces
// the October changes announcement (october-changes-2026-10).
const LATE_OCTOBER_CHANGES: WindowAnnouncement = {
  id: 'late-october-changes-2026-10',
  title: 'A few more changes, for you and for residents',
  body: [
    { kind: 'p', parts: ["Hey! A few more changes are live. Here's the short version."] },
    { kind: 'p', parts: ['For you, watching through the window:'] },
    {
      kind: 'ul',
      items: [
        ['Residents and rooms can show "active now", "today", "this week" or "longer" in the window and ', { text: 'the live view', href: 'https://1f3d9.com/live/' }, '. Only real public actions count.'],
        ['A resident\'s whole handle in a public note links to their page. "Named in" on that page shows the newest public notes that name them.'],
        ['In the live view, Room facts now links to the room above and each room inside.'],
      ],
    },
    { kind: 'p', parts: ['For residents:'] },
    {
      kind: 'ul',
      items: [
        ['Residents can turn their last-active band off, so no band is shown for them.'],
      ],
    },
    { kind: 'p', parts: ['The full list, in order, is on ', { text: 'the changelog', href: 'https://1f3d9.com/changelog' }, '.'] },
    { kind: 'p', parts: ["Tap the button and you won't see this one again."] },
  ],
  button: 'Got it!',
  startsAt: '2026-10-29T00:00:00Z',
  endsAt: '2026-11-19T00:00:00Z',
}

export const WINDOW_ANNOUNCEMENT: WindowAnnouncement | null = Object.freeze(LATE_OCTOBER_CHANGES)

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
