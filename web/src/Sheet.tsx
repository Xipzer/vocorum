// Action sheet: a bottom sheet on phones (long press), a menu at the pointer on
// desktop (right click). One history entry, so phone Back closes it; Esc too.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './icons.tsx'

export type SheetAction = { label: string; icon?: IconName; run: () => void; red?: boolean; radio?: boolean; checked?: boolean; sub?: string }
/** Where a menu opens: at a point (right-click, long press) or dropped from a control,
 *  8px below it and aligned to its start or end edge, like Discord's. */
export type SheetAt = { x: number; y: number } | { rect: DOMRect; align: 'start' | 'end' }
export type SheetSpec = { title: string; subtitle?: string; badge?: ReactNode; groups: SheetAction[][]; at?: SheetAt; plain?: boolean; /** A question before an action: the title stays on desktop too. */ confirm?: boolean }

/** A menu that drops from the clicked control. */
export const below = (el: Element, align: 'start' | 'end' = 'end'): SheetAt => ({ rect: el.getBoundingClientRect(), align })

// Whether the last input was a key or a pointer, to decide where focus goes when a menu opens.
let lastInput: 'key' | 'pointer' = 'pointer'
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (lastInput = e.key === 'Tab' || e.key === 'Enter' || e.key === ' ' || e.key.startsWith('Arrow') ? 'key' : lastInput), true)
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), true)
}

// Rename lives in the chat header; a sheet elsewhere asks it to start.
export const sessionActions: { rename?: (id: string) => void; pendingRename?: string; links?: (id: string) => void; services?: () => void; settings?: (section?: string) => void; channelSettings?: (channelId: string) => void; openThread?: (id: string) => void; inbox?: () => void } = {}

const phone = () => window.matchMedia('(max-width: 767px)').matches

export function Sheet({ spec, onClose }: { spec: SheetSpec; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null)
  const [offset, setOffset] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // A picked action runs once the Back that closes this sheet has landed, so an action
  // that navigates (or opens another sheet) is not undone by it.
  const after = useRef<(() => void) | null>(null)
  const isPhone = phone()

  useEffect(() => {
    history.pushState({ sheet: true }, '')
    const onPop = () => {
      onClose()
      const run = after.current
      after.current = null
      if (run) window.setTimeout(run, 0)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close()
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('.sheet-item') ?? [])]
      if (!items.length) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      items[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus()
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Opened from the keyboard: focus the first item, so arrows and Enter work straight away.
  useEffect(() => {
    if (lastInput === 'key') panel.current?.querySelector<HTMLElement>('.sheet-item')?.focus()
  }, [])

  // Desktop: open at the pointer, kept inside the window.
  useLayoutEffect(() => {
    if (isPhone || !panel.current) return
    const { width, height } = panel.current.getBoundingClientRect()
    const at = spec.at ?? { x: window.innerWidth / 2 - width / 2, y: window.innerHeight / 3 }
    const clampX = (x: number) => Math.min(Math.max(8, x), window.innerWidth - width - 8)
    if ('rect' in at) {
      // Below the control (above it if there's no room), its edge lined up with the control's.
      const { rect, align } = at
      const top = rect.bottom + 8 + height <= window.innerHeight - 8 ? rect.bottom + 8 : Math.max(8, rect.top - 8 - height)
      setPos({ left: clampX(align === 'end' ? rect.right - width : rect.left), top })
    } else setPos({ left: clampX(at.x), top: Math.min(Math.max(8, at.y), window.innerHeight - height - 8) })
  }, [isPhone, spec.at])

  const close = () => {
    if (history.state?.sheet) history.back()
    else onClose()
  }
  const pick = (action: SheetAction) => {
    if (history.state?.sheet) {
      after.current = action.run
      history.back()
    } else {
      onClose()
      window.setTimeout(action.run, 0)
    }
  }

  return (
    <div className={`sheet-layer${isPhone ? ' phone' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && close()} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={panel}
        className={`sheet${spec.plain && !isPhone ? ' plain' : ''}${spec.confirm ? ' confirm' : ''}`}
        role="menu"
        style={isPhone ? { transform: offset ? `translateY(${offset}px)` : undefined, transition: drag.current ? 'none' : undefined } : (pos ?? { visibility: 'hidden' })}
        onPointerDown={(e) => {
          if (!isPhone || (e.target as HTMLElement).closest('button')) return
          drag.current = { y: e.clientY, t: performance.now(), dy: 0 }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          drag.current.dy = Math.max(0, e.clientY - drag.current.y)
          setOffset(drag.current.dy)
        }}
        onPointerUp={() => {
          const d = drag.current
          drag.current = null
          if (!d) return
          const speed = d.dy / Math.max(1, performance.now() - d.t)
          if (d.dy > 110 || speed > 0.55) close()
          else setOffset(0)
        }}
      >
        {isPhone && <div className="grab" />}
        <div className="sheet-head" hidden={spec.plain && !isPhone}>
          {spec.badge && <div className="sheet-badge">{spec.badge}</div>}
          <div className="sheet-titles">
            <div className="sheet-title">{spec.title}</div>
            {spec.subtitle && <div className="sheet-sub">{spec.subtitle}</div>}
          </div>
        </div>
        {spec.groups
          .filter((g) => g.length)
          .map((group, i) => (
            <div key={i} className="sheet-group">
              {group.map((action) => (
                <button key={action.label} className={`sheet-item${action.red ? ' red' : ''}${action.sub ? ' two-line' : ''}`} role={action.radio ? 'menuitemradio' : 'menuitem'} aria-checked={action.radio ? Boolean(action.checked) : undefined} onClick={() => pick(action)}>
                  {action.icon && <Icon name={action.icon} size={isPhone ? 22 : 18} />}
                  <span className="sheet-item-text">
                    {action.label}
                    {action.sub && <span className="sheet-sub-label">{action.sub}</span>}
                  </span>
                  {action.radio && <i className={`sheet-radio${action.checked ? ' on' : ''}`} />}
                </button>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

// Long press (500 ms, cancelled by 10 px of movement or by starting on an inner
// control) on touch, right click on desktop. The click after a long press is eaten.
// The menu opens under the finger, so the tap the browser makes when the finger lifts
// would land on a menu item (Delete, say). Swallow that tap: everything until shortly
// after the lift.
function swallowRelease() {
  const swallow = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const kinds = ['click', 'mousedown', 'mouseup'] as const
  for (const k of kinds) window.addEventListener(k, swallow, true)
  let done = false
  const stop = () => {
    if (done) return
    done = true
    for (const k of kinds) window.removeEventListener(k, swallow, true)
  }
  const lifted = () => window.setTimeout(stop, 400)
  window.addEventListener('pointerup', lifted, { capture: true, once: true })
  window.addEventListener('pointercancel', lifted, { capture: true, once: true })
  window.setTimeout(stop, 5000)
}

export function usePress(onPress: (at: { x: number; y: number }) => void) {
  const timer = useRef<number | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const cancel = () => {
    window.clearTimeout(timer.current)
    start.current = null
  }
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      fired.current = false
      if (e.pointerType === 'mouse') return
      const inner = (e.target as HTMLElement).closest('button, a, input, textarea, select')
      if (inner && inner !== e.currentTarget) return
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = window.setTimeout(() => {
        fired.current = true
        swallowRelease()
        navigator.vibrate?.(8)
        onPress(start.current ?? { x: e.clientX, y: e.clientY })
        start.current = null
      }, 500)
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault()
      if (fired.current) return
      cancel()
      onPress({ x: e.clientX, y: e.clientY })
    },
    onClickCapture: (e: React.MouseEvent<HTMLElement>) => {
      if (fired.current) {
        e.preventDefault()
        e.stopPropagation()
        fired.current = false
      }
    },
  }
}
