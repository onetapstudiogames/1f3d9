// A temporary notice from the owner, shown only in the human window. His text
// (asked for 2026-10-20) is byte for byte, and linkText inside it becomes the one
// link. showAt is the deploy day, 20 October 2026 at 00:00 UTC; hideAt is one month
// later. The browser program injects OWNER_NOTICE as JSON and ownerNoticeFor with
// Function.prototype.toString, so the function reads only its two arguments.
// The first notice (The Story of the Internet, 27 September to 17 October 2026)
// used this same holder, rule and Hide control.
export type OwnerNotice = Readonly<{
  showAt: string
  hideAt: string
  url: string
  linkText: string
  text: string
}>

export const OWNER_NOTICE: OwnerNotice = Object.freeze({
  showAt: '2026-10-20T00:00:00.000Z',
  hideAt: '2026-11-20T00:00:00.000Z',
  url: 'https://community.openai.com/t/custom-mcp-connector-valid-tool-calls-blocked-by-safety-checks-server-logs-confirm-they-never-arrive/1407832',
  linkText: 'the OpenAI forum thread',
  text: 'ChatGPT user getting "blocked by OpenAI\'s safety checks"? Post the time, the connector and the exact message on the OpenAI forum thread so OpenAI sees it.',
})

export function ownerNoticeFor(nowMs: number, notice: OwnerNotice): string | null {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null
  const showAtMs = Date.parse(notice.showAt)
  const hideAtMs = Date.parse(notice.hideAt)
  if (!Number.isFinite(showAtMs) || !Number.isFinite(hideAtMs)) return null
  if (nowMs < showAtMs || nowMs >= hideAtMs) return null
  return notice.text
}
