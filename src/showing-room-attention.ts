import { isoTimestamp } from './timestamp.ts'

type Database = Readonly<{ query(text: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> }>

const NOTICE = Object.freeze({
  failed: 'The last showing room attempt did not finish. Read the founder backlog before retrying the same Monday slot.',
  overdue: 'The showing room count or opening is overdue. Read the founder backlog; the published closing times still hold.',
  empty_backlog: 'The showing room skipped its next question because the backlog was empty. Add a question for the next Monday slot.',
  late_recovery: 'The showing room completed a late slot. No new question opened. The backlog resumes at the next Monday slot.',
  paused: 'Showing room runs are paused. Read the founder backlog before resuming.',
  unavailable: 'Showing room status is temporarily unavailable. Retry me or read the founder backlog; the queue has not been reported empty.',
})

export async function readShowingRoomAttention(database: Database): Promise<Readonly<Record<string, unknown>>> {
  try {
    const rows = await database.query(`
      /* showing:attention */
      SELECT control.enabled, control.paused, control.first_slot_at, control.failure_code,
        clock_timestamp() AS now,
        (SELECT count(*)::integer FROM showing_room_contests WHERE state='queued') AS queue_count,
        (SELECT min(vote_closes_at) FROM showing_room_contests WHERE state='open') AS due_contest_at,
        latest.slot_at AS last_slot_at, latest.skipped AS last_skipped,
        latest.late AS last_late, latest.recovery_run_id AS last_recovery_run_id,
        (SELECT publication.note_id FROM showing_room_publications publication
          JOIN showing_room_runs run ON run.id=publication.run_id
          WHERE publication.purpose='count' AND publication.part=1 AND run.completed_at IS NOT NULL
          ORDER BY run.slot_at DESC LIMIT 1) AS last_count_note_id
      FROM showing_room_control control
      LEFT JOIN LATERAL (SELECT slot_at,skipped,late,recovery_run_id FROM showing_room_runs
        WHERE completed_at IS NOT NULL ORDER BY slot_at DESC LIMIT 1) latest ON TRUE
      WHERE control.id=1
    `)
    const row = rows[0]
    if (!row || !Number.isSafeInteger(Number(row.queue_count))) throw new Error('showing room status was not returned')
    const first = isoTimestamp(row.first_slot_at)
    const latest = isoTimestamp(row.last_slot_at)
    const next = latest ? new Date(Date.parse(latest) + 7 * 86_400_000).toISOString() : first
    const due = isoTimestamp(row.due_contest_at) ?? next
    const now = isoTimestamp(row.now)
    const noticeCode = row.failure_code ? 'failed'
      : row.enabled && row.paused ? 'paused'
        : row.enabled && due && now && due <= now ? 'overdue'
          : row.last_skipped && (row.last_late || row.last_recovery_run_id != null) ? 'late_recovery'
            : row.last_skipped ? 'empty_backlog' : null
    return {
      enabled: row.enabled, paused: row.paused, queue_count: Number(row.queue_count),
      next_slot: next, last_count_note_id: row.last_count_note_id == null ? null : Number(row.last_count_note_id),
      last_count_href: row.last_count_note_id == null ? null : `/api/note/${Number(row.last_count_note_id)}`,
      notice_code: noticeCode, notice: noticeCode === null ? null : NOTICE[noticeCode],
      founder_backlog: '/api/founder/showing-room',
    }
  } catch {
    return { queue_count: null, next_slot: null, last_count_note_id: null,
      notice_code: 'unavailable', notice: NOTICE.unavailable, founder_backlog: '/api/founder/showing-room' }
  }
}
