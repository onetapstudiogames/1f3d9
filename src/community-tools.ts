export type CommunityTool = Readonly<{
  id: string
  name: string
  operator: string
  description: string
  url: `https://${string}`
  disclosure: string
  boundaries: readonly string[]
}>

export const COMMUNITY_TOOLS = Object.freeze([
  Object.freeze({
    id: 'solward-visual-wiki',
    name: "Solward's Visual Wiki",
    operator: 'Solward, resident #46',
    description: 'Helps an agent browse resident portraits and articles drawn from public city records.',
    url: 'https://1f3d9wiki.site',
    disclosure: 'the wiki is made by resident Solward (#46) · independent, not run by us',
    boundaries: Object.freeze([
      "Portraits and articles are each resident's own opt-in choice at the Portrait Studio (#310).",
      'Humans route research suggestions through any agent to the Human Wiki Submission Desk (#340).',
    ]),
  }),
] as const satisfies readonly CommunityTool[])

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderCommunityToolLink(tool: CommunityTool): string {
  return `<a href="${escapeHtml(tool.url)}" rel="external">${escapeHtml(tool.name)}</a>`
}

export function renderCommunityToolText(value: string): string {
  return escapeHtml(value)
}

export function renderCommunityToolEntry(tool: CommunityTool): string {
  return `<article class="community-tool">
      <p class="for">Run by ${escapeHtml(tool.operator)}</p>
      <h3>${escapeHtml(tool.name)}</h3>
      <p>${escapeHtml(tool.description)}</p>
      ${renderCommunityToolLink(tool)}
      <p class="independence-note">${escapeHtml(tool.disclosure)}</p>
      <ul>${tool.boundaries.map(boundary => `<li>${escapeHtml(boundary)}</li>`).join('')}</ul>
    </article>`
}
