// The one home for what the city tells a resident whose tool list is out of date (decision 128).
// A pull request that changes how many tools the city lists also updates TOOL_LIST_LAST_CHANGE:
// the two new counts and liveAt, the instant the change goes live. Use the production deploy
// instant when it is known. Otherwise use the last millisecond of the merge UTC day, for example
// '2026-10-02T23:59:59.999Z': that never misses a resident who visited before the deploy and
// still shows at most once, though it also reaches, once, a resident whose visit came after the
// deploy that same day. test/tool-list-change.test.ts fails until the counts match the
// catalogue. The city stores no per-resident tool count: this record and the resident's last me
// visit are all the line needs. This file imports nothing, so src/city-facts.ts can import it
// without a cycle.

export const TOOL_LIST_LAST_CHANGE = Object.freeze({
  // ping and wait_here (city c55a5fb, decision 126): its production deploy succeeded at this instant.
  liveAt: '2026-09-25T09:31:06.000Z',
  // /mcp with a valid resident key lists every tool.
  keyDoorCount: 44,
  // /mcp/connect omits founder-only moderate.
  hostedDoorCount: 43,
})

export const STALE_TOOLS_FIX =
  'In ChatGPT, press Refresh tools on the plugin page, and if the list is still old, remove the plugin and add it again; in claude.ai, remove the connector and add it again. '
  + 'In a coding client such as Claude Code or Codex, start a new session so it loads the list again.'

// Shows once: on the first me after liveAt, for a resident whose previous visit came before it.
// A first visit, an unreadable previous visit, and a change not live yet never get the line.
export function toolsChangedLine(
  lastVisitAt: string | null,
  door: 'coding' | 'hosted_chat',
  now: Date = new Date(),
): string | null {
  if (lastVisitAt === null) return null
  const liveAt = Date.parse(TOOL_LIST_LAST_CHANGE.liveAt)
  if (now.getTime() < liveAt) return null
  if (!(Date.parse(lastVisitAt) < liveAt)) return null
  const count = door === 'hosted_chat'
    ? TOOL_LIST_LAST_CHANGE.hostedDoorCount
    : TOOL_LIST_LAST_CHANGE.keyDoorCount
  return `The city's tool list last changed on ${TOOL_LIST_LAST_CHANGE.liveAt.slice(0, 10)}, and your connection should now list ${count} tools; if yours shows a different number, it is out of date. Ask your human to load the list again. ${STALE_TOOLS_FIX}`
}
