// Tooltips for chrome controls: a dark label above the control, at once on hover as Discord's
// header icons (sidebar rows after a short delay), and at once on keyboard focus. It takes over native `title`s on controls inside the app
// chrome (icon buttons, the search bar, rail icons, sidebar thread rows), so the two
// never show together.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from './text.ts'

const SCOPE = '.icon-button, .silent-mark, .search-field, .rail-item, .message-actions > button, .row-gear, .channel-list .channel[data-nav], .channel-list .linked-row'
// Beside the control, as Discord does: server icons and sidebar rows, whose tooltip
// above would cover the rows over them.
const BESIDE = '.rail-item, .channel-list .channel'
// Sidebar rows wait, so running the pointer down the list stays quiet.
const ROW_DELAY = 400

type Tip = { text: string; x: number; y: number; side: 'above' | 'below' | 'right'; out?: boolean }

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
  const ref = useRef<HTMLDivElement>(null)
  // Kept 8px inside the window; the arrow still points at the control.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !tip || tip.side === 'right') return
    const half = el.offsetWidth / 2
    const x = Math.min(Math.max(tip.x, half + 8), window.innerWidth - half - 8)
    el.style.left = `${x}px`
    el.style.setProperty('--arrow', `${tip.x - x}px`)
  }, [tip])
  useEffect(() => {
    let timer = 0
    let gone = 0
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
        // Server icons and sidebar rows speak to the right, as in Discord; others above (below at the top edge).
        if (el.matches(BESIDE)) return setTip({ text, x: r.right, y: r.top + r.height / 2, side: 'right' })
        const below = r.top < 44
        setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom : r.top, side: below ? 'below' : 'above' })
      }
      // Moving between controls keeps the tooltip up without waiting again.
      if (now || !el.matches('.channel-list *') || Date.now() - lastHidden < 600) place()
      else timer = window.setTimeout(place, ROW_DELAY)
    }
    // Discord fades a tooltip out over ~50 ms.
    const hide = () => {
      clearTimeout(timer)
      if (current) lastHidden = Date.now()
      current = null
      setTip((t) => (t && !t.out ? { ...t, out: true } : t))
      clearTimeout(gone)
      gone = window.setTimeout(() => setTip((t) => (t?.out ? null : t)), motion() === 'auto' ? 0 : 50)
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
      clearTimeout(gone)
    }
  }, [])
  if (!tip) return null
  // Only a real shortcut in brackets becomes a key hint ("Search (Ctrl+F)"), not a name.
  const m = / \(((?:Ctrl|Alt|Shift|Esc|Enter|⌘|⌥|⇧)[^)]*)\)$/.exec(tip.text)
  const [main, keys] = m ? [tip.text.slice(0, m.index), m[1]] : [tip.text, undefined]
  return (
    <div ref={ref} className={`tip ${tip.side}${tip.out ? ' out' : ''}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {main}
      {keys && <kbd>{keys}</kbd>}
    </div>
  )
}
