// At most one row owns the action bar, including across a split view. Only
// the old and new owner update when a pointer crosses a long list of messages.
import { useEffect, useRef, useState } from 'react'

type Source = 'pointer' | 'keyboard'
type Owner = { set: (on: boolean) => void; source: Source }
let owner: Owner | null = null

export function useMessageToolbar() {
  const [hot, set] = useState(false)
  const pointer = useRef('')
  const take = (source: Source) => {
    // Touch browsers can emit a compatibility mouse event over a neighbouring row.
    // Leave its text available for long press; real keyboard focus still owns a bar.
    if (source === 'pointer' && !window.matchMedia('(any-hover: hover)').matches) return
    if (owner?.set !== set) { owner?.set(false); set(true) }
    owner = { set, source }
  }
  const release = () => {
    if (owner?.set === set) { owner = null; set(false) }
  }
  useEffect(() => () => { if (owner?.set === set) owner = null }, [])
  return { hot, warm: {
    onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType !== 'touch' && !e.buttons && matchMedia('(any-hover: hover)').matches) take('pointer') },
    onPointerDownCapture: (e: React.PointerEvent) => {
      pointer.current = e.pointerType
      if (e.pointerType !== 'touch') take('pointer')
      else release()
    },
    onPointerLeave: () => {
      pointer.current = ''
      if (owner?.source === 'pointer') release()
    },
    onKeyDownCapture: (e: React.KeyboardEvent) => {
      if ((e.target as Element).closest('[role=dialog]')) return
      pointer.current = ''; take('keyboard')
    },
    onFocus: (e: React.FocusEvent) => {
      if (pointer.current === 'touch' || (e.target as Element).closest('[role=dialog]')) return
      if (!window.matchMedia('(any-hover: hover)').matches && !(e.target as Element).matches(':focus-visible')) return
      take(pointer.current && !(e.target as Element).matches(':focus-visible') ? 'pointer' : 'keyboard')
    },
    onBlur: (e: React.FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null) && (owner?.source === 'keyboard' || !e.currentTarget.matches(':hover'))) release()
    },
  } }
}
