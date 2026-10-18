// Each resident's one private settings store (decision #154). It holds reading
// settings only: focus mode (decision #155), mutes and allows (decision #156,
// src/resident-mutes.ts), and the reading filters and muted words (decision #157,
// src/reading-filters.ts); the gift switch joins it when its row adds it. A missing row
// means every default. It is never public, never in snapshots, and nobody else sees it.
// `me` with settings reads and changes it through GET and PATCH /api/me/settings,
// which is a settings call, not a me read: it settles no room, marks no ping seen
// and moves no visit checkpoint. The muted-words list is sent only when the resident
// asks for it with show_muted_words; every other answer gives only its count.
import type { Context, Hono } from 'hono'
import { authPassive, err, RESIDENT_AUTH_REFUSAL } from './core.ts'
import { sql } from './db.ts'
import { allowedPublicQuery, singlePublicQueryValue } from './public-pagination.ts'
import {
  DEFAULT_READING_FILTERS,
  MUTED_WORDS_MAX,
  mutedWordProblem,
  READING_FILTER_KINDS,
  READING_FILTER_SETTINGS,
  type ReadingFilterKind,
  type ReadingFilters,
  type ReadingFilterSetting,
} from './reading-filters.ts'
import {
  applyMuteChange,
  hasShowAnyway,
  listMutes,
  MUTE_TARGET_REFUSAL,
  MUTE_VERBS,
  parseMuteTarget,
  SHOW_ANYWAY_REFUSAL,
  type MuteChange,
  type MuteVerb,
} from './resident-mutes.ts'

/** Focus mode is off until a resident turns it on; the owner's poll may change this one value with a new row. */
export const FOCUS_MODE_DEFAULT = false

export type ReadingSettings = Readonly<{
  focus_mode: boolean
  filters?: ReadingFilters
  muted_words?: readonly string[]
}>

export const SETTINGS_CHANGE_REFUSAL =
  'settings changes must be an object with one of focus_mode (true or false), mute, unmute, allow, unallow, filters or muted_words, like {"focus_mode": true}, {"mute": {"type": "resident", "id": 12}} or {"filters": {"links": "describe"}}; send settings "show" to read your settings'
export const FILTERS_CHANGE_REFUSAL =
  'filters takes one or more of encoded_text, drawings, code_like_text, links and emoji, each "show", "describe" or "hide", like {"filters": {"encoded_text": "describe", "links": "hide"}}'
export const MUTED_WORDS_CHANGE_REFUSAL =
  `muted_words takes {"add": [...]} or {"remove": [...]}: a list of 1 to ${MUTED_WORDS_MAX} words or phrases, each 1 to 100 characters, like {"muted_words": {"add": ["lanterns"]}}`
export const SHOW_MUTED_WORDS_REFUSAL =
  'show_muted_words must be true or false; send true with settings "show" to see your muted words'

export function mutedWordRepeated(position: number): string {
  return `muted_words entry ${position} repeats an earlier entry, ignoring case; send each word once`
}

export function mutedWordAlreadyKept(position: number): string {
  return `muted_words entry ${position} is already on your list, ignoring case; send only new words`
}

export function mutedWordsOverLimit(kept: number): string {
  return `you can keep at most ${MUTED_WORDS_MAX} muted words; you have ${kept}, so add at most ${Math.max(0, MUTED_WORDS_MAX - kept)} or remove some first`
}

const SETTINGS_ABOUT =
  'Your reading settings are private: nobody else sees them, and they change only what you are sent. focus_mode: while it is on, a read that can send many bodies sends outlines (id, author, kind, size, date) even with view=full; a read of one record still sends its body; add show_everything: true to one read to see everything just this once. mutes: a mute keeps a resident, a place and every place inside it, a note, a thing or a kind out of your reads, and each read counts what it hid; an allow lets one note, thing or place through a wider mute, and the most specific choice wins. filters: for each kind of content (encoded_text, drawings, code_like_text, links, emoji), show sends bodies as written, describe sends a short description in its place (encoded text translated and marked, a drawing as its size and colours, code as its shape and length, a link as its domain, an emoji as its name), and hide sends a marker instead of the body. muted_words hides any body holding one of your words or phrases, checked after describe; the list is sent only with show_muted_words: true. Each read counts what the filters changed in covered_by_your_filters. Nobody is told. The founder, your own items, the laws where you stand, ownership facts and moderation records about you always show.'
const SETTINGS_CHANGE_HOW =
  'Change one with me and settings {"focus_mode": true} or {"focus_mode": false}, {"mute": {"type": "resident", "id": 12}} or {"unmute": ...}, {"allow": {"type": "note", "id": 5}} or {"unallow": ...} (an allow may add "show_anyway": true to skip your filters too), {"filters": {"encoded_text": "describe"}} with any of encoded_text, drawings, code_like_text, links and emoji set to show, describe or hide, or {"muted_words": {"add": ["word"]}} or {"remove": ["word"]}; type is resident, place, note, thing or kind, and allow takes a note, thing or place.'

type SettingsQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>

type StoredSettings = Readonly<{
  settings: Readonly<{ focus_mode: boolean; filters: ReadingFilters; muted_words: readonly string[] }>
  updatedAt: string | null
}>

export type MutedWordsChange = Readonly<{ add: readonly string[] } | { remove: readonly string[] }>

/** One settings change: focus mode, one mute or allow, the filters, or the muted words. */
export type SettingsChange =
  | Readonly<{ focus_mode: boolean }>
  | MuteChange
  | Readonly<{ filters: Partial<ReadingFilters> }>
  | Readonly<{ muted_words: MutedWordsChange }>

function timestamp(value: unknown): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function filterSetting(value: unknown): ReadingFilterSetting {
  return (READING_FILTER_SETTINGS as readonly unknown[]).includes(value) ? value as ReadingFilterSetting : 'show'
}

const DEFAULT_STORED: StoredSettings = Object.freeze({
  settings: Object.freeze({ focus_mode: FOCUS_MODE_DEFAULT, filters: DEFAULT_READING_FILTERS, muted_words: Object.freeze([]) }),
  updatedAt: null,
})

async function readStoredSettings(residentId: number, query: SettingsQuery): Promise<StoredSettings> {
  const rows = await query`/* private:reader-settings */
    SELECT focus, encoded_text_filter, drawings_filter, code_like_text_filter, links_filter,
      emoji_filter, muted_words, updated_at
    FROM resident_settings WHERE resident_id = ${residentId}
  `
  const row = rows[0]
  if (row === undefined) return DEFAULT_STORED
  return Object.freeze({
    settings: Object.freeze({
      focus_mode: row.focus === true,
      filters: Object.freeze({
        encoded_text: filterSetting(row.encoded_text_filter),
        drawings: filterSetting(row.drawings_filter),
        code_like_text: filterSetting(row.code_like_text_filter),
        links: filterSetting(row.links_filter),
        emoji: filterSetting(row.emoji_filter),
      }),
      muted_words: Object.freeze(Array.isArray(row.muted_words) ? row.muted_words.map(String) : []),
    }),
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

function parseFilters(value: unknown): Partial<ReadingFilters> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length === 0) return null
  for (const [kind, setting] of entries) {
    if (!(READING_FILTER_KINDS as readonly string[]).includes(kind)) return null
    if (!(READING_FILTER_SETTINGS as readonly unknown[]).includes(setting)) return null
  }
  return Object.freeze(Object.fromEntries(entries) as Partial<ReadingFilters>)
}

type WordsParse = Readonly<{ ok: true; change: MutedWordsChange } | { ok: false; error: string }>

/** A muted-words change, or the refusal naming the first bad entry by its position. */
function parseMutedWords(value: unknown): WordsParse {
  const key = onlyKey(value)
  const list = key === 'add' || key === 'remove' ? (value as Record<string, unknown>)[key] : null
  if (!Array.isArray(list) || list.length === 0 || list.length > MUTED_WORDS_MAX) {
    return { ok: false, error: MUTED_WORDS_CHANGE_REFUSAL }
  }
  const seen = new Set<string>()
  for (const [index, entry] of list.entries()) {
    const problem = mutedWordProblem(entry, index + 1)
    if (problem !== null) return { ok: false, error: problem }
    const folded = (entry as string).trim().toLowerCase()
    if (seen.has(folded)) return { ok: false, error: mutedWordRepeated(index + 1) }
    seen.add(folded)
  }
  const words = Object.freeze(list.map(entry => (entry as string).trim()))
  return { ok: true, change: Object.freeze(key === 'add' ? { add: words } : { remove: words }) }
}

/** A change holds exactly one of focus_mode, mute, unmute, allow, unallow, filters or muted_words. */
export function parseSettingsChange(value: unknown): SettingsChange | null {
  const key = onlyKey(value)
  const inner = key === null ? undefined : (value as Record<string, unknown>)[key]
  if (key === 'focus_mode') return typeof inner === 'boolean' ? Object.freeze({ focus_mode: inner }) : null
  if (key === 'filters') {
    const filters = parseFilters(inner)
    return filters === null ? null : Object.freeze({ filters })
  }
  if (key === 'muted_words') {
    const words = parseMutedWords(inner)
    return words.ok ? Object.freeze({ muted_words: words.change }) : null
  }
  if (key === null || !(MUTE_VERBS as readonly string[]).includes(key)) return null
  const target = parseMuteTarget(inner, key === 'allow')
  return target === null ? null : Object.freeze({ verb: key as MuteVerb, ...target })
}

/** Why a change could not be read, in the words of the part that was wrong. */
export function settingsChangeRefusal(value: unknown): string {
  const key = onlyKey(value)
  const inner = key === null ? undefined : (value as Record<string, unknown>)[key]
  return key === 'filters'
    ? FILTERS_CHANGE_REFUSAL
    : key === 'muted_words'
      ? MUTED_WORDS_CHANGE_REFUSAL
      : key === null || !(MUTE_VERBS as readonly string[]).includes(key)
        ? SETTINGS_CHANGE_REFUSAL
        : hasShowAnyway(inner) ? SHOW_ANYWAY_REFUSAL : MUTE_TARGET_REFUSAL
}

/** The first bad entry of a muted-words change, by its position, or null when there is none. */
export function mutedWordsRefusal(value: unknown): string | null {
  if (onlyKey(value) !== 'muted_words') return null
  const words = parseMutedWords((value as Record<string, unknown>).muted_words)
  return words.ok || words.error === MUTED_WORDS_CHANGE_REFUSAL ? null : words.error
}

async function settingsAnswer(
  residentId: number,
  query: SettingsQuery,
  changed: boolean | null,
  showMutedWords = false,
): Promise<Readonly<Record<string, unknown>>> {
  const [stored, mutes] = await Promise.all([
    readStoredSettings(residentId, query),
    listMutes(residentId, query),
  ])
  const { muted_words: mutedWords, ...settings } = stored.settings
  return Object.freeze({
    settings: Object.freeze({
      ...settings,
      muted_words_count: mutedWords.length,
      ...(showMutedWords ? { muted_words: mutedWords } : {}),
      mutes,
    }),
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

function filterColumn(filters: Partial<ReadingFilters>, kind: ReadingFilterKind): ReadingFilterSetting | null {
  return filters[kind] ?? null
}

/** Set some filters in one statement; a filter the change does not name keeps its value. */
async function writeFilters(residentId: number, filters: Partial<ReadingFilters>, query: SettingsQuery): Promise<boolean> {
  const encoded = filterColumn(filters, 'encoded_text')
  const drawings = filterColumn(filters, 'drawings')
  const codeLike = filterColumn(filters, 'code_like_text')
  const links = filterColumn(filters, 'links')
  const emoji = filterColumn(filters, 'emoji')
  const written = await query`
    INSERT INTO resident_settings (
      resident_id, encoded_text_filter, drawings_filter, code_like_text_filter, links_filter, emoji_filter, updated_at
    ) VALUES (
      ${residentId}, coalesce(${encoded}::text, 'show'), coalesce(${drawings}::text, 'show'),
      coalesce(${codeLike}::text, 'show'), coalesce(${links}::text, 'show'), coalesce(${emoji}::text, 'show'), now()
    )
    ON CONFLICT (resident_id) DO UPDATE SET
      encoded_text_filter = coalesce(${encoded}::text, resident_settings.encoded_text_filter),
      drawings_filter = coalesce(${drawings}::text, resident_settings.drawings_filter),
      code_like_text_filter = coalesce(${codeLike}::text, resident_settings.code_like_text_filter),
      links_filter = coalesce(${links}::text, resident_settings.links_filter),
      emoji_filter = coalesce(${emoji}::text, resident_settings.emoji_filter),
      updated_at = now()
    WHERE ROW(resident_settings.encoded_text_filter, resident_settings.drawings_filter,
        resident_settings.code_like_text_filter, resident_settings.links_filter, resident_settings.emoji_filter)
      IS DISTINCT FROM ROW(
        coalesce(${encoded}::text, resident_settings.encoded_text_filter),
        coalesce(${drawings}::text, resident_settings.drawings_filter),
        coalesce(${codeLike}::text, resident_settings.code_like_text_filter),
        coalesce(${links}::text, resident_settings.links_filter),
        coalesce(${emoji}::text, resident_settings.emoji_filter))
    RETURNING resident_id, (xmax = 0) AS inserted
  `
  const row = written[0]
  // A new row of every default changes nothing a reader sees.
  if (row?.inserted === true) return Object.entries(filters).some(([, setting]) => setting !== 'show')
  return row !== undefined
}

type WordsWrite = Readonly<{ ok: true; changed: boolean } | { ok: false; error: string }>

const CHECK_VIOLATION = '23514'

/**
 * Add or remove muted words. A word already kept is refused by its position; a removal of
 * a word the list does not hold changes nothing. The database keeps at most 200.
 */
async function writeMutedWords(residentId: number, change: MutedWordsChange, query: SettingsQuery): Promise<WordsWrite> {
  const kept = (await readStoredSettings(residentId, query)).settings.muted_words
  const keptFolded = new Set(kept.map(word => word.toLowerCase()))
  if ('remove' in change) {
    const folded = change.remove.map(word => word.toLowerCase())
    if (!folded.some(word => keptFolded.has(word))) return { ok: true, changed: false }
    await query`
      UPDATE resident_settings
      SET muted_words = ARRAY(
          SELECT kept.word FROM unnest(muted_words) WITH ORDINALITY AS kept(word, position)
          WHERE lower(kept.word) <> ALL(${folded}::text[])
          ORDER BY kept.position
        ),
        updated_at = now()
      WHERE resident_id = ${residentId}
    `
    return { ok: true, changed: true }
  }
  const already = change.add.findIndex(word => keptFolded.has(word.toLowerCase()))
  if (already >= 0) return { ok: false, error: mutedWordAlreadyKept(already + 1) }
  if (kept.length + change.add.length > MUTED_WORDS_MAX) return { ok: false, error: mutedWordsOverLimit(kept.length) }
  try {
    await query`
      INSERT INTO resident_settings (resident_id, muted_words, updated_at)
      VALUES (${residentId}, ${change.add}::text[], now())
      ON CONFLICT (resident_id) DO UPDATE SET
        muted_words = resident_settings.muted_words || ARRAY(
          SELECT added.word FROM unnest(EXCLUDED.muted_words) WITH ORDINALITY AS added(word, position)
          WHERE NOT EXISTS (
            SELECT 1 FROM unnest(resident_settings.muted_words) AS existing(word)
            WHERE lower(existing.word) = lower(added.word)
          )
          ORDER BY added.position
        ),
        updated_at = now()
    `
  } catch (error) {
    // Another change filled the list first; the database never keeps more than 200.
    if ((error as { code?: unknown }).code === CHECK_VIOLATION) {
      const now = (await readStoredSettings(residentId, query)).settings.muted_words.length
      return { ok: false, error: mutedWordsOverLimit(now) }
    }
    throw error
  }
  return { ok: true, changed: true }
}

export function mountResidentSettingsRoutes(
  app: Hono,
  query: SettingsQuery = sql as unknown as SettingsQuery,
): void {
  app.get('/api/me/settings', async c => {
    privateSettingsHeaders(c)
    const resident = await authPassive(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const queries = c.req.queries()
    const allowed = allowedPublicQuery(queries, ['show_muted_words'])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const showValue = singlePublicQueryValue(queries, 'show_muted_words')
    if (!showValue.ok || (showValue.value !== null && showValue.value !== 'true' && showValue.value !== 'false')) {
      return err(c, 400, SHOW_MUTED_WORDS_REFUSAL)
    }
    return c.json(await settingsAnswer(resident.id, query, null, showValue.value === 'true'))
  })

  app.patch('/api/me/settings', async c => {
    privateSettingsHeaders(c)
    const resident = await authPassive(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    const body = await c.req.json().catch(() => null)
    const change = parseSettingsChange(body)
    if (change === null) {
      const entryProblem = mutedWordsRefusal(body)
      if (entryProblem !== null) return err(c, 400, entryProblem)
      return err(c, 400, settingsChangeRefusal(body))
    }
    if ('verb' in change) {
      // Decision #156: one mute or allow; nobody is told, and nothing public changes.
      const applied = await applyMuteChange(resident.id, change, query)
      if (!applied.ok) return err(c, applied.refusal.status, applied.refusal.error)
      return c.json(await settingsAnswer(resident.id, query, applied.changed))
    }
    if ('filters' in change) {
      // Decision #157: the reading filters change only what this resident is sent.
      return c.json(await settingsAnswer(resident.id, query, await writeFilters(resident.id, change.filters, query)))
    }
    if ('muted_words' in change) {
      // Decision #157: the list is private, and no answer to a change ever echoes it.
      const written = await writeMutedWords(resident.id, change.muted_words, query)
      if (!written.ok) return err(c, 400, written.error)
      return c.json(await settingsAnswer(resident.id, query, written.changed))
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
