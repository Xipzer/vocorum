import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from './api.ts'
import './thread-filter.css'

const choices = ['Working', 'Waiting for you', 'Failed', 'Unread', 'Quiet'] as const
export const ALL_MARKS = (1 << choices.length) - 1
export function markBit(state: SessionSummary['state'] | undefined, unread: boolean) {
  return 1 << (state === 'busy' ? 0 : state === 'waiting' ? 1 : state === 'failed' ? 2 : unread ? 3 : 4)
}
export function useThreadFilter(account: string, guild: string) {
  const key = `thread-filter:${account}:${guild}`
  const [saved, set] = useState<Record<string, number>>({})
  const initial = useMemo(() => {
    const raw = localStorage.getItem(key), n = raw === null ? ALL_MARKS : Number(raw)
    return Number.isInteger(n) && n >= 0 && n <= ALL_MARKS ? n : ALL_MARKS
  }, [key])
  const mask = saved[key] ?? initial
  return [mask, (next: number) => { set(s => ({ ...s, [key]: next })); localStorage.setItem(key, String(next)) }] as const
}

export function ThreadFilter({ mask, change }: { mask: number; change: (n: number) => void }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    wrap.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true})
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true) }
  }, [open])
  return <div ref={wrap} className="mark-filter" onBlur={e=>{if(e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))setOpen(false)}}>
    <button ref={trigger} type="button" className="icon-button mark-trigger" aria-label="Filter threads by status" aria-expanded={open} title="Filter threads by status" data-filtered={mask!==ALL_MARKS || undefined} onClick={()=>setOpen(v=>!v)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M3 7h6m4 0h8M3 17h10m4 0h4"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg>
    </button>
    {open && <fieldset className="mark-options"><legend>Thread status</legend>
      <label><input type="checkbox" checked={mask===ALL_MARKS} ref={el=>{if(el)el.indeterminate=mask!==0&&mask!==ALL_MARKS}} onChange={()=>change(mask===ALL_MARKS?0:ALL_MARKS)}/>All statuses</label>
      {choices.map((label,i)=><label key={label}><input type="checkbox" checked={!!(mask & (1<<i))} onChange={()=>change(mask ^ (1<<i))}/><i className={`mark-swatch s${i}`} aria-hidden="true"/>{label}</label>)}
    </fieldset>}
  </div>
}

// One observer for both normal and linked rows; no scroll-time geometry scans.
let visible: IntersectionObserver | undefined
export function MarkHalo() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current, row=el?.parentElement
    if (!row || !el || typeof IntersectionObserver==='undefined') return
    visible ??= new IntersectionObserver(entries => { for(const e of entries) e.target.querySelector('.mark-halo')?.toggleAttribute('data-visible',e.isIntersecting) })
    visible.observe(row); return ()=>visible?.unobserve(row)
  }, [])
  return <span ref={ref} className="mark-halo" aria-hidden="true"/>
}
