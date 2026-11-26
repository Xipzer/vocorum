// Paging is armed by input, not by scroll events: the browser also fires those
// when we open a channel, append messages, restore an anchor or resize a pane.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { snowflakeGt, store, type ChannelMessages } from './store.ts'

type Anchor = { first: string; node: HTMLElement | null; y: number; height: number }

// Older history is asked for while the reader is still this far from the top (as Discord
// does), so a page is usually in before they reach the edge: no stop and bounce at the top,
// then a jump of the scroll bar when the page lands.
const nearTop = (el: HTMLElement) => el.scrollTop <= Math.max(96, el.clientHeight * 2)
export function useMessageHistory(channel: string, entry: ChannelMessages | undefined, scroller: RefObject<HTMLDivElement | null>, pinned: RefObject<boolean>) {
  const anchor = useRef<Anchor | null>(null)
  const [state, setState] = useState<'ready' | 'loading' | 'error'>('ready')
  const armed = useRef(0)
  const touchY = useRef(0)
  const fade = useRef(0)
  // While the scroll bar is held, no page is added: the thumb follows the pointer only.
  const dragging = useRef(false)

  useLayoutEffect(() => {
    const el = scroller.current
    anchor.current = null; armed.current = 0; dragging.current = false; pinned.current = true; setState('ready')
    return () => { clearTimeout(fade.current); if (el) { delete el.dataset.scrolling; delete el.dataset.prepending } }
  }, [channel, scroller, pinned])

  const reveal = () => {
    const el = scroller.current
    if (!el) return
    el.dataset.scrolling = 'true'
    clearTimeout(fade.current)
    fade.current = window.setTimeout(() => { delete el.dataset.scrolling }, 700)
  }
  const older = async () => {
    const el = scroller.current, first = entry?.list[0]?.id
    if (!el || !first || !entry?.hasMore || entry.loading || anchor.current) return
    armed.current = 0
    pinned.current = false
    // Use a message's position *in the content*. Someone can keep scrolling
    // during the request without being put back at their old screen position.
    // Not the oldest loaded message: once older ones land above it, it can lose its
    // author header or gain a date divider, which would move everything below it.
    const top = el.getBoundingClientRect().top
    const nodes = [...el.querySelectorAll<HTMLElement>('[id^="m-"]')]
    const node = nodes.find((n) => n.id !== `m-${first}` && n.getBoundingClientRect().top >= top) ?? nodes.find((n) => n.getBoundingClientRect().bottom > top) ?? null
    const capture = { first, node, y: node ? node.getBoundingClientRect().top - top + el.scrollTop : 0, height: el.scrollHeight }
    anchor.current = capture; el.dataset.prepending = 'true'; setState('loading')
    try { await store.loadMessages(channel, { older: true }) }
    catch {
      if (anchor.current === capture) { anchor.current = null; delete el.dataset.prepending; setState('error') }
    }
  }
  // The skeleton shown while the page loads is taller than the line it replaces: the view stays put.
  useLayoutEffect(() => {
    const a = anchor.current, el = scroller.current
    if (state !== 'loading' || !entry?.loading || !a?.node?.isConnected || !el) return
    const y = a.node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    if (!pinned.current) el.scrollTop += y - a.y
    a.y = y
  }, [state, entry?.loading, scroller, pinned])
  useLayoutEffect(() => {
    const a = anchor.current, el = scroller.current
    if (!a || !el || !entry || entry.loading) return
    if (snowflakeGt(a.first, entry.list[0]?.id)) {
      const delta = a.node?.isConnected ? a.node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - a.y : el.scrollHeight - a.height
      if (!pinned.current) el.scrollTop += delta
    }
    anchor.current = null; delete el.dataset.prepending; setState('ready')
  }, [entry, scroller, pinned])

  const input = (up: boolean) => {
    reveal()
    armed.current = up ? performance.now() + 650 : 0
    if (up && !dragging.current && scroller.current && nearTop(scroller.current)) void older()
  }
  return {
    state, older,
    onWheel: (e: React.WheelEvent) => { if (e.deltaY) input(e.deltaY < 0) },
    onTouchStart: (e: React.TouchEvent) => { touchY.current = e.touches[0]?.clientY ?? 0 },
    onTouchMove: (e: React.TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchY.current
      if (Math.abs(y - touchY.current) > 1) { input(y > touchY.current); touchY.current = y }
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // A native desktop scrollbar drag (buttons and message text are not scroll gestures).
      if (e.pointerType !== 'mouse' || e.clientX < e.currentTarget.getBoundingClientRect().right - 12) return
      reveal()
      dragging.current = true
      const release = () => {
        window.removeEventListener('pointerup', release, true)
        window.removeEventListener('pointercancel', release, true)
        dragging.current = false
        input(true)
      }
      window.addEventListener('pointerup', release, true)
      window.addEventListener('pointercancel', release, true)
    },
    key: (key: string, shift: boolean) => {
      if (['Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', ' '].includes(key)) input(['Home', 'PageUp', 'ArrowUp'].includes(key) || key === ' ' && shift)
    },
    scrolled: (el: HTMLElement) => {
      if (dragging.current) reveal()
      else if (performance.now() < armed.current && nearTop(el)) void older()
    },
  }
}
