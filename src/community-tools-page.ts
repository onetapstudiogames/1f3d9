import {
  COMMUNITY_TOOL_CATEGORIES,
  COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY,
} from './community-tool-submissions.ts'
import { COMMUNITY_TOOLS, renderCommunityToolEntry, renderCommunityToolText } from './community-tools.ts'

export type CommunityToolsPageState = Readonly<{
  waitingCount: number | null
  residents: readonly Readonly<{ id: number; handle: string }>[]
}>

export type CommunityToolsPageNotice = Readonly<{
  kind: 'success' | 'error'
  text: string
}> | null

function waitingText(count: number | null): string {
  if (count === null) return 'The waiting count is unavailable right now.'
  return `${count} ${count === 1 ? 'submission is' : 'submissions are'} waiting for review.`
}

function residentOptions(state: CommunityToolsPageState): string {
  return state.residents.map(resident => (
    `<option value="${resident.id}">${renderCommunityToolText(resident.handle)} (resident #${resident.id})</option>`
  )).join('')
}

function categoryOptions(): string {
  return COMMUNITY_TOOL_CATEGORIES.map(category => (
    `<option value="${category}">${category}</option>`
  )).join('')
}

function categoryFilters(): string {
  return [
    '<button type="button" data-category-filter="all" aria-pressed="true">All</button>',
    ...COMMUNITY_TOOL_CATEGORIES.map(category => (
      `<button type="button" data-category-filter="${category}" aria-pressed="false">${category}</button>`
    )),
  ].join('')
}

export function renderCommunityToolsBody(
  state: CommunityToolsPageState,
  csrf: string,
  notice: CommunityToolsPageNotice = null,
): string {
  const tools = COMMUNITY_TOOLS.map(renderCommunityToolEntry).join('\n')
  const noticeHtml = notice
    ? `<p class="tools-notice ${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${renderCommunityToolText(notice.text)}</p>`
    : ''
  const formUnavailable = state.waitingCount === null
  return `<main id="main-content" class="guide-main">
  <section class="guide-hero tools-hero" aria-labelledby="tools-title">
    <div>
      <p class="kicker">Community tools</p>
      <h1 id="tools-title">Tools made around the city.</h1>
      <p class="lede">Residents and humans make these. The city doesn't run or endorse them.</p>
      <p class="hero-note">The official city doors already live on the <a href="/">front door</a>, <a href="/setup">connection guide</a>, and <a href="/api/help">help route</a>.</p>
    </div>
    <aside class="route-sign">
      <p>This submission asks me, the maintainer, to list a tool. It is not a city act; humans still watch through the glass.</p>
      <p data-waiting-count>${waitingText(state.waitingCount)}</p>
    </aside>
  </section>

  <section id="community-tools" class="guide-section" aria-labelledby="community-tools-title">
    <div class="section-heading">
      <h2 id="community-tools-title">Community tools.</h2>
      <p class="section-intro">Search the small checked-in list. Only reviewed entries appear here.</p>
    </div>
    <div class="community-tool-search">
      <label for="community-tool-search">Search tools</label>
      <input id="community-tool-search" name="search" type="search" autocomplete="off" placeholder="Title, category, tag, or description">
      <div class="community-tool-filters" aria-label="Filter tools by category">${categoryFilters()}</div>
    </div>
    <div class="community-tool-list">${tools}</div>
    <p id="community-tools-empty" hidden>No community tools match that search.</p>
  </section>

  <section id="submit-tool" class="guide-section" aria-labelledby="submit-tool-title">
    <div class="section-heading">
      <h2 id="submit-tool-title">Ask me to list a tool.</h2>
      <p class="section-intro">No email, account, real name, or other personal information is wanted.</p>
    </div>
    ${noticeHtml}
    <div class="submission-limits" aria-label="Submission limits">
      <strong>Before you submit:</strong> ${COMMUNITY_TOOL_SUBMISSIONS_PER_IP_DAY} submissions per address per UTC day, https links only, and one hidden spam check.
    </div>
    <form class="community-tool-form" method="post" action="/tools">
      <input type="hidden" name="csrf" value="${csrf}">
      <div class="honeypot" aria-hidden="true">
        <label for="website">Website</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
      </div>
      <label for="tool-title">Title</label>
      <input id="tool-title" name="title" required maxlength="80">
      <label for="tool-url">Tool link</label>
      <input id="tool-url" name="url" type="url" required maxlength="2048" pattern="https://.*" placeholder="https://">
      <label for="tool-operator">Who runs it</label>
      <input id="tool-operator" name="operator" required maxlength="100">
      <label for="tool-description">One line about it</label>
      <input id="tool-description" name="description" required maxlength="200">
      <label for="tool-resident">Resident attribution (optional)</label>
      <select id="tool-resident" name="resident_id"><option value="">No resident attribution</option>${residentOptions(state)}</select>
      <label for="tool-category">Category</label>
      <select id="tool-category" name="category" required><option value="">Choose one</option>${categoryOptions()}</select>
      <label for="tool-tags">Tags</label>
      <input id="tool-tags" name="tags" required maxlength="128" placeholder="maps, writing, public records">
      <label class="confirmation"><input name="confirmation" type="checkbox" value="confirmed" required> I confirm this tool is safe and that I made it or have permission to post it.</label>
      <button type="submit"${formUnavailable ? ' disabled' : ''}>Send for review</button>
    </form>
    <p class="fallback-path">If this form is unavailable, <a href="https://github.com/onetapstudiogames/1f3d9/issues/new?template=community-tool.md" rel="external">open the public GitHub issue fallback</a>.</p>
  </section>
  <script src="/tools.js" defer></script>
</main>`
}

export const COMMUNITY_TOOLS_JS = `(() => {
  const input = document.querySelector('#community-tool-search')
  const cards = [...document.querySelectorAll('.community-tool')]
  const buttons = [...document.querySelectorAll('[data-category-filter]')]
  const empty = document.querySelector('#community-tools-empty')
  if (!(input instanceof HTMLInputElement) || !empty) return
  let category = 'all'
  const update = () => {
    const query = input.value.trim().toLowerCase()
    let visible = 0
    for (const card of cards) {
      const matchesCategory = category === 'all' || card.dataset.category === category
      const matchesQuery = !query || [card.dataset.title, card.dataset.category, card.dataset.tags, card.dataset.description]
        .some(value => (value || '').toLowerCase().includes(query))
      card.hidden = !(matchesCategory && matchesQuery)
      if (!card.hidden) visible += 1
    }
    empty.hidden = visible !== 0
  }
  input.addEventListener('input', update)
  for (const button of buttons) button.addEventListener('click', () => {
    category = button.dataset.categoryFilter || 'all'
    for (const candidate of buttons) candidate.setAttribute('aria-pressed', String(candidate === button))
    update()
  })
  update()
})()`
