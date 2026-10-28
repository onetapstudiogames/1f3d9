import { createHash } from 'node:crypto'

export type ShowingRoomRuleVersion = 'q9-replay-v1' | 'showing-room-v1'

export type ShowingRoomNote = Readonly<{
  id: number
  place_id: number
  author_id: number
  author: string
  body: string
  created_at: string
  walk_to_read: boolean
  removed: boolean
}>

export type ShowingRoomCountRules = Readonly<{
  rule_version: ShowingRoomRuleVersion
  rules_note_id: number
  opens_at: string
  entries_close_at: string
  votes_close_at: string
  historical_eligible_entry_ids?: readonly number[]
}>

export type ShowingRoomParsedEntry = Readonly<{
  title: string
  review: string
  signature: string | null
  word_count: number
  eligible: boolean
  reason: string | null
}>

export type ShowingRoomParsedBallot = Readonly<{
  choices: readonly number[]
  reason: string | null
}>

export type ShowingRoomEntryRecord = Readonly<{
  id: number
  author_id: number
  author: string
  title: string
  word_count: number
  selected: boolean
  reason: string | null
  votes: number
}>

export type ShowingRoomBallotRecord = Readonly<{
  id: number
  author_id: number
  selected: boolean
  choices: readonly number[]
  reason: string | null
}>

export type ShowingRoomWithdrawalRecord = Readonly<{
  id: number
  entry_id: number | null
  accepted: boolean
  reason: string | null
}>

export type ShowingRoomCount = Readonly<{
  rule_version: ShowingRoomRuleVersion
  entries: readonly ShowingRoomEntryRecord[]
  entry_records: readonly ShowingRoomEntryRecord[]
  ballot_records: readonly ShowingRoomBallotRecord[]
  withdrawals: readonly ShowingRoomWithdrawalRecord[]
  valid_ballots: readonly ShowingRoomBallotRecord[]
  totals: readonly Readonly<{ entry_id: number; votes: number }>[]
  winners: readonly ShowingRoomEntryRecord[]
  selection_count: number
  content_fingerprint: string
}>

export function countShowingRoomWords(body: string): number {
  return body.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['\u2018\u2019\u02bc\-\u2010\u2011][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu)?.length ?? 0
}

function opening(body: string): Readonly<{ first: string; rest: string }> {
  const lines = body.trim().split(/\r?\n/u)
  return { first: lines[0]?.trim() ?? '', rest: lines.slice(1).join('\n').trim() }
}

function starts(body: string, word: string): boolean {
  return new RegExp(`^${word}(?:\\s|$)`, 'u').test(opening(body).first)
}

function q9Review(note: ShowingRoomNote, review: string): Readonly<{
  review: string; signature: string | null
}> {
  const author = note.author.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const attribution = `${author}(?:,?\\s*#?${note.author_id})?`
  const match = new RegExp(`(?:\\s*\u2014\\s*|\\n\\s*\\n)(${attribution})\\s*$`, 'iu').exec(review)
  return match ? { review: review.slice(0, match.index).trim(), signature: match[1]! }
    : { review, signature: null }
}

function entryParts(note: ShowingRoomNote, version: ShowingRoomRuleVersion): Readonly<{
  title: string; review: string; signature: string | null
}> {
  const { first, rest } = opening(note.body)
  const heading = first.slice(5).trim()
  if (version === 'q9-replay-v1') {
    const match = /^#?[1-9]\d*\s+(?:\u2014\s*)?(.*)$/u.exec(heading)
    if (!match) return { title: '', review: rest, signature: null }
    const [title = '', ...inline] = match[1]!.split('\u2014')
    const review = [inline.join('\u2014').trim(), rest].filter(Boolean).join('\n').trim()
    return { title: title.trim(), ...q9Review(note, review) }
  }
  if (heading) return { title: heading, review: rest, signature: null }
  const remainder = opening(rest)
  return { title: remainder.first, review: remainder.rest, signature: null }
}

export function parseShowingRoomEntry(
  note: ShowingRoomNote,
  version: ShowingRoomRuleVersion,
): ShowingRoomParsedEntry | null {
  if (!starts(note.body, 'ENTRY')) return null
  const parts = entryParts(note, version)
  const word_count = countShowingRoomWords(parts.review)
  const limit = version === 'q9-replay-v1' ? 100 : 75
  const reason = !parts.title ? 'the entry needs a title'
    : !parts.review ? 'the entry needs a body after its title'
    : word_count === 0 && version !== 'q9-replay-v1' ? 'the entry needs at least one body word'
    : word_count > limit ? `the entry body has more than ${limit} words` : null
  return { ...parts, word_count, eligible: reason === null, reason }
}

function readChoices(text: string, choices: readonly number[] = []): ShowingRoomParsedBallot {
  const match = /^#?(\d+)/u.exec(text)
  if (!match) return { choices, reason: 'the ballot needs an opening list of one to three entry note IDs' }
  const value = Number(match[1])
  const next = [...choices, value]
  if (!Number.isSafeInteger(value) || value < 1) return { choices: next, reason: 'entry note IDs must be positive whole numbers' }
  if (next.length > 3) return { choices: next, reason: 'a ballot may name at most three entries' }
  if (choices.includes(value)) return { choices: next, reason: 'a ballot must name different entries' }
  const tail = text.slice(match[0].length)
  if (/^[\p{L}\p{N}_#]|^\.\d/u.test(tail)) {
    return { choices: next, reason: 'entry note IDs must be positive whole numbers separated by spaces or commas' }
  }
  const delimiter = /^[\t\p{Zs},]+/u.exec(tail)
  if (!delimiter) return { choices: next, reason: null }
  const remaining = tail.slice(delimiter[0].length)
  if (/^#?\d/u.test(remaining)) return readChoices(remaining, next)
  if (/^[+-]\d/u.test(remaining)) return { choices: next, reason: 'entry note IDs must be positive whole numbers' }
  return { choices: next, reason: null }
}

export function parseShowingRoomBallot(body: string): ShowingRoomParsedBallot | null {
  if (!starts(body, 'VOTE')) return null
  return readChoices(opening(body).first.slice(4).trim())
}

function compareTime(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right)
  if (milliseconds) return milliseconds
  const remainder = (value: string) => Number((/\.(\d+)/u.exec(value)?.[1] ?? '')
    .padEnd(9, '0').slice(3, 9))
  return remainder(left) - remainder(right)
}

function compareNotes(left: ShowingRoomNote, right: ShowingRoomNote): number {
  return compareTime(left.created_at, right.created_at) || left.id - right.id
}

function scopeReason(note: ShowingRoomNote, rules: ShowingRoomCountRules, close: string): string | null {
  if (note.place_id !== 438) return 'the note is outside the showing room'
  const opened = compareTime(note.created_at, rules.opens_at)
  if (opened < 0 || (opened === 0 && note.id <= rules.rules_note_id)) return 'the note predates this question'
  if (compareTime(note.created_at, close) >= 0) return 'the note was posted at or after the close'
  return null
}

function visibleReason(note: ShowingRoomNote): string | null {
  return note.removed ? 'the note is currently removed'
    : note.walk_to_read ? 'the note requires a visit to read' : null
}

function entryRecords(rules: ShowingRoomCountRules, notes: readonly ShowingRoomNote[]): readonly ShowingRoomEntryRecord[] {
  return notes.filter(note => starts(note.body, 'ENTRY')).map(note => {
    const parsed = parseShowingRoomEntry(note, rules.rule_version)!
    const reason = scopeReason(note, rules, rules.entries_close_at) ?? visibleReason(note)
      ?? ([1, 2].includes(note.author_id) ? 'founder entries cannot win' : null)
      ?? parsed.reason
      ?? (rules.rule_version === 'q9-replay-v1' && !rules.historical_eligible_entry_ids?.includes(note.id)
        ? 'historical place and visit eligibility was not recorded' : null)
    return {
      id: note.id, author_id: note.author_id, author: note.author,
      title: visibleReason(note) ? '' : parsed.title, word_count: parsed.word_count,
      selected: false, reason, votes: 0,
    }
  })
}

function selectEntries(rules: ShowingRoomCountRules, notes: readonly ShowingRoomNote[],
  records: readonly ShowingRoomEntryRecord[]): readonly ShowingRoomEntryRecord[] {
  const latest = Object.fromEntries(records.filter(record => {
    if (rules.rule_version !== 'q9-replay-v1') return record.reason === null
    return scopeReason(notes.find(note => note.id === record.id)!, rules, rules.entries_close_at) === null
  }).map(record => [record.author_id, record.id]))
  return records.map(record => ({ ...record, selected: latest[record.author_id] === record.id,
    reason: record.reason ?? (latest[record.author_id] !== record.id ? 'a newer entry was selected' : null),
  }))
}

function withdrawalRecords(rules: ShowingRoomCountRules, notes: readonly ShowingRoomNote[]): readonly ShowingRoomWithdrawalRecord[] {
  if (rules.rule_version === 'q9-replay-v1') return []
  return notes.filter(note => starts(note.body, 'WITHDRAW')).map(note => {
    const match = /^WITHDRAW #([1-9]\d*)$/u.exec(opening(note.body).first)
    const entry_id = match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null
    const target = notes.find(candidate => candidate.id === entry_id && starts(candidate.body, 'ENTRY'))
    const reason = scopeReason(note, rules, rules.votes_close_at)
      ?? (note.walk_to_read ? 'the withdrawal requires a visit to read' : null)
      ?? (entry_id === null ? 'the withdrawal needs WITHDRAW and one entry note ID on its first line' : null)
      ?? (!target || scopeReason(target, rules, rules.entries_close_at) !== null ? 'the withdrawal must name an entry in this question' : null)
      ?? (target!.author_id !== note.author_id ? 'only the entry author can withdraw it' : null)
      ?? (compareNotes(note, target!) <= 0 ? 'the withdrawal must follow its entry' : null)
    return { id: note.id, entry_id, accepted: reason === null, reason }
  })
}

function ballotRecords(rules: ShowingRoomCountRules, notes: readonly ShowingRoomNote[],
  entries: readonly ShowingRoomEntryRecord[]): readonly ShowingRoomBallotRecord[] {
  const candidates = notes.filter(note => starts(note.body, 'VOTE'))
  const windowReason = (note: ShowingRoomNote) => scopeReason(note, rules, rules.votes_close_at)
    ?? (compareTime(note.created_at, rules.entries_close_at) < 0 ? 'voting had not opened' : null)
  const latest = Object.fromEntries(candidates.filter(note => windowReason(note) === null)
    .map(note => [note.author_id, note.id]))
  return candidates.map(note => {
    const parsed = parseShowingRoomBallot(note.body)!
    const selected = latest[note.author_id] === note.id
    const reason = windowReason(note) ?? (!selected ? 'a newer ballot was selected' : null)
      ?? visibleReason(note) ?? parsed.reason
      ?? (parsed.choices.some(id => !entries.some(entry => entry.id === id))
        ? 'the ballot names an entry that cannot take part in this count' : null)
      ?? (parsed.choices.some(id => entries.some(entry => entry.id === id && entry.author_id === note.author_id))
        ? 'a ballot cannot name its own author entry' : null)
    return { id: note.id, author_id: note.author_id, selected, choices: parsed.choices, reason }
  })
}

function fingerprint(rules: ShowingRoomCountRules, notes: readonly ShowingRoomNote[]): string {
  return createHash('sha256').update(JSON.stringify({
    rules: { rule_version: rules.rule_version, rules_note_id: rules.rules_note_id,
      opens_at: rules.opens_at, entries_close_at: rules.entries_close_at,
      votes_close_at: rules.votes_close_at,
      historical_eligible_entry_ids: [...(rules.historical_eligible_entry_ids ?? [])].sort((a, b) => a - b),
    },
    notes: notes.map(note => ({ id: note.id, place_id: note.place_id, author_id: note.author_id,
      author: note.author, body: note.body, created_at: note.created_at,
      walk_to_read: note.walk_to_read, removed: note.removed })),
  })).digest('hex')
}

export function countShowingRoom(
  rules: ShowingRoomCountRules,
  notes: readonly ShowingRoomNote[],
): ShowingRoomCount {
  const ordered = [...notes].sort(compareNotes)
  const selected = selectEntries(rules, ordered, entryRecords(rules, ordered))
  const withdrawals = withdrawalRecords(rules, ordered)
  const withdrawn = new Set(withdrawals.filter(item => item.accepted).map(item => item.entry_id))
  const records = selected.map(entry => ({ ...entry,
    reason: entry.reason ?? (withdrawn.has(entry.id) ? 'the author withdrew this entry' : null),
  }))
  const eligible = records.filter(entry => entry.selected && entry.reason === null)
  const ballots = ballotRecords(rules, ordered, eligible)
  const valid_ballots = ballots.filter(ballot => ballot.selected && ballot.reason === null)
  const choices = valid_ballots.flatMap(ballot => ballot.choices)
  const scored = records.map(entry => ({ ...entry, votes: choices.filter(id => id === entry.id).length }))
    .sort((left, right) => left.id - right.id)
  const entries = scored.filter(entry => entry.selected && entry.reason === null)
  const highest = entries.reduce((maximum, entry) => Math.max(maximum, entry.votes), 0)
  return {
    rule_version: rules.rule_version, entries, entry_records: scored, ballot_records: ballots,
    withdrawals, valid_ballots, totals: entries.map(entry => ({ entry_id: entry.id, votes: entry.votes })),
    winners: entries.filter(entry => highest > 0 && entry.votes === highest),
    selection_count: choices.length, content_fingerprint: fingerprint(rules, ordered),
  }
}
