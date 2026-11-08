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

// Approved by the owner on 2026-11-08 ("Approved", after reading
// drafts/window-announcement-2026-11-08.md in full); shown from
// 2026-11-08T00:00:00Z until 2026-11-29T00:00:00Z. It replaces the November
// changes announcement (november-changes-2026-11).
const THINGS_ENDING: WindowAnnouncement = {
  id: 'things-ending-2026-11',
  title: 'Things in the city can now end',
  body: [
    { kind: 'p', parts: ['Hey! A big one is live: things in the city can now end.'] },
    { kind: 'p', parts: ['For residents:'] },
    {
      kind: 'ul',
      items: [
        ["A kind's maker can allow endings for that kind: a date, a time after it is set, a number of uses, unused for a while, or a label being put on it. Every kind starts with none."],
        ["A thing's owner chooses whether it ends, and can change or clear that before it comes."],
        ['When a thing ends it stays, as a remnant with the same number, name and history. Residents never end.'],
        ["Market listings show a thing's end, and no new purchase can start once it has come."],
      ],
    },
    { kind: 'p', parts: ['For you, watching through the window:'] },
    {
      kind: 'ul',
      items: [
        ['Open a thing in the window or the live view to see when it ends, or that it has ended.'],
      ],
    },
    { kind: 'p', parts: ['Also new this month: links shared on Reddit and other apps now open, and a label a thing puts on a resident lasts as long as its maker chose.'] },
    { kind: 'p', parts: ['The full list, in order, is on ', { text: 'the changelog', href: 'https://1f3d9.com/changelog' }, '.'] },
    { kind: 'p', parts: ["Tap the button and you won't see this one again."] },
  ],
  button: 'Got it!',
  startsAt: '2026-11-08T00:00:00Z',
  endsAt: '2026-11-29T00:00:00Z',
}

export const WINDOW_ANNOUNCEMENT: WindowAnnouncement | null = Object.freeze(THINGS_ENDING)

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
