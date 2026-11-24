// The emoji picker: every system emoji, searchable, grouped like Discord's, with the ones
// you use most on top. The emoji list loads only when the picker first opens.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LoadingMark } from './components.tsx'

type Groups = Array<{ name: string; emoji: Array<[string, string]> }>
let cache: Groups | null = null
const load = async () => (cache ??= (await import('./emoji-data.ts')).EMOJI_GROUPS)

const RECENT_KEY = 'emoji:recent'
export const recentEmoji = (): string[] => JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
export function rememberEmoji(emoji: string) {
  const next = [emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 24)
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
}

export function EmojiPicker({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (emoji: string) => void; onClose: () => void }) {
  const [groups, setGroups] = useState<Groups | null>(cache)
  const [q, setQ] = useState('')
  const [hover, setHover] = useState<[string, string] | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    if (!groups) void load().then(setGroups)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const away = (e: PointerEvent) => !panel.current?.contains(e.target as Node) && onClose()
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', away, true)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerdown', away, true)
    }
  }, [])
  // Below the button, right edges aligned; above it when there's no room.
  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8)
    const top = anchor.bottom + 8 + height <= window.innerHeight - 8 ? anchor.bottom + 8 : Math.max(8, anchor.top - 8 - height)
    setPos({ left, top })
  }, [anchor, groups])
  const term = q.trim().toLowerCase()
  const names = useMemo(() => new Map((groups ?? []).flatMap((g) => g.emoji)), [groups])
  const shown: Groups = !groups
    ? []
    : term
      ? [{ name: 'Results', emoji: groups.flatMap((g) => g.emoji).filter(([, n]) => n.includes(term)).slice(0, 160) }]
      : [{ name: 'Frequently used', emoji: recentEmoji().map((e) => [e, names.get(e) ?? ''] as [string, string]) }, ...groups].filter((g) => g.emoji.length)
  const pick = (e: string) => {
    rememberEmoji(e)
    onPick(e)
    onClose()
  }
  return (
    <div ref={panel} className="emoji-picker" role="dialog" aria-label="Pick an emoji" style={pos ?? { visibility: 'hidden' }}>
      <label className="search">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the perfect emoji" aria-label="Search emoji" />
      </label>
      <div className="emoji-scroll">
        {!groups && (
          <div className="loading-inline">
            <LoadingMark size={28} />
          </div>
        )}
        {shown.map((g) => (
          <section key={g.name}>
            <h4>{g.name}</h4>
            <div className="emoji-grid">
              {g.emoji.map(([e, n]) => (
                <button key={e} className="emoji-cell" onClick={() => pick(e)} onMouseEnter={() => setHover([e, n])} aria-label={n || e}>
                  {e}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="emoji-foot">{hover ? <><span className="emoji-big">{hover[0]}</span>:{hover[1].replace(/\s+/g, '_')}:</> : 'Pick an emoji'}</div>
    </div>
  )
}
