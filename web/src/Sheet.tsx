// Action sheet: a bottom sheet on phones (long press), a menu at the pointer on
// desktop (right click). One history entry, so phone Back closes it; Esc too.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './icons.tsx'
import { leave } from './text.ts'

export type SheetAction = { label: string; icon?: IconName; run: () => void; red?: boolean; radio?: boolean; checked?: boolean; sub?: string }
/** Where a menu opens: at a point (right-click, long press) or dropped from a control,
 *  8px below it and aligned to its start or end edge, like Discord's. */
export type SheetAt = { x: number; y: number } | { rect: DOMRect; align: 'start' | 'end' } | { rect: DOMRect; side: 'left' | 'right' }
export type SheetSpec = { title: string; subtitle?: string; badge?: ReactNode; groups: SheetAction[][]; at?: SheetAt; plain?: boolean; /** A question before an action: the title stays on desktop too. */ confirm?: boolean; /** A card (a profile) in place of the title and actions. */ card?: (finish: (run: () => void) => void) => ReactNode }

/** A menu that drops from the clicked control. */
export const below = (el: Element, align: 'start' | 'end' = 'end'): SheetAt => ({ rect: el.getBoundingClientRect(), align })
/** A popout beside the clicked control, its top level with the control's. */
export const beside = (el: Element, side: 'left' | 'right'): SheetAt => ({ rect: el.getBoundingClientRect(), side })

// Whether the last input was a key or a pointer, to decide where focus goes when a menu opens.
let lastInput: 'key' | 'pointer' = 'pointer'
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (lastInput = e.key === 'Tab' || e.key === 'Enter' || e.key === ' ' || e.key.startsWith('Arrow') ? 'key' : lastInput), true)
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), true)
}

// Rename lives in the chat header; a sheet elsewhere asks it to start.
export const sessionActions: { rename?: (id: string) => void; pendingRename?: string; links?: (id: string) => void; services?: () => void; settings?: (section?: string) => void; channelSettings?: (channelId: string) => void; openThread?: (id: string) => void; inbox?: () => void; mentions?: (channelId: string) => void; scheduled?: (channelId?: string) => void } = {}

const phone = () => window.matchMedia('(max-width: 767px)').matches

type Picker = { trigger: HTMLButtonElement; body: (finish: (run: () => void) => void, cancel: () => void) => ReactNode }

export function Sheet({ spec, onClose, picker }: { spec: SheetSpec; onClose: () => void; picker?: Picker }) {
  const panel = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const sheetId = useId()
  const closing = useRef(false)
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null)
  const [offset, setOffset] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // A picked action runs once the Back that closes this sheet has landed, so an action
  // that navigates (or opens another sheet) is not undone by it.
  const after = useRef<(() => void) | null>(null)
  const [isPhone, setPhone] = useState(phone)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const change = () => setPhone(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    const url = location.href
    if (history.state?.sheet !== sheetId) history.pushState({ sheet: sheetId }, '')
    const onPop = () => {
      if (history.state?.sheet === sheetId) return
      onClose()
      if (picker?.trigger.isConnected) picker.trigger.focus({ preventScroll: true })
      const run = after.current
      after.current = null
      if (run) window.setTimeout(run, 0)
    }
    // An open menu owns Esc and the arrows, so it hears them first (capture) and keeps them.
    // A right-clicked message stays focused under its menu and takes the same keys for itself:
    // left to bubble, they never reached the menu.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
      if ((picker || spec.card) && e.key === 'Tab') {
        const buttons = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
        if (!buttons.length) return
        if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1)!.focus() }
        else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0]!.focus() }
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(panel.current?.querySelectorAll<HTMLElement>('.sheet-item:not(:disabled)') ?? [])]
      if (!items.length) return
      e.preventDefault()
      e.stopPropagation()
      const i = items.indexOf(document.activeElement as HTMLElement)
      items[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus()
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onKey, true)
      // A live edit may remove an open selector. Also tolerate the dev mount/unmount probe.
      if (picker) queueMicrotask(() => { if (!panel.current && history.state?.sheet === sheetId && location.href === url) history.back() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Start on the current choice. On an action menu only move focus for keyboard input.
  // Once placed: a desktop menu is hidden until then, and hidden buttons take no focus.
  const placed = isPhone || pos !== null
  const focused = useRef(false)
  useEffect(() => {
    if (!placed || focused.current) return
    focused.current = true
    if (!picker && (spec.card || lastInput !== 'key')) {
      if (spec.card) panel.current?.focus({ preventScroll: true })
      return
    }
    const current = panel.current?.querySelector<HTMLElement>('[aria-selected=true]')
    const first = panel.current?.querySelector<HTMLElement>('.sheet-item:not(:disabled), .choice-cancel')
    ;(current ?? first ?? panel.current)?.focus({ preventScroll: true })
    current?.scrollIntoView({ block: 'nearest' })
  }, [placed])

  // Desktop: open at the pointer, kept inside the window.
  const trigger = picker?.trigger
  useLayoutEffect(() => {
    const el = panel.current
    if (isPhone || !el) return
    // Choices belong to the field. Use its live width in split view, flip on
    // short viewports, and scroll the options rather than covering the field.
    if (trigger) {
      const place = () => {
        const r = trigger.getBoundingClientRect()
        el.style.width = `${Math.min(r.width, window.innerWidth - 16)}px`
        const below = window.innerHeight - r.bottom - 16, above = r.top - 16
        const wants = Math.min(264, (el.querySelector('[role=listbox]')?.scrollHeight ?? 0) + (el.querySelector('.choice-foot')?.clientHeight ?? 0) + el.offsetHeight - el.clientHeight + 2 * parseFloat(getComputedStyle(el).paddingTop))
        const up = below < wants && above > below
        el.style.maxHeight = `${Math.max(0, Math.min(264, up ? above : below))}px`
        const { width, height } = el.getBoundingClientRect()
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
        const top = Math.max(8, up ? r.top - 8 - height : r.bottom + 8)
        setPos((p) => p?.left === left && p.top === top ? p : { left, top })
      }
      place()
      const observer = new ResizeObserver(place)
      observer.observe(trigger); observer.observe(el)
      window.addEventListener('resize', place)
      const onScroll = (e: Event) => { if (!(e.target instanceof Node) || !el.contains(e.target)) place() }
      window.addEventListener('scroll', onScroll, true)
      return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); el.style.removeProperty('width'); el.style.removeProperty('max-height') }
    }
    const { width, height } = el.getBoundingClientRect()
    const at = spec.at ?? { x: window.innerWidth / 2 - width / 2, y: window.innerHeight / 3 }
    const clampX = (x: number) => Math.min(Math.max(8, x), window.innerWidth - width - 8)
    if ('side' in at) {
      const { rect, side } = at
      setPos({ left: clampX(side === 'left' ? rect.left - 8 - width : rect.right + 8), top: Math.min(Math.max(8, rect.top), window.innerHeight - height - 8) })
    } else if ('rect' in at) {
      // Below the control (above it if there's no room), its edge lined up with the control's.
      const { rect, align } = at
      const top = rect.bottom + 8 + height <= window.innerHeight - 8 ? rect.bottom + 8 : Math.max(8, rect.top - 8 - height)
      setPos({ left: clampX(align === 'end' ? rect.right - width : rect.left), top })
    } else setPos({ left: clampX(at.x), top: Math.min(Math.max(8, at.y), window.innerHeight - height - 8) })
  }, [isPhone, spec.at, trigger])

  const close = () => {
    if (closing.current) return
    closing.current = true
    const go = () => history.state?.sheet === sheetId ? history.back() : onClose()
    // A confirmation leaves as Discord's confirm dialog does (desktop, motion allowed).
    if (spec.confirm) leave(layer.current, go, 120)
    else go()
  }
  const finish = (run: () => void) => {
    if (closing.current) return
    // A confirmed action happens as the question starts to leave, not after it.
    if (spec.confirm) { run(); close(); return }
    if (history.state?.sheet === sheetId) after.current = run
    else window.setTimeout(run, 0)
    close()
  }

  return (
    <div ref={layer} className={`sheet-layer${isPhone ? ' phone' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && close()} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={panel}
        className={`sheet${spec.plain && !isPhone ? ' plain' : ''}${spec.confirm ? ' confirm' : ''}${picker ? ' choice-sheet' : ''}${spec.card ? ' profile-sheet' : ''}`}
        role={picker || spec.card ? 'dialog' : 'menu'} aria-modal={picker || spec.card ? true : undefined} aria-label={picker || spec.card ? spec.title : undefined} tabIndex={picker || spec.card ? -1 : undefined}
        style={isPhone ? { transform: offset ? `translateY(${offset}px)` : undefined, transition: drag.current ? 'none' : undefined } : (pos ?? { visibility: 'hidden' })}
        onPointerDown={(e) => {
          if (!isPhone || (e.target as HTMLElement).closest('button')) return
          if (picker && !(e.target as Element).closest('.grab, .sheet-head')) return
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
        onPointerCancel={() => { drag.current = null; setOffset(0) }}
      >
        {isPhone && <div className="grab" />}
        {spec.card?.(finish)}
        <div className="sheet-head" hidden={(spec.plain && !isPhone) || Boolean(spec.card)}>
          {spec.badge && <div className="sheet-badge">{spec.badge}</div>}
          <div className="sheet-titles">
            <div className="sheet-title">{spec.title}</div>
            {spec.subtitle && <div className="sheet-sub">{spec.subtitle}</div>}
          </div>
          {picker && isPhone && <button className="choice-close" aria-label="Close selector" onClick={close}><Icon name="close" size={16} /></button>}
        </div>
        {picker ? picker.body(finish, close) : spec.groups
          .filter((g) => g.length)
          .map((group, i) => (
            <div key={i} className="sheet-group">
              {group.map((action) => (
                <button key={action.label} className={`sheet-item${action.red ? ' red' : ''}${action.sub ? ' two-line' : ''}`} role={action.radio ? 'menuitemradio' : 'menuitem'} aria-checked={action.radio ? Boolean(action.checked) : undefined} onClick={() => finish(action.run)}>
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
