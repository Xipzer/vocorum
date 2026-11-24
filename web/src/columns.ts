// Desktop columns: the server rail and the channel list can each be dragged
// wider or narrower, and collapsed. Drag below a threshold and the column
// folds away; drag a pixel back out and it snaps open at its minimum.
// Widths live in CSS variables on <html>, so a drag never re-renders React:
// pointer moves write one variable per animation frame, and transitions are
// off while dragging and on for snaps, folds and toggles.

import { useEffect, useSyncExternalStore } from 'react'

type Spec = { cssVar: string; min: number; max: number; fallback: number; fold: number }
export type ColumnId = 'rail' | 'side'

const SPECS: Record<ColumnId, Spec> = {
  // The rail has one useful width: it only opens or folds.
  rail: { cssVar: '--rail-w', min: 72, max: 72, fallback: 72, fold: 36 },
  side: { cssVar: '--side-w', min: 200, max: 480, fallback: 264, fold: 140 },
}

type State = { width: number; collapsed: boolean }
const load = (id: ColumnId): State => {
  try {
    const saved = JSON.parse(localStorage.getItem(`column:${id}`) ?? 'null') as State | null
    if (saved && Number.isFinite(saved.width)) return { width: clamp(id, saved.width), collapsed: Boolean(saved.collapsed) }
  } catch {}
  return { width: SPECS[id].fallback, collapsed: false }
}
const clamp = (id: ColumnId, w: number) => Math.min(SPECS[id].max, Math.max(SPECS[id].min, Math.round(w)))

const state: Record<ColumnId, State> = { rail: load('rail'), side: load('side') }
const listeners = new Set<() => void>()
let snapshot = { ...state }

// --x-w is the visible (animated) width; --x-open the width its content is laid out at,
// so folding clips the content instead of reflowing it every frame.
function apply(id: ColumnId, width: number, open = width) {
  const root = document.documentElement.style
  root.setProperty(SPECS[id].cssVar, `${width}px`)
  root.setProperty(`${SPECS[id].cssVar}-open`, `${Math.max(SPECS[id].min, open)}px`)
}

function commit(id: ColumnId, next: State) {
  state[id] = next
  snapshot = { ...state }
  apply(id, next.collapsed ? 0 : next.width, next.width)
  document.documentElement.dataset[`${id}Collapsed`] = String(next.collapsed)
  localStorage.setItem(`column:${id}`, JSON.stringify(next))
  for (const fn of listeners) fn()
}

export function initColumns() {
  for (const id of Object.keys(SPECS) as ColumnId[]) commit(id, state[id])
}

export function toggleColumn(id: ColumnId, collapsed = !state[id].collapsed) {
  commit(id, { ...state[id], collapsed })
}

export function resetColumns() {
  for (const id of Object.keys(SPECS) as ColumnId[]) commit(id, { width: SPECS[id].fallback, collapsed: false })
}

export function useColumns() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => snapshot,
  )
}

// Pointer drag on a column's right edge. Double click folds or opens it.
export function startResize(id: ColumnId, event: React.PointerEvent<HTMLElement>) {
  if (event.button !== 0) return
  event.preventDefault()
  const handle = event.currentTarget
  handle.setPointerCapture(event.pointerId)
  const spec = SPECS[id]
  const startX = event.clientX
  const from = state[id].collapsed ? 0 : state[id].width
  const root = document.documentElement
  root.dataset['resizing'] = id
  let raw = from
  let frame = 0
  const move = (e: PointerEvent) => {
    raw = from + e.clientX - startX
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      // Follow the pointer, but never wider than max; below the fold it shows how far it would fold.
      const w = Math.max(0, Math.min(spec.max, raw))
      apply(id, w, Math.max(w, state[id].collapsed ? spec.min : Math.min(state[id].width, w)))
    })
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    cancelAnimationFrame(frame)
    delete root.dataset['resizing']
    const moved = Math.abs(raw - from) > 2
    if (!moved) return commit(id, state[id])
    // Below the fold: collapse. Pulled out from collapsed by any amount: open at least at min.
    if (raw < spec.fold && !(state[id].collapsed && raw > from)) commit(id, { ...state[id], collapsed: true })
    else commit(id, { width: clamp(id, raw), collapsed: false })
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

// Ctrl/Cmd+B folds the channel list, Ctrl/Cmd+Alt(Option)+B the server rail.
// e.code, not e.key: on a Mac, Option+B types "∫".
export function useColumnKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== 'KeyB') return
      e.preventDefault()
      toggleColumn(e.altKey ? 'rail' : 'side')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

// Shortcut labels in the platform's words: ⌘B and ⌥⌘B on a Mac.
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const keys = (alt: boolean) => (isMac ? `${alt ? '⌥' : ''}⌘B` : `Ctrl+${alt ? 'Alt+' : ''}B`)
