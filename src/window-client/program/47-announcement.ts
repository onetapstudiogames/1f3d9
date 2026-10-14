// The one-time owner announcement (data in src/window-client/announcement.ts,
// holder in src/window-page.ts). The server marks the holder with the running
// announcement's id; this part shows it once per browser. Closing stores the
// id; without browser storage it shows once per page load.
export const PART_47_ANNOUNCEMENT = `  const announcementBox = document.getElementById('announcement')
  const announcementDialog = announcementBox ? announcementBox.querySelector('[role="dialog"]') : null
  const announcementTitle = document.getElementById('announcement-title')
  const announcementBody = document.getElementById('announcement-body')
  const announcementOk = document.getElementById('announcement-ok')
  let announcementReturnFocus = null

  function readSeenAnnouncements() {
    try {
      return parseSeenAnnouncementIds(localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY))
    } catch {
      return []
    }
  }

  function announcementInline(parts) {
    return parts.map(part => {
      if (typeof part === 'string') return part
      const link = document.createElement('a')
      link.href = part.href
      link.rel = 'external noopener'
      link.target = '_blank'
      link.textContent = part.text
      return link
    })
  }

  function renderAnnouncement(announcement) {
    announcementTitle.textContent = announcement.title
    announcementOk.textContent = announcement.button
    announcementBody.replaceChildren(...announcement.body.map(block => {
      if (block.kind === 'ul') {
        const list = document.createElement('ul')
        list.replaceChildren(...block.items.map(item => {
          const entry = document.createElement('li')
          entry.replaceChildren(...announcementInline(item))
          return entry
        }))
        return list
      }
      const paragraph = document.createElement('p')
      paragraph.replaceChildren(...announcementInline(block.parts))
      return paragraph
    }))
  }

  function closeAnnouncement() {
    if (!announcementBox || announcementBox.hidden) return
    announcementBox.hidden = true
    try {
      localStorage.setItem(
        ANNOUNCEMENT_STORAGE_KEY,
        JSON.stringify(rememberAnnouncement(readSeenAnnouncements(), WINDOW_ANNOUNCEMENT.id)),
      )
    } catch {
      // Without browser storage the announcement shows once per page load.
    }
    const returnTo = announcementReturnFocus && document.contains(announcementReturnFocus)
      ? announcementReturnFocus
      : tabs.find(tab => tab.getAttribute('aria-selected') === 'true')
    returnTo?.focus()
  }

  function openAnnouncement() {
    if (!announcementBox || !announcementDialog || !announcementTitle || !announcementBody || !announcementOk) return
    if (!shouldShowAnnouncement(announcementBox.dataset.announcement, WINDOW_ANNOUNCEMENT, readSeenAnnouncements())) return
    renderAnnouncement(WINDOW_ANNOUNCEMENT)
    const active = document.activeElement
    announcementReturnFocus = active instanceof HTMLElement && active !== document.body ? active : null
    announcementBox.hidden = false
    announcementDialog.focus()
  }

  announcementOk?.addEventListener('click', closeAnnouncement)
  announcementBox?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAnnouncement()
      return
    }
    if (event.key !== 'Tab') return
    const stops = [announcementBody, ...announcementBody.querySelectorAll('a[href]'), announcementOk]
    const at = stops.indexOf(document.activeElement)
    event.preventDefault()
    const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length
    stops[next].focus()
  })
  openAnnouncement()

`
