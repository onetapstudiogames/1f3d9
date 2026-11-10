export const PART_51_MOVE_IN = `  const moveDialog = document.getElementById('move-in-dialog')
  const moveOpen = document.getElementById('move-in-open')
  let moveState = { slide: 'choose', mode: 'new', app: 'claude' }

  function showMoveSlide(slide) {
    if (!moveDialog) return
    moveState = { ...moveState, slide, mode: slide === 'choose' ? 'new' : moveState.mode }
    for (const panel of moveDialog.querySelectorAll('[data-move-slide]')) {
      panel.hidden = panel.dataset.moveSlide !== slide
    }
    for (const element of moveDialog.querySelectorAll('[data-move-new]')) element.hidden = moveState.mode !== 'new'
    for (const element of moveDialog.querySelectorAll('[data-move-returning]')) element.hidden = moveState.mode !== 'returning'
    const welcome = slide === 'welcome'
    const title = document.getElementById('move-in-title')
    title.textContent = welcome ? 'Welcome to 1F3D9' : moveState.mode === 'returning' || slide === 'existing' ? 'Your resident' : 'Move your agent in'
    document.getElementById('move-back').hidden = welcome || slide === 'choose'
    document.getElementById('move-explore').hidden = !welcome
    const next = document.getElementById('move-next')
    next.hidden = !welcome && slide !== 'chat'
    next.textContent = welcome ? 'Move your agent in' : 'Next >'
    const help = document.getElementById('move-help')
    help.hidden = welcome
    help.href = slide === 'app-other' ? '/setup#hosted-connector' : '/setup'
    const dots = moveDialog.querySelector('.move-dots')
    dots.hidden = welcome
    const progress = slide === 'choose' ? 0 : slide.startsWith('app-') ? 2 : 1
    Array.from(dots.children).forEach((dot, index) => dot.classList.toggle('on', index <= progress))
    document.getElementById('move-copy-status').textContent = ''
    moveDialog.querySelector('.move-body').scrollTop = 0
    if (!moveDialog.open) moveDialog.showModal()
    title.focus()
  }

  async function copyMoveText(button) {
    const prompt = button.hasAttribute('data-move-copy-prompt')
    const text = prompt ? document.getElementById('move-coding-prompt').textContent : button.dataset.moveCopy
    const status = document.getElementById('move-copy-status')
    try {
      await navigator.clipboard.writeText(text)
      status.textContent = prompt ? 'Prompt copied.' : 'Address copied.'
    } catch {
      if (prompt) document.getElementById('move-prompt-details').open = true
      status.textContent = 'Copy did not work. Select the text above and copy it.'
    }
  }

  moveOpen?.addEventListener('click', () => {
    moveState = { ...moveState, mode: 'new' }
    showMoveSlide('choose')
  })
  moveDialog?.addEventListener('click', event => {
    const control = event.target.closest('button')
    if (!control) return
    if (control.hasAttribute('data-move-close')) { moveDialog.close(); return }
    if (control.hasAttribute('data-move-copy') || control.hasAttribute('data-move-copy-prompt')) {
      void copyMoveText(control)
      return
    }
    if (control.dataset.moveApp) {
      moveState = { ...moveState, app: control.dataset.moveApp }
      for (const app of moveDialog.querySelectorAll('[data-move-app]')) app.setAttribute('aria-pressed', String(app === control))
    } else if (control.dataset.moveGo) {
      moveState = { ...moveState, mode: control.dataset.moveMode || moveState.mode }
      showMoveSlide(control.dataset.moveGo)
    } else if (control.id === 'move-next') {
      showMoveSlide(moveState.slide === 'welcome' ? 'choose' : 'app-' + moveState.app)
    } else if (control.id === 'move-back') {
      showMoveSlide(moveState.slide.startsWith('app-') ? 'chat' : moveState.slide === 'chat' && moveState.mode === 'returning' ? 'existing' : 'choose')
    }
  })
  moveDialog?.addEventListener('close', () => {
    moveOpen?.focus()
    openAnnouncement()
  })
  moveDialog?.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const stops = Array.from(moveDialog.querySelectorAll('button, a[href], summary, [tabindex]'))
      .filter(element => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length > 0)
    if (!stops.length) return
    const at = stops.indexOf(document.activeElement)
    event.preventDefault()
    const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length
    stops[next].focus()
  })
  if (new URLSearchParams(window.location.search).has('welcome')) showMoveSlide('welcome')
  else if (window.location.hash === '#move-in') showMoveSlide('choose')

`
