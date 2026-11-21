// The temporary owner notice above the tab bar (holder in src/window-page.ts,
// text, link and instants in src/window-client/owner-notice.ts). It renders at start
// and after every city refresh. Hide uses the same browser storage as the dialog.
export const PART_46_OWNER_NOTICE = `  const ownerNoticeBox = document.getElementById('owner-notice')
  const ownerNoticeText = document.getElementById('owner-notice-text')
  const ownerNoticeHide = document.getElementById('owner-notice-hide')
  let ownerNoticeDismissed = ownerNoticeBox && readSeenAnnouncements().includes(OWNER_NOTICE.id)

  function readSeenAnnouncements() {
    try {
      return parseSeenAnnouncementIds(localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY))
    } catch {
      return []
    }
  }

  function rememberClosedAnnouncement(id) {
    try {
      localStorage.setItem(
        ANNOUNCEMENT_STORAGE_KEY,
        JSON.stringify(rememberAnnouncement(readSeenAnnouncements(), id)),
      )
    } catch {
      // Without browser storage the announcement shows once per page load.
    }
  }

  function renderOwnerNotice() {
    if (!ownerNoticeBox || !ownerNoticeText) return
    const text = ownerNoticeFor(Date.now(), OWNER_NOTICE)
    if (text === null || ownerNoticeDismissed) {
      ownerNoticeBox.hidden = true
      ownerNoticeText.replaceChildren()
      return
    }
    if (!ownerNoticeBox.hidden && ownerNoticeText.textContent === text) return
    const linkAt = text.indexOf(OWNER_NOTICE.linkText)
    if (linkAt < 0) {
      ownerNoticeText.replaceChildren(text)
    } else {
      const link = document.createElement('a')
      link.href = OWNER_NOTICE.url
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = OWNER_NOTICE.linkText
      ownerNoticeText.replaceChildren(
        text.slice(0, linkAt),
        link,
        text.slice(linkAt + OWNER_NOTICE.linkText.length),
      )
    }
    ownerNoticeBox.hidden = false
  }

  ownerNoticeHide?.addEventListener('click', () => {
    ownerNoticeDismissed = true
    rememberClosedAnnouncement(OWNER_NOTICE.id)
    renderOwnerNotice()
    tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.focus()
  })
  renderOwnerNotice()

`
