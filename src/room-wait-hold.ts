import {
  WAIT_POLL_MILLISECONDS,
  type PublicPing,
  type RoomLine,
  type WaitReason,
  type WaitSeconds,
} from './room-talk-contract.ts'

export type WaitCursors = Readonly<{ line: string; ping: string }>
export type WaitPingRead = Readonly<{
  change_id: string
  kind: 'ping_sent' | 'ping_answered'
  ping: PublicPing
}>
export type WaitRead = Readonly<{
  lines: readonly RoomLine[]
  linesHasMore: boolean
  pings: readonly WaitPingRead[]
  pingsHasMore: boolean
  next: WaitCursors
  still: 'here' | 'moved'
}>

export async function holdWait(input: Readonly<{
  seconds: WaitSeconds
  start: WaitCursors
  read: (cursors: WaitCursors) => Promise<WaitRead>
  closed: () => boolean
  sleep: (milliseconds: number) => Promise<void>
  now: () => number
}>): Promise<Readonly<{ reason: WaitReason | 'closed'; read: WaitRead }>> {
  const deadline = input.now() + input.seconds * 1_000
  let cursors = input.start

  while (true) {
    const read = await input.read(cursors)
    if (read.still === 'moved') return { reason: 'moved', read }
    if (read.lines.length > 0 || read.pings.length > 0) return { reason: 'change', read }
    if (input.closed()) return { reason: 'closed', read }

    const remaining = deadline - input.now()
    if (remaining <= 0) return { reason: 'timeout', read }

    cursors = read.next
    await input.sleep(Math.min(WAIT_POLL_MILLISECONDS, remaining))
  }
}
