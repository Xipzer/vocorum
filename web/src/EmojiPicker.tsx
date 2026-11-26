// The emoji picker: the server's own emoji, then every standard emoji, searchable, grouped
// like Discord's, with the ones you use most on top. The lists load when it first opens.

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LoadingMark } from './components.tsx'
import { Icon } from './icons.tsx'
import { customName, customTag, emojify, serverEmoji } from './emoji.tsx'
import { useStore } from './store.ts'

type Groups = Array<{ name: string; emoji: Array<[string, string]> }>
// One emoji stands for each standard group on the rail, in the order of emoji-data.ts.
const GROUP_MARK: Record<string, string> = { 'Smileys & Emotion': '😀', 'People & Body': '👋', 'Animals & Nature': '🐻', 'Food & Drink': '🍔', 'Travel & Places': '✈️', Activities: '⚽', Objects: '💡', Symbols: '❤️', Flags: '🏳️' }
let cache: Groups | null = null
const load = async () => (cache ??= (await import('./emoji-data.ts')).EMOJI_GROUPS)

const RECENT_KEY = 'emoji:recent'
export const recentEmoji = (): string[] => JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
export function rememberEmoji(emoji: string) {
  const next = [emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 24)
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
}

export function EmojiPicker({ anchor, guildId, onPick, onClose }: { anchor: DOMRect; guildId?: string; onPick: (emoji: string) => void; onClose: () => void }) {
  const [groups, setGroups] = useState<Groups | null>(cache)
  const [server, setServer] = useState<Array<[string, string]>>([])
  const guild = useStore((d) => d.state?.guilds?.find((g) => g.id === guildId) ?? d.state?.guild)
  const serverName = guild?.name ?? 'This server'
  const guildIcon = guild && 'icon' in guild && guild.icon ? `/client/guild-icons/${guild.id}?v=${guild.icon}` : null
  useEffect(() => {
    void serverEmoji(guildId).then((list) => setServer(list.map((e) => [customTag(e), e.name])))
  }, [guildId])
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
    // Inside the pane that holds the button: opened from a reaction at the left of a row,
    // it must not lie over the channel list.
    const pane = el.closest('.chat')?.getBoundingClientRect()
    const left = Math.max((pane?.left ?? 0) + 8, Math.min(anchor.right - width, (pane?.right ?? window.innerWidth) - width - 8))
    const top = anchor.bottom + 8 + height <= window.innerHeight - 8 ? anchor.bottom + 8 : Math.max(8, anchor.top - 8 - height)
    setPos({ left, top })
  }, [anchor, groups])
  const term = q.trim().toLowerCase()
  const names = useMemo(() => new Map([...(groups ?? []).flatMap((g) => g.emoji), ...server]), [groups, server])
  // Another server's emoji in the recent list can't be sent here: leave them out.
  const recent = recentEmoji().filter((e) => !customName(e) || names.has(e))
  const all: Array<Groups[number] & { mark: ReactNode }> = !groups
    ? []
    : [
        { name: 'Frequently used', emoji: recent.map((e) => [e, names.get(e) ?? ''] as [string, string]), mark: <Icon name="clock" /> },
        { name: serverName, emoji: server, mark: guildIcon ? <img className="emoji-rail-server" src={guildIcon} alt="" /> : server[0] && emojify(server[0][0]) },
        ...groups.map((g) => ({ ...g, mark: emojify(GROUP_MARK[g.name] ?? g.emoji[0]?.[0] ?? '') })),
      ].filter((g) => g.emoji.length)
  const shown: Groups = term && groups ? [{ name: 'Results', emoji: [...server, ...groups.flatMap((g) => g.emoji)].filter(([, n]) => n.toLowerCase().includes(term)).slice(0, 160) }] : all
  // The rail follows the scroll: the current group is the last one whose heading has reached the top.
  const scroll = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLElement>(null)
  const [current, setCurrent] = useState(0)
  const [jump, setJump] = useState<number | null>(null)
  // Where a rail click left the list: a group too near the end to reach the top keeps its marker.
  const jumped = useRef<number | null>(null)
  const spy = () => {
    const el = scroll.current
    if (!el || term || (jumped.current !== null && Math.abs(el.scrollTop - jumped.current) < 1)) return
    jumped.current = null
    const sections = [...el.querySelectorAll('section')]
    const at = el.scrollTop + 1
    setCurrent(Math.max(0, sections.findLastIndex((s) => s.offsetTop <= at)))
  }
  useLayoutEffect(() => {
    if (jump === null || term) return
    const section = scroll.current?.querySelectorAll('section')[jump]
    if (section) {
      scroll.current!.scrollTop = section.offsetTop
      jumped.current = scroll.current!.scrollTop
    }
    setCurrent(jump)
    setJump(null)
  }, [jump, term])
  useEffect(() => {
    const r = rail.current
    const item = r?.children[current] as HTMLElement | undefined
    if (!r || !item) return
    if (item.offsetTop < r.scrollTop) r.scrollTop = item.offsetTop - 8
    else if (item.offsetTop + item.offsetHeight > r.scrollTop + r.clientHeight) r.scrollTop = item.offsetTop + item.offsetHeight + 8 - r.clientHeight
  }, [current])
  const pick = (e: string) => {
    rememberEmoji(e)
    onPick(e)
    onClose()
  }
  return (
    <div ref={panel} className="emoji-picker" role="dialog" aria-label="Pick an emoji" style={pos ?? { visibility: 'hidden' }}>
      <div className="emoji-head">
        <label className="search">
          <Icon name="search" size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the perfect emoji" aria-label="Search emoji" />
        </label>
      </div>
      <div className="emoji-body">
        <nav ref={rail} className="emoji-rail" aria-label="Emoji categories">
          {all.map((g, i) => (
            <button
              key={g.name}
              className="emoji-rail-item"
              aria-current={!term && i === current ? 'true' : undefined}
              aria-label={g.name}
              title={g.name}
              onClick={() => {
                setQ('')
                setJump(i)
              }}
            >
              {g.mark}
            </button>
          ))}
        </nav>
        <div ref={scroll} className="emoji-scroll" onScroll={spy}>
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
                    {emojify(e)}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      <div className="emoji-foot">{hover ? <><span className="emoji-big">{emojify(hover[0])}</span>:{hover[1].replace(/\s+/g, '_')}:</> : 'Pick an emoji'}</div>
    </div>
  )
}
