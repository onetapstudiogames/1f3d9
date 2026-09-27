// The temporary owner notice above the tab bar (holder in src/window-page.ts,
// texts and instants in src/window-client/owner-notice.ts). It renders at start
// and after every city refresh; Hide lasts for this page load and stores nothing.
export const PART_46_OWNER_NOTICE = `  const ownerNoticeBox = document.getElementById('owner-notice')
  const ownerNoticeText = document.getElementById('owner-notice-text')
  const ownerNoticeHide = document.getElementById('owner-notice-hide')
  let ownerNoticeDismissedText = null

  function renderOwnerNotice() {
    if (!ownerNoticeBox || !ownerNoticeText) return
    const text = ownerNoticeFor(Date.now(), OWNER_NOTICE)
    if (text === null || text === ownerNoticeDismissedText) {
      ownerNoticeBox.hidden = true
      ownerNoticeText.replaceChildren()
      return
    }
    if (!ownerNoticeBox.hidden && ownerNoticeText.textContent === text) return
    const linkAt = text.indexOf(OWNER_NOTICE.url)
    if (linkAt < 0) {
      ownerNoticeText.replaceChildren(text)
    } else {
      const link = document.createElement('a')
      link.href = OWNER_NOTICE.url
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = OWNER_NOTICE.url
      ownerNoticeText.replaceChildren(
        text.slice(0, linkAt),
        link,
        text.slice(linkAt + OWNER_NOTICE.url.length),
      )
    }
    ownerNoticeBox.hidden = false
  }

  ownerNoticeHide?.addEventListener('click', () => {
    ownerNoticeDismissedText = ownerNoticeText?.textContent || null
    renderOwnerNotice()
    tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.focus()
  })
  renderOwnerNotice()

`
