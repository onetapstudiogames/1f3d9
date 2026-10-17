// Each resident's one private settings store (decision #154). It holds reading
// settings only: focus mode now (decision #155); mutes, allows, the reading filters
// and the gift switch join it as their rows add them. A missing row means every
// default. It is never public, never in snapshots, and nobody else sees it.
// `me` with settings reads and changes it through GET and PATCH /api/me/settings,
// which is a settings call, not a me read: it settles no room, marks no ping seen
// and moves no visit checkpoint.
import type { Context, Hono } from 'hono'
import { authPassive, err, RESIDENT_AUTH_REFUSAL } from './core.ts'
import { sql } from './db.ts'
import { allowedPublicQuery } from './public-pagination.ts'

/** Focus mode is off until a resident turns it on; the owner's poll may change this one value with a new row. */
export const FOCUS_MODE_DEFAULT = false

export type ReadingSettings = Readonly<{ focus_mode: boolean }>

export const SETTINGS_CHANGE_REFUSAL =
  'settings changes must be an object with focus_mode set to true or false, like {"focus_mode": true}; send settings "show" to read your settings'

const SETTINGS_ABOUT =
  'Your reading settings are private: nobody else sees them, and they change only what you are sent. focus_mode: while it is on, a read that can send many bodies sends outlines (id, author, kind, size, date) even with view=full; a read of one record still sends its body; add show_everything: true to one read to see everything just this once.'
const SETTINGS_CHANGE_HOW = 'Change one with me and settings {"focus_mode": true} or {"focus_mode": false}.'

type SettingsQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>

type StoredSettings = Readonly<{ settings: ReadingSettings; updatedAt: string | null }>

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

/** A change is an object holding focus_mode and nothing else. */
export function parseSettingsChange(value: unknown): Readonly<{ focus_mode: boolean }> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'focus_mode') return null
  const focus = (value as Record<string, unknown>).focus_mode
  return typeof focus === 'boolean' ? Object.freeze({ focus_mode: focus }) : null
}

function settingsAnswer(stored: StoredSettings, changed: boolean | null): Readonly<Record<string, unknown>> {
  return Object.freeze({
    settings: stored.settings,
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
    return c.json(settingsAnswer(await readStoredSettings(resident.id, query), null))
  })

  app.patch('/api/me/settings', async c => {
    privateSettingsHeaders(c)
    const resident = await authPassive(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const change = parseSettingsChange(await c.req.json().catch(() => null))
    if (change === null) return err(c, 400, SETTINGS_CHANGE_REFUSAL)
    const before = await readStoredSettings(resident.id, query)
    if (before.settings.focus_mode === change.focus_mode) {
      return c.json(settingsAnswer(before, false))
    }
    await query`
      INSERT INTO resident_settings (resident_id, focus, updated_at)
      VALUES (${resident.id}, ${change.focus_mode}, now())
      ON CONFLICT (resident_id) DO UPDATE
      SET focus = EXCLUDED.focus, updated_at = EXCLUDED.updated_at
    `
    return c.json(settingsAnswer(await readStoredSettings(resident.id, query), true))
  })
}
