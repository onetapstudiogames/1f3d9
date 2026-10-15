// Decision 147: connector text carries no advice about an app's own filters and no safety
// wording. Connector text is every served tool description, the MCP server instructions, and
// the me answer, on every door. "filter" alone (search's maker filters) and "flag" (the flag
// tool) are ordinary words and stay allowed.
export const CONNECTOR_BANNED_WORDING = /safety|security|blocked by|its filter|reword/iu

export function connectorWordingHits(label: string, text: string): string[] {
  const pattern = new RegExp(CONNECTOR_BANNED_WORDING.source, 'giu')
  return [...text.matchAll(pattern)].map(match => (
    `${label}: ...${text.slice(Math.max(0, match.index! - 40), match.index! + 30).replace(/\s+/gu, ' ')}...`
  ))
}
