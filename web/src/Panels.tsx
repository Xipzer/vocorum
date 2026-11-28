// Side panels beside the thread (docked on desktop, full screen on phones):
// message search and a channel's pins. Plus the mentions inbox view.

import { isMac } from './columns.ts'
import { extensions } from './extensions.tsx'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { below, Sheet, type SheetSpec } from './Sheet.tsx'
import { profileSheet, type ProfileOf } from './Profile.tsx'
import { liveCustom, ownStatus, STATUS_TEXT } from './Status.tsx'
import { startAuthentication } from '@simplewebauthn/browser'
import { api, call, type Channel, type HubRequest, type Reminder, type FoundChannel, type LinkKind, type Mention, type Message, type SearchResult, type Service, type ServiceEvent, type SessionSummary } from './api.ts'
import { Avatar, machineIcon } from './Avatar.tsx'
import { Icon, type IconName } from './icons.tsx'
import { E } from './emoji.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { agentName, dmName, isDm, machineOf, snowflakeGt, store, useMachineName, useStore } from './store.ts'
import { cronLabel, isDue, remindTime, remindSheet } from './remind.ts'
import { can, P } from './perms.ts'
import { clock, displayName, plain } from './text.ts'
import { approveInApp, native } from './native.ts'
import { approvalError } from './login.ts'
import { CodeCard } from './SettingsPeople.tsx'
import { STYLE } from './Overview.tsx'
import { elapsedRun } from './run-clock.ts'
import { ALL_MARKS, choices as MARKS, markBit, ThreadFilter, useThreadFilter } from './ThreadFilter.tsx'
import './threads-panel.css'

export type Jump = (channelId: string, messageId: string) => void

function when(iso: string) {
  const date = new Date(iso)
  const today = new Date().toDateString() === date.toDateString()
  return today ? clock(iso) : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

// "#project › session" for a result's channel.
function useWhere() {
  const state = useStore((d) => d.state)
  return (channel: FoundChannel) => {
    const parent = channel.parent_id ? state?.channels.find((c) => c.id === channel.parent_id) : undefined
    const name = plain(channel.name ?? '')
    return parent && parent.type !== 4 ? `#${parent.name} › ${name}` : `#${name}`
  }
}

// Server snippets mark hits with **…**; shown as highlights, everything else as text.
// Mentions arrive as ids (<@id>, <#id>) and read as the names the chat shows.
function Snippet({ text, userName, channelName }: { text: string; userName: (id: string) => string | null; channelName: (id: string) => string | null }) {
  // Markdown syntax around the hits is noise in a one-line result.
  const parts = text
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${userName(id) ?? 'someone'}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${channelName(id) ?? 'channel'}`)
    .replace(/```\w*|`/g, '')
    .replace(/^#{1,6}\s+|^>\s?|^-#\s+/gm, '')
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => (i % 2 ? part : part.replace(/[*_~]{1,3}/g, '')))
  return (
    <span className="snippet">
      {parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
    </span>
  )
}

// An empty panel: one icon, a short title, one line. No paragraphs.
export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <b>{title}</b>
      {children && <span>{children}</span>}
    </div>
  )
}

function useDesk() {
  const [desk, setDesk] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)')
    const on = () => setDesk(query.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [])
  return desk
}

// Discord's popout on desktop: it hangs from its trigger, right edge on the trigger's right edge,
// under the header; a trigger low on the screen (the inbox bell) opens it upward from the user
// panel's left edge. Height follows the content; a click outside closes it.
function usePopout(anchor: string | undefined, box: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const desk = useDesk()
  const [at, setAt] = useState<CSSProperties | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const on = Boolean(anchor && desk)
  useLayoutEffect(() => {
    if (!anchor || !on) return setAt(null)
    const place = () => {
      const trigger = [...document.querySelectorAll<HTMLElement>(anchor)].find((el) => !el.closest('.side-panel') && el.getBoundingClientRect().width > 0)
      const width = box.current?.offsetWidth ?? 0
      const fit = (left: number) => Math.round(Math.max(8, Math.min(left, innerWidth - 8 - width)))
      const r = trigger?.getBoundingClientRect()
      if (trigger && r && r.top > innerHeight / 2) {
        const foot = (trigger.closest('.user-panel') ?? trigger).getBoundingClientRect()
        return setAt({ left: fit(foot.left), top: 'auto', bottom: Math.round(innerHeight - foot.top + 8), '--pop-room': `${Math.round(foot.top - 16)}px` } as CSSProperties)
      }
      const head = (trigger?.closest('.chat-header') ?? document.querySelector('.app > .chat > .chat-header'))?.getBoundingClientRect()
      const top = Math.round(head?.bottom ?? 48)
      setAt({ left: fit((r ? r.right : innerWidth - 8) - width), top, bottom: 'auto', '--pop-room': `${innerHeight - top - 16}px` } as CSSProperties)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, on, box])
  useEffect(() => {
    if (!anchor || !on) return
    const down = (e: PointerEvent) => {
      const target = e.target as Element
      if (box.current?.contains(target) || target.closest?.(`${anchor}, .sheet-layer, .overlay, .lightbox`)) return
      close.current()
    }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [anchor, on, box])
  return on ? (at ?? { visibility: 'hidden' }) : null
}

// Side panel shell: icon and title like Discord's popouts, a count only when there's something.
// With an anchor (a CSS selector for its trigger) it floats as a popout on desktop.
function Panel({ title, icon, count, children, onClose, extra, kind, action, anchor }: { title: ReactNode; icon?: IconName; count?: number; children: ReactNode; onClose: () => void; extra?: ReactNode; /** Names the panel for its own type sizes (`pins-panel`). */ kind?: 'threads' | 'pins' | 'inbox' | 'members'; /** On a phone: a close X at the left and this button at the right, around a centred title. */ action?: { label: string; icon: IconName; run: () => void }; anchor?: string }) {
  const box = useRef<HTMLElement>(null)
  const popout = usePopout(anchor, box, onClose)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.sheet-layer, .overlay')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <aside ref={box} className={`side-panel${kind ? ` ${kind}-panel` : ''}${action ? ' with-action' : ''}${popout ? ' popout' : ''}`} style={popout ?? undefined} role="complementary">
      <header className="panel-head">
        <button className="icon-button panel-back" onClick={onClose} aria-label="Close panel">
          <Icon name={action ? 'close' : 'back'} size={22} />
        </button>
        {icon && <Icon name={icon} size={20} className="panel-icon" />}
        <div className="panel-title">
          {title}
          {count ? <span className="panel-count num">{count}</span> : null}
        </div>
        {extra}
        <button className="icon-button panel-close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
        {action && (
          <button className="icon-button panel-action" onClick={action.run} aria-label={action.label} title={action.label}>
            <Icon name={action.icon} size={22} />
          </button>
        )}
      </header>
      {children}
    </aside>
  )
}

const TOKENS = ['from:', 'in:', 'has:', 'mentions:me', 'before:', 'after:']

export function SearchPanel({ onClose, onJump, initial = '' }: { onClose: () => void; onJump: Jump; initial?: string }) {
  const [q, setQ] = useState(initial)
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest')
  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const where = useWhere()
  const seq = useRef(0)
  const hubState = useStore((d) => d.state)
  // Mentions in a result read as they do in the chat: the person's or channel's name.
  const userName = (raw: string) => {
    const user = hubState?.users.find((u) => u.id === (hubState.user_aliases?.[raw] ?? raw))
    return user ? (user.global_name ?? user.username) : null
  }
  const channelName = (id: string) => (hubState?.channels.find((c) => c.id === id) ?? hubState?.threads.find((c) => c.id === id))?.name ?? null
  // A bot's result carries the name the chat shows for it: its machine's.
  const author = (r: SearchResult) => {
    const machine = r.message.author.bot && hubState ? machineOf(hubState, (hubState.threads.find((c) => c.id === r.channel.id) ?? hubState.channels.find((c) => c.id === r.channel.id)) ?? ({ ...r.channel, name: r.channel.name ?? undefined } as Channel)) : null
    return machine ? agentName(hubState!.machine_bots, machine) : (r.message.author.global_name ?? r.message.author.username)
  }

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const query = q.trim()
    if (!query) {
      setResults([])
      setTotal(null)
      return
    }
    const id = ++seq.current
    const timer = window.setTimeout(async () => {
      setBusy(true)
      try {
        const page = await api.search(query, 0, order)
        if (id !== seq.current) return
        setResults(page.results)
        setTotal(page.total)
        setError(null)
      } catch (e) {
        if (id === seq.current) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (id === seq.current) setBusy(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [q, order])

  const more = async () => {
    setBusy(true)
    const page = await api.search(q.trim(), results.length, order).catch(() => null)
    setBusy(false)
    if (page) setResults([...results, ...page.results])
  }

  return (
    <Panel title="Search" icon="search" onClose={onClose}>
      <div className="panel-search">
        <label className="search">
          <Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" aria-label="Search messages" enterKeyHint="search" />
          {q && (
            <button className="icon-button" style={{ width: 24, height: 24 }} onClick={() => setQ('')} aria-label="Clear search">
              <Icon name="close" size={16} />
            </button>
          )}
        </label>
        {!q.trim() ? (
          <div className="tokens">
            {TOKENS.map((t) => (
              <button
                key={t}
                className="token"
                onClick={() => {
                  setQ((v) => `${v ? `${v.trimEnd()} ` : ''}${t}`)
                  input.current?.focus()
                }}
              >
                {t}
              </button>
            ))}
          </div>
        ) : (
          <div className="panel-meta">
            <span className="num">{busy && total === null ? 'Searching…' : `${total ?? 0} ${total === 1 ? 'result' : 'results'}`}</span>
            <span className="panel-tabs">
              {(['newest', 'oldest'] as const).map((o) => (
                <button key={o} className={`tab${order === o ? ' on' : ''}`} onClick={() => setOrder(o)}>
                  {o === 'newest' ? 'Newest' : 'Oldest'}
                </button>
              ))}
            </span>
          </div>
        )}
      </div>
      <div className="panel-body">
        {error && <div className="error panel-pad">{error}</div>}
        {results.map((r) => (
          <button key={r.message.id} className="result" onClick={() => onJump(r.channel.id, r.message.id)}>
            <span className="result-where">{where(r.channel)}</span>
            <span className="result-head">
              <Avatar id={r.message.author.id} name={author(r)} size="inline" />
              <b>{author(r)}</b>
              <span className="num">{when(r.message.timestamp)}</span>
            </span>
            <Snippet text={r.snippet ?? plain(r.message.content, userName, channelName).slice(0, 200)} userName={userName} channelName={channelName} />
          </button>
        ))}
        {total !== null && results.length < total && (
          <button className="button more" disabled={busy} onClick={() => void more()}>
            Load more
          </button>
        )}
        {total === 0 && !busy && <Empty icon="search" title="No results">Try fewer words or another filter.</Empty>}
      </div>
    </Panel>
  )
}

export function PinsPanel({ channelId, ctx, onClose, onJump }: { channelId: string; ctx: MarkdownContext; onClose: () => void; onJump: Jump }) {
  const [pins, setPins] = useState<Message[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = useStore((d) => d.messages[channelId]?.list)
  const pinnedKey = (list ?? []).filter((m) => m.pinned).map((m) => m.id).join(',')
  useEffect(() => {
    api.pins(channelId).then((r) => setPins(r.messages), (e: Error) => setError(e.message))
  }, [channelId, pinnedKey])
  return (
    <Panel title="Pinned messages" icon="pin" kind="pins" count={pins?.length} onClose={onClose} anchor=".chat-header [aria-label='Pinned messages']">
      <div className="panel-body">
        {error && <div className="error panel-pad">{error}</div>}
        {pins?.length === 0 && <Empty icon="pin" title="No pinned messages">Pin a message to keep it here.</Empty>}
        {pins?.map((m) => (
          <div key={m.id} className="pin">
            <div className="result-head">
              <Avatar id={m.author.id} name={m.author.global_name ?? m.author.username} size="inline" />
              <b>{m.author.global_name ?? m.author.username}</b>
              <span className="num">{when(m.timestamp)}</span>
              <span className="pin-actions">
                <button className="icon-button" onClick={() => onJump(channelId, m.id)} aria-label="Jump to message" title="Jump">
                  <Icon name="chevron" size={16} />
                </button>
                {(can(P.PIN_MESSAGES, channelId) || can(P.MANAGE_MESSAGES, channelId)) && <button
                  className="icon-button"
                  onClick={() => void api.pin(channelId, m.id, false).then(() => setPins((p) => p?.filter((x) => x.id !== m.id) ?? null))}
                  aria-label="Unpin"
                  title="Unpin"
                >
                  <Icon name="close" size={16} />
                </button>}
              </span>
            </div>
            <div className="pin-body">{m.content ? <Markdown text={m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content} ctx={ctx} /> : <span className="muted">Attachment or components</span>}</div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

// One mention or needs-you item as a row; shared by a server's Mentions page and the inbox.
function useMentions(guildId?: string, channelId?: string) {
  const [mentions, setMentions] = useState<Mention[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seen = useStore((d) => d.seen)
  useEffect(() => {
    let live = true
    setMentions(null); setError(null)
    api.inbox(channelId ? { channelId } : guildId ? { guildId } : undefined).then(r => { if (live) setMentions(r.mentions) }, (e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [guildId, channelId])
  const unread = (m: Mention) => !m.read && !(seen[m.channel.id] && (seen[m.channel.id]!.length > m.message.id.length || (seen[m.channel.id]!.length === m.message.id.length && seen[m.channel.id]! >= m.message.id)))
  const list = channelId ? mentions?.filter(m => m.channel.id === channelId) : guildId ? mentions?.filter((m) => store.guildOf(m.channel.id) === guildId) : mentions
  return { list, error, unread }
}

function MentionRow({ m, unread, onJump, showServer }: { m: Mention; unread: boolean; onJump: Jump; showServer?: boolean }) {
  const where = useWhere()
  const users = useStore((d) => d.state?.users)
  const guilds = store.guilds()
  const name = (id: string) => {
    const u = users?.find((x) => x.id === id)
    return u ? (u.global_name ?? u.username) : null
  }
  const server = showServer ? guilds.find((g) => g.id === store.guildOf(m.channel.id))?.name : null
  return (
    <button className={`ov-item mention-row${unread ? ' unread' : ''}`} onClick={() => onJump(m.channel.id, m.message.id)}>
      <span className="ov-main">
        <i className={`st ${unread ? 'waiting' : 'idle'}`} />
        <span className="ov-title">
          {m.message.author.global_name ?? m.message.author.username}
          <span className="ov-where">{[server, where(m.channel)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="ov-age num">{when(m.message.timestamp)}</span>
      </span>
      <span className="ov-line">{plain(m.message.content, name) || 'Attachment or components'}</span>
    </button>
  )
}

export function ChatMentions({ channelId, onClose, onJump }: { channelId: string; onClose: () => void; onJump: Jump }) {
  const { list, error, unread } = useMentions(undefined, channelId)
  return <Panel title="Mentions here" icon="at" count={list?.length} onClose={onClose}>
    <div className="panel-body">{error ? <p className="error panel-pad">{error}</p> : !list ? <p className="ws-meta panel-pad" role="status">Loading mentions…</p> : !list.length ? <Empty icon="at" title="No mentions in this chat"/> : list.map(m => <MentionRow key={m.message.id} m={m} unread={unread(m)} onJump={onJump}/>)}</div>
  </Panel>
}

// A server's Mentions page: mentions in this server's channels only.
export function Inbox({ guildId, onMenu, onJump, onSearch }: { guildId: string; onMenu: () => void; onJump: Jump; onSearch: () => void }) {
  const { list, error, unread } = useMentions(guildId)
  const guildName = store.guilds().find((g) => g.id === guildId)?.name
  const count = list?.filter(unread).length ?? 0
  return (
    <section className="chat overview">
      <header className="chat-header">
        <button className="icon-button menu" onClick={onMenu} aria-label="Channels">
          <Icon name="back" size={22} className="phone-only" />
          <Icon name="sidebar" size={20} className="desk-only-icon" />
        </button>
        <div className="chat-titles">
          <span className="chat-title">
            <Icon name="at" size={20} className="title-icon" />
            Mentions
          </span>
          <span className="chat-sub">{guildName ? `${guildName} · last 14 days` : 'Last 14 days'}</span>
        </div>
        <span className="chat-actions">
          {count > 0 && (
            <button className="button" onClick={() => store.markAllSeen([...new Set(list!.filter(unread).map((m) => m.channel.id))])}>
              Mark all read
            </button>
          )}
          <button className="icon-button" onClick={onSearch} aria-label="Search messages" title={`Search (${isMac ? "⌘F" : "Ctrl+F"})`}>
            <Icon name="search" />
          </button>
        </span>
      </header>
      <div className="messages">
        <div className="ov mentions-page">
          {error && <div className="error">{error}</div>}
          {list?.length === 0 && <Empty icon="at" title="No mentions">Mentions in this server from the last 14 days show here.</Empty>}
          {list?.map((m) => <MentionRow key={m.message.id} m={m} unread={unread(m)} onJump={onJump} />)}
        </div>
      </div>
    </section>
  )
}

// The inbox (bell in the user panel): everything that wants you, across every server:
// sessions waiting on you or failed, then mentions.
export function InboxPanel({ onClose, onJump, onOpen }: { onClose: () => void; onJump: Jump; onOpen: (id: string) => void }) {
  const { list, error, unread } = useMentions()
  const sessions = useStore((d) => d.sessions)
  const machineName = useMachineName()
  const needs = Object.values(sessions)
    .filter((s) => s.state === 'waiting' || s.state === 'failed')
    .sort((a, b) => b.since.localeCompare(a.since))
  const unreadCount = list?.filter(unread).length ?? 0
  // Agents' requests: pending first, then what was decided in the last 15 minutes.
  const allRequests = useStore((d) => d.requests)
  const now = Date.now()
  // An approved invite stays while its pairing code can still be sent.
  const requests = allRequests.filter((r) => (r.status === 'pending' && r.expires_at > now) || (r.decided_at ?? 0) > now - 15 * 60_000 || inviteOf(r)?.code)
  const pendingCount = requests.filter((r) => r.status === 'pending').length
  const reminders = useStore((d) => d.reminders) ?? []
  const due = reminders.filter(isDue).reverse()
  const upcoming = reminders.filter((r) => !isDue(r))
  const more = extensions.reduce((sum, e) => sum + (e.useInboxCount?.() ?? 0), 0)
  return (
    <Panel
      title="Inbox"
      icon="bell"
      kind="inbox"
      count={due.length + pendingCount + needs.length + unreadCount + more}
      onClose={onClose}
      anchor=".inbox-button"
      extra={
        unreadCount > 0 ? (
          <button className="button" onClick={() => store.markAllSeen([...new Set(list!.filter(unread).map((m) => m.channel.id))])}>
            Mark all read
          </button>
        ) : undefined
      }
    >
      <div className="panel-body">
        {error && <div className="error panel-pad">{error}</div>}
        {reminders.length > 0 && (
          <div className="panel-section">
            Reminders {due.length > 0 && <span className="num">{due.length}</span>}
          </div>
        )}
        {[...due, ...upcoming].map((r) => (
          <ReminderRow key={r.id} reminder={r} due={isDue(r)} onJump={onJump} onOpen={onOpen} />
        ))}
        {requests.length > 0 && (
          <div className="panel-section">
            Requests {pendingCount > 0 && <span className="num">{pendingCount}</span>}
          </div>
        )}
        {requests.map((r) => (
          <RequestCard key={r.id} request={r} />
        ))}
        {needs.length > 0 && (
          <div className="panel-section">
            Needs you <span className="num">{needs.length}</span>
          </div>
        )}
        {needs.map((s) => (
          <button key={s.id} className="result thread-row" onClick={() => onOpen(s.id)}>
            <span className="link-title">
              <i className={`st ${s.state}`} />
              <b>{plain(s.title)}</b>
            </span>
            <span className="result-where">
              {[s.project && `#${s.project}`, s.machine && machineName(s.machine)].filter(Boolean).join(' · ')}
              {s.ask?.text ? ` · ${plain(s.ask.text).slice(0, 80)}` : s.error ? ` · ${s.error}` : ''}
            </span>
          </button>
        ))}
        {extensions.map((e) => e.InboxSection && <e.InboxSection key={e.id} onOpen={onOpen} />)}
        {(list?.length ?? 0) > 0 && (
          <div className="panel-section">
            Mentions <span className="num">{list!.length}</span>
          </div>
        )}
        {list?.map((m) => <MentionRow key={m.message.id} m={m} unread={unread(m)} onJump={onJump} showServer />)}
        {reminders.length === 0 && requests.length === 0 && needs.length === 0 && more === 0 && list?.length === 0 && <Empty icon="bell" title="You're all caught up">Mentions and sessions waiting on you, from every server, show here.</Empty>}
      </div>
    </Panel>
  )
}

// A reminder: due ones lead with Done and Later; upcoming ones say when, and can go.
function ReminderRow({ reminder: r, due, onJump, onOpen, fullText = false }: { reminder: Reminder; due: boolean; onJump: Jump; onOpen: (id: string) => void; fullText?: boolean }) {
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const [error, setError] = useState<string | null>(null)
  const channel = store.channel(r.channel_id)
  const where = channel ? (isDm(channel) ? `@${dmName(channel, store.data.state?.me.id ?? '')}` : `#${plain(channel.name ?? '')}`) : 'a channel you can no longer see'
  const loaded = r.message_id ? store.data.messages[r.channel_id]?.list.find((m) => m.id === r.message_id) : undefined
  const message = r.message ?? (loaded ? { content: loaded.content, author: loaded.author } : null)
  const text = r.note ?? (message ? plain(message.content) : '')
  const go = () => (r.message_id ? onJump(r.channel_id, r.message_id) : onOpen(r.channel_id))
  // Done dismisses a fired one on every device; the cross cancels an upcoming one.
  const done = () => void api.forget(r.id).then(() => store.dropReminder(r.id), (e: Error) => setError(e.message))
  return (
    <div className={`reminder-row${due ? ' due' : ''}`}>
      <button className="reminder-main" onClick={go}>
        {text && <span className="reminder-text">{message?.author && !r.note ? <b>{displayName(message.author)}: </b> : null}{fullText ? text : text.slice(0, 140)}</span>}
        <span className="reminder-when num">
          <Icon name="bell" size={14} />
          <time dateTime={new Date(r.at).toISOString()}>{remindTime(r.at)}</time>
          <span className="reminder-where">{where}</span>
        </span>
        {error && <span className="reminder-error">{error}</span>}
      </button>
      {due ? (
        <span className="reminder-actions">
          <button className="button" onClick={(e) => setSheet(remindSheet(below(e.currentTarget), { reminder: r }, setError))}>
            Later
          </button>
          <button className="button primary" onClick={done}>
            Done
          </button>
        </span>
      ) : (
        <button className="icon-button reminder-cancel" onClick={done} aria-label="Cancel reminder" title="Cancel reminder">
          <Icon name="close" size={16} />
        </button>
      )}
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}

// Messages waiting to be posted: in one channel, or everywhere. Each says when (in local
// time, or its repeat), where, and what; a failed one says why. The cross cancels it.
export function ScheduledPanel({ channelId, onClose, onOpen, onJump }: { channelId?: string; onClose: () => void; onOpen: (id: string) => void; onJump: Jump }) {
  const machineName = useMachineName()
  const all = useStore((d) => d.scheduled)
  const reminders = (useStore((d) => d.reminders) ?? []).filter((r) => !r.due && (!channelId || r.channel_id === channelId))
  const list = channelId ? all.filter((s) => s.channel_id === channelId) : all
  const [error, setError] = useState<string | null>(null)
  const routines = useStore((d) => d.routines)
    .map((m) => ({ ...m, routines: m.routines.filter((r) => !channelId || r.channel_id === channelId || r.thread_id === channelId) }))
    .filter((m) => m.routines.length)
  const routineCount = routines.reduce((n, m) => n + m.routines.length, 0)
  const where = (id: string) => {
    const c = store.channel(id)
    return c ? (isDm(c) ? `@${dmName(c, store.data.state?.me.id ?? '')}` : `#${plain(c.name ?? '')}`) : 'a channel you can no longer see'
  }
  const cancel = (id: string) => void api.forget(id).then(() => store.upsertScheduled({ ...all.find((s) => s.id === id)!, status: 'cancelled' }), (e: Error) => setError(e.message))
  return (
    <Panel title="Scheduled" icon="clock" count={list.length + reminders.length + routineCount} onClose={onClose}>
      <div className="panel-body scheduled-list">
        {error && <div className="error panel-pad">{error}</div>}
        {list.length > 0 && (
          <div className="panel-section">
            Messages <span className="num">{list.length}</span>
          </div>
        )}
        {list.map((s) => (
          <div key={s.id} className={`reminder-row scheduled${s.status === 'failed' ? ' failed' : ''}`}>
            <button className="reminder-main" onClick={() => onOpen(s.channel_id)}>
              <span className="reminder-when num">
                <Icon name={s.cron ? 'repeat' : 'clock'} size={14} />
                {s.status === 'failed' ? 'Not sent' : s.cron ? cronLabel(s.cron, s.next_at) : s.next_at ? remindTime(s.next_at) : ''}
                {!channelId && <span className="reminder-where">{where(s.channel_id)}</span>}
              </span>
              <span className="reminder-text">{plain(s.content)}</span>
              {s.status === 'failed' && s.last_result && <span className="reminder-error">{s.last_result}</span>}
            </button>
            <button className="icon-button reminder-cancel" onClick={() => cancel(s.id)} aria-label="Cancel scheduled message" title="Cancel">
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
        {reminders.length > 0 && (
          <div className="panel-section">
            Reminders <span className="num">{reminders.length}</span>
          </div>
        )}
        {reminders.map((r) => (
          <ReminderRow key={r.id} reminder={r} due={false} fullText onJump={onJump} onOpen={onOpen} />
        ))}
        {routines.map((m) => (
          <Fragment key={m.machine}>
            <div className="panel-section">
              Routines on {machineName(m.machine)} <span className="num">{m.routines.length}</span>
            </div>
            {m.routines.map((r) => {
              const target = r.thread_id ?? r.channel_id
              const next = r.next_run ? Date.parse(r.next_run) : NaN
              return (
                <div key={r.id} className="reminder-row routine">
                  <button className="reminder-main" onClick={() => target && onOpen(target)} disabled={!target}>
                    <span className="reminder-when num">
                      <Icon name={r.schedule.startsWith('at ') ? 'clock' : 'repeat'} size={14} />
                      {Number.isFinite(next) ? remindTime(next) : r.schedule}
                      {!channelId && target && <span className="reminder-where">{where(target)}</span>}
                    </span>
                    <span className="reminder-text">{r.prompt}</span>
                    <span className="routine-meta">{[Number.isFinite(next) && r.schedule, r.status && r.status !== 'active' ? r.status : null].filter(Boolean).join(' · ')}</span>
                  </button>
                </div>
              )
            })}
          </Fragment>
        ))}
        {routineCount > 0 && <p className="panel-note">Routines are edited in Kimaki.</p>}
        {list.length === 0 && reminders.length === 0 && routineCount === 0 && (
          <Empty icon="clock" title="Nothing scheduled">
            Right-click Send, or hold it on a phone, to post a message later.
          </Empty>
        )}
      </div>
    </Panel>
  )
}

// One change an agent asked for. The summary is shown verbatim (it says when a role can
// give a shell); approving takes a fresh passkey on this device.
const DECIDED: Record<HubRequest['status'], string> = { pending: '', approved: 'Approved', denied: 'Denied', failed: 'Failed', expired: 'Expired' }
// "at 14:05", "tomorrow 09:00", "Mon 09:00": when a request lapses, inside a sentence.
const expiry = (ms: number) => {
  const t = remindTime(ms)
  return /^\d/.test(t) ? `at ${t}` : t.replace(/^(Tomorrow|Yesterday)/, (w) => w.toLowerCase())
}

// An approved "invite a person": the new person's first pairing code, for the owner to send.
// The hub gives the code only to the owner's own devices, and only while it can be used.
type InviteResult = { user?: { username: string; global_name?: string | null }; code?: string | null; expires_at?: number; pairing?: 'ready' | 'used' | 'expired' }
function inviteOf(request: HubRequest) {
  if (request.status !== 'approved' || !/^\/client\/guilds\/\d+\/invites$/.test(request.route ?? '')) return null
  return (request.result as InviteResult | null) ?? null
}

function InviteOutcome({ request, invite }: { request: HubRequest; invite: InviteResult }) {
  const guilds = useStore((d) => d.state?.guilds)
  const name = invite.user ? (invite.user.global_name ?? invite.user.username) : 'They'
  const guild = guilds?.find((g) => request.route?.includes(`/guilds/${g.id}/`))?.name ?? 'the server'
  if (invite.code && invite.expires_at) return <CodeCard code={invite.code} expires={invite.expires_at} qr note={`Send it to ${name}. They open Vocorum on their device and enter it under New device, or scan the code.`} />
  return (
    <div className="request-outcome">
      {invite.pairing === 'used' ? `${name} has joined.` : invite.pairing === 'expired' ? 'This code expired. Make a new one in Members.' : `${name} was added to ${guild}. Nothing to send.`}
    </div>
  )
}

export function RequestCard({ request }: { request: HubRequest }) {
  const [busy, setBusy] = useState<'approve' | 'deny' | 'undo' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = (kind: 'approve' | 'deny' | 'undo') => {
    setBusy(kind)
    setError(null)
    void (async () => {
      if (kind === 'deny') await api.deny(request.id)
      else if (kind === 'undo') store.upsertRequest(await api.undo(request.id))
      else if (native) await approveInApp(request.id)
      else {
        const { challengeId, options } = await api.approveOptions(request.id)
        await api.approve(request.id, challengeId, await startAuthentication({ optionsJSON: options }))
      }
      await store.loadRequests()
    })()
      .catch((e: unknown) => setError(approvalError(e)))
      .finally(() => setBusy(null))
  }
  const pending = request.status === 'pending'
  const invite = inviteOf(request)
  const failure = request.status !== 'failed' ? null : typeof request.result === 'string' ? request.result : ((request.result as { error?: string } | null)?.error ?? null)
  return (
    <div className={`request-card ${request.status}`}>
      <div className="request-summary">{request.summary}</div>
      {/* The summary above is the hub's own account of the change; the reason is the asker's. */}
      {request.reason && (
        <div className="request-reason">
          <span className="request-reason-label">In their words</span>
          {request.reason}
        </div>
      )}
      <div className="request-meta">
        from {request.origin}
        {pending ? ` · expires ${expiry(request.expires_at)}` : ` · ${DECIDED[request.status]}${failure ? `: ${failure}` : ''}`}
      </div>
      {error && <div className="error">{error}</div>}
      {invite && <InviteOutcome request={request} invite={invite} />}
      {pending && (
        <div className="request-actions">
          <button className="button" disabled={busy !== null} onClick={() => act('deny')}>
            Deny
          </button>
          <button className="button primary" disabled={busy !== null} onClick={() => act('approve')}>
            <Icon name="key" size={16} />
            Approve
          </button>
        </div>
      )}
      {request.status === 'approved' && request.undoable && (
        <div className="request-actions">
          <button className="button" disabled={busy !== null} onClick={() => act('undo')}>
            Undo
          </button>
        </div>
      )}
    </div>
  )
}

const KIND_TEXT: Record<LinkKind, string> = {
  liaison: 'Liaison: you name each other',
  parent: 'Started this session',
  spawned: 'Started from here',
  mentions: 'Named in this session',
  mentioned: 'Names this session',
}

// Sessions this one works with: liaisons first, then parent and children, then one-way mentions.
export function LinksPanel({ channelId, onClose, onOpen, onJump }: { channelId: string; onClose: () => void; onOpen: (id: string) => void; onJump: Jump }) {
  const links = useStore((d) => d.linked[channelId])
  const machineName = useMachineName()
  const threads = useStore((d) => d.state?.threads)
  const channels = useStore((d) => d.state?.channels)
  const sessions = useStore((d) => d.sessions)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    store.loadLinks(channelId).catch((e: Error) => setError(e.message))
  }, [channelId])
  return (
    <Panel title="Linked sessions" icon="link" count={links?.length} onClose={onClose}>
      <div className="panel-body">
        {error && <div className="error panel-pad">{error}</div>}
        {links?.length === 0 && <Empty icon="link" title="No linked sessions">Sessions that name this one show here.</Empty>}
        {links?.map((link) => {
          const thread = threads?.find((t) => t.id === link.id)
          const project = thread?.parent_id ? channels?.find((c) => c.id === thread.parent_id)?.name : null
          const session = sessions[link.id]
          return (
            <div key={link.id} className="result link-item">
              <button className="link-open" onClick={() => onOpen(link.id)}>
                <span className="result-where">{[project && `#${project}`, session?.machine && machineName(session.machine)].filter(Boolean).join(' · ')}</span>
                <span className="link-title">
                  <i className={`st ${session?.state ?? 'idle'}`} />
                  <b>{thread ? plain(thread.name ?? '') : 'A thread not on this hub'}</b>
                </span>
                <span className="link-kind">
                  {KIND_TEXT[link.kind]} · <span className="num">{link.count}</span> {link.count === 1 ? 'reference' : 'references'} · {when(link.last)}
                </span>
              </button>
              {link.messageId ? (
                <button className="link-button link-jump" onClick={() => onJump(link.messageChannelId, link.messageId)}>
                  Show the latest reference
                </button>
              ) : (
                <span className="link-kind link-jump">Linked in Kimaki</span>
              )}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}


const SERVICE_LABEL: Record<Service['status'], string> = { running: 'Running', waiting: 'Waiting', stopped: 'Stopped', failed: 'Failed', restarting: 'Crash loop', starting: 'Starting' }
const SERVICE_DOT: Record<Service['status'], string> = { running: 'ok', waiting: 'idle', stopped: 'idle', failed: 'failed', restarting: 'failed', starting: 'busy' }
const short = (unit: string) => unit.replace(/\.(service|timer)$/, '')

function since(iso: string | null): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

function until(iso: string | null): string {
  if (!iso) return ''
  const s = (Date.parse(iso) - Date.now()) / 1000
  if (s < 60) return 'next in <1m'
  if (s < 3600) return `next in ${Math.round(s / 60)}m`
  return `next ${new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

// A timer and the service it runs read as one scheduled job.
function scheduled(timer: Service, all: Service[]): Service['status'] {
  const job = all.find((s) => s.unit === timer.runs)
  if (job && (job.status === 'failed' || job.status === 'restarting')) return job.status
  if (job?.status === 'running' || job?.status === 'starting') return 'running'
  return timer.status
}

function ServiceRow({ service, status, onOpen }: { service: Service; status: Service['status']; onOpen: () => void }) {
  return (
    <button className="result service-row" onClick={onOpen}>
      <span className="link-title">
        <i className={`st ${SERVICE_DOT[status]}`} aria-label={SERVICE_LABEL[status]} />
        <b>{short(service.unit)}</b>
        <span className="service-meta num">{service.kind === 'timer' ? until(service.next) : status === 'running' ? since(service.since) : SERVICE_LABEL[status].toLowerCase()}</span>
      </span>
      {service.description && <span className="result-where">{service.description}</span>}
    </button>
  )
}

// Services on the hub's machine that agents started: what runs, what failed, what is scheduled.
export function ServicesPanel({ onClose, onOpen, threadId }: { onClose: () => void; onOpen: (id: string) => void; threadId?: string }) {
  const all = useStore((d) => d.services)
  const services = threadId && all ? all.filter((s) => s.threads.includes(threadId) || all.some((t) => t.threads.includes(threadId) && t.runs === s.unit)) : all
  const [unit, setUnit] = useState<string | null>(null)
  const [showStopped, setShowStopped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    store.loadServices().then(() => setError(null), (e: Error) => setError(e.message))
  }, [])
  const selected = unit ? services?.find((s) => s.unit === unit) : undefined
  if (unit && services) return <ServiceDetail unit={unit} service={selected} all={services} onBack={() => setUnit(null)} onClose={onClose} onOpen={onOpen} />
  const list = (services ?? []).filter((s) => !s.timer)
  const status = (s: Service) => (s.kind === 'timer' ? scheduled(s, services ?? []) : s.status)
  const attention = list.filter((s) => ['failed', 'restarting'].includes(status(s)))
  const running = list.filter((s) => s.kind === 'service' && ['running', 'starting'].includes(s.status))
  const timers = list.filter((s) => s.kind === 'timer' && !attention.includes(s))
  const stopped = list.filter((s) => s.kind === 'service' && !attention.includes(s) && !running.includes(s))
  const section = (title: string, items: Service[], extra?: ReactNode) =>
    items.length > 0 && (
      <>
        <div className="panel-section">
          {title} <span className="num">{items.length}</span>
          {extra}
        </div>
        {items.map((s) => (
          <ServiceRow key={s.unit} service={s} status={status(s)} onOpen={() => setUnit(s.unit)} />
        ))}
      </>
    )
  return (
    <Panel title="Services" icon="server" count={running.length} onClose={onClose}>
      <div className="panel-body">
        {error && <div className="error panel-pad">{error}</div>}
        {services?.length === 0 &&
          (threadId ? (
            <Empty icon="server" title="No services">Services this agent runs show here.</Empty>
          ) : (
            <Empty icon="server" title="No services">User services on this machine show here.</Empty>
          ))}
        {section('Needs attention', attention)}
        {section('Running', running)}
        {section('Scheduled', timers)}
        {stopped.length > 0 && (
          <>
            <button className="panel-section fold" onClick={() => setShowStopped(!showStopped)} aria-expanded={showStopped}>
              Stopped <span className="num">{stopped.length}</span>
              <Icon name="chevron" size={14} />
            </button>
            {showStopped && stopped.map((s) => <ServiceRow key={s.unit} service={s} status={s.status} onOpen={() => setUnit(s.unit)} />)}
          </>
        )}
      </div>
    </Panel>
  )
}

const EVENT_TEXT: Record<string, string> = { started: 'Started', stopped: 'Stopped', failed: 'Failed', crashed: 'Crashed', restarted: 'Restarted', version: 'New version', appeared: 'First seen', removed: 'Removed', 'unit file changed': 'Unit file changed', 'start requested': 'Start requested', 'stop requested': 'Stop requested', 'restart requested': 'Restart requested' }

function ServiceDetail({ unit, service, all, onBack, onClose, onOpen }: { unit: string; service?: Service; all: Service[]; onBack: () => void; onClose: () => void; onOpen: (id: string) => void }) {
  const [events, setEvents] = useState<ServiceEvent[] | null>(null)
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threads = useStore((d) => d.state?.threads)
  const job = service?.runs ? all.find((s) => s.unit === service.runs) : undefined
  const key = `${service?.status}-${service?.since}-${job?.status}`
  useEffect(() => {
    Promise.all([api.serviceEvents(unit), job ? api.serviceEvents(job.unit) : Promise.resolve({ events: [] })]).then(
      ([a, b]) => setEvents([...a.events, ...b.events].sort((x, y) => y.at - x.at)),
      (e: Error) => setError(e.message),
    )
  }, [unit, key, job?.unit])
  const act = (verb: 'start' | 'stop' | 'restart', at: { x: number; y: number }) =>
    setSheet({
      at,
      title: `${verb[0]!.toUpperCase()}${verb.slice(1)} ${short(unit)}?`,
      confirm: true,
      subtitle: unit === 'vocorum.service' && verb !== 'start' ? 'This is the hub itself: the app reconnects when it is back.' : 'Runs systemctl --user on the hub machine.',
      groups: [
        [
          {
            label: `${verb[0]!.toUpperCase()}${verb.slice(1)}`,
            icon: verb === 'stop' ? 'stop' : verb === 'start' ? 'play' : 'unarchive',
            red: verb === 'stop',
            run: () => {
              setBusy(true)
              setError(null)
              store
                .controlService(unit, verb)
                .catch((e: Error) => setError(e.message))
                .finally(() => setBusy(false))
            },
          },
        ],
      ],
    })
  const at = (e: React.MouseEvent) => ({ x: e.clientX, y: e.clientY })
  const live = service && ['running', 'starting', 'restarting', 'waiting'].includes(service.status)
  return (
    <Panel
      title={
        <span className="service-title">
          <button className="icon-button" onClick={onBack} aria-label="All services">
            <Icon name="back" size={18} />
          </button>
          {short(unit)}
        </span>
      }
      onClose={onClose}
    >
      <div className="panel-body service-detail">
        {!service ? (
          <Empty icon="server" title="Service removed">Its history is below.</Empty>
        ) : (
          <>
            {service.description && <p className="service-desc">{service.description}</p>}
            <div className="status-rows">
              <div className={`status-row ${service.status === 'failed' || service.status === 'restarting' ? 'bad' : service.status === 'running' ? 'ok' : 'warn'}`}>
                <i />
                <span>
                  <b>{SERVICE_LABEL[service.status]}</b>
                  {service.since && ` since ${new Date(service.since).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`}
                  {service.status === 'failed' && service.sub ? ` (${service.sub})` : ''}
                </span>
              </div>
            </div>
            <dl className="facts num">
              {service.pid ? (
                <>
                  <dt>PID</dt>
                  <dd>{service.pid}</dd>
                </>
              ) : null}
              {service.kind === 'timer' && (
                <>
                  <dt>Next run</dt>
                  <dd>{service.next ? new Date(service.next).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'none'}</dd>
                  {job && (
                    <>
                      <dt>Last run</dt>
                      <dd>
                        {SERVICE_LABEL[job.status]}
                        {job.since ? ` · ${since(job.since)} ago` : ''}
                      </dd>
                    </>
                  )}
                </>
              )}
              <dt>Restarts</dt>
              <dd>{service.restarts}</dd>
              {service.version && (
                <>
                  <dt>Version</dt>
                  <dd>{service.version}</dd>
                </>
              )}
              <dt>Boot</dt>
              <dd>{service.transient ? 'one-off (systemd-run)' : service.enabled ? 'starts on boot' : 'manual'}</dd>
            </dl>
            <div className="service-actions">
              {live && service.kind === 'service' && (
                <button className="button" disabled={busy} onClick={(e) => act('restart', at(e))}>
                  Restart
                </button>
              )}
              {live ? (
                <button className="button danger" disabled={busy} onClick={(e) => act('stop', at(e))}>
                  Stop
                </button>
              ) : (
                <button className="button primary" disabled={busy} onClick={(e) => act('start', at(e))}>
                  Start
                </button>
              )}
            </div>
            {error && <div className="error">{error}</div>}
            {service.threads.length > 0 && (
              <>
                {service.threads.map((id, i) => {
                  const thread = threads?.find((t) => t.id === id)
                  return (
                    <Fragment key={id}>
                      {i < 2 && <div className="panel-section">{i === 0 ? 'Responsible agent' : 'Also worked on it'}</div>}
                      <button className="channel linked-row" onClick={() => onOpen(id)} title={i === 0 ? 'The agent that last started, restarted or changed this service' : undefined}>
                        <Icon name="thread" size={14} />
                        <span className="channel-name">{thread ? plain(thread.name ?? '') : id}</span>
                      </button>
                    </Fragment>
                  )
                })}
              </>
            )}
          </>
        )}
        <div className="panel-section">History</div>
        {events?.length === 0 && <p className="panel-note">Nothing recorded yet.</p>}
        <ol className="history">
          {events?.map((e, i) => (
            <li key={i} className={e.kind === 'failed' || e.kind === 'crashed' ? 'bad' : ''}>
              <span className="num">{new Date(e.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
              <span>
                {EVENT_TEXT[e.kind] ?? e.kind}
                {e.unit !== unit ? ` (${short(e.unit)})` : ''}
                {e.detail ? <span className="muted"> · {e.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </Panel>
  )
}

// A thread's first prompt, when the channel isn't loaded that far back: one small request,
// a few at a time, asked for only once its card is near the screen.
const starters = new Map<string, Promise<Message | null>>()
const starterQueue: Array<() => void> = []
let starterSlots = 4
function fetchStarter(threadId: string, channelId: string) {
  let job = starters.get(threadId)
  if (!job) {
    job = new Promise<void>((go) => (starterSlots > 0 ? (starterSlots--, go()) : starterQueue.push(go)))
      .then(() => call<{ messages: Message[] }>(`/client/channels/${channelId}/messages?limit=1&before=${BigInt(threadId) + 1n}`))
      .then(
        (page) => page.messages.find((m) => m.id === threadId) ?? null,
        () => (starters.delete(threadId), null),
      )
      .finally(() => {
        const next = starterQueue.shift()
        if (next) next()
        else starterSlots++
      })
    starters.set(threadId, job)
  }
  return job
}
function useStarter(card: React.RefObject<HTMLElement | null>, threadId: string, loaded: Message | undefined, from: string | null) {
  const [fetched, setFetched] = useState<Message | null>(null)
  const wanted = !loaded && from
  useEffect(() => {
    const el = card.current
    if (!wanted || !el) return
    let live = true
    const load = () => void fetchStarter(threadId, wanted).then((m) => live && setFetched(m))
    if (typeof IntersectionObserver === 'undefined') return load()
    const near = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (near.disconnect(), load()), { rootMargin: '400px' })
    near.observe(el)
    return () => {
      live = false
      near.disconnect()
    }
  }, [card, threadId, wanted])
  return loaded ?? fetched ?? undefined
}

// The buttons of a mirrored question, as on the Overview: the answer goes without opening.
function ThreadAnswer({ session, onOpen }: { session: SessionSummary; onOpen: (id: string) => void }) {
  const [chose, setChose] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const ask = session.ask
  if (chose) return <span className="ov-line num">{chose}</span>
  if (!ask?.choices) return null
  const choose = async (customId: string, label: string) => {
    if (busy) return
    setBusy(true)
    setFailed(null)
    try {
      const result = await api.interaction({ type: 'button', customId, channelId: session.id, messageId: ask.messageId })
      if (result.type === 9) onOpen(session.id)
      else if (!result.acknowledged) setFailed("The bot didn't answer. Try again, or type your reply.")
      else setChose(`Chose ${label} · ${clock(new Date().toISOString())}`)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="action-row">
        {ask.choices.map((c) => (
          <button key={c.customId} className={`button${STYLE[c.style] ?? ''}${busy ? ' busy' : ''}`} disabled={busy} onClick={() => void choose(c.customId, c.label)}>
            {c.label}
          </button>
        ))}
      </div>
      {failed && <span className="ov-line error">{failed}</span>}
    </>
  )
}

const EDGES = ['busy', 'waiting', 'failed'] as const
const RANK: Partial<Record<SessionSummary['state'], number>> = { waiting: 0, failed: 1, busy: 2 }

// One thread as a card (on phones a row of one grouped list per section). Its left edge is the status: working, waiting for you, failed, or white
// for unread when nothing is active. The title is bright only when unread.
function ThreadCard({ thread, session, unread, starter, from, names, onOpen }: { thread: Channel; session?: SessionSummary; unread: boolean; starter?: Message; from: string | null; names: (text: string) => string; onOpen: (id: string) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const first = useStarter(root, thread.id, starter, from)
  const state = session?.state
  const edge = EDGES.find((e) => e === state) ?? (unread ? 'unread' : undefined)
  const raw = state === 'waiting' ? session?.ask?.text : state === 'failed' ? session?.error : state === 'busy' ? session?.lastStep : undefined
  const line = names(raw || first?.content || '').replace(/^(question|error):\s*/i, '')
  const run = state === 'busy' ? elapsedRun(session) : null
  const at = Number((BigInt(thread.last_message_id ?? thread.id) >> 22n) + 1420070400000n)
  const mark = [edge && edge !== 'unread' && MARKS[EDGES.indexOf(edge)], unread && 'Unread messages'].filter(Boolean).join(', ')
  return (
    <div ref={root} className="result thread-row panel-thread" data-thread={thread.id} data-edge={edge} data-unread={unread || undefined}>
      <button className="link-title thread-open" aria-description={mark || undefined} onClick={() => onOpen(thread.id)}>
        <b>{plain(thread.name ?? '')}</b>
      </button>
      {line && <span className="ov-line">{line}</span>}
      {session?.state === 'waiting' && <ThreadAnswer key={session.ask?.messageId} session={session} onOpen={onOpen} />}
      <span className="result-where">
        <span className="thread-count num">
          <Icon name="chat" size={14} />
          {thread.message_count ?? 0}
        </span>
        <span className="num">{since(new Date(run !== null ? Date.now() - run : at).toISOString())}</span>
      </span>
      <Icon name="chevron" size={20} className="thread-chevron" />
    </div>
  )
}

// Up and Down walk the cards, from the search field too; Enter on one opens it.
function threadKeys(e: React.KeyboardEvent<HTMLElement>) {
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
  const target = e.target as HTMLElement
  const panel = target.closest('.side-panel')
  const field = panel?.querySelector<HTMLElement>('.thread-search-tools .search input')
  const cards = [...(panel?.querySelectorAll<HTMLElement>('.thread-open') ?? [])]
  const at = cards.indexOf(target.closest('.panel-thread')?.querySelector<HTMLElement>('.thread-open') as HTMLElement)
  if (at < 0 && target !== field) return
  const next = at < 0 ? (e.key === 'ArrowDown' ? cards[0] : undefined) : (cards[at + (e.key === 'ArrowDown' ? 1 : -1)] ?? (e.key === 'ArrowUp' ? field : undefined))
  if (!next) return
  e.preventDefault()
  next.focus()
}

// The threads of a channel, newest activity first, like Discord's Threads popout.
export function ThreadsPanel({ channelId, onClose, onOpen, onCreate }: { channelId: string; onClose: () => void; onOpen: (id: string) => void; onCreate: () => void }) {
  const state = useStore((d) => d.state)
  const sessions = useStore((d) => d.sessions)
  const seen = useStore((d) => d.seen)
  const entry = useStore((d) => d.messages[channelId])
  const [query, setQuery] = useState('')
  // The same status filter as the channel list, kept for this channel's panel alone.
  const [mask, setMask] = useThreadFilter(state?.me.id ?? '', `panel:${channelId}`)
  // Ages and the run clock move on while the panel stays open.
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const channel = state?.channels.find((c) => c.id === channelId)
  // Threads start from a message in an agent's project channel, so that is where Create Thread goes.
  const creates = Boolean(state && channel && channel.type === 0 && machineOf(state, channel) && can(P.SEND_MESSAGES, channel) && can(P.CREATE_PUBLIC_THREADS, channel))
  const q = query.trim().toLowerCase()
  const unread = (t: Channel) => snowflakeGt(t.last_message_id, seen[t.id])
  const named = (state?.threads ?? []).filter((t) => t.parent_id === channelId && (!q || plain(t.name ?? '').toLowerCase().includes(q)))
  const threads = named
    .filter((t) => mask & markBit(sessions[t.id]?.state, unread(t)))
    .sort((a, b) => (BigInt(b.last_message_id ?? b.id) > BigInt(a.last_message_id ?? a.id) ? 1 : -1))
  const rank = (t: Channel) => RANK[sessions[t.id]?.state ?? 'idle'] ?? 3
  const open = threads.filter((t) => !t.thread_metadata?.archived).sort((a, b) => rank(a) - rank(b))
  const older = threads.filter((t) => t.thread_metadata?.archived)
  const names = (text: string) =>
    plain(
      text,
      (id) => {
        const user = state?.users.find((u) => u.id === id)
        return user ? displayName(user) : null
      },
      (id) => state?.channels.find((c) => c.id === id)?.name ?? null,
    )
  // A thread's first prompt is the channel message it was started from.
  const loaded = new Map<string, Message>()
  for (const m of entry?.list ?? []) loaded.set((m as Message & { thread?: { id: string } }).thread?.id ?? m.id, m)
  const from = entry?.loading || (entry && !entry.hasMore) ? null : channelId
  const desk = useDesk()
  const search = (
    <div className="thread-search-tools">
      <label className="search">
        <Icon name="search" size={18} />
        <input autoFocus={!window.matchMedia('(pointer: coarse)').matches} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search thread names" aria-label="Search thread names" />
      </label>
      <ThreadFilter mask={mask} change={setMask} />
    </div>
  )
  const row = (t: Channel) => <ThreadCard key={t.id} thread={t} session={sessions[t.id]} unread={unread(t)} starter={loaded.get(t.id)} from={from} names={names} onOpen={onOpen} />
  return (
    <Panel
      title="Threads"
      icon="threads"
      kind="threads"
      onClose={onClose}
      action={creates ? { label: 'Create Thread', icon: 'plus', run: onCreate } : undefined}
      anchor=".chat-header [aria-label='Threads']"
      extra={
        desk ? (
          <>
            <div className="panel-search" onKeyDown={threadKeys}>
              {search}
            </div>
            {creates && (
              <button className="button primary thread-create" onClick={onCreate}>
                Create
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {creates && !desk && (
        <button className="create-thread" onClick={onCreate}>
          <Icon name="threads" size={24} />
          <span>Create Thread</span>
          <Icon name="chevron" size={20} />
        </button>
      )}
      {!desk && (
        <div className="panel-search" onKeyDown={threadKeys}>
          {search}
        </div>
      )}
      <div className="panel-body" onKeyDown={threadKeys}>
        {threads.length === 0 &&
          (named.length > 0 ? (
            <div className="mark-empty" role="status">
              No matching threads. <button onClick={() => setMask(ALL_MARKS)}>Show all statuses</button>
            </div>
          ) : q ? (
            <Empty icon="search" title="No matching threads" />
          ) : (
            <Empty icon="threads" title="No threads yet">A message in{channel ? ` #${channel.name}` : ' this channel'} starts one.</Empty>
          ))}
        {open.length > 0 && (
          <div className="panel-section">
            Active <span className="num">{open.length}</span>
          </div>
        )}
        {open.length > 0 && <div className="thread-group">{open.map(row)}</div>}
        {older.length > 0 && (
          <div className="panel-section">
            Archived <span className="num">{older.length}</span>
          </div>
        )}
        {older.length > 0 && <div className="thread-group">{older.map(row)}</div>}
      </div>
    </Panel>
  )
}

// Who is in this workspace: people with their devices and where they are, each machine's bot.
export function MembersPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const state = useStore((d) => d.state)
  const typing = useStore((d) => d.typing[channelId])
  const machineName = useMachineName()
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  if (!state) return null
  const presence = state.presence ?? {}
  // A member's profile card, beside the list as Discord's; the row stays lit while it is open.
  const profile = (e: React.MouseEvent, key: string, of: ProfileOf) => {
    const row = e.currentTarget.getBoundingClientRect()
    const edge = e.currentTarget.closest('.side-panel')?.getBoundingClientRect().left ?? row.left
    setOpened(key)
    setSheet(profileSheet(of, { rect: new DOMRect(edge, row.top, row.right - edge, row.height), side: 'left' }, channelId))
  }
  const all = [...state.channels, ...state.threads]
  const where = (id: string | null) => {
    if (!id) return 'Overview'
    if (id === channelId) return 'here'
    const c = all.find((x) => x.id === id)
    return c ? (state.threads.some((t) => t.id === id) ? plain(c.name ?? '') : `#${c.name}`) : 'elsewhere'
  }
  const now = Date.now()
  const isTyping = (id: string) => (typing?.[id] ?? 0) > now
  const status = (id: string) => (id === state.me.id ? ownStatus(state) : (presence[id]?.status ?? 'offline'))
  const row = (u: (typeof state.users)[number]) => {
    const p = presence[u.id]
    const st = status(u.id)
    const notes: string[] = []
    if (u.pending) notes.push('Not joined yet')
    const custom = !u.bot && liveCustom(u.id === state.me.id ? state.user_status?.custom_status : p?.custom_status)
    if (custom && !isTyping(u.id)) notes.push(custom.text)
    if (u.bot && p?.activity && !p.machines?.length) notes.push(p.activity)
    if (isTyping(u.id)) notes.push(u.bot ? 'working here' : 'typing here')
    for (const d of p?.devices ?? []) notes.push(`${d.name}${d.visible ? '' : ' (away)'} · ${where(d.channel_id)}`)
    if (u.bot && p?.machines?.length) notes.push(p.machines.map((m) => `${machineName(m.machine)}${m.online ? '' : ' (offline)'}`).join(', '))
    return (
      <button key={u.id} className={`member${st === 'offline' || st === 'invisible' ? ' away' : ''}${opened === u.id ? ' open' : ''}`} onClick={(e) => profile(e, u.id, { user: u })}>
        <span className="member-avatar">
          <Avatar id={u.id} name={u.global_name ?? u.username} size="panel" version={u.avatar} />
          <i className={`presence ${st}`} aria-label={STATUS_TEXT[st]} />
        </span>
        <span className="member-name">
          <span className="member-line">
            <b><E>{u.global_name ?? u.username}</E></b>
            {u.bot && <span className="bot-tag">BOT</span>}
          </span>
          {notes.length > 0 && <span className="member-note">{notes[0]}{notes.length > 1 ? `, +${notes.length - 1}` : ''}</span>}
        </span>
      </button>
    )
  }
  // The shared bot shows as one member per machine, each with its own Discord picture.
  type Row = { key: string; user: (typeof state.users)[number]; machine?: { machine: string; online: boolean; activity?: string | null } }
  const rows: Row[] = state.users.flatMap((u) => {
    const machines = u.bot ? presence[u.id]?.machines : undefined
    return machines?.length ? machines.map((m) => ({ key: `${u.id}:${m.machine}`, user: u, machine: m })) : [{ key: u.id, user: u }]
  })
  const isOn = (r: Row) => (r.machine ? r.machine.online : !['offline', 'invisible'].includes(status(r.user.id)))
  const render = (r: Row) => {
    if (!r.machine) return row(r.user)
    const u = r.user
    return (
      <button key={r.key} className={`member${r.machine.online ? '' : ' away'}${opened === r.key ? ' open' : ''}`} onClick={(e) => profile(e, r.key, { user: u, machine: r.machine!.machine })}>
        <span className="member-avatar">
          <Avatar id={u.id} name={machineName(r.machine.machine)} size="panel" src={machineIcon(state.machine_icons, r.machine.machine, 'avatar')} />
          <i className={`presence ${r.machine.online ? 'online' : 'offline'}`} aria-label={r.machine.online ? 'online' : 'offline'} />
        </span>
        <span className="member-name">
          <span className="member-line">
            <b>{machineName(r.machine.machine)}</b>
            <span className="bot-tag">BOT</span>
          </span>
          {isTyping(u.id) ? <span className="member-note">working here</span> : r.machine.activity && <span className="member-note">{r.machine.activity}</span>}
        </span>
      </button>
    )
  }
  const online = rows.filter(isOn)
  const offline = rows.filter((r) => !isOn(r))
  return (
    <Panel title="Members" icon="members" kind="members" onClose={onClose}>
      <div className="panel-body">
        <div className="panel-section">
          Online <span className="num">{online.length}</span>
        </div>
        {online.map(render)}
        {offline.length > 0 && (
          <>
            <div className="panel-section">
              Offline <span className="num">{offline.length}</span>
            </div>
            {offline.map(render)}
          </>
        )}
      </div>
      {sheet && <Sheet spec={sheet} onClose={() => (setSheet(null), setOpened(null))} />}
    </Panel>
  )
}
