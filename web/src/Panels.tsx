// Side panels beside the thread (docked on desktop, full screen on phones):
// message search and a channel's pins. Plus the mentions inbox view.

import { isMac } from './columns.ts'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Sheet, type SheetSpec } from './Sheet.tsx'
import { startAuthentication } from '@simplewebauthn/browser'
import { api, type HubRequest, type FoundChannel, type LinkKind, type Mention, type Message, type SearchResult, type Service, type ServiceEvent } from './api.ts'
import { Avatar, machineIcon } from './Avatar.tsx'
import { Icon, type IconName } from './icons.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { store, useStore } from './store.ts'
import { can, P } from './perms.ts'
import { clock, plain, machineLabel } from './text.ts'
import { approveInApp, native } from './native.ts'

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
function Snippet({ text }: { text: string }) {
  // Markdown syntax around the hits is noise in a one-line result.
  const parts = text
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

// Side panel shell: icon and title like Discord's popouts, a count only when there's something.
function Panel({ title, icon, count, children, onClose, extra }: { title: ReactNode; icon?: IconName; count?: number; children: ReactNode; onClose: () => void; extra?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.sheet-layer, .overlay')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <aside className="side-panel" role="complementary">
      <header className="panel-head">
        <button className="icon-button panel-back" onClick={onClose} aria-label="Close panel">
          <Icon name="back" size={22} />
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
              <Avatar id={r.message.author.id} name={r.message.author.global_name ?? r.message.author.username} size="inline" />
              <b>{r.message.author.global_name ?? r.message.author.username}</b>
              <span className="num">{when(r.message.timestamp)}</span>
            </span>
            <Snippet text={r.snippet ?? plain(r.message.content).slice(0, 200)} />
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
    <Panel title="Pinned messages" icon="pin" count={pins?.length} onClose={onClose}>
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
function useMentions(guildId?: string) {
  const [mentions, setMentions] = useState<Mention[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seen = useStore((d) => d.seen)
  useEffect(() => {
    api.inbox().then((r) => setMentions(r.mentions), (e: Error) => setError(e.message))
  }, [])
  const unread = (m: Mention) => !m.read && !(seen[m.channel.id] && (seen[m.channel.id]!.length > m.message.id.length || (seen[m.channel.id]!.length === m.message.id.length && seen[m.channel.id]! >= m.message.id)))
  const list = guildId ? mentions?.filter((m) => store.guildOf(m.channel.id) === guildId) : mentions
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
      <span className="ov-line">{plain(m.message.content, name).slice(0, 200) || 'Attachment or components'}</span>
    </button>
  )
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
        <div className="ov">
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
  const needs = Object.values(sessions)
    .filter((s) => s.state === 'waiting' || s.state === 'failed')
    .sort((a, b) => b.since.localeCompare(a.since))
  const unreadCount = list?.filter(unread).length ?? 0
  // Agents' requests: pending first, then what was decided in the last 15 minutes.
  const allRequests = useStore((d) => d.requests)
  const now = Date.now()
  const requests = allRequests.filter((r) => (r.status === 'pending' && r.expires_at > now) || (r.decided_at ?? 0) > now - 15 * 60_000)
  const pendingCount = requests.filter((r) => r.status === 'pending').length
  return (
    <Panel
      title="Inbox"
      icon="bell"
      count={pendingCount + needs.length + unreadCount}
      onClose={onClose}
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
              {[s.project && `#${s.project}`, s.machine].filter(Boolean).join(' · ')}
              {s.ask?.text ? ` · ${plain(s.ask.text).slice(0, 80)}` : s.error ? ` · ${s.error}` : ''}
            </span>
          </button>
        ))}
        {(list?.length ?? 0) > 0 && (
          <div className="panel-section">
            Mentions <span className="num">{list!.length}</span>
          </div>
        )}
        {list?.map((m) => <MentionRow key={m.message.id} m={m} unread={unread(m)} onJump={onJump} showServer />)}
        {requests.length === 0 && needs.length === 0 && list?.length === 0 && <Empty icon="bell" title="You're all caught up">Mentions and sessions waiting on you, from every server, show here.</Empty>}
      </div>
    </Panel>
  )
}

// One change an agent asked for. The summary is shown verbatim (it says when a role can
// give a shell); approving takes a fresh passkey on this device.
const DECIDED: Record<HubRequest['status'], string> = { pending: '', approved: 'Approved', denied: 'Denied', failed: 'Failed', expired: 'Expired' }
function RequestCard({ request }: { request: HubRequest }) {
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }
  const pending = request.status === 'pending'
  const failure = request.status !== 'failed' ? null : typeof request.result === 'string' ? request.result : ((request.result as { error?: string } | null)?.error ?? null)
  return (
    <div className={`request-card ${request.status}`}>
      <div className="request-summary">{request.summary}</div>
      {request.reason && <div className="request-reason">{request.reason}</div>}
      <div className="request-meta">
        from {request.origin}
        {pending ? ` · expires ${clock(new Date(request.expires_at).toISOString())}` : ` · ${DECIDED[request.status]}${failure ? `: ${failure}` : ''}`}
      </div>
      {error && <div className="error">{error}</div>}
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
                <span className="result-where">{[project && `#${project}`, session?.machine].filter(Boolean).join(' · ')}</span>
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

// The threads of a channel, newest activity first, like Discord's Threads popout.
export function ThreadsPanel({ channelId, onClose, onOpen }: { channelId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const state = useStore((d) => d.state)
  const sessions = useStore((d) => d.sessions)
  const [query, setQuery] = useState('')
  const channel = state?.channels.find((c) => c.id === channelId)
  const q = query.trim().toLowerCase()
  const threads = (state?.threads ?? [])
    .filter((t) => t.parent_id === channelId && (!q || plain(t.name ?? '').toLowerCase().includes(q)))
    .sort((a, b) => (BigInt(b.last_message_id ?? b.id) > BigInt(a.last_message_id ?? a.id) ? 1 : -1))
  const open = threads.filter((t) => !t.thread_metadata?.archived)
  const older = threads.filter((t) => t.thread_metadata?.archived)
  const row = (t: (typeof threads)[number]) => {
    const session = sessions[t.id]
    const at = t.last_message_id ?? t.id
    return (
      <button key={t.id} className="result thread-row" onClick={() => onOpen(t.id)}>
        <span className="link-title">
          <i className={`st ${session?.state ?? 'idle'}`} />
          <b>{plain(t.name ?? '')}</b>
        </span>
        <span className="result-where">
          {session?.lastStep ?? (t.message_count ? `${t.message_count} ${t.message_count === 1 ? 'message' : 'messages'}` : 'No messages yet')}
          <span className="num"> · {since(new Date(Number((BigInt(at) >> 22n) + 1420070400000n)).toISOString())}</span>
        </span>
      </button>
    )
  }
  return (
    <Panel title="Threads" icon="threads" onClose={onClose}>
      <div className="panel-search">
        <label className="search">
          <Icon name="search" size={18} />
          <input autoFocus={!window.matchMedia('(pointer: coarse)').matches} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search thread names" aria-label="Search thread names" />
        </label>
      </div>
      <div className="panel-body">
        {threads.length === 0 && (q ? <Empty icon="search" title="No matching threads" /> : <Empty icon="threads" title="No threads yet">A message in{channel ? ` #${channel.name}` : ' this channel'} starts one.</Empty>)}
        {open.length > 0 && (
          <div className="panel-section">
            Active <span className="num">{open.length}</span>
          </div>
        )}
        {open.map(row)}
        {older.length > 0 && (
          <div className="panel-section">
            Archived <span className="num">{older.length}</span>
          </div>
        )}
        {older.map(row)}
      </div>
    </Panel>
  )
}

// Who is in this workspace: people with their devices and where they are, each machine's bot.
export function MembersPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const state = useStore((d) => d.state)
  const typing = useStore((d) => d.typing[channelId])
  if (!state) return null
  const presence = state.presence ?? {}
  const all = [...state.channels, ...state.threads]
  const where = (id: string | null) => {
    if (!id) return 'Overview'
    if (id === channelId) return 'here'
    const c = all.find((x) => x.id === id)
    return c ? (state.threads.some((t) => t.id === id) ? plain(c.name ?? '') : `#${c.name}`) : 'elsewhere'
  }
  const now = Date.now()
  const isTyping = (id: string) => (typing?.[id] ?? 0) > now
  const status = (id: string) => presence[id]?.status ?? (id === state.me.id ? 'online' : 'offline')
  const row = (u: (typeof state.users)[number]) => {
    const p = presence[u.id]
    const st = status(u.id)
    const notes: string[] = []
    if (isTyping(u.id)) notes.push(u.bot ? 'working here' : 'typing here')
    for (const d of p?.devices ?? []) notes.push(`${d.name}${d.visible ? '' : ' (away)'} · ${where(d.channel_id)}`)
    if (u.bot && p?.machines?.length) notes.push(p.machines.map((m) => `${m.machine}${m.online ? '' : ' (offline)'}`).join(', '))
    return (
      <div key={u.id} className={`member${st === 'offline' ? ' away' : ''}`}>
        <span className="member-avatar">
          <Avatar id={u.id} name={u.global_name ?? u.username} size="panel" version={u.avatar} />
          <i className={`presence ${st}`} aria-label={st} />
        </span>
        <span className="member-name">
          <span className="member-line">
            <b>{u.global_name ?? u.username}</b>
            {u.bot && <span className="bot-tag">BOT</span>}
          </span>
          {notes.length > 0 && <span className="member-note">{notes[0]}{notes.length > 1 ? `, +${notes.length - 1}` : ''}</span>}
        </span>
      </div>
    )
  }
  // The shared bot shows as one member per machine, each with its own Discord picture.
  type Row = { key: string; user: (typeof state.users)[number]; machine?: { machine: string; online: boolean } }
  const rows: Row[] = state.users.flatMap((u) => {
    const machines = u.bot ? presence[u.id]?.machines : undefined
    return machines?.length ? machines.map((m) => ({ key: `${u.id}:${m.machine}`, user: u, machine: m })) : [{ key: u.id, user: u }]
  })
  const isOn = (r: Row) => (r.machine ? r.machine.online : status(r.user.id) !== 'offline')
  const render = (r: Row) => {
    if (!r.machine) return row(r.user)
    const u = r.user
    return (
      <div key={r.key} className={`member${r.machine.online ? '' : ' away'}`}>
        <span className="member-avatar">
          <Avatar id={u.id} name={r.machine.machine} size="panel" src={machineIcon(state.machine_icons, r.machine.machine, 'avatar')} />
          <i className={`presence ${r.machine.online ? 'online' : 'offline'}`} aria-label={r.machine.online ? 'online' : 'offline'} />
        </span>
        <span className="member-name">
          <span className="member-line">
            <b>{machineLabel(r.machine.machine)}</b>
            <span className="bot-tag">BOT</span>
          </span>
          {isTyping(u.id) && <span className="member-note">working here</span>}
        </span>
      </div>
    )
  }
  const online = rows.filter(isOn)
  const offline = rows.filter((r) => !isOn(r))
  return (
    <Panel title="Members" icon="members" onClose={onClose}>
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
    </Panel>
  )
}
