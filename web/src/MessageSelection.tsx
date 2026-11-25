// A draft belongs to one chat pane. Ranges follow its rendered rows, not the
// backing history: one folded group can stand for many different messages.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api, type Message } from './api.ts'
import { Icon } from './icons.tsx'
import { plain } from './text.ts'

const LIMIT = 100
const rows = (root: Element | null) => [...(root?.querySelectorAll<HTMLButtonElement>('button[data-pick-id]') ?? [])]

export function useMessageSelection(channelId: string, onDeleted: (ids: readonly string[]) => void) {
  const pane = useRef<HTMLElement>(null)
  const anchor = useRef<string | null>(null)
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [review, setReview] = useState<readonly string[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const active = picked !== null

  const start = (id?: string) => {
    if (active || !pane.current) return
    anchor.current = id ?? null
    setError('')
    setPicked(new Set(id ? [id] : []))
  }
  const exit = () => {
    setReview(null); setPicked(null); setError(''); anchor.current = null
    pane.current?.querySelector<HTMLElement>('.chat-history')?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (!active) return
    const first = rows(pane.current).find((el) => el.dataset.pickId === anchor.current)
    ;(first ?? pane.current?.querySelector<HTMLElement>('.pick-cancel'))?.focus({ preventScroll: true })
  }, [active])

  // A live delete, a permission change or a regroup can remove a checkbox. A
  // smaller draft needs a new confirmation; never silently submit a subset.
  const valid = (ids: Set<string> | readonly string[]) => {
    const available = new Set(rows(pane.current).map((el) => el.dataset.pickId))
    const keep = [...ids].filter((id) => available.has(id))
    if (keep.length === (ids instanceof Set ? ids.size : ids.length)) return true
    setPicked(new Set(keep)); setReview(null)
    setError('The selection changed. Review the remaining messages.')
    return false
  }
  useLayoutEffect(() => { if (picked?.size && !sending.current) valid(picked) })

  const toggle = (button: HTMLButtonElement, range: boolean) => {
    if (!picked || review || sending.current) return
    const id = button.dataset.pickId!
    const next = new Set(picked)
    const ordered = range ? rows(button.closest('.chat-history, .output-panel')).map((el) => el.dataset.pickId!) : []
    const a = anchor.current ? ordered.indexOf(anchor.current) : -1
    const b = ordered.indexOf(id)
    if (a !== -1 && b !== -1) {
      for (const mid of ordered.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(mid)
    } else if (!next.delete(id)) next.add(id)
    if (next.size > LIMIT) { setError(`Select up to ${LIMIT} messages at a time.`); return }
    if (a === -1) anchor.current = id
    setError(''); setPicked(next)
  }
  const ask = () => {
    if (!picked?.size || sending.current || !valid(picked)) return
    setError(''); setReview([...picked])
  }
  const submit = async () => {
    if (!review || sending.current || !pane.current || !valid(review)) return
    const ids = review
    sending.current = true; setBusy(true); setReview(null)
    try {
      const result = await api.bulkDelete(channelId, ids)
      if (!Array.isArray(result?.deleted_ids) || result.deleted_ids.length !== ids.length || !ids.every((id) => result.deleted_ids.includes(id))) throw new Error('Refresh this chat to check its history.')
      onDeleted(result.deleted_ids)
      exit()
    } catch (e) {
      setError(`Deletion not confirmed. ${e instanceof Error ? e.message : String(e)}`)
    } finally { sending.current = false; setBusy(false) }
  }
  return { pane, picked, review, error, busy, start, toggle, ask, submit, back: () => setReview(null), cancel: () => { if (!sending.current) exit() } }
}

type Selection = ReturnType<typeof useMessageSelection>

export function PickRow({ message, allowed, selection, children }: { message: Message; allowed: boolean; selection: Selection; children: ReactNode }) {
  const checked = selection.picked!.has(message.id)
  const name = message.author.global_name ?? message.author.username
  const excerpt = plain(message.content).slice(0, 100) || message.attachments[0]?.filename || message.embeds[0]?.title || 'Message'
  return <div className={`pick-row${checked ? ' picked' : ''}${allowed ? '' : ' unavailable'}`}>
    <div inert>{children}</div>
    {allowed && <button className="message-choice" role="checkbox" aria-checked={checked} aria-label={`${name}: ${excerpt}`} data-pick-id={message.id} disabled={selection.busy} onClick={(e) => selection.toggle(e.currentTarget, e.shiftKey)}>
      <span className="pick-mark" aria-hidden="true">{checked && <svg viewBox="0 0 16 16" width="14" height="14"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>}</span>
    </button>}
  </div>
}

// A native modal traps focus, starts on Cancel and keeps the final action
// away from the button that opened it (including a double click or tap).
function DeleteReview({ count, back, submit }: { count: number; back: () => void; submit: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = `Delete ${count} ${count === 1 ? 'message' : 'messages'}?`
  useLayoutEffect(() => {
    const el = dialog.current!
    el.showModal()
    return () => el.close()
  }, [])
  return <dialog ref={dialog} className="delete-review" aria-label={title} onCancel={(e) => { e.preventDefault(); back() }}>
    <h2>{title}</h2><p>This cannot be undone.</p>
    <div><button autoFocus className="button" onClick={back}>Cancel</button><button className="button danger" onClick={submit}>Delete</button></div>
  </dialog>
}

export function SelectionDock({ selection: s }: { selection: Selection }) {
  return <div className="selection-dock" role="region" aria-label="Message selection">
    {s.error && <p role="alert">{s.error}</p>}
    <div className="selection-controls">
      <strong className="num" role="status">{s.busy ? 'Deleting…' : `${s.picked!.size} selected`}</strong>
      <button className="button pick-cancel" disabled={s.busy} onClick={s.cancel}>Cancel</button>
      <button className="button pick-delete" disabled={!s.picked!.size || s.busy} onClick={s.ask}><Icon name="trash" size={16} />Delete</button>
    </div>
    {s.review && <DeleteReview count={s.review.length} back={s.back} submit={() => void s.submit()} />}
  </div>
}
