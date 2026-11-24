// Phone keyboard dock. A keyboard only counts as open when the visual viewport
// shrinks by 120 px or more within 900 ms of a text field gaining focus (a
// hardware keyboard or a desktop focus is not a keyboard). While open the app
// is sized to the visual viewport, the page pan iOS adds is undone so the
// header stays put, and the state is re-checked while the field is focused
// (a field removed while focused never fires focusout).

const THRESHOLD = 120
const WINDOW_MS = 900

export function installKeyboardDock() {
  const vv = window.visualViewport
  if (!vv || !window.matchMedia('(pointer: coarse)').matches) return () => {}
  const root = document.documentElement
  let baseline = vv.height
  let focusedAt = 0
  let poll: number | undefined

  const isField = (el: Element | null) => Boolean(el && (el.matches('textarea, input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), [contenteditable=true]')))
  const apply = () => {
    const shrunk = baseline - vv.height
    const open = isField(document.activeElement) && shrunk >= THRESHOLD && (root.dataset['keyboard'] === 'open' || performance.now() - focusedAt < WINDOW_MS || shrunk > 200)
    if (open) {
      root.dataset['keyboard'] = 'open'
      root.style.setProperty('--app-height', `${vv.height}px`)
      root.style.setProperty('--kb-height', `${Math.max(0, baseline - vv.height)}px`)
      if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0)
    } else {
      delete root.dataset['keyboard']
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--kb-height')
      if (!isField(document.activeElement)) baseline = Math.max(baseline, vv.height)
    }
  }
  const onFocusIn = (e: FocusEvent) => {
    if (!isField(e.target as Element)) return
    focusedAt = performance.now()
    window.clearInterval(poll)
    poll = window.setInterval(() => {
      apply()
      if (!isField(document.activeElement)) window.clearInterval(poll)
    }, 400)
  }
  const onFocusOut = () => window.setTimeout(apply, 50)
  const onResize = () => {
    if (!isField(document.activeElement) && !root.dataset['keyboard']) baseline = vv.height
    apply()
  }
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  vv.addEventListener('resize', onResize)
  vv.addEventListener('scroll', apply)
  return () => {
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusout', onFocusOut)
    vv.removeEventListener('resize', onResize)
    vv.removeEventListener('scroll', apply)
    window.clearInterval(poll)
  }
}
