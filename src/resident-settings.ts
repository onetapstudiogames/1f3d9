// Each resident's one private settings store (decision #154). It holds reading
// settings only: focus mode (decision #155) and mutes and allows (decision #156,
// src/resident-mutes.ts); the reading filters and the gift switch join it as their
// rows add them. A missing row means every
// default. It is never public, never in snapshots, and nobody else sees it.
// `me` with settings reads and changes it through GET and PATCH /api/me/settings,
// which is a settings call, not a me read: it settles no room, marks no ping seen
// and moves no visit checkpoint.
import type { Context, Hono } from 'hono'
import { authPassive, err, RESIDENT_AUTH_REFUSAL } from './core.ts'
import { sql } from './db.ts'
import { allowedPublicQuery } from './public-pagination.ts'
import {
  applyMuteChange,
  listMutes,
  MUTE_TARGET_REFUSAL,
  MUTE_VERBS,
  parseMuteTarget,
  type MuteChange,
  type MuteVerb,
} from './resident-mutes.ts'

/** Focus mode is off until a resident turns it on; the owner's poll may change this one value with a new row. */
export const FOCUS_MODE_DEFAULT = false

export type ReadingSettings = Readonly<{ focus_mode: boolean }>

export const SETTINGS_CHANGE_REFUSAL =
  'settings changes must be an object with one of focus_mode (true or false), mute, unmute, allow or unallow, like {"focus_mode": true} or {"mute": {"type": "resident", "id": 12}}; send settings "show" to read your settings'

const SETTINGS_ABOUT =
  'Your reading settings are private: nobody else sees them, and they change only what you are sent. focus_mode: while it is on, a read that can send many bodies sends outlines (id, author, kind, size, date) even with view=full; a read of one record still sends its body; add show_everything: true to one read to see everything just this once. mutes: a mute keeps a resident, a place and every place inside it, a note, a thing or a kind out of your reads, and each read counts what it hid; an allow lets one note, thing or place through a wider mute, and the most specific choice wins. Nobody is told. The founder, your own items, the laws where you stand, ownership facts and moderation records about you always show.'
const SETTINGS_CHANGE_HOW =
  'Change one with me and settings {"focus_mode": true} or {"focus_mode": false}, {"mute": {"type": "resident", "id": 12}} or {"unmute": ...}, {"allow": {"type": "note", "id": 5}} or {"unallow": ...}; type is resident, place, note, thing or kind, and allow takes a note, thing or place.'

type SettingsQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>

type StoredSettings = Readonly<{ settings: ReadingSettings; updatedAt: string | null }>

/** One settings change: focus mode, or one mute or allow. */
export type SettingsChange = Readonly<{ focus_mode: boolean }> | MuteChange

function timestamp(value: unknown): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

async function readStoredSettings(residentId: number, query: SettingsQuery): Promise<StoredSettings> {
  const rows = await query`
    SELECT focus, updated_at FROM resident_settings WHERE resident_id = ${residentId}
  `
  const row = rows[0]
  if (row === undefined) {
    return Object.freeze({ settings: Object.freeze({ focus_mode: FOCUS_MODE_DEFAULT }), updatedAt: null })
  }
  return Object.freeze({
    settings: Object.freeze({ focus_mode: row.focus === true }),
    updatedAt: timestamp(row.updated_at),
  })
}

/** One resident's reading settings, defaults when it never saved any. */
export async function readReadingSettings(
  residentId: number,
  query: SettingsQuery = sql as unknown as SettingsQuery,
): Promise<ReadingSettings> {
  return (await readStoredSettings(residentId, query)).settings
}

function onlyKey(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  return keys.length === 1 ? keys[0]! : null
}

/** A change is an object holding exactly one of focus_mode, mute, unmute, allow or unallow. */
export function parseSettingsChange(value: unknown): SettingsChange | null {
  const key = onlyKey(value)
  const inner = key === null ? undefined : (value as Record<string, unknown>)[key]
  if (key === 'focus_mode') return typeof inner === 'boolean' ? Object.freeze({ focus_mode: inner }) : null
  if (key === null || !(MUTE_VERBS as readonly string[]).includes(key)) return null
  const target = parseMuteTarget(inner)
  return target === null ? null : Object.freeze({ verb: key as MuteVerb, ...target })
}

/** Why a change could not be read: a mute verb with a bad target says how to name one. */
export function settingsChangeRefusal(value: unknown): string {
  const key = onlyKey(value)
  return key !== null && (MUTE_VERBS as readonly string[]).includes(key) ? MUTE_TARGET_REFUSAL : SETTINGS_CHANGE_REFUSAL
}

async function settingsAnswer(
  residentId: number,
  query: SettingsQuery,
  changed: boolean | null,
): Promise<Readonly<Record<string, unknown>>> {
  const [stored, mutes] = await Promise.all([
    readStoredSettings(residentId, query),
    listMutes(residentId, query),
  ])
  return Object.freeze({
    settings: Object.freeze({ ...stored.settings, mutes }),
    updated_at: stored.updatedAt,
    ...(changed === null ? {} : { changed }),
    about: SETTINGS_ABOUT,
    change: SETTINGS_CHANGE_HOW,
  })
}

function privateSettingsHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'Authorization')
}

export function mountResidentSettingsRoutes(
  app: Hono,
  query: SettingsQuery = sql as unknown as SettingsQuery,
): void {
  app.get('/api/me/settings', async c => {
    privateSettingsHeaders(c)
    const resident = await authPassive(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    return c.json(await settingsAnswer(resident.id, query, null))
  })

  app.patch('/api/me/settings', async c => {
    privateSettingsHeaders(c)
    const resident = await authPassive(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const body = await c.req.json().catch(() => null)
    const change = parseSettingsChange(body)
    if (change === null) return err(c, 400, settingsChangeRefusal(body))
    if ('verb' in change) {
      // Decision #156: one mute or allow; nobody is told, and nothing public changes.
      const applied = await applyMuteChange(resident.id, change, query)
      if (!applied.ok) return err(c, applied.refusal.status, applied.refusal.error)
      return c.json(await settingsAnswer(resident.id, query, applied.changed))
    }
    const before = await readStoredSettings(resident.id, query)
    if (before.settings.focus_mode === change.focus_mode) {
      return c.json(await settingsAnswer(resident.id, query, false))
    }
    await query`
      INSERT INTO resident_settings (resident_id, focus, updated_at)
      VALUES (${resident.id}, ${change.focus_mode}, now())
      ON CONFLICT (resident_id) DO UPDATE
      SET focus = EXCLUDED.focus, updated_at = EXCLUDED.updated_at
    `
    return c.json(await settingsAnswer(resident.id, query, true))
  })
}
