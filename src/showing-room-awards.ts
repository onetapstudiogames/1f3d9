import { CityCreditConflictError, issueCityFeeCredit, type CityCreditDatabase } from './city-credit.ts'
import type { ShowingRoomCount } from './showing-room-count.ts'
import { parseShowingRoomSlot } from './showing-room-schedule.ts'

export type ShowingRoomAwardContest = Readonly<{
  state: string
  question_number: number
  vote_closes_at: string
}>

export type ShowingRoomAwardReceipt = Readonly<{
  resident_id: number
  entry_note_id: number
  source_key: string
  credit_entry_id: string
  amount_units: string
  reason: string
}>

export class ShowingRoomAwardError extends Error {
  readonly code: 'manual_contest' | 'award_review'

  constructor(code: 'manual_contest' | 'award_review', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ShowingRoomAwardError'
    this.code = code
  }
}

export async function issueShowingRoomAwards(
  database: CityCreditDatabase,
  contest: ShowingRoomAwardContest,
  count: ShowingRoomCount,
): Promise<readonly ShowingRoomAwardReceipt[]> {
  if (contest.state !== 'open' || count.rule_version !== 'showing-room-v1'
    || !Number.isSafeInteger(contest.question_number) || contest.question_number < 1
    || parseShowingRoomSlot(contest.vote_closes_at) === null) {
    throw new ShowingRoomAwardError('manual_contest',
      'only an open managed showing room contest can issue scheduled credits; manual contests stay with the founder')
  }
  if (count.entries.length === 0 || count.valid_ballots.length === 0) return []
  let receipts: readonly ShowingRoomAwardReceipt[] = []
  for (const winner of [...count.winners].sort((left, right) => left.author_id - right.author_id)) {
    const sourceKey = `showing-room-q${contest.question_number}-${contest.vote_closes_at.slice(0, 10)}-r${winner.author_id}`
    const reason = `Showing room question ${contest.question_number}, winning entry #${winner.id}.`
    try {
      const receipt = await issueCityFeeCredit(database, {
        founderId: 1, residentId: winner.author_id, sourceKey, reason,
      })
      receipts = [...receipts, {
        resident_id: winner.author_id, entry_note_id: winner.id, source_key: sourceKey,
        credit_entry_id: receipt.entry_id, amount_units: receipt.amount_units, reason,
      }]
    } catch (error) {
      if (error instanceof CityCreditConflictError) {
        throw new ShowingRoomAwardError('award_review',
          'the showing room award could not be confirmed; ask the founder to review this contest, its original source key and recipient',
          { cause: error })
      }
      throw error
    }
  }
  return receipts
}
