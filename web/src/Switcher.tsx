// Discord's Quick Switcher (Ctrl+K) and the keyboard shortcut sheet (Ctrl+/).
// The switcher searches every channel and thread (archived too) across all
// servers. Prefixes narrow it: # channels, * servers, @ people and bots.
// Enter on an empty query goes back to the previous channel.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Channel } from './api.ts'
import { Icon, type IconName } from './icons.tsx'
import { snowflakeGt, store, THREAD_TYPES, useStore } from './store.ts'
import { native } from './native.ts'
import { plain } from './text.ts'

type Item = { id: string; kind: 'channel' | 'thread' | 'server' | 'person'; label: string; hint: string; icon: IconName; unread: boolean; mentions: number; open: () => void; rank: number }

const RECENT_KEY = 'recent-channels'

export function rememberVisit(id: string) {
  const list = [id, ...(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).filter((x) => x !== id)].slice(0, 30)
  localStorage.setItem(RECENT_KEY, JSON.stringify(list))
}

export function previousVisit(current: string | null): string | null {
  return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).find((id) => id !== current && store.channel(id)) ?? null
}

// Higher is better: whole-word start, then substring, then letters in order.
function score(text: string, q: string) {
  const t = text.toLowerCase()
  if (!q) return 1
  if (t.startsWith(q)) return 100
  const at = t.indexOf(q)
  if (at >= 0) return /[\s\-_/·]/.test(t[at - 1] ?? ' ') ? 80 : 60
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 20 : 0
}

export function QuickSwitcher({ current, onOpen, onGuild, onClose }: { current: string | null; onOpen: (id: string) => void; onGuild: (id: string) => void; onClose: () => void }) {
  const state = useStore((d) => d.state)
  const seen = useStore((d) => d.seen)
  const mentions = useStore((d) => d.mentions)
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => input.current?.focus(), [])

  const items = useMemo(() => {
    if (!state) return []
    const guilds = store.guilds()
    const guildName = (id: string | null | undefined) => (guilds.length > 1 ? (guilds.find((g) => g.id === (id ?? state.guild.id))?.name ?? '') : '')
    const name = (c: Channel) => plain(c.name ?? '', () => null, () => null) || 'untitled'
    const prefix = /^[#*@]/.exec(query)?.[0] ?? ''
    const q = query.slice(prefix.length).trim().toLowerCase()
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]
    const recency = (id: string) => (recent.includes(id) ? 30 - recent.indexOf(id) : 0)
    const out: Item[] = []
    const add = (item: Omit<Item, 'rank'>, base: number) => {
      const s = score(item.label, q)
      if (s > 0) out.push({ ...item, rank: s * 10 + base })
    }
    if (prefix === '' || prefix === '#') {
      for (const c of [...state.channels, ...state.threads]) {
        if (c.type === 4 || c.id === current) continue
        const thread = THREAD_TYPES.has(c.type)
        if (prefix === '#' && thread) continue
        const parent = thread ? state.channels.find((p) => p.id === c.parent_id) : state.channels.find((p) => p.id === c.parent_id && p.type === 4)
        const archived = Boolean(c.thread_metadata?.archived)
        const unread = snowflakeGt(c.last_message_id, seen[c.id])
        const hint = [parent ? (thread ? `#${parent.name}` : parent.name) : '', guildName(c.guild_id), archived ? 'archived' : ''].filter(Boolean).join(' · ')
        add({ id: c.id, kind: thread ? 'thread' : 'channel', label: name(c), hint, icon: thread ? 'thread' : 'hash', unread, mentions: mentions[c.id] ?? 0, open: () => onOpen(c.id) }, recency(c.id) + (unread ? 5 : 0) + (mentions[c.id] ? 10 : 0) - (archived ? 15 : 0))
      }
    }
    if ((prefix === '' && q) || prefix === '*') {
      for (const g of guilds) add({ id: g.id, kind: 'server', label: g.name, hint: 'Server', icon: 'server', unread: false, mentions: 0, open: () => onGuild(g.id) }, 0)
    }
    if (prefix === '@') {
      for (const u of state.users) add({ id: u.id, kind: 'person', label: u.global_name ?? u.username, hint: u.bot ? 'App' : `@${u.username}`, icon: 'at', unread: false, mentions: 0, open: () => void navigator.clipboard?.writeText(`<@${u.id}>`) }, 0)
    }
    return out.sort((a, b) => b.rank - a.rank).slice(0, 50)
  }, [state, seen, mentions, query, current, onOpen, onGuild])

  useEffect(() => setPick(0), [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.switcher-item.picked')?.scrollIntoView({ block: 'nearest' })
  }, [pick])

  const choose = (item: Item | undefined) => {
    if (!item) {
      // The URL, not the prop: the route state can trail a fresh hash change by a task.
      const back = !query.trim() ? previousVisit(/^#\/c\/(\d+)/.exec(location.hash)?.[1] ?? current) : null
      if (back) onOpen(back)
    } else item.open()
    onClose()
  }

  return (
    <div className="overlay switcher-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher" role="dialog" aria-label="Quick switcher">
        <div className="switcher-field">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Where would you like to go?"
            aria-label="Where would you like to go?"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (items.length) setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(query.trim() ? items[pick] : undefined)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
              }
            }}
          />
        </div>
        <div className="switcher-list" ref={list}>
          {!query.trim() && items.length > 0 && <div className="switcher-head">Recent and unread</div>}
          {items.map((item, index) => (
            <button key={`${item.kind}${item.id}`} className={`switcher-item${index === pick ? ' picked' : ''}${item.unread ? ' unread' : ''}`} onMouseMove={() => setPick(index)} onClick={() => choose(item)}>
              <Icon name={item.icon} size={16} />
              <span className="switcher-label">{item.label}</span>
              {item.hint && <span className="switcher-hint">{item.hint}</span>}
              {item.mentions > 0 && <span className="badge num">{item.mentions}</span>}
            </button>
          ))}
          {query.trim() && items.length === 0 && <div className="switcher-empty">Nothing matches.</div>}
        </div>
        <div className="switcher-tip">
          Type <kbd>#</kbd> for channels, <kbd>*</kbd> for servers, <kbd>@</kbd> to copy a mention. <kbd>Enter</kbd> on empty goes back.
        </div>
      </div>
    </div>
  )
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const SHORTCUTS: Array<[string, string]> = [
  [`${mod} K`, 'Quick switcher'],
  ['Alt ↑ / ↓', 'Previous or next channel or thread'],
  ['Alt Shift ↑ / ↓', 'Previous or next unread'],
  [`${mod} Alt ↑ / ↓`, 'Previous or next server'],
  [`${mod} [ / ]`, 'Back or forward'],
  [`${mod} I`, 'Inbox'],
  [`${mod} P`, 'Pinned messages'],
  [`${mod} U`, 'Member list'],
  [`${mod} Shift U`, 'Upload a file'],
  [`${mod} E`, 'Emoji'],
  ['↑ / ↓ in the message list', 'Pick a message, then R reply, E edit, P pin, + react, Delete delete'],
  ...(native ? [[`${mod} + / −`, 'Zoom in or out'] as [string, string]] : []),
  ['Esc', 'Mark the open channel read'],
  ['Shift Esc', 'Mark the server read'],
  ['↑ in an empty message box', 'Edit your last message'],
  [`${mod} F`, 'Search'],
  [`${mod} /`, 'This list'],
  ['Shift Enter', 'New line'],
  [`${mod} B / I / U`, 'Bold, italic, underline in the message box'],
]

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts" role="dialog" aria-label="Keyboard shortcuts">
        <div className="modal-header">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="shortcut-row">
              <span>{what}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
