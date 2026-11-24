// Tooltips for chrome controls: a dark label above the control after a short delay, and
// at once on keyboard focus. It takes over native `title`s on controls inside the app
// chrome (icon buttons, the search bar, rail icons), so the two never show together.

import { useEffect, useState } from 'react'

const SCOPE = '.icon-button, .search-field, .rail-item, .message-actions > button, .row-gear'
const DELAY = 400

type Tip = { text: string; x: number; y: number; side: 'above' | 'below' | 'right' }

function label(el: HTMLElement): string {
  const title = el.getAttribute('title')
  if (title) {
    el.dataset['tip'] = title
    el.removeAttribute('title')
  }
  return el.dataset['tip'] ?? el.getAttribute('aria-label') ?? ''
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)
  useEffect(() => {
    let timer = 0
    let lastHidden = 0
    let current: HTMLElement | null = null
    const show = (el: HTMLElement, now: boolean) => {
      const text = label(el)
      if (!text) return
      current = el
      clearTimeout(timer)
      const place = () => {
        if (current !== el || !el.isConnected) return
        const r = el.getBoundingClientRect()
        // Server icons speak to the right, as in Discord; others above (below at the top edge).
        if (el.matches('.rail-item')) return setTip({ text, x: r.right, y: r.top + r.height / 2, side: 'right' })
        const below = r.top < 44
        setTip({ text, x: Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60), y: below ? r.bottom : r.top, side: below ? 'below' : 'above' })
      }
      // Moving between controls keeps the tooltip up without waiting again.
      if (now || Date.now() - lastHidden < 600) place()
      else timer = window.setTimeout(place, DELAY)
    }
    const hide = () => {
      clearTimeout(timer)
      if (current) lastHidden = Date.now()
      current = null
      setTip(null)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const el = (e.target as HTMLElement).closest<HTMLElement>(SCOPE)
      if (el === current) return
      if (el) show(el, false)
      else if (current) hide()
    }
    const focus = (e: FocusEvent) => {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>(SCOPE)
      if (el && el.matches(':focus-visible')) show(el, true)
    }
    window.addEventListener('pointerover', over)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('focusin', focus)
    window.addEventListener('focusout', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('pointerover', over)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('focusin', focus)
      window.removeEventListener('focusout', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])
  if (!tip) return null
  // Only a real shortcut in brackets becomes a key hint ("Search (Ctrl+F)"), not a name.
  const m = / \(((?:Ctrl|Alt|Shift|Esc|Enter|⌘|⌥|⇧)[^)]*)\)$/.exec(tip.text)
  const [main, keys] = m ? [tip.text.slice(0, m.index), m[1]] : [tip.text, undefined]
  return (
    <div className={`tip ${tip.side}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {main}
      {keys && <kbd>{keys}</kbd>}
    </div>
  )
}
