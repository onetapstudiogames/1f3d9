import { PART_33_AGREEMENTS_AND_HISTORY_CONTROLS } from '../../src/window-client/program/33-agreements-and-history-controls.ts'
import { PART_50_MENTIONS } from '../../src/window-client/program/50-mentions.ts'
import { sourceBetween, type HistoryEntry } from './harness.ts'

class RenderNode {
  id = ''
  hidden = false
  children: RenderNode[] = []
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  textContent: string
  constructor(text = '') { this.textContent = text }
  append(...nodes: RenderNode[]) { this.children = [...this.children, ...nodes] }
  replaceChildren(...nodes: RenderNode[]) { this.children = nodes; this.textContent = '' }
  setAttribute(name: string, value: string) { this.attributes = { ...this.attributes, [name]: value } }
  querySelectorAll() { return [] }
  addEventListener() {}
}

// Run the real renderer and its old shared control so the quiet-only regression
// fails on the leaked control, not on a mocked replacement for it.
export function mentionsRenderer(entry: HistoryEntry) {
  const root = new RenderNode()
  const find = (id: string, node = root): RenderNode | null =>
    node.id === id ? node : node.children.map(child => find(id, child)).find(Boolean) ?? null
  const hideHistoryControl = (node: RenderNode) => { node.hidden = true; node.replaceChildren() }
  const control = sourceBetween(PART_33_AGREEMENTS_AND_HISTORY_CONTROLS,
    '  function renderHistoryControl', '  // One read shape')
  new Function('document', 'nodes', 'element', 'historyEntry', 'placeReference',
    'isQuietPlace', 'hideHistoryControl', 'renderViewerList', 'noteCard', `
    const state = { view: 'conversations', resident: 'selene' };
    const handleIsMuted = () => false;
    const selectionIssue = () => null;
    const autoLoadFilteredHistory = () => {};
    const splitMutedRows = (_kind, rows) => ({ shown: rows, hidden: [] });
    const historyKey = () => 'mentions:selene';
    const muteNotice = () => null;
    const shownHandle = handle => handle;
    const namedHistoryGap = entry => entry.gapAfterIds?.length ? {} : null;
    ${control}
    ${PART_50_MENTIONS}
    renderMentions({});
  `)(
    { getElementById: find }, { conversationPage: { after: (node: RenderNode) => root.append(node) } },
    (_tag: string, _className: string, text?: string) => new RenderNode(text),
    () => entry,
    (_snapshot: unknown, id: number) => id === 99 ? null : { quiet: id === 12 },
    (place: { quiet: boolean }) => place.quiet,
    hideHistoryControl,
    (target: RenderNode, list: RenderNode) => target.replaceChildren(list),
    (note: { id: number }) => new RenderNode('note:' + note.id),
  )
  return { node: find, markup: () => JSON.parse(JSON.stringify(root)) as unknown }
}
