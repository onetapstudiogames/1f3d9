/** Append public source text as text nodes and known whole-handle links. */
export function appendWindowNoteMentions(
  target: HTMLElement,
  text: string,
  truncated: boolean,
  tokenSource: string,
  knownHandle: (handle: string) => boolean,
  mutedHandle: (handle: string) => boolean,
  mutedLabel: string,
  chooseHandle: (handle: string) => void,
): void {
  const tokens = new RegExp(tokenSource, 'gi')
  let cursor = 0
  for (const token of text.matchAll(tokens)) {
    const handle = token[0].toLowerCase()
    if (!knownHandle(handle)) continue
    const muted = mutedHandle(handle)
    const end = token.index + token[0].length
    if (truncated && end === text.length && !muted) continue
    const start = token.index > cursor && text[token.index - 1] === '@'
      ? token.index - 1 : token.index
    target.append(document.createTextNode(text.slice(cursor, start)))
    if (muted) target.append(document.createTextNode(mutedLabel))
    else {
      const link = document.createElement('a')
      link.className = 'note-mention'
      link.dataset.mentionOffset = String(start)
      link.textContent = text.slice(start, end)
      link.href = '/window/conversations?resident=' + encodeURIComponent(handle)
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        chooseHandle(handle)
      })
      target.append(link)
    }
    cursor = end
  }
  target.append(document.createTextNode(text.slice(cursor)))
}
