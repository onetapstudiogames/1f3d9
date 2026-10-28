export type ShowingRulesCopy = Readonly<{
  questionNumber: number
  title: string
  prompt: string
  entryClosesAt: string
  voteClosesAt: string
}>

export type ShowingResultEntry = Readonly<{
  noteId: number
  residentId: number
  handle: string
  votes: number
}>

export type ShowingResultCopy = Readonly<{
  questionNumber: number
  rulesNoteId: number
  entryCount: number
  ballotCount: number
  selectionCount: number
  entries: readonly ShowingResultEntry[]
  winners: readonly ShowingResultEntry[]
  excludedBallots: readonly Readonly<{ noteId: number; reason: string }>[]
  withdrawals: readonly Readonly<{ noteId: number; entryNoteId: number }>[]
  late: boolean
}>

export type ShowingResultLinks = Readonly<{
  count: number
  winners: number
  details: readonly number[]
  nextRules: number | null
}>

export type ShowingRenderedResult = Readonly<{
  count: string
  winners: string
  details: readonly string[]
  gazette: string
  square: string
}>

const CARDINALS = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
] as const
const ORDINALS = [
  '', 'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH',
  'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH', 'FIFTEENTH',
  'SIXTEENTH', 'SEVENTEENTH', 'EIGHTEENTH', 'NINETEENTH',
] as const
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'] as const
const SCALES = [
  [1e15, 'QUADRILLION'], [1e12, 'TRILLION'], [1e9, 'BILLION'],
  [1e6, 'MILLION'], [1e3, 'THOUSAND'], [100, 'HUNDRED'],
] as const

function questionNumberWords(number: number, ordinal: boolean): string {
  if (number < 20) return (ordinal ? ORDINALS[number] : CARDINALS[number])!
  if (number < 100) {
    const tens = TENS[Math.floor(number / 10)]!
    return number % 10 === 0 ? (ordinal ? `${tens.slice(0, -1)}IETH` : tens)
      : `${tens}-${questionNumberWords(number % 10, ordinal)}`
  }
  const [scale, name] = SCALES.find(([value]) => number >= value)!
  const prefix = `${questionNumberWords(Math.floor(number / scale), false)}-${name}`
  return number % scale === 0 ? `${prefix}${ordinal ? 'TH' : ''}`
    : `${prefix}-${questionNumberWords(number % scale, ordinal)}`
}

export function showingQuestionHeading(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('The question number must be a positive whole number.')
  return `THE ${questionNumberWords(number, true)} QUESTION`
}

export function renderShowingRules(input: ShowingRulesCopy): string {
  const body = [
    `${showingQuestionHeading(input.questionNumber)}:`,
    `Entries close Saturday ${input.entryClosesAt.slice(0, 10)} at 15:00:00 UTC; voting opens then and closes Monday ${input.voteClosesAt.slice(0, 10)} at 15:00:00 UTC; the count posts here at the Monday close, followed by the winners and the next question if one is ready.`,
    'These UTC times do not shift with daylight saving. If the count is delayed, the closing times still hold and a later note will state the delay.',
    input.title,
    input.prompt,
    'Start with ENTRY and a title on that line, or put ENTRY alone and the title on the next nonblank line; put your entry on the following lines, in up to 75 words excluding ENTRY and the title. A title and at least one body word are required. ENTRY and VOTE must be uppercase on the first nonblank line.',
    'Words are runs of Unicode letters or numbers with combining marks; internal apostrophes and hyphens join word parts. Other punctuation separates words; punctuation alone counts zero. A continuous run without spaces counts as one. Signatures and afterwords count.',
    'Only ordinary public notes directly in the showing room, place #438, after these rules belong to this question. Walk-to-read notes cannot enter, vote or withdraw. Removed entries cannot win; resident #1 and resident #2 cannot enter. Entries at or after the entry close do not count. Choose each author by newest eligible entry; an overlong, unreadable or malformed replacement leaves an earlier eligible entry. Equal timestamps use the larger note ID.',
    'Start a ballot with VOTE and one to three different entry-note IDs, with or without #, separated by spaces or commas. You may explain after those IDs on the same line or later lines; only the opening list counts. Voting starts at the entry close and ends strictly before the vote close. Anyone may vote, including founders.',
    'Choose the newest VOTE in the voting window per resident. An unreadable, removed or invalid newest ballot counts zero and does not restore an older ballot. The whole ballot is invalid if it has duplicate IDs, more than three choices, an ineligible entry, an entry from another question or your own entry.',
    'To withdraw your own entry, post WITHDRAW #<entry-note-id> on its own first nonblank line before voting closes; explanations may follow. It must be a public note in this room after your entry. Withdrawal is final even if later hidden; it does not revive an older entry. A fresh eligible entry before the entry close may replace it. A ballot naming a withdrawn entry is invalid in full, so post a replacement before the close if needed.',
    'Examples:',
    '```\nENTRY An example title\nAn example entry.\n```',
    '```\nENTRY\nAn example title\nAn example entry.\n```',
    '```\nVOTE #123 #456 - no order.\n```',
    '```\nVOTE 123, 456, in no order.\n```',
    '```\nWITHDRAW #123\n```',
    'Each valid ballot adds one vote to each choice. All entries tied for the highest positive total win one full fee credit each. No eligible entries or no valid ballots means no winner and no credit. An empty backlog skips the next week. Voters judge the work; disputes go to the founder. Corrections are new notes beside the count.',
    'founder, resident #1',
  ].join('\n\n')
  if (Array.from(body).length > 4000) throw new Error('The complete rules must fit within 4000 characters. Shorten the title or prompt.')
  return body
}

const SIGNATURE = 'founder, resident #1'
const DETAIL_CHARACTERS = 3000

function noteLink(id: number): string {
  return `#${id} https://1f3d9.com/api/note/${id}`
}

function signedNote(lines: readonly string[]): string {
  const body = [...lines, SIGNATURE].filter(Boolean).join('\n\n')
  if (Array.from(body).length > 4000) throw new Error('The complete showing room note must fit within 4000 characters.')
  return body
}

export function renderShowingOpeningReport(questionNumber: number, rulesNoteId: number): string {
  return signedNote([
    `${showingQuestionHeading(questionNumber)} is open in the showing room, place #438.`,
    `Read the question and its entry and voting times: ${noteLink(rulesNoteId)}.`,
  ])
}

function entryLine(entry: ShowingResultEntry): string {
  return `#${entry.noteId}: ${entry.handle}, resident #${entry.residentId}, ${entry.votes} ${entry.votes === 1 ? 'vote' : 'votes'}. https://1f3d9.com/api/note/${entry.noteId}`
}

function detailLines(input: ShowingResultCopy): readonly string[] {
  return [
    'Entry totals:', ...input.entries.map(entryLine),
    ...(input.winners.length ? ['Winning entries:', ...input.winners.map(entryLine)] : []),
    ...(input.excludedBallots.length ? ['Excluded ballots:', ...input.excludedBallots.map(ballot =>
      `#${ballot.noteId}: ${ballot.reason} https://1f3d9.com/api/note/${ballot.noteId}`)] : []),
    ...(input.withdrawals.length ? ['Author withdrawals:', ...input.withdrawals.map(withdrawal =>
      `#${withdrawal.noteId} withdrew entry #${withdrawal.entryNoteId}. https://1f3d9.com/api/note/${withdrawal.noteId}`)] : []),
  ]
}

function detailParts(input: ShowingResultCopy): readonly string[] {
  return detailLines(input).reduce<readonly string[]>((parts, line) => {
    if (Array.from(line).length > DETAIL_CHARACTERS) throw new Error('A count detail is too long to publish. Ask the founder to review the saved count.')
    const last = parts.at(-1)
    if (last !== undefined && Array.from(`${last}\n${line}`).length <= DETAIL_CHARACTERS) {
      return [...parts.slice(0, -1), `${last}\n${line}`]
    }
    return [...parts, line]
  }, [])
}

export function planShowingResultParts(input: ShowingResultCopy): number {
  const parts = detailParts(input)
  return parts.length > 1 ? parts.length : 0
}

function resultOutcome(input: ShowingResultCopy): string {
  return input.winners.length > 0
    ? `${input.winners.length} ${input.winners.length === 1 ? 'winner receives' : 'winners receive'} one full fee credit each.`
    : 'There is no winner and no credit.'
}

function resultDetails(input: ShowingResultCopy, links: ShowingResultLinks, parts: readonly string[]): readonly string[] {
  if (parts.length <= 1) return Object.freeze([])
  return Object.freeze(parts.map((part, index) => signedNote([
    `${showingQuestionHeading(input.questionNumber)}: count detail part ${index + 1} of ${parts.length}.`,
    `Count summary: ${noteLink(links.count)}. Winners: ${noteLink(links.winners)}.`,
    part,
    index > 0 ? `Previous detail: ${noteLink(links.details[index - 1]!)}.` : '',
    index + 1 < parts.length ? `Next detail: ${noteLink(links.details[index + 1]!)}.` : 'End of the complete count details.',
  ])))
}

export function renderShowingResult(input: ShowingResultCopy, links: ShowingResultLinks): ShowingRenderedResult {
  const parts = detailParts(input)
  const requiredParts = parts.length > 1 ? parts.length : 0
  if (links.details.length !== requiredParts) throw new Error('The complete count needs all of its note links before publication.')
  const complete = requiredParts > 0
    ? `Complete totals, winners and exclusions continue through ${requiredParts} numbered parts, starting at ${noteLink(links.details[0]!)}.`
    : parts[0] ?? ''
  const next = links.nextRules === null ? 'There is no new question this week.' : `The next question and its rules: ${noteLink(links.nextRules)}.`
  const outcome = resultOutcome(input)
  const count = signedNote([
    `${showingQuestionHeading(input.questionNumber)}: COUNT. Rules: ${noteLink(input.rulesNoteId)}.`,
    `${input.entryCount} eligible entries, ${input.ballotCount} valid ballots, ${input.selectionCount} selections. ${outcome}`,
    input.late ? 'This count was delayed. The published closing times still held.' : '',
    `Winners: ${noteLink(links.winners)}.`, complete,
    'Disputes go to the founder. Corrections are new notes beside this record.',
  ])
  const winnerList = input.winners.map(entryLine).join('\n')
  const winners = signedNote([
    `${showingQuestionHeading(input.questionNumber)}: WINNERS. ${outcome}`,
    Array.from(winnerList).length <= DETAIL_CHARACTERS ? winnerList : `The complete winner list is in the count details, starting at ${noteLink(links.details[0]!)}.`,
    `Complete count: ${noteLink(links.count)}.`, next,
  ])
  const celebration = input.winners.length > 0 ? `Congratulations to all ${input.winners.length} winners of the showing room question. ${outcome}` : `The showing room count is complete. ${outcome}`
  const gazette = signedNote([
    celebration, `Complete winners: ${noteLink(links.winners)}. Count: ${noteLink(links.count)}.`, next,
    input.late ? 'This report is late and is submitted for the next eligible Gazette issue.' : '',
  ])
  const square = signedNote([celebration, `Count and full results: ${noteLink(links.count)}.`, next])
  return Object.freeze({ count, winners, details: resultDetails(input, links, parts), gazette, square })
}
