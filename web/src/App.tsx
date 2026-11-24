// App shell: passkey gate, channel list with sessions hung under projects,
// message pane. On phones the list is a full screen and a thread pushes over it.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ago } from './SettingsKit.tsx'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { api, connectEvents, type Channel, type Guild, type HubState, type LinkKind, type SessionSummary } from './api.ts'
import { Avatar, machineIcon } from './Avatar.tsx'
import { Chat } from './Chat.tsx'
import { Overview } from './Overview.tsx'
import { SettingsHost } from './Settings.tsx'
import { can, P } from './perms.ts'
import { Inbox, InboxPanel, LinksPanel, MembersPanel, PinsPanel, SearchPanel, ServicesPanel, ThreadsPanel } from './Panels.tsx'
import { below, Sheet, sessionActions, usePress, type SheetSpec } from './Sheet.tsx'
import type { MarkdownContext } from './markdown.tsx'
import { ModalDialog, type OpenModal } from './Modal.tsx'
import { snowflakeGt, store, useStore } from './store.ts'
import { bellSheet, useFocusReporting, useNotificationClicks } from './notify.ts'
import { native, shareOrigin } from './native.ts'
import { NativeLogin } from './NativeLogin.tsx'
import { loginError } from './login.ts'
import { Tooltips } from './Tooltip.tsx'
import { WorkspacePanel } from './Workspace.tsx'
import { LoadingMark } from './components.tsx'
import { initColumns, keys, startResize, toggleColumn, useColumnKeys, useColumns, type ColumnId } from './columns.ts'

initColumns()
import { Icon } from './icons.tsx'
import { plain, machineLabel } from './text.ts'

const LIVE_THREADS = 5

export function applyAccent(accent: string | null) {
  if (accent === 'pink') document.documentElement.dataset['accent'] = 'pink'
  else delete document.documentElement.dataset['accent']
}
applyAccent(localStorage.getItem('accent'))

// A pairing link (#pair=CODE) opens straight onto creating this device's passkey. The
// fragment is read once and cleared so the code never stays in the address bar or history.
const PAIR_CODE = (() => {
  const code = /^#pair=([A-Z0-9]{10})$/.exec(location.hash)?.[1] ?? null
  if (/^#pair=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search)
  return code
})()

function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState(PAIR_CODE ?? '')
  const [pairing, setPairing] = useState(PAIR_CODE !== null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ on: 'signin' | 'pair'; text: string } | null>(null)
  const run = async (on: 'signin' | 'pair', fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onDone()
    } catch (e) {
      setError({ on, text: loginError(e) })
    } finally {
      setBusy(false)
    }
  }
  if (native) return <NativeLogin onDone={onDone} />
  const pairError = error?.on === 'pair' ? error.text : null
  return (
    <div className="login">
      <div className="login-card">
        <div className="login-head">
          <h1>{pairing ? 'Pair this device' : 'Vocorum'}</h1>
          <p>{pairing ? 'Create a passkey on this device to finish.' : "Sign in with this device's passkey."}</p>
        </div>
        {!pairing && (
          <>
            <button
              className="button primary wide"
              disabled={busy}
              onClick={() =>
                void run('signin', async () => {
                  const { challengeId, options } = await api.loginOptions()
                  await api.login(challengeId, await startAuthentication({ optionsJSON: options }))
                })
              }
            >
              Sign in with passkey
            </button>
            {error?.on === 'signin' && <p className="login-error" role="alert">{error.text}</p>}
            <div className="login-divider">
              <span>New device</span>
            </div>
          </>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run('pair', async () => {
              const { challengeId, options } = await api.registerOptions(code)
              await api.register(challengeId, await startRegistration({ optionsJSON: options }))
            })
          }}
        >
          <label className={`login-label${pairError ? ' bad' : ''}`} htmlFor="pairing-code">
            Pairing code
            {pairError && <span role="alert"> · {pairError}</span>}
          </label>
          <input id="pairing-code" className="code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} />
          <button className={`button wide${pairing ? ' primary' : ''}`} disabled={busy || code.trim().length < 6} autoFocus={pairing}>
            {pairing ? 'Create passkey' : 'Pair this device'}
          </button>
        </form>
        {pairing ? (
          <button className="link-button login-help" onClick={() => setPairing(false)}>
            This device already has a passkey? Sign in
          </button>
        ) : (
          <p className="login-help">
            No code? On the hub machine, run <code>vocorum pair &lt;device&gt;</code>
          </p>
        )}
      </div>
    </div>
  )
}

function useRoute(): [string | null, (id: string) => void] {
  const read = () => (location.hash === '#/overview' ? 'overview' : location.hash === '#/inbox' ? 'inbox' : (/^#\/c\/(\d+)/.exec(location.hash)?.[1] ?? null))
  const [id, setId] = useState(read)
  useEffect(() => {
    const onHash = () => setId(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return [id, (next) => (location.hash = next === 'overview' || next === 'inbox' ? `#/${next}` : `#/c/${next}`)]
}

// The thread tree: one continuous trunk from under the project to the last elbow.
function Tree({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const last = el.lastElementChild as HTMLElement | null
      setHeight(last ? last.offsetTop + last.offsetHeight / 2 - 4 : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  })
  return (
    <div className="tree">
      <i className="trunk" style={{ height }} />
      <div ref={ref}>{children}</div>
    </div>
  )
}

function UserPanel({ state }: { state: HubState }) {
  const [open, setOpen] = useState(false)
  const [accent, setAccent] = useState(localStorage.getItem('accent') ?? 'cyan')
  const me = state.users.find((u) => u.id === state.me.id)
  const name = me?.global_name ?? me?.username ?? 'You'
  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  const pick = (value: string) => {
    setAccent(value)
    localStorage.setItem('accent', value)
    applyAccent(value)
  }
  return (
    <div className="user-panel">
      <button className="user-panel-me" onClick={() => (setOpen(!open), setAccent(localStorage.getItem('accent') ?? 'cyan'))} aria-expanded={open} aria-label="Settings" title="Settings">
        <span className="member-avatar">
          <Avatar id={state.me.id} name={name} size="panel" version={me?.avatar} />
          <SystemLight />
        </span>
        <span className="user-panel-name">
          {name}
          <small>{state.device.name}</small>
        </span>
      </button>
      <InboxButton />
      <ServicesButton />
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-label">Accent colour</div>
          <button className={`menu-item${accent !== 'pink' ? ' on' : ''}`} onClick={() => pick('cyan')}>
            <i className="swatch" style={{ background: 'var(--cyan)' }} /> Cyber cyan
          </button>
          <button className={`menu-item${accent === 'pink' ? ' on' : ''}`} onClick={() => pick('pink')}>
            <i className="swatch" style={{ background: 'var(--pink)' }} /> Hyper pink
          </button>
          <button className="menu-item" onClick={() => (setOpen(false), sessionActions.settings?.())}>
            <Icon name="gear" size={18} /> User settings
          </button>
          <button className="menu-item red" onClick={() => void api.logout().then(() => location.reload())}>
            <Icon name="signout" size={18} /> Sign out
          </button>
        </div>
      )}
      <SettingsHost />
    </div>
  )
}

const NO_MACHINES: never[] = []

// The system light is connectivity: green when this device reaches the hub and every
// machine is up, amber when a machine is offline, red when the hub can't be reached.
// Services show on their own button. Hover or focus shows the detail.
function SystemLight() {
  const online = useStore((d) => d.online)
  // Machine and service health are the hub owner's; others see the hub and this device.
  const machines = useStore((d) => (d.state?.hub_owner === false ? NO_MACHINES : d.machines))
  const push = useStore((d) => d.state?.notifications?.push_subscribed)
  const icons = useStore((d) => d.state?.machine_icons)
  // Connectivity only: the hub and the machines. Services have their own button.
  const down = machines.filter((m) => m.online === false)
  const level = !online ? 'red' : down.length ? 'amber' : 'green'
  const headline = !online ? 'Can’t reach the hub, retrying' : down.length ? `${down.map((m) => machineLabel(m.name)).join(', ')} offline` : 'Connected'
  return (
    <span className={`system-light ${level}`} tabIndex={0} role="status" aria-label={headline}>
      <i />
      <span className="system-pop" role="tooltip">
        <b>{headline}</b>
        <span className="sys-row">
          <i className={online ? 'ok' : 'bad'} />
          Hub {online ? 'connected' : 'disconnected'}
        </span>
        {machines.map((m) => (
          <span key={m.name} className="sys-row">
            <i className={m.online === false ? 'bad' : m.online ? 'ok' : 'idle'} />
            {machineIcon(icons, m.name, 'avatar') && <img className="sys-icon" src={machineIcon(icons, m.name, 'avatar')!} alt="" />}
            {machineLabel(m.name)} {m.online === false ? 'offline' : m.online ? 'online' : 'unknown'}
            {m.running + m.waiting > 0 && <span className="num muted"> · {m.running} running, {m.waiting} waiting</span>}
          </span>
        ))}
        <span className="sys-row">
          <i className={push ? 'ok' : 'idle'} />
          Notifications {push ? 'on' : 'off'} on this device
        </span>
      </span>
    </span>
  )
}

// The inbox bell: everything waiting on you across every server, as one count.
function InboxButton() {
  const mentions = useStore((d) => Object.values(d.mentions).reduce((a, b) => a + b, 0))
  const waiting = useStore((d) => Object.values(d.sessions).filter((s) => s.state === 'waiting' || s.state === 'failed').length)
  const requests = useStore((d) => d.requests.filter((r) => r.status === 'pending' && r.expires_at > Date.now()).length)
  const count = mentions + waiting + requests
  return (
    <button className={`icon-button inbox-button${count ? ' with-count' : ''}`} onClick={() => sessionActions.inbox?.()} aria-label={count ? `Inbox: ${count}` : 'Inbox'} title="Inbox">
      <Icon name="bell" />
      {count > 0 && <span className="num">{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

// Services on the hub machine: a count of what runs, red when something failed.
function ServicesButton() {
  const services = useStore((d) => d.services)
  if (!services?.length) return null
  const failed = services.filter((s) => s.status === 'failed' || s.status === 'restarting').length
  return (
    <button className={`icon-button services-button${failed ? ' bad' : ''}`} onClick={() => sessionActions.services?.()} aria-label={failed ? `Services: ${failed} failed` : 'Services'} title="Services">
      <Icon name="server" />
      {failed > 0 && <span className="num">{failed}</span>}
    </button>
  )
}

// Phones: swipe right on a thread to pull the session list back over it, like iOS back.
function useSwipeBack(enabled: boolean, onOpen: () => void) {
  useEffect(() => {
    if (!enabled || !window.matchMedia('(max-width: 767px)').matches) return
    let start: { x: number; y: number; t: number } | null = null
    let dragging = false
    let dx = 0
    const nav = () => document.querySelector<HTMLElement>('.sidebar')
    const page = () => document.querySelector<HTMLElement>('main > .chat, .app > .chat, section.chat')
    const skip = (el: EventTarget | null) => el instanceof Element && Boolean(el.closest('.codeblock, pre, .sheet-layer, .side-panel, input, textarea, .composer, [data-swipe="off"]'))
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || skip(e.target)) return
      start = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, t: Date.now() }
      dragging = false
      dx = 0
    }
    const move = (e: TouchEvent) => {
      if (!start) return
      const x = e.touches[0]!.clientX - start.x
      const y = e.touches[0]!.clientY - start.y
      if (!dragging) {
        if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) return void (start = null)
        if (x < 12 || Math.abs(x) < Math.abs(y) * 1.5) return
        dragging = true
      }
      dx = Math.max(0, x)
      const el = nav()
      const top = page()
      if (el && top) {
        // iOS back: the thread slides off to the right, the list comes up from underneath.
        el.style.transition = top.style.transition = 'none'
        el.style.zIndex = '0'
        el.style.transform = `translateX(${(dx / window.innerWidth - 1) * 30}%)`
        el.style.filter = `brightness(${0.55 + 0.45 * Math.min(1, dx / window.innerWidth)})`
        top.style.transform = `translateX(${dx}px)`
        top.classList.add('swiping')
      }
      e.preventDefault()
    }
    const up = () => {
      const el = nav()
      const top = page()
      if (dragging && el && top) {
        const speed = dx / Math.max(1, Date.now() - start!.t)
        const done = dx > window.innerWidth * 0.3 || speed > 0.5
        top.style.transition = 'transform var(--move) var(--ease-out)'
        top.style.transform = done ? 'translateX(100%)' : ''
        el.style.transition = ''
        el.style.transform = done ? 'translateX(0)' : ''
        window.setTimeout(() => {
          el.style.zIndex = el.style.transform = el.style.filter = top.style.transform = top.style.transition = ''
          top.classList.remove('swiping')
          if (done) onOpen()
        }, done ? 220 : 240)
      }
      start = null
      dragging = false
    }
    document.addEventListener('touchstart', down, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', up)
    document.addEventListener('touchcancel', up)
    return () => {
      document.removeEventListener('touchstart', down)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', up)
      document.removeEventListener('touchcancel', up)
    }
  }, [enabled, onOpen])
}

function elapsed(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  return m < 1 ? '' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

function ThreadRow({ thread, title, current, unread, session, favourite, mentions, onOpen, onSheet }: { thread: Channel; title: string; current: boolean; unread: boolean; session?: SessionSummary; favourite: boolean; mentions: number; onOpen: (id: string) => void; onSheet: (spec: SheetSpec) => void }) {
  const state = session?.state
  const manage = can(P.MANAGE_THREADS, thread) || thread.owner_id === store.data.state?.me.id
  const press = usePress((at) => {
    onSheet({
      at,
      title,
      subtitle: [session?.project, session?.machine, state && state !== 'idle' ? STATE_LABEL[state] : null].filter(Boolean).join(' · '),
      badge: <i className={`st ${state ?? 'idle'}`} />,
      groups: [
        [{ label: 'Mark as read', icon: 'eye', run: () => store.markSeen(thread.id) }],
        [{ label: favourite ? 'Remove from favourites' : 'Add to favourites', icon: 'star', run: () => void store.toggleFavourite(thread.id) }],
        [store.isOutput(thread) ? { label: 'Show as conversation', icon: 'chat', run: () => void store.setOutput(thread, false) } : { label: 'Show as output feed', icon: 'feed', run: () => void store.setOutput(thread, true) }],
        [
          ...(manage ? [{ label: 'Rename', icon: 'pencil' as const, run: () => sessionActions.rename?.(thread.id) }] : []),
          { label: 'Copy link', icon: 'link', run: () => void navigator.clipboard?.writeText(`${shareOrigin()}/#/c/${thread.id}`) },
          { label: 'Edit thread', icon: 'gear', run: () => sessionActions.channelSettings?.(thread.id) },
          { label: 'Copy ID', icon: 'hash', run: () => void navigator.clipboard?.writeText(thread.id) },
          ...(manage ? [{ label: thread.thread_metadata?.archived ? 'Unarchive' : 'Archive', icon: (thread.thread_metadata?.archived ? 'unarchive' : 'archive') as 'archive', run: () => void api.patchThread(thread.id, { archived: !thread.thread_metadata?.archived }) }] : []),
        ],
        state === 'busy' && store.commandsFor(thread.id).some((c) => c.name === 'abort') ? [{ label: 'Stop the run', icon: 'stop', red: true, run: () => void api.command(thread.id, 'abort', []) }] : [],
      ],
    })
  })
  return (
    <button className={`channel${current ? ' active' : ''}${unread ? ' unread' : ''}${thread.thread_metadata?.archived ? ' dim' : ''}`} onClick={() => onOpen(thread.id)} {...press}>
      <span className="channel-name">{title}</span>
      {state === 'busy' && session && elapsed(session.since) && <span className="meta">{elapsed(session.since)}</span>}
      {mentions > 0 && <span className="badge num" aria-label={`${mentions} mentions`}>{mentions}</span>}
      {state && state !== 'idle' && state !== 'done' && <i className={`st ${state}`} aria-label={STATE_LABEL[state]} />}
    </button>
  )
}

export const LINK_LABEL: Record<LinkKind, string> = { liaison: 'liaison', parent: 'started this', spawned: 'started here', mentions: 'mentioned here', mentioned: 'mentions this' }
const LINKED_ROWS = 4
const SHORT_KIND: Record<LinkKind, string> = { liaison: 'liaison', parent: 'parent', spawned: 'child', mentions: '', mentioned: '' }

// The open thread's linked sessions, nested under its row: a quick hop between liaising agents.
function LinkedRows({ threadId, title, onOpen }: { threadId: string; title: (t: Channel) => string; onOpen: (id: string) => void }) {
  const links = useStore((d) => d.linked[threadId])
  const threads = useStore((d) => d.state?.threads)
  const sessions = useStore((d) => d.sessions)
  useEffect(() => {
    void store.loadLinks(threadId).catch(() => {})
  }, [threadId])
  if (!links?.length) return null
  const shown = links.slice(0, LINKED_ROWS)
  return (
    <div className="linked" aria-label="Linked sessions">
      {shown.map((link) => {
        const thread = threads?.find((t) => t.id === link.id)
        const state = sessions[link.id]?.state
        return (
          <button key={link.id} className="channel linked-row" onClick={() => onOpen(link.id)} title={LINK_LABEL[link.kind]}>
            <Icon name="link" size={14} />
            <span className="channel-name">{thread ? title(thread) : 'A thread not on this hub'}</span>
            {state && state !== 'idle' && state !== 'done' ? <i className={`st ${state}`} aria-label={STATE_LABEL[state]} /> : <span className="meta">{SHORT_KIND[link.kind]}</span>}
          </button>
        )
      })}
      {links.length > LINKED_ROWS && (
        <button className="channel linked-row more-links" onClick={() => sessionActions.links?.(threadId)}>
          <span className="channel-name">{links.length - LINKED_ROWS} more linked</span>
        </button>
      )}
    </div>
  )
}

const STATE_LABEL: Record<string, string> = { waiting: 'waiting for you', failed: 'failed', busy: 'working', done: 'done', idle: 'idle' }


function ProjectRow({ channel, current, unread, threads, mentions, onOpen, onSheet }: { channel: Channel; current: boolean; unread: boolean; threads: Channel[]; mentions: number; onOpen: (id: string) => void; onSheet: (spec: SheetSpec) => void }) {
  const press = usePress((at) =>
    onSheet({
      at,
      title: `#${channel.name}`,
      subtitle: channel.topic ?? undefined,
      groups: [
        [{ label: 'Mark all as read', icon: 'eye', run: () => store.markAllSeen([channel.id, ...threads.map((t) => t.id)]) }],
        [store.isOutput(channel) ? { label: 'Show as conversation', icon: 'chat', run: () => void store.setOutput(channel, false) } : { label: 'Show as output feed', icon: 'feed', run: () => void store.setOutput(channel, true) }],
        [{ label: 'Edit channel', icon: 'gear', run: () => sessionActions.channelSettings?.(channel.id) }],
        [{ label: 'Copy ID', icon: 'hash', run: () => void navigator.clipboard?.writeText(channel.id) }],
      ],
    }),
  )
  return (
    <button className={`channel${current ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={() => onOpen(channel.id)} {...press}>
      <span className="hash">#</span>
      <span className="channel-name">{channel.name}</span>
      {mentions > 0 && <span className="badge num" aria-label={`${mentions} mentions`}>{mentions}</span>}
      {can(P.MANAGE_CHANNELS, channel) && <span
        className="row-gear"
        role="button"
        tabIndex={-1}
        aria-label="Edit channel"
        title="Edit channel"
        onClick={(e) => {
          e.stopPropagation()
          sessionActions.channelSettings?.(channel.id)
        }}
      >
        <Icon name="gear" size={16} />
      </span>}
    </button>
  )
}

// The draggable right edge of a column: invisible until hovered, a hairline while dragging.
function ColumnHandle({ id, label }: { id: ColumnId; label: string }) {
  const columns = useColumns()
  const collapsed = columns[id].collapsed
  return (
    <div
      className={`col-handle col-${id}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label}: drag to resize, double click to ${collapsed ? 'open' : 'fold'}`}
      title={`${collapsed ? 'Open' : 'Fold'} the ${label.toLowerCase()} (${keys(id === 'rail')}), or drag`}
      onPointerDown={(e) => startResize(id, e)}
      onDoubleClick={() => toggleColumn(id)}
    />
  )
}

function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}&\s]/gu, ' ').split(/\s+/).filter(Boolean)
  // Discord's rule: the first letter of each word, so one word gives one letter.
  return (words.length ? words.slice(0, 3).map((w) => [...w][0]) : ['?']).join('').toUpperCase()
}

// Servers down the left, like Discord: initials, a white pip for unread, red for mentions.
function GuildRail({ guilds, current, onGuild }: { guilds: Guild[]; current: string; onGuild: (id: string) => void }) {
  const state = useStore((d) => d.state)!
  const seen = useStore((d) => d.seen)
  const mentions = useStore((d) => d.mentions)
  const all = [...state.channels, ...state.threads]
  return (
    <div className="rail" role="navigation" aria-label="Servers">
      {guilds.map((g) => {
        const mine = all.filter((c) => (c.guild_id ?? state.guild.id) === g.id)
        const unread = g.id !== current && mine.some((c) => snowflakeGt(c.last_message_id, seen[c.id]))
        const count = mine.reduce((sum, c) => sum + (mentions[c.id] ?? 0), 0)
        return (
          <button key={g.id} className={`rail-item${g.id === current ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={() => onGuild(g.id)} title={g.name} aria-label={`${g.name}${count ? `, ${count} mentions` : ''}`} aria-current={g.id === current}>
            <i className="rail-pip" />
            <span className={`rail-guild${g.icon ? ' has-icon' : ''}`}>{g.icon ? <img src={`/client/guild-icons/${g.id}?v=${g.icon}`} alt="" /> : initials(g.name)}</span>
            {count > 0 && <span className="rail-badge num">{count > 99 ? '99+' : count}</span>}
          </button>
        )
      })}
    </div>
  )
}

// Hovering "N older" previews those threads, as Discord's "More Active Threads" popout does,
// with See all opening the channel's Threads panel. Pointer devices only.
const snowflakeTime = (id: string | null | undefined) => (id ? Number((BigInt(id) >> 22n) + 1420070400000n) : 0)
function OlderThreads({ threads, onOpen, onSeeAll, children }: { threads: Channel[]; onOpen: (id: string) => void; onSeeAll?: () => void; children: ReactNode }) {
  const [at, setAt] = useState<DOMRect | null>(null)
  const timer = useRef(0)
  const wrap = useRef<HTMLDivElement>(null)
  const enter = () => {
    if (!threads.length || !window.matchMedia('(hover: hover)').matches) return
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAt(wrap.current!.getBoundingClientRect()), at ? 0 : 300)
  }
  const leave = () => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAt(null), 150)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const list = [...threads].sort((a, b) => snowflakeTime(b.last_message_id ?? b.id) - snowflakeTime(a.last_message_id ?? a.id)).slice(0, 8)
  return (
    <div ref={wrap} onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {at &&
        createPortal(
          <div className="threads-popout" role="dialog" aria-label="More threads" style={{ left: at.right + 8, top: Math.min(at.top - 8, window.innerHeight - 64 - list.length * 40) }} onMouseEnter={enter} onMouseLeave={leave}>
            <div className="threads-popout-title">More threads</div>
            {list.map((t) => (
              <button key={t.id} className="threads-popout-row" onClick={() => { setAt(null); onOpen(t.id) }}>
                <Icon name="thread" size={16} />
                <span className="threads-popout-name">{plain(t.name ?? '')}</span>
                <span className="threads-popout-age num">{ago(snowflakeTime(t.last_message_id ?? t.id))}</span>
              </button>
            ))}
            {onSeeAll && (
              <button className="threads-popout-all" onClick={() => { setAt(null); onSeeAll() }}>
                See all
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

// Discord's "NEW MENTIONS" (top, red) and "NEW UNREADS" (bottom) pills: shown while a
// mentioned or unread row is scrolled out of the channel list; a click brings it into view.
function ListPills({ list, edge }: { list: React.RefObject<HTMLDivElement | null>; edge: 'top' | 'bottom' }) {
  const [kind, setKind] = useState<'mentions' | 'unreads' | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const floorRef = useRef(0)
  const rightRef = useRef(0)
  // The pill hangs from a zero-height dock that sits sticky inside the list's padding;
  // place it 6px above the user panel, measured after every layout.
  useLayoutEffect(() => {
    if (edge !== 'bottom' || !pillRef.current || !dockRef.current) return
    pillRef.current.style.bottom = `${6 + dockRef.current.getBoundingClientRect().top - floorRef.current}px`
    pillRef.current.style.right = `${rightRef.current}px`
  })
  const target = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = list.current
    if (!el) return
    let frame = 0
    const check = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = el.getBoundingClientRect()
        // The floating user panel covers the list's foot: what sits under it is out of view,
        // and the bottom pill sits 6px above it (Discord).
        const panel = document.querySelector('.user-panel')?.getBoundingClientRect()
        const floor = panel && panel.top < box.bottom ? panel.top : box.bottom
        floorRef.current = panel ? panel.top : box.bottom
        rightRef.current = panel && dockRef.current ? dockRef.current.getBoundingClientRect().right - panel.right : 0
        const out = (r: DOMRect) => (edge === 'top' ? r.bottom < box.top + 8 : r.top > floor - 8)
        const rows = [...el.querySelectorAll<HTMLElement>('.channel:not(.overview-row)')]
        const ordered = edge === 'top' ? rows.reverse() : rows
        const mention = ordered.find((r) => r.querySelector('.badge') && out(r.getBoundingClientRect()))
        const unread = mention ? null : ordered.find((r) => r.classList.contains('unread') && out(r.getBoundingClientRect()))
        target.current = mention ?? unread ?? null
        setKind(mention ? 'mentions' : unread ? 'unreads' : null)
        if (edge === 'bottom' && pillRef.current && dockRef.current) {
          pillRef.current.style.bottom = `${6 + dockRef.current.getBoundingClientRect().top - floorRef.current}px`
          pillRef.current.style.right = `${rightRef.current}px`
        }
      })
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    const watch = new MutationObserver(check)
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    window.addEventListener('resize', check)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', check)
      watch.disconnect()
      window.removeEventListener('resize', check)
    }
  }, [list, edge])
  return (
    <div ref={dockRef} className={`list-pill-dock ${edge}`}>
      {kind && (
        <button ref={pillRef} className={`list-pill ${kind}`} onClick={() => target.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>
          {kind === 'mentions' ? 'New mentions' : 'New unreads'}
        </button>
      )}
    </div>
  )
}

function Sidebar({ state, current, open, onOpen, ctx, guild, onGuild, onThreads }: { state: HubState; current: string | null; open: boolean; onOpen: (id: string) => void; ctx: MarkdownContext; guild: string; onGuild: (id: string) => void; onThreads?: (channelId: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const seen = useStore((d) => d.seen)
  const online = useStore((d) => d.online)
  const sessions = useStore((d) => d.sessions)
  const machines = useStore((d) => d.machines)
  const favourites = useStore((d) => d.favourites)
  const mentionCounts = useStore((d) => d.mentions)
  // This server's mentions only; the inbox bell in the user panel counts every server.
  const totalMentions = Object.entries(mentionCounts).reduce((a, [id, n]) => (store.guildOf(id) === guild ? a + n : a), 0)
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('collapsed') ?? '{}'))
  const [showOlder, setShowOlder] = useState<Record<string, boolean>>({})
  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] }
    setCollapsed(next)
    localStorage.setItem('collapsed', JSON.stringify(next))
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])
  const title = (c: Channel) => plain(c.name ?? '', ctx.userName, ctx.channelName) || 'untitled'
  const unread = (c: Channel) => snowflakeGt(c.last_message_id, seen[c.id]) && c.id !== current
  const q = query.trim().toLowerCase()
  const hit = (c: Channel) => !q || title(c).toLowerCase().includes(q)
  const guilds = store.guilds()
  const inGuild = (c: Channel) => (c.guild_id ?? state.guild.id) === guild
  const guildName = guilds.find((g) => g.id === guild)?.name ?? state.guild.name
  const categories = state.channels.filter((c) => c.type === 4 && inGuild(c)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const text = state.channels.filter((c) => (c.type === 0 || c.type === 5 || c.type === 15) && inGuild(c)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  const groups: Array<{ category: Channel | null; channels: Channel[] }> = [
    { category: null, channels: text.filter((c) => !c.parent_id || !categories.some((cat) => cat.id === c.parent_id)) },
    ...categories.map((category) => ({ category, channels: text.filter((c) => c.parent_id === category.id) })),
  ]
  const recent = (a: Channel, b: Channel) => (snowflakeGt(a.last_message_id ?? a.id, b.last_message_id ?? b.id) ? -1 : 1)
  const threadsOf = (id: string) => state.threads.filter((t) => t.parent_id === id).sort(recent)
  const waiting = Object.values(sessions).filter((s) => s.state === 'waiting').length
  // A machine that's down dims its category; the reason lives in the status light.
  const machineOf = (category: Channel) => machines.find((x) => x.name.toLowerCase() === (category.name ?? '').toLowerCase() || `kimaki ${x.name.toLowerCase()}` === (category.name ?? '').toLowerCase())
  const row = (thread: Channel) => (
    <Fragment key={thread.id}>
      <ThreadRow thread={thread} title={title(thread)} current={thread.id === current} unread={unread(thread)} session={sessions[thread.id]} favourite={favourites.includes(thread.id)} mentions={thread.id === current ? 0 : (mentionCounts[thread.id] ?? 0)} onOpen={onOpen} onSheet={setSheet} />
      {thread.id === current && !q && <LinkedRows threadId={thread.id} title={title} onOpen={onOpen} />}
    </Fragment>
  )
  const favouriteThreads = favourites.map((id) => state.threads.find((t) => t.id === id)).filter((t): t is Channel => Boolean(t && hit(t)))

  return (
    <nav className={`sidebar${open ? ' open' : ''}${guilds.length ? ' with-rail' : ''}`}>
      {guilds.length > 0 && <GuildRail guilds={guilds} current={guild} onGuild={onGuild} />}
      {guilds.length > 0 && <ColumnHandle id="rail" label="Server list" />}
      <div className="side-main">
      <div className="side-head">
        <button
          className="side-title"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const ids = [...state.channels, ...state.threads].filter(inGuild).map((c) => c.id)
            setSheet({
              at: below(e.currentTarget.querySelector('.side-title-pill') ?? e.currentTarget, 'start'),
              plain: true,
              title: guildName,
              groups: [
                [
                  ...(can(P.MANAGE_GUILD, null, guild) ? [{ label: 'Invite people', icon: 'members' as const, run: () => sessionActions.settings?.('members') }] : []),
                  ...(can(P.MANAGE_GUILD, null, guild) || can(P.MANAGE_CHANNELS, null, guild) || can(P.MANAGE_ROLES, null, guild) ? [{ label: 'Server settings', icon: 'gear' as const, run: () => sessionActions.settings?.('server') }] : []),
                ],
                [
                  { label: 'Notification settings', icon: 'bell', run: () => setSheet(bellSheet(state, { id: guild, type: -1 } as Channel, { x: r.left + 8, y: r.bottom + 8 }, () => {})) },
                  { label: 'Privacy settings', icon: 'eye', run: () => sessionActions.settings?.('server-privacy') },
                  { label: 'Mark server as read', icon: 'check', run: () => store.markAllSeen(ids) },
                ],
                [
                  { label: 'Collapse all categories', icon: 'down', run: () => { const next = Object.fromEntries(categories.map((c) => [c.id, true])); setCollapsed(next); localStorage.setItem('collapsed', JSON.stringify(next)) } },
                  { label: 'Copy server ID', icon: 'copy', run: () => void navigator.clipboard?.writeText(guild) },
                ],
              ],
            })
          }}
        >
          <span className="side-title-pill">
            <span>{guildName}</span>
            <Icon name="down" size={16} />
          </span>
        </button>
        <label className="search">
          <Icon name="search" size={18} />
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} placeholder="Search" aria-label="Search sessions" />
          {query && (
            <button className="icon-button" style={{ width: 24, height: 24 }} onClick={() => setQuery('')} aria-label="Clear search">
              <Icon name="close" size={16} />
            </button>
          )}
        </label>
      </div>
      <div className="channel-list" ref={listRef}>
        <ListPills list={listRef} edge="top" />
        {!q && (
          <button className={`channel overview-row${current === 'overview' ? ' active' : ''}`} onClick={() => onOpen('overview')}>
            <Icon name="eye" size={18} />
            <span className="channel-name">Overview</span>
            {waiting > 0 && <span className="meta need num">{waiting} need you</span>}
          </button>
        )}
        {!q && (
          <button className={`channel overview-row${current === 'inbox' ? ' active' : ''}`} onClick={() => onOpen('inbox')}>
            <Icon name="at" size={18} />
            <span className="channel-name">Mentions</span>
            {totalMentions > 0 && <span className="badge num">{totalMentions}</span>}
          </button>
        )}
        {favouriteThreads.length > 0 && (
          <div className="category">
            <div className="category-name static">Favourites</div>
            {favouriteThreads.map(row)}
          </div>
        )}
        {groups.map(({ category, channels }) => {
          if (channels.length === 0 && !category) return null
          const hidden = Boolean(category && collapsed[category.id] && !q)
          const rows = channels.flatMap((channel) => {
            const threads = threadsOf(channel.id)
            const matching = threads.filter(hit)
            if (q && !hit(channel) && matching.length === 0) return []
            // Live: unarchived, newest first, up to 5, plus the open, unread and active ones. The rest fold.
            const active = matching.filter((t) => !t.thread_metadata?.archived)
            const live = q ? matching : active.filter((t, i) => i < LIVE_THREADS || t.id === current || unread(t) || ['waiting', 'busy', 'failed'].includes(sessions[t.id]?.state ?? ''))
            const older = q ? [] : matching.filter((t) => !live.includes(t))
            const visible = hidden ? live.filter((t) => t.id === current || unread(t)) : live
            if (hidden && channel.id !== current && !unread(channel) && visible.length === 0) return []
            return [
              <div key={channel.id}>
                <ProjectRow channel={channel} current={channel.id === current} unread={unread(channel)} threads={threads} mentions={channel.id === current ? 0 : (mentionCounts[channel.id] ?? 0)} onOpen={onOpen} onSheet={setSheet} />
                {(visible.length > 0 || (!hidden && older.length > 0)) && (
                  <Tree>
                    {visible.map(row)}
                    {!hidden && older.length > 0 && (
                      <OlderThreads threads={showOlder[channel.id] ? [] : older} onOpen={onOpen} onSeeAll={onThreads ? () => onThreads(channel.id) : undefined}>
                        <button className="channel older" onClick={() => setShowOlder({ ...showOlder, [channel.id]: !showOlder[channel.id] })}>
                          <span className="channel-name">{showOlder[channel.id] ? 'Hide older' : `${older.length} older`}</span>
                        </button>
                      </OlderThreads>
                    )}
                    {!hidden && showOlder[channel.id] && older.map(row)}
                  </Tree>
                )}
              </div>,
            ]
          })
          if (q && rows.length === 0) return null
          return (
            <div key={category?.id ?? 'root'} className="category">
              {category && (
                <button className={`category-name${hidden ? ' collapsed' : ''}${machineOf(category)?.online === false ? ' down' : ''}`} onClick={() => toggle(category.id)} aria-expanded={!hidden} title={machineOf(category)?.online === false ? `${category.name}: machine offline` : undefined}>
                  <Icon name="down" size={14} />
                  {machineIcon(state.machine_icons, machineOf(category)?.name ?? category.name?.replace(/^kimaki\s+/i, ''), 'guild_icon') && <img className="category-icon" src={machineIcon(state.machine_icons, machineOf(category)?.name ?? category.name?.replace(/^kimaki\s+/i, ''), 'guild_icon')!} alt="" />}
                  {category.name}
                </button>
              )}
              {rows}
            </div>
          )
        })}
      </div>
        <ListPills list={listRef} edge="bottom" />
      </div>
      <UserPanel state={state} />
      <ColumnHandle id="side" label="Channel list" />
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </nav>
  )
}

function Main() {
  const state = useStore((d) => d.state)
  const [current, setCurrent] = useRoute()
  const [drawer, setDrawer] = useState(() => !location.hash && window.matchMedia('(max-width: 767px)').matches)
  // On phones, arriving at a channel from outside the list (a notification, a link, Back)
  // shows that channel rather than leaving the list over it.
  useEffect(() => {
    const onHash = () => {
      if (window.matchMedia('(max-width: 767px)').matches && /^#\/c\//.test(location.hash)) setDrawer(false)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [modal, setModal] = useState<OpenModal | null>(null)
  const [linkSheet, setLinkSheet] = useState<SheetSpec | null>(null)
  useColumnKeys()
  // The header's back/list button: the drawer on phones, unfolds the channel list on desktop.
  const showChannels = () => (window.matchMedia('(max-width: 767px)').matches ? setDrawer(true) : toggleColumn('side', false))
  const [guildPick, setGuildPick] = useState(() => localStorage.getItem('guild') ?? '')
  // Opening a channel moves the sidebar to its server and remembers it as that server's last.
  const openGuild = current && store.guildOf(current)
  useEffect(() => {
    if (!openGuild || !current || current === 'overview' || current === 'inbox') return
    setGuildPick(openGuild)
    localStorage.setItem('guild', openGuild)
    localStorage.setItem('lastByGuild', JSON.stringify({ ...JSON.parse(localStorage.getItem('lastByGuild') ?? '{}'), [openGuild]: current }))
  }, [current, openGuild])
  const openDrawer = useCallback(() => setDrawer(true), [])
  useSwipeBack(!drawer && !linkSheet && !modal, openDrawer)
  const [panel, setPanel] = useState<{ kind: 'search'; q?: string } | { kind: 'pins' | 'links' | 'threads' | 'members' | 'split' | 'workspace'; channelId: string } | { kind: 'services'; threadId?: string } | { kind: 'inbox' } | null>(null)
  // Channel panels follow the open channel, and close on pages that aren't channels.
  useEffect(() => {
    setPanel((p) => {
      if (!p || !('channelId' in p) || p.kind === 'threads') return p
      if (!current || current === 'overview' || current === 'inbox') return null
      return p.kind === 'split' ? (p.channelId === current ? null : p) : { ...p, channelId: current }
    })
  }, [current])
  const togglePanel = (next: { kind: 'pins' | 'links' | 'threads' | 'members' | 'workspace'; channelId: string }) => setPanel((p) => (p && p.kind === next.kind && 'channelId' in p && p.channelId === next.channelId ? null : next))
  sessionActions.links = (channelId) => setPanel({ kind: 'links', channelId })
  // A thread opened from its channel sits beside it on desktop (Discord's split view).
  sessionActions.openThread = (id) => {
    if (window.matchMedia('(max-width: 767px)').matches || current === id) setCurrent(id)
    else setPanel({ kind: 'split', channelId: id })
  }
  sessionActions.services = () => setPanel((p) => (p?.kind === 'services' ? null : { kind: 'services' }))
  sessionActions.inbox = () => setPanel((p) => (p?.kind === 'inbox' ? null : { kind: 'inbox' }))
  const [jumpTo, setJumpTo] = useState<{ channelId: string; messageId: string; nonce: number } | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setPanel({ kind: 'search' })
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  useEffect(() => connectEvents((t, d) => store.apply(t, d), () => void store.resync(), (online) => store.setOnline(online)), [])
  useFocusReporting(current && current !== 'overview' && current !== 'inbox' ? current : null)
  useNotificationClicks((channelId, messageId) => (messageId ? jump(channelId, messageId) : setCurrent(channelId)))

  // Opening the app with nothing chosen: the Overview when anything waits for the owner.
  const sessions = useStore((d) => d.sessions)
  const decided = useRef(Boolean(location.hash))
  useEffect(() => {
    if (decided.current || Object.keys(sessions).length === 0) return
    decided.current = true
    if (Object.values(sessions).some((s) => s.state === 'waiting')) {
      setCurrent('overview')
      setDrawer(false)
    }
  }, [sessions, setCurrent])

  const ctx: MarkdownContext = useMemo(
    () => ({
      userName: (raw) => {
        // A Discord id the mirror maps to a hub user (state.user_aliases) resolves to that user.
        const id = state?.user_aliases?.[raw] ?? raw
        const user = state?.users.find((u) => u.id === id)
        return user ? (user.global_name ?? user.username) : null
      },
      channelName: (id) => state?.channels.find((c) => c.id === id)?.name ?? state?.threads.find((c) => c.id === id)?.name ?? null,
      openChannel: (id) => setCurrent(id),
      isThread: (id) => Boolean(state?.threads.some((c) => c.id === id)),
      role: (id) => {
        for (const list of Object.values(state?.roles ?? {})) {
          const role = list.find((r) => r.id === id)
          if (role) return { name: role.name, color: role.color }
        }
        return null
      },
      sessionThread: (sessionId) => state?.sessionThreads?.[sessionId] ?? null,
      linkMenu: ({ url, channelId }, at) =>
        setLinkSheet({
          at,
          title: channelId ? plain(state?.threads.find((c) => c.id === channelId)?.name ?? state?.channels.find((c) => c.id === channelId)?.name ?? 'Link') : 'Link',
          subtitle: url,
          groups: [
            [
              ...(channelId ? [{ label: 'Go to channel', icon: 'thread' as const, run: () => setCurrent(channelId) }] : []),
              { label: 'Open link', icon: 'external' as const, run: () => void window.open(url, '_blank', 'noopener') },
              { label: 'Copy link', icon: 'copy' as const, run: () => void navigator.clipboard?.writeText(url) },
              ...('share' in navigator ? [{ label: 'Share link', icon: 'share' as const, run: () => void navigator.share({ url }).catch(() => {}) }] : []),
            ],
          ],
        }),
    }),
    [state, setCurrent],
  )

  if (!state)
    return (
      <div className="splash">
        <LoadingMark />
      </div>
    )
  const overview = current === 'overview'
  const inbox = current === 'inbox'
  const jump = (channelId: string, messageId: string) => {
    setJumpTo({ channelId, messageId, nonce: Date.now() })
    setCurrent(channelId)
    setDrawer(false)
    // On a phone the panel covers the thread: close it so the jump is visible.
    if (window.matchMedia('(max-width: 767px)').matches) setPanel(null)
  }
  const channel = overview || inbox ? undefined : (current && (state.channels.find((c) => c.id === current) ?? state.threads.find((c) => c.id === current))) || state.channels.find((c) => c.type === 0 && (c.guild_id ?? state.guild.id) === guildPick) || state.channels.find((c) => c.type === 0)
  // The server shown in the sidebar: the open channel's, else the one picked last.
  const guildIds = store.guilds().map((g) => g.id)
  const activeGuild = guildIds.includes(guildPick) ? guildPick : channel?.guild_id && guildIds.includes(channel.guild_id) ? channel.guild_id : state.guild.id
  const pickGuild = (id: string) => {
    setGuildPick(id)
    localStorage.setItem('guild', id)
    if (window.matchMedia('(max-width: 767px)').matches) return
    const last = JSON.parse(localStorage.getItem('lastByGuild') ?? '{}')[id] as string | undefined
    const target = [...state.channels, ...state.threads].find((c) => c.id === last) ?? state.channels.find((c) => c.type === 0 && c.guild_id === id)
    if (target) setCurrent(target.id)
  }
  const open = (id: string) => {
    setModal(null)
    setCurrent(id)
    setDrawer(false)
  }

  return (
    <div className="app">
      <Tooltips />
      <Sidebar state={state} current={overview ? 'overview' : inbox ? 'inbox' : (channel?.id ?? null)} open={drawer} onOpen={open} ctx={ctx} guild={activeGuild} onGuild={pickGuild} onThreads={(channelId) => setPanel({ kind: 'threads', channelId })} />
      {overview ? (
        <Overview onMenu={showChannels} onOpen={open} onSearch={() => setPanel({ kind: 'search' })} />
      ) : inbox ? (
        <Inbox guildId={activeGuild} onMenu={showChannels} onJump={jump} onSearch={() => setPanel({ kind: 'search' })} />
      ) : channel && !(channel.type === 4) ? (
        <Chat
          // Every sibling here has its own key prefix: a panel keyed by the same id as the
          // chat makes React leave the old chat on screen when the channel changes.
          key={`c${channel.id}`}
          channel={channel}
          state={state}
          ctx={ctx}
          onMenu={showChannels}
          onModal={(m) => setModal(m)}
          jumpTo={jumpTo?.channelId === channel.id ? jumpTo : null}
          onSearch={() => setPanel({ kind: 'search' })}
          open={panel && (!('channelId' in panel) || panel.channelId === channel.id || panel.kind === 'threads') ? (panel.kind === 'services' && panel.threadId !== channel.id ? null : panel.kind) : null}
          onPins={() => togglePanel({ kind: 'pins', channelId: channel.id })}
          onLinks={() => togglePanel({ kind: 'links', channelId: channel.id })}
          onThreads={() => togglePanel({ kind: 'threads', channelId: channel.parent_id && state.threads.some((t) => t.id === channel.id) ? channel.parent_id : channel.id })}
          onMembers={() => togglePanel({ kind: 'members', channelId: channel.id })}
          onServices={() => setPanel((p) => (p?.kind === 'services' && p.threadId === channel.id ? null : { kind: 'services', threadId: channel.id }))}
          onWorkspace={() => togglePanel({ kind: 'workspace', channelId: channel.id })}
        />
      ) : (
        <section className="chat empty">
          <button className="icon-button menu" onClick={() => setDrawer(true)} aria-label="Channels">
            <Icon name="back" />
          </button>
          <p className="muted">No channels yet. Connect a bot and let it create some.</p>
        </section>
      )}
      {panel?.kind === 'search' && <SearchPanel key="search" initial={panel.q} onClose={() => setPanel(null)} onJump={jump} />}
      {linkSheet && <Sheet spec={linkSheet} onClose={() => setLinkSheet(null)} />}
      {panel?.kind === 'services' && (
        <ServicesPanel
          key={`s${panel.threadId ?? 'all'}`}
          threadId={panel.threadId}
          onClose={() => setPanel(null)}
          onOpen={(id) => {
            setCurrent(id)
            setDrawer(false)
            if (window.matchMedia('(max-width: 767px)').matches) setPanel(null)
          }}
        />
      )}
      {panel?.kind === 'links' && <LinksPanel key={`l${panel.channelId}`} channelId={panel.channelId} onClose={() => setPanel(null)} onOpen={(id) => { setCurrent(id); setDrawer(false) }} onJump={jump} />}
      {panel?.kind === 'split' && channel && (() => {
        const thread = state.threads.find((t) => t.id === panel.channelId)
        if (!thread || thread.id === channel.id) return null
        return (
          <aside className="side-panel split-panel" role="complementary" aria-label="Thread">
            <Chat
              key={`split-${thread.id}`}
              channel={thread}
              state={state}
              ctx={ctx}
              onMenu={() => {}}
              onModal={(m) => setModal(m)}
              jumpTo={null}
              split={{ onClose: () => setPanel(null) }}
              onSearch={() => setPanel({ kind: 'search' })}
              onPins={() => setPanel({ kind: 'pins', channelId: thread.id })}
              onLinks={() => setPanel({ kind: 'links', channelId: thread.id })}
              onThreads={() => setPanel({ kind: 'threads', channelId: channel.id })}
              onMembers={() => setPanel({ kind: 'members', channelId: thread.id })}
              onServices={() => setPanel({ kind: 'services', threadId: thread.id })}
            />
          </aside>
        )
      })()}
      {panel?.kind === 'inbox' && <InboxPanel onClose={() => setPanel(null)} onJump={jump} onOpen={(id) => { setCurrent(id); setDrawer(false); if (window.matchMedia('(max-width: 767px)').matches) setPanel(null) }} />}
      {panel?.kind === 'threads' && <ThreadsPanel key={`t${panel.channelId}`} channelId={panel.channelId} onClose={() => setPanel(null)} onOpen={(id) => { setCurrent(id); setDrawer(false); if (window.matchMedia('(max-width: 767px)').matches) setPanel(null) }} />}
      {panel?.kind === 'workspace' && <WorkspacePanel key={`w${panel.channelId}`} channelId={panel.channelId} ctx={ctx} onClose={() => setPanel(null)} onJump={jump} onOpen={(id) => { setCurrent(id); setDrawer(false) }} onServices={() => setPanel({ kind: 'services', threadId: panel.channelId })} />}
      {panel?.kind === 'members' && <MembersPanel key={`m${panel.channelId}`} channelId={panel.channelId} onClose={() => setPanel(null)} />}
      {panel?.kind === 'pins' && <PinsPanel key={`p${panel.channelId}`} channelId={panel.channelId} ctx={ctx} onClose={() => setPanel(null)} onJump={jump} />}
      {modal && modal.channelId === channel?.id && (
        <ModalDialog
          modal={modal}
          ctx={ctx}
          onClose={() => setModal(null)}
          onResult={(result) => {
            if (result.type === 9 && result.data) setModal({ channelId: modal.channelId, messageId: modal.messageId, data: result.data })
          }}
        />
      )}
    </div>
  )
}

export function App() {
  const [phase, setPhase] = useState<'loading' | 'login' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const check = async () => {
    try {
      const status = await api.status()
      if (!status.signedIn) return setPhase('login')
      await store.loadState()
      setPhase('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }
  useEffect(() => void check(), [])
  // A hub that is restarting or out of reach: try again on its own every few seconds.
  useEffect(() => {
    if (phase !== 'error') return
    const timer = window.setInterval(() => void check(), 5000)
    return () => window.clearInterval(timer)
  }, [phase])
  if (phase === 'loading')
    return (
      <div className="splash">
        <LoadingMark />
      </div>
    )
  if (phase === 'error')
    return (
      <div className="login">
        <div className="login-card" role="alert">
          <div className="login-head">
            <h1>Can't reach the hub</h1>
            <p>{/can't reach the hub/i.test(error) ? 'Check this device is on your network. It tries again by itself.' : error}</p>
          </div>
          <button className="button primary wide" onClick={() => void check()}>
            Try again
          </button>
        </div>
      </div>
    )
  if (phase === 'login') return <Login onDone={() => void check()} />
  return <Main />
}
