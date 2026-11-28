import { ALL_MARKS, markBit, MarkHalo, ThreadFilter, useThreadFilter } from './ThreadFilter.tsx'
// App shell: passkey gate, channel list with sessions hung under projects,
// message pane. On phones the list is a full screen and a thread pushes over it.

import { memo, Fragment, Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ago } from './SettingsKit.tsx'
import { elapsedRun } from './run-clock.ts'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { api, connectEvents, signedIn, type Channel, type Guild, type HubState, type LinkKind, type SessionSummary, type User } from './api.ts'
import { Avatar, DmAvatar, machineIcon } from './Avatar.tsx'
import { Chat } from './Chat.tsx'
import { ActivityPane, Overview } from './Overview.tsx'
import { extensions } from './extensions.tsx'
import { SettingsHost } from './Settings.tsx'
import { can, P } from './perms.ts'
import { ChatMentions, Empty, Inbox, InboxPanel, ScheduledPanel, LinksPanel, MembersPanel, PinsPanel, SearchPanel, ServicesPanel, ThreadsPanel } from './Panels.tsx'
import { below, Sheet, sessionActions, usePress, type SheetAt, type SheetSpec } from './Sheet.tsx'
import type { MarkdownContext } from './markdown.tsx'
import { ModalDialog, type OpenModal } from './Modal.tsx'
import { DM_GUILD, dmName, dmUser, isDm, machineNamed, snowflakeGt, store, THREAD_TYPES, machineName, useMachineName, useStore } from './store.ts'
import { bellSheet, effective, useFocusReporting, useNotificationClicks } from './notify.ts'
import { native, shareOrigin } from './native.ts'
import { setPlace } from './TitleBar.tsx'
import { NativeLogin } from './NativeLogin.tsx'
import { HubUpdateBadge } from './HubUpdate.tsx'
import { loginError } from './login.ts'
import { Tooltips } from './Tooltip.tsx'
import { WhenHost } from './When.tsx'
import { WorkspacePanel } from './Workspace.tsx'
import { boardForLocation, setBoardLocation } from './board-route.ts'
import { QuickSwitcher, rememberVisit, ShortcutSheet } from './Switcher.tsx'
import { LoadingMark } from './components.tsx'
import { initColumns, keys, startResize, toggleColumn, useColumnKeys, useColumns, type ColumnId } from './columns.ts'

initColumns()
import { Icon, type IconName } from './icons.tsx'
import { E } from './emoji.tsx'
import { Forum } from './Forum.tsx'
import { Notice } from './Notice.tsx'
import { CallPill, VoicePeople, VoiceStrip, VoiceView } from './Voice.tsx'
import { plain, displayName, motion } from './text.ts'
import { indexThreads, listedUntil, newestThreadFirst, snowflakeTime } from './thread-list.ts'
import { rendered } from './perf.ts'

export function applyAccent(accent: string | null) {
  if (accent === 'pink') document.documentElement.dataset['accent'] = 'pink'
  else delete document.documentElement.dataset['accent']
}
applyAccent(localStorage.getItem('accent'))

// Themes: 'vocorum' (the default look, with its accent) or 'og' (Discord's dark scheme).
// /theme.js applies the saved one before the first paint; this keeps a live change in step.
export type Theme = 'vocorum' | 'og'
export function savedTheme(): Theme {
  return localStorage.getItem('theme') === 'og' ? 'og' : 'vocorum'
}
export function applyTheme(theme: Theme) {
  if (theme === 'og') document.documentElement.dataset['theme'] = 'og'
  else delete document.documentElement.dataset['theme']
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'og' ? '#121214' : '#060608')
}
applyTheme(savedTheme())

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

// Markdown and keyboard listeners depend on this callback. Navigation does not
// capture the current route, so a background activity update need not replace it.
function navigate(next: string) {
  location.hash = next === 'overview' || next === 'inbox' ? `#/${next}` : next.startsWith('x:') ? `#/x/${next.slice(2)}` : `#/c/${next}`
}

// A number that changes only when a channel or thread is added, removed or renamed.
const named = { channels: undefined as unknown, threads: undefined as unknown, text: '', version: 0 }
function nameVersion(state: HubState | null): number {
  if (!state || (state.channels === named.channels && state.threads === named.threads)) return named.version
  named.channels = state.channels
  named.threads = state.threads
  let text = ''
  for (const c of state.channels) text += `${c.id}:${c.name ?? ''}\n`
  for (const c of state.threads) text += `${c.id}=${c.name ?? ''}\n`
  if (text !== named.text) {
    named.text = text
    named.version++
  }
  return named.version
}

function useRoute(): [string | null, (id: string) => void] {
  const read = () => (location.hash === '#/overview' ? 'overview' : location.hash === '#/inbox' ? 'inbox' : /^#\/x\/[\w-]+$/.test(location.hash) ? `x:${location.hash.slice(4)}` : (/^#\/c\/(\d+)/.exec(location.hash)?.[1] ?? null))
  const [id, setId] = useState(read)
  useEffect(() => {
    const onHash = () => setId(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return [id, navigate]
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
      <HubUpdateBadge />
      {open && (
        <div className="menu-pop" role="menu">
          {savedTheme() === 'vocorum' && (
            <>
              <div className="menu-label">Accent colour</div>
              <button className={`menu-item${accent !== 'pink' ? ' on' : ''}`} onClick={() => pick('cyan')}>
                <i className="swatch" style={{ background: 'var(--cyan)' }} /> Cyber cyan
              </button>
              <button className={`menu-item${accent === 'pink' ? ' on' : ''}`} onClick={() => pick('pink')}>
                <i className="swatch" style={{ background: 'var(--pink)' }} /> Hyper pink
              </button>
            </>
          )}
          <button className="menu-item" onClick={() => (setOpen(false), sessionActions.settings?.())}>
            <Icon name="gear" size={20} /> User settings
          </button>
          {!signedIn.local && (
            <button className="menu-item red" onClick={() => void api.logout().then(() => location.reload())}>
              <Icon name="signout" size={20} /> Sign out
            </button>
          )}
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
  const named = useMachineName()
  // Connectivity only: the hub and the machines. Services have their own button.
  const down = machines.filter((m) => m.online === false)
  const level = !online ? 'red' : down.length ? 'amber' : 'green'
  const headline = !online ? 'Can’t reach the hub, retrying' : down.length ? `${down.map((m) => named(m.name)).join(', ')} offline` : 'Connected'
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
            {named(m.name)} {m.online === false ? 'offline' : m.online ? 'online' : 'unknown'}
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

// Everything waiting on you across every server, as one count.
function useInboxCount() {
  const mentions = useStore((d) => Object.values(d.mentions).reduce((a, b) => a + b, 0))
  const waiting = useStore((d) => Object.values(d.sessions).filter((s) => s.state === 'waiting' || s.state === 'failed').length)
  const requests = useStore((d) => d.requests.filter((r) => r.status === 'pending' && r.expires_at > Date.now()).length)
  const due = useStore((d) => (d.reminders ?? []).filter((r) => r.due).length)
  const more = extensions.reduce((sum, e) => sum + (e.useInboxCount?.() ?? 0), 0)
  return mentions + waiting + requests + due + more
}

// The same count on the installed app's icon, where the platform has app badges.
function useAppBadge() {
  const count = useInboxCount()
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return
    void (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {})
  }, [count])
}

// The inbox bell.
function InboxButton() {
  const count = useInboxCount()
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

function WorkingAge({ session }: { session: SessionSummary }) {
  const [, tick] = useState(0)
  // Wake just this label at its next displayed minute or hour, even in a quiet thread.
  useEffect(() => {
    let timer = 0
    const schedule = () => {
      const age = elapsedRun(session)
      if (age === null) return
      const unit = age < 3_600_000 ? 60_000 : 3_600_000
      timer = window.setTimeout(() => { tick((n) => n + 1); schedule() }, Math.ceil(unit - age % unit))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [session])
  const age = elapsedRun(session)
  if (age === null || age < 60_000) return null
  return <span className="meta">{age < 3_600_000 ? `${Math.floor(age / 60_000)}m` : `${Math.floor(age / 3_600_000)}h`}</span>
}

// One mark at the edge. Activity picks its colour; unread picks the title weight.
function threadMark(state: SessionSummary['state'] | undefined, unread: boolean) {
  const activity = state === 'busy' || state === 'waiting' || state === 'failed' ? state : undefined
  const description = [activity && STATE_LABEL[activity], unread && 'Unread messages'].filter(Boolean).join(', ')
  return { 'data-thread-row': '', 'data-thread-activity': activity, 'aria-description': description || undefined }
}

// Memoised: a message anywhere replaces the workspace state and redraws the sidebar, and
// each row should redraw only when its own thread, session, unread or mention count does.
const ThreadRow = memo(function ThreadRow({ thread, title, current, unread, muted, session, favourite, mentions, onOpen, onSheet }: { thread: Channel; title: string; current: boolean; unread: boolean; muted: boolean; session?: SessionSummary; favourite: boolean; mentions: number; onOpen: (id: string) => void; onSheet: (spec: SheetSpec) => void }) {
  const state = session?.state
  const mark = threadMark(state, unread)
  const manage = can(P.MANAGE_THREADS, thread) || thread.owner_id === store.data.state?.me.id
  const press = usePress((at) => {
    onSheet({
      at,
      title,
      subtitle: [session?.project, session?.machine && machineName(session.machine), state && state !== 'idle' ? STATE_LABEL[state] : null].filter(Boolean).join(' · '),
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
    <button data-nav={thread.id} {...mark} title={[title, mark['aria-description']].filter(Boolean).join('\n')} aria-current={current ? 'page' : undefined} className={`channel${current ? ' active' : ''}${unread ? ' unread' : ''}${muted ? ' muted' : ''}${thread.thread_metadata?.archived ? ' dim' : ''}`} onClick={() => onOpen(thread.id)} {...press}>
      {state === 'busy' && <MarkHalo/>}
      <span className="channel-name"><E>{title}</E></span>
      {state === 'busy' && session?.runStartedAt != null && <WorkingAge session={session} />}
      {mentions > 0 && <span className="badge num" aria-label={`${mentions} mentions`}>{mentions}</span>}
    </button>
  )
})

export const LINK_LABEL: Record<LinkKind, string> = { liaison: 'liaison', parent: 'started this', spawned: 'started here', mentions: 'mentioned here', mentioned: 'mentions this' }
const LINKED_ROWS = 4
const SHORT_KIND: Record<LinkKind, string> = { liaison: 'liaison', parent: 'parent', spawned: 'child', mentions: '', mentioned: '' }

// The open thread's linked sessions, nested under its row: a quick hop between liaising agents.
function LinkedRows({ threadId, title, unread, onOpen, mask }: { mask:number; threadId: string; title: (t: Channel) => string; unread: (t: Channel) => boolean; onOpen: (id: string) => void }) {
  const links = useStore((d) => d.linked[threadId])
  const threads = useStore((d) => d.state?.threads)
  const sessions = useStore((d) => d.sessions)
  useEffect(() => {
    void store.loadLinks(threadId).catch(() => {})
  }, [threadId])
  if (!links?.length) return null
  const eligible = mask === ALL_MARKS ? links : links.filter(l => { const t = threads?.find(x => x.id === l.id); return t && (mask & markBit(sessions[t.id]?.state,unread(t))) })
  if (!eligible.length) return null
  const shown = [...eligible].sort(newestThreadFirst).slice(0, LINKED_ROWS)
  return (
    <div className="linked" aria-label="Linked sessions">
      {shown.map((link) => {
        const thread = threads?.find((t) => t.id === link.id)
        const state = sessions[link.id]?.state
        const isUnread = Boolean(thread && unread(thread))
        const mark = threadMark(state, isUnread)
        return (
          <button key={link.id} {...mark} className={`channel linked-row${isUnread ? ' unread' : ''}`} onClick={() => onOpen(link.id)} title={[LINK_LABEL[link.kind], mark['aria-description']].filter(Boolean).join('\n')}>
            {state === 'busy' && <MarkHalo/>}
            <Icon name="link" size={14} />
            <span className="channel-name"><E>{thread ? title(thread) : 'A thread not on this hub'}</E></span>
            {(!state || state === 'idle' || state === 'done') && <span className="meta">{SHORT_KIND[link.kind]}</span>}
          </button>
        )
      })}
      {eligible.length > LINKED_ROWS && (
        <button className="channel linked-row more-links" onClick={() => sessionActions.links?.(threadId)}>
          <span className="channel-name">{eligible.length - LINKED_ROWS} more linked</span>
        </button>
      )}
    </div>
  )
}

const STATE_LABEL: Record<string, string> = { waiting: 'waiting for you', failed: 'failed', busy: 'working', done: 'done', idle: 'idle' }


function ProjectRow({ channel, current, unread, muted, threads, mentions, onOpen, onSheet }: { channel: Channel; current: boolean; unread: boolean; muted: boolean; threads: Channel[]; mentions: number; onOpen: (id: string) => void; onSheet: (spec: SheetSpec) => void }) {
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
    <button data-nav={channel.id} data-voice-channel={channel.type === 2 || undefined} className={`channel${current ? ' active' : ''}${unread ? ' unread' : ''}${muted ? ' muted' : ''}`} onClick={() => onOpen(channel.id)} {...press}>
      <span className="hash">{channel.type === 15 ? <Icon name="threads" size={16} /> : channel.type === 2 ? <Icon name="voiceChannel" size={20} /> : '#'}</span>
      <span className="channel-name"><E>{channel.name}</E></span>
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
      {state.private_channels && <DmRail current={current} onGuild={onGuild} />}
      {[...guilds.filter((g) => g.id !== state.admin_guild_id), ...guilds.filter((g) => g.id === state.admin_guild_id)].map((g) => {
        const admin = g.id === state.admin_guild_id
        const mine = all.filter((c) => (c.guild_id ?? state.guild.id) === g.id)
        const unread = g.id !== current && mine.some((c) => snowflakeGt(c.last_message_id, seen[c.id]) && !effective(state, c).mutedUntil)
        const count = mine.reduce((sum, c) => sum + (mentions[c.id] ?? 0), 0)
        return (
          <Fragment key={g.id}>
          {admin && <i className="rail-line" aria-hidden />}
          <button className={`rail-item${g.id === current ? ' active' : ''}${unread ? ' unread' : ''}${admin ? ' admin' : ''}`} onClick={() => onGuild(g.id)} title={admin ? `${g.name}: only you and your admin agent` : g.name} aria-label={`${g.name}${count ? `, ${count} mentions` : ''}`} aria-current={g.id === current}>
            <i className="rail-pip" />
            <span className={`rail-guild${g.icon ? ' has-icon' : ''}`} data-long={(!g.icon && [...initials(g.name)].length > 2) || undefined}>{g.icon ? <img src={`/client/guild-icons/${g.id}?v=${g.icon}`} alt="" /> : initials(g.name)}</span>
            {count > 0 && <span className="rail-badge num">{count > 99 ? '99+' : count}</span>}
          </button>
          </Fragment>
        )
      })}
    </div>
  )
}

// Discord's Home button and, under it, a direct message with unread messages as its
// person's avatar with the count; a line parts them from the servers.
function DmRail({ current, onGuild }: { current: string; onGuild: (id: string) => void }) {
  const state = useStore((d) => d.state)!
  const seen = useStore((d) => d.seen)
  const mentions = useStore((d) => d.mentions)
  const dms = state.channels.filter(isDm)
  const unread = dms.filter((c) => snowflakeGt(c.last_message_id, seen[c.id]))
  const home = current === DM_GUILD
  return (
    <>
      <button className={`rail-item${home ? ' active' : ''}${!home && unread.length ? ' unread' : ''}`} onClick={() => onGuild(DM_GUILD)} title="Direct messages" aria-label="Direct messages" aria-current={home}>
        <i className="rail-pip" />
        <span className="rail-guild rail-home">
          <Icon name="chat" size={22} />
        </span>
      </button>
      {unread.slice(0, 5).map((c) => {
        const name = dmName(c, state.me.id)
        const count = mentions[c.id] ?? 0
        return (
          <a key={c.id} className="rail-item unread" href={`#/c/${c.id}`} title={name} aria-label={`${name}${count ? `, ${count} unread` : ''}`}>
            <i className="rail-pip" />
            <span className="rail-guild has-icon rail-dm">
              <DmAvatar channel={c} size="panel" />
            </span>
            {count > 0 && <span className="rail-badge num">{count > 99 ? '99+' : count}</span>}
          </a>
        )
      })}
      <i className="rail-line" aria-hidden />
    </>
  )
}

// Hovering "N older" previews those threads, as Discord's "More Active Threads" popout does,
// with See all opening the channel's Threads panel. Pointer devices only.
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
  const list = threads.slice(0, 8)
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
// Memoised: its layout effect measures the list, and running that on every sidebar redraw
// forced a layout of every row for each message anywhere.
const ListPills = memo(function ListPills({ list, edge }: { list: React.RefObject<HTMLDivElement | null>; edge: 'top' | 'bottom' }) {
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
    let dirty = true
    let mentionedRows: HTMLElement[] = [], unreadRows: HTMLElement[] = []
    const check = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (dirty) {
          dirty = false
          mentionedRows = Array.from(el.querySelectorAll<HTMLElement>('.channel:not(.overview-row) .badge'), b => b.closest<HTMLElement>('.channel')!)
          unreadRows = Array.from(el.querySelectorAll<HTMLElement>('.channel.unread:not(.overview-row)'))
        }
        const box = el.getBoundingClientRect()
        // The floating user panel covers the list's foot: what sits under it is out of view,
        // and the bottom pill sits 6px above it (Discord). During a call the voice strip
        // floats above the panel, so it is the strip the pill has to clear.
        const panel = (document.querySelector('.voice-strip') ?? document.querySelector('.user-panel'))?.getBoundingClientRect()
        const floor = panel && panel.top < box.bottom ? panel.top : box.bottom
        floorRef.current = panel ? panel.top : box.bottom
        rightRef.current = panel && dockRef.current ? dockRef.current.getBoundingClientRect().right - panel.right : 0
        // Rows occur in vertical order. Look up the nearest one past the edge without
        // measuring every channel on every scroll frame. Re-read membership on DOM changes.
        const nearest = (rows: HTMLElement[]) => {
          let lo = 0, hi = rows.length
          while (lo < hi) {
            const mid = (lo + hi) >>> 1, r = rows[mid]!.getBoundingClientRect()
            if (edge === 'top' ? r.bottom < box.top + 8 : r.top <= floor - 8) lo = mid + 1
            else hi = mid
          }
          return rows[edge === 'top' ? lo - 1 : lo]
        }
        const mention = nearest(mentionedRows)
        const unread = mention ? null : nearest(unreadRows)
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
    const watch = new MutationObserver(() => { dirty = true; check() })
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    window.addEventListener('resize', check)
    // The list shrinks when the voice strip appears and grows back when it goes.
    const sized = new ResizeObserver(check)
    sized.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', check)
      watch.disconnect()
      sized.disconnect()
      window.removeEventListener('resize', check)
    }
  }, [list, edge])
  return (
    <div ref={dockRef} className={`list-pill-dock ${edge}`}>
      {kind && (
        <button ref={pillRef} className={`list-pill ${kind}`} onClick={() => target.current?.scrollIntoView({ block: 'center', behavior: motion() })}>
          {kind === 'mentions' ? 'New mentions' : 'New unreads'}
        </button>
      )}
    </div>
  )
})

// A message replaces the channel and thread lists (each channel carries its last message
// id) several times a minute. On its own that changes nothing the sidebar shows unless a
// row turns unread or an expired thread comes back into the list, so the sidebar skips the
// redraw otherwise. The same goes for a read mark that moves without changing whether its
// row is unread (the open chat reading each new message). Every other prop and part of the
// hub state must be the same object.
type SidebarProps = Parameters<typeof SidebarView>[0]
function sameSidebar(a: SidebarProps, b: SidebarProps) {
  if (a.current !== b.current || a.open !== b.open || a.ctx !== b.ctx || a.guild !== b.guild) return false
  if (b.guild === DM_GUILD) return a.state === b.state && a.seen === b.seen // the direct messages are ordered by their last message
  if (a.seen !== b.seen && !sameSeen(a, b)) return false
  if (a.state === b.state) return true
  for (const key of Object.keys(b.state) as Array<keyof HubState>) if (key !== 'channels' && key !== 'threads' && a.state[key] !== b.state[key]) return false
  return sameRows(a.state.channels, b.state.channels, a.seen, b.seen) && sameRows(a.state.threads, b.state.threads, a.seen, b.seen)
}
function sameSeen(a: SidebarProps, b: SidebarProps) {
  const row = (state: HubState, id: string) => state.threads.find((c) => c.id === id) ?? state.channels.find((c) => c.id === id)
  const unread = (p: SidebarProps, id: string) => snowflakeGt(row(p.state, id)?.last_message_id, p.seen[id])
  for (const id in b.seen) if (b.seen[id] !== a.seen[id] && unread(a, id) !== unread(b, id)) return false
  for (const id in a.seen) if (!(id in b.seen)) return false
  return true
}
function sameRows(before: Channel[], after: Channel[], seenBefore: Record<string, string>, seen: Record<string, string>) {
  if (before === after) return true
  if (before.length !== after.length) return false
  const now = Date.now()
  for (let i = 0; i < after.length; i++) {
    const x = before[i]!, y = after[i]!
    if (x === y) continue
    if (x.id !== y.id) return false
    for (const key of Object.keys(y) as Array<keyof Channel>) if (key !== 'last_message_id' && key !== 'message_count' && x[key] !== y[key]) return false
    if (snowflakeGt(x.last_message_id, seenBefore[x.id]) !== snowflakeGt(y.last_message_id, seen[y.id])) return false
    if (THREAD_TYPES.has(y.type) && listedUntil(x) > now !== listedUntil(y) > now) return false
  }
  return true
}
const SidebarMemo = memo(SidebarView, sameSidebar)
function Sidebar(props: Omit<SidebarProps, 'seen'>) {
  const seen = useStore((d) => d.seen)
  return <SidebarMemo {...props} seen={seen} />
}

function SidebarView({ state, seen, current, open, onOpen: openLatest, ctx, guild, onGuild, onThreads }: { state: HubState; seen: Record<string, string>; current: string | null; open: boolean; onOpen: (id: string) => void; ctx: MarkdownContext; guild: string; onGuild: (id: string) => void; onThreads?: (channelId: string) => void }) {
  // One open handler for the life of the sidebar, so memoised rows keep their props equal.
  const latestOpen = useRef(openLatest)
  latestOpen.current = openLatest
  const onOpen = useCallback((id: string) => latestOpen.current(id), [])
  const listRef = useRef<HTMLDivElement>(null)
  const online = useStore((d) => d.online)
  const sessions = useStore((d) => d.sessions)
  const machines = useStore((d) => d.machines)
  const favourites = useStore((d) => d.favourites)
  const mentionCounts = useStore((d) => d.mentions)
  const scheduledCount = useStore((d) => d.scheduled.filter((s) => s.status === 'pending').length + (d.reminders ?? []).filter((r) => !r.due).length + d.routines.reduce((n, m) => n + m.routines.length, 0))
  // This server's mentions only; the inbox bell in the user panel counts every server.
  const totalMentions = Object.entries(mentionCounts).reduce((a, [id, n]) => (store.guildOf(id) === guild ? a + n : a), 0)
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const [query, setQuery] = useState('')
  const [mask, changeMask] = useThreadFilter(state.me.id,guild)
  const filtering = mask !== ALL_MARKS
  const search = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('collapsed') ?? '{}'))
  const [showOlder, setShowOlder] = useState<Record<string, boolean>>({})
  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] }
    setCollapsed(next)
    localStorage.setItem('collapsed', JSON.stringify(next))
  }
  // A title is worked out once per thread object: a message anywhere redraws the sidebar,
  // and most of its rows have not changed.
  const titles = useMemo(() => new WeakMap<Channel, string>(), [ctx])
  const title = (c: Channel) => {
    let t = titles.get(c)
    if (t === undefined) titles.set(c, (t = plain(c.name ?? '', ctx.userName, ctx.channelName) || 'untitled'))
    return t
  }
  // Discord greys a muted row and gives it no unread mark; its mentions still count.
  const muted = (c: Channel) => effective(state, c).mutedUntil !== null
  const unread = (c: Channel) => (THREAD_TYPES.has(c.type) || c.id !== current) && snowflakeGt(c.last_message_id, seen[c.id]) && !muted(c)
  const passes = (t:Channel) => !filtering || Boolean(mask & markBit(sessions[t.id]?.state,unread(t)))
  const q = query.trim().toLowerCase()
  const hit = (c: Channel) => !q || title(c).toLowerCase().includes(q)
  const guilds = store.guilds()
  const inGuild = (c: Channel) => (c.guild_id ?? state.guild.id) === guild
  const guildName = guilds.find((g) => g.id === guild)?.name ?? state.guild.name
  const categories = state.channels.filter((c) => c.type === 4 && inGuild(c)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  // Kimaki can make its own voice channel before an import brings Discord's of the same
  // name: one row for the two, unless the later one is open or has people in it.
  const inCall = new Set((state.voice_states ?? []).map((v) => v.channel_id))
  const text = state.channels
    .filter((c) => (c.type === 0 || c.type === 2 || c.type === 5 || c.type === 15) && inGuild(c))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .filter((c, i, all) => c.type !== 2 || c.id === current || inCall.has(c.id) || !all.slice(0, i).some((o) => o.type === 2 && o.name === c.name && o.parent_id === c.parent_id))
  const groups: Array<{ category: Channel | null; channels: Channel[] }> = [
    { category: null, channels: text.filter((c) => !c.parent_id || !categories.some((cat) => cat.id === c.parent_id)) },
    ...categories.map((category) => ({ category, channels: text.filter((c) => c.parent_id === category.id) })),
  ]
  const [clock, tick] = useState(0)
  const threadList = useMemo(() => indexThreads(state.threads, Date.now()), [state.threads, clock])
  useEffect(() => {
    if (!Number.isFinite(threadList.nextExpiry)) return
    const timer = window.setTimeout(() => tick((n) => n + 1), Math.max(1, Math.min(2_147_483_647, threadList.nextExpiry - Date.now())))
    return () => window.clearTimeout(timer)
  }, [threadList.nextExpiry, clock])
  const waiting = Object.values(sessions).filter((s) => s.state === 'waiting').length
  // A machine that's down dims its category; the reason lives in the status light.
  const machineOf = (category: Channel) => {
    const machine = machineNamed(state, category.name ?? '')?.toLowerCase()
    return machines.find((x) => x.name.toLowerCase() === machine || x.name.toLowerCase() === (category.name ?? '').toLowerCase() || `kimaki ${x.name.toLowerCase()}` === (category.name ?? '').toLowerCase())
  }
  const row = (thread: Channel) => (
    <Fragment key={thread.id}>
      <ThreadRow thread={thread} title={title(thread)} current={thread.id === current} unread={unread(thread)} muted={muted(thread)} session={sessions[thread.id]} favourite={favourites.includes(thread.id)} mentions={thread.id === current ? 0 : (mentionCounts[thread.id] ?? 0)} onOpen={onOpen} onSheet={setSheet} />
      {thread.id === current && !q && <LinkedRows mask={mask} unread={unread} threadId={thread.id} title={title} onOpen={onOpen} />}
    </Fragment>
  )
  const favouriteThreads = favourites.map((id) => state.threads.find((t) => t.id === id)).filter((t): t is Channel => Boolean(t && hit(t) && passes(t)))

  return (
    <nav className={`sidebar${open ? ' open' : ''}${guilds.length ? ' with-rail' : ''}`}>
      {guilds.length > 0 && <GuildRail guilds={guilds} current={guild} onGuild={onGuild} />}
      {guilds.length > 0 && <ColumnHandle id="rail" label="Server list" />}
      <div className="side-main">
      {guild === DM_GUILD ? (
        <DmList state={state} current={current} onOpen={onOpen} />
      ) : (
      <>
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
            {guild === state.admin_guild_id && <Icon name="shield" size={16} className="admin-mark" />}
            <span>{guildName}</span>
            <Icon name="down" size={16} />
          </span>
        </button>
        {guild === state.admin_guild_id && (
          <p className="admin-note">
            <Icon name="shield" size={14} />
            Only you and your admin agent.
          </p>
        )}
        <div className="thread-search-tools"><label className="search">
          <Icon name="search" size={18} />
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} placeholder="Search" aria-label="Search sessions" />
          {query && (
            <button className="icon-button" style={{ width: 24, height: 24 }} onClick={() => setQuery('')} aria-label="Clear search">
              <Icon name="close" size={16} />
            </button>
          )}
        </label><ThreadFilter key={guild} mask={mask} change={changeMask}/></div>
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
        {!q && extensions.map((e) => e.SidebarRow && <e.SidebarRow key={e.id} active={current === `x:${e.id}`} onOpen={() => onOpen(`x:${e.id}`)} />)}
        {!q && (
          <button className={`channel overview-row${current === 'inbox' ? ' active' : ''}`} onClick={() => onOpen('inbox')}>
            <Icon name="at" size={18} />
            <span className="channel-name">Mentions</span>
            {totalMentions > 0 && <span className="badge num">{totalMentions}</span>}
          </button>
        )}
        {!q && scheduledCount > 0 && (
          <button className="channel overview-row" onClick={() => sessionActions.scheduled?.()}>
            <Icon name="clock" size={18} />
            <span className="channel-name">Scheduled</span>
            <span className="meta num">{scheduledCount}</span>
          </button>
        )}
        {filtering && !state.threads.some(t=>inGuild(t)&&hit(t)&&passes(t)) && <div className="mark-empty" role="status">No matching threads. <button onClick={()=>changeMask(ALL_MARKS)}>Show all statuses</button></div>}
        {!q && extensions.map(e => e.BeforeChannels && <e.BeforeChannels key={e.id} current={current} onOpen={onOpen} />)}
        {favouriteThreads.length > 0 && (
          <div className="category">
            <div className="category-name static">Favourites</div>
            {favouriteThreads.map(row)}
          </div>
        )}
        {groups.map(({ category, channels }) => {
          if (channels.length === 0 && !category) return null
          const hidden = Boolean(category && collapsed[category.id] && !q && !filtering)
          const rows = channels.flatMap((channel) => {
            const threads = threadList.byParent.get(channel.id) ?? []
            const matching = threads.filter(t=>hit(t)&&passes(t))
            if (filtering && !matching.length) return []
            if (q && !hit(channel) && matching.length === 0) return []
            const listed = (t: Channel) => t.id === current || threadList.visible.has(t.id) || (filtering && markBit(sessions[t.id]?.state,unread(t)) !== 16)
            const live = q ? matching : matching.filter(listed)
            const older = q ? [] : matching.filter((t) => !listed(t))
            const visible = hidden ? live.filter((t) => t.id === current || unread(t)) : showOlder[channel.id] ? matching : live
            if (hidden && channel.id !== current && !unread(channel) && visible.length === 0) return []
            return [
              <div key={channel.id}>
                <ProjectRow channel={channel} current={channel.id === current} unread={unread(channel)} muted={muted(channel)} threads={threads} mentions={channel.id === current ? 0 : (mentionCounts[channel.id] ?? 0)} onOpen={onOpen} onSheet={setSheet} />
                {channel.type === 2 && <VoicePeople state={state} channel={channel} />}
                {(visible.length > 0 || (!hidden && older.length > 0)) && (
                  <Tree>
                    {visible.map(row)}
                    {/* Folded: "N older" with its hover preview. Unfolded: the threads, then
                        "Hide older" under them (no preview: they are all in view). */}
                    {!hidden && older.length > 0 && !showOlder[channel.id] && (
                      <OlderThreads threads={older} onOpen={onOpen} onSeeAll={onThreads ? () => onThreads(channel.id) : undefined}>
                        <button className="channel older" onClick={() => setShowOlder({ ...showOlder, [channel.id]: true })}>
                          <span className="channel-name">{`${older.length} older`}</span>
                        </button>
                      </OlderThreads>
                    )}
                    {!hidden && older.length > 0 && showOlder[channel.id] && (
                      <button className="channel older" onClick={() => setShowOlder({ ...showOlder, [channel.id]: false })}>
                        <span className="channel-name">Hide older</span>
                      </button>
                    )}
                  </Tree>
                )}
              </div>,
            ]
          })
          if ((q || filtering) && rows.length === 0) return null
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
      </>
      )}
      </div>
      <VoiceStrip state={state} onOpen={onOpen} />
      <UserPanel state={state} />
      <ColumnHandle id="side" label="Channel list" />
      {/* On the body: the sidebar is a containing block (contain: layout), so a backdrop left
          inside it would cover the list only and a click in the chat would not close the menu. */}
      {sheet && createPortal(<Sheet spec={sheet} onClose={() => setSheet(null)} />, document.body)}
    </nav>
  )
}

// Direct messages in the channel list's place: a finder, then people, newest first, as
// Discord's DM list (avatar, name, status; bold when unread, a red count for new ones).
function DmList({ state, current, onOpen }: { state: HubState; current: string | null; onOpen: (id: string) => void }) {
  const seen = useStore((d) => d.seen)
  const mentions = useStore((d) => d.mentions)
  const machines = useStore((d) => d.machines)
  const [query, setQuery] = useState('')
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const q = query.trim().toLowerCase()
  const me = state.me.id
  const dms = state.channels
    .filter(isDm)
    .map((c) => ({ c, user: dmUser(c, me), name: dmName(c, me) }))
    .filter(({ user, name }) => !q || `${name} ${user?.username ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (snowflakeGt(a.c.last_message_id ?? a.c.id, b.c.last_message_id ?? b.c.id) ? -1 : 1))
  const start = (at: SheetAt) => setSheet(newDmSheet(state, at, onOpen))
  return (
    <>
      <div className="side-head">
        <div className="side-title static">
          <span className="side-title-pill">
            <span>Direct messages</span>
          </span>
        </div>
        <label className="search">
          <Icon name="search" size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} placeholder="Find a conversation" aria-label="Find a conversation" />
        </label>
      </div>
      <div className="channel-list dm-list">
        <div className="category">
          <div className="category-name static dm-head">
            Direct messages
            <button className="icon-button dm-new" onClick={(e) => start(below(e.currentTarget, 'end'))} aria-label="New message" title="New message">
              <Icon name="plus" size={16} />
            </button>
          </div>
          {dms.map(({ c, user, name }) => {
            const unread = c.id !== current && snowflakeGt(c.last_message_id, seen[c.id])
            const count = c.id === current ? 0 : (mentions[c.id] ?? 0)
            const status = c.machine ? (machines.find((m) => m.name.toLowerCase() === c.machine!.toLowerCase())?.online === false ? 'offline' : 'online') : user ? (state.presence?.[user.id]?.status ?? 'offline') : 'offline'
            return (
              <button key={c.id} data-nav={c.id} className={`channel dm-row${c.id === current ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={() => onOpen(c.id)}>
                <span className="dm-avatar">
                  <DmAvatar channel={c} size="panel" />
                  <i className={`presence ${status}`} />
                </span>
                <span className="channel-name"><E>{name}</E></span>
                {(c.machine || user?.bot) && <span className="bot-tag">BOT</span>}
                {count > 0 && <span className="badge num">{count > 99 ? '99+' : count}</span>}
              </button>
            )
          })}
        </div>
        {dms.length === 0 &&
          (q ? (
            <Empty icon="search" title="No conversations match" />
          ) : (
            <div className="dm-empty">
              <Empty icon="chat" title="No direct messages yet">
                Talk to one person, away from the channels.
              </Empty>
              <button className="button primary" onClick={(e) => start(below(e.currentTarget))}>
                New message
              </button>
            </div>
          ))}
      </div>
      {sheet && createPortal(<Sheet spec={sheet} onClose={() => setSheet(null)} />, document.body)}
    </>
  )
}

// Who to write to: the people you share a server with (agents work in project channels).
function newDmSheet(state: HubState, at: SheetAt, onOpen: (id: string) => void): SheetSpec {
  const people = state.users.filter((u) => u.id !== state.me.id && !u.bot).sort((a, b) => displayName(a).localeCompare(displayName(b)))
  const open = (to: { recipient_id: string } | { machine: string }) => void store.openDm(to).then((c) => onOpen(c.id)).catch(() => {})
  return {
    at,
    title: 'New message',
    groups: [
      people.length
        ? people.map((u) => ({ label: displayName(u), sub: `@${u.username}`, icon: 'at' as const, run: () => open({ recipient_id: u.id }) }))
        : [{ label: 'Invite people', sub: 'No one else is on this hub yet', icon: 'members' as const, run: () => sessionActions.settings?.('members') }],
    ],
  }
}

// A new server: what to do first, as Discord's welcome checklist. Commands copy on click.
function Welcome({ name }: { name: string }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(text)
    window.setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500)
  }
  const steps: { icon: IconName; title: string; note: ReactNode; run: () => void; copies?: string }[] = [
    { icon: 'server', title: 'Connect a machine', note: <code>vocorum kimaki setup &lt;machine&gt;</code>, copies: 'vocorum kimaki setup ', run: () => copy('vocorum kimaki setup ') },
    { icon: 'download', title: 'Move from Discord', note: <code>vocorum discord import all</code>, copies: 'vocorum discord import all', run: () => copy('vocorum discord import all') },
    { icon: 'phone', title: 'Pair another device', note: 'Your phone or another computer', run: () => sessionActions.settings?.('devices') },
    { icon: 'members', title: 'Invite people', note: 'They get their own account', run: () => sessionActions.settings?.('members') },
  ]
  return (
    <div className="welcome">
      <h1>
        Welcome to
        <br />
        {name}
      </h1>
      <p>Agents post here once a machine is connected. Run the commands on the hub machine.</p>
      <div className="welcome-steps">
        {steps.map((s) => (
          <button key={s.title} className="welcome-step" onClick={s.run}>
            <span className="welcome-icon">
              <Icon name={s.icon} size={20} />
            </span>
            <span className="welcome-text">
              <b>{s.title}</b>
              <span>{s.copies && copied === s.copies ? 'Copied' : s.note}</span>
            </span>
            <Icon name={s.copies ? 'copy' : 'chevron'} size={16} />
          </button>
        ))}
      </div>
    </div>
  )
}

// Lost the hub for more than a few seconds (not a quick reconnect): one pill at the top,
// gone when the socket is back. The system light in the user panel says the same, quietly.
function OfflineNotice() {
  const online = useStore((d) => d.online)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (online) return setShown(false)
    const timer = window.setTimeout(() => setShown(true), 3000)
    return () => window.clearTimeout(timer)
  }, [online])
  if (!shown) return null
  return (
    <div className="offline-notice" role="status">
      <Icon name="warn" size={16} />
      Can't reach the hub. Retrying.
    </div>
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
      if (window.matchMedia('(max-width: 767px)').matches && /^#\/(c\/|overview$|inbox$)/.test(location.hash)) setDrawer(false)
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
  // Wide screens: an Activity column beside every conversation from 2400px, and from 3200px a
  // session's Workspace beside it as well, until closed.
  const wide = useMediaQuery('(min-width: 2400px)')
  const wider = useMediaQuery('(min-width: 3200px)')
  const [autoBoard, setAutoBoard] = useState(() => localStorage.getItem('wide:workspace') !== 'off')
  const sessionMap = useStore((d) => d.sessions)
  const [panel, setPanel] = useState<{ kind: 'search'; q?: string } | { kind: 'pins' | 'links' | 'threads' | 'members' | 'split' | 'workspace' | 'mentions'; channelId: string } | { kind: 'services'; threadId?: string } | { kind: 'inbox' } | { kind: 'scheduled'; channelId?: string } | null>(null)
  const account = state?.me.id
  useEffect(() => {
    if (!account) return
    const follow = () => {
      const id = boardForLocation(account)
      setPanel(p => id && store.channel(id) ? (p?.kind === 'workspace' && p.channelId === id ? p : { kind: 'workspace', channelId: id }) : p?.kind === 'workspace' ? null : p)
    }
    follow(); window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [account])
  // Channel panels follow the open channel, and close on pages that aren't channels.
  useEffect(() => {
    setPanel((p) => {
      if (!p || !('channelId' in p) || p.kind === 'threads' || p.kind === 'workspace') return p
      if (!current || current === 'overview' || current === 'inbox') return null
      return p.kind === 'split' ? (p.channelId === current ? null : p) : { ...p, channelId: current }
    })
  }, [current])
  // Create Thread: a message in the channel starts one, so open the channel at its message box.
  const startThread = (channelId: string) => {
    const before = current === channelId ? null : document.querySelector('.chat .composer textarea')
    setCurrent(channelId)
    setDrawer(false)
    setPanel(null)
    let frames = 0
    const focus = () => {
      const box = document.querySelector<HTMLTextAreaElement>('.chat:not(.split) .composer textarea')
      if (box && (box !== before || frames > 30)) box.focus()
      else if (frames++ < 60) requestAnimationFrame(focus)
    }
    requestAnimationFrame(focus)
  }
  const togglePanel = (next: { kind: 'pins' | 'links' | 'threads' | 'members' | 'workspace'; channelId: string }) => setPanel((p) => (p && p.kind === next.kind && 'channelId' in p && p.channelId === next.channelId ? null : next))
  sessionActions.links = (channelId) => setPanel({ kind: 'links', channelId })
  // A thread opened from its channel sits beside it on desktop (Discord's split view).
  sessionActions.openThread = (id) => {
    if (window.matchMedia('(max-width: 767px)').matches || current === id) setCurrent(id)
    else setPanel({ kind: 'split', channelId: id })
  }
  sessionActions.services = () => setPanel((p) => (p?.kind === 'services' ? null : { kind: 'services' }))
  sessionActions.inbox = () => setPanel((p) => (p?.kind === 'inbox' ? null : { kind: 'inbox' }))
  sessionActions.mentions = channelId => setPanel({ kind: 'mentions', channelId })
  // A request link (#/requests/<id>, from an agent or the CLI) opens the Inbox, where it waits.
  useEffect(() => {
    const onHash = () => {
      if (!/^#\/requests\/[0-9a-f]{12}$/.test(location.hash)) return
      history.replaceState(null, '', current ? (current === 'overview' || current === 'inbox' ? `#/${current}` : `#/c/${current}`) : '#')
      setPanel({ kind: 'inbox' })
    }
    onHash()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [current])
  sessionActions.scheduled = (channelId) => setPanel((p) => (p?.kind === 'scheduled' && p.channelId === channelId ? null : { kind: 'scheduled', ...(channelId && { channelId }) }))
  const [jumpTo, setJumpTo] = useState<{ channelId: string; messageId: string; nonce: number } | null>(null)
  // A message link (#/c/<channel>/<message>) opens the channel and jumps to the message.
  useEffect(() => {
    const onHash = () => {
      const m = /^#\/c\/(\d+)\/(\d+)/.exec(location.hash)
      if (!m) return
      setJumpTo({ channelId: m[1]!, messageId: m[2]!, nonce: Date.now() })
      history.replaceState(null, '', `#/c/${m[1]}`)
    }
    onHash()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [switcher, setSwitcher] = useState<'switcher' | 'shortcuts' | null>(null)
  useEffect(() => {
    if (current && current !== 'overview' && current !== 'inbox') rememberVisit(current)
  }, [current])
  // Discord's navigation keys. Alt+arrows walk the sidebar rows in the order shown.
  useEffect(() => {
    // From the URL, not React state: the route updates a task after the hash changes.
    const routeNow = () => /^#\/c\/(\d+)/.exec(location.hash)?.[1] ?? null
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSwitcher((s) => (s === 'switcher' ? null : 'switcher'))
      } else if (mod && e.key === '/') {
        e.preventDefault()
        setSwitcher((s) => (s === 'shortcuts' ? null : 'shortcuts'))
      } else if (mod && e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Ctrl+Alt+arrows: the previous or next server on the rail.
        const items = [...document.querySelectorAll<HTMLElement>('.rail .rail-item')]
        const at = items.findIndex((r) => r.classList.contains('active'))
        const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
        if (next) {
          e.preventDefault()
          next.click()
        }
      } else if (mod && !e.shiftKey && !e.altKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        if (e.key === '[') history.back()
        else history.forward()
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i' && !typing(e)) {
        e.preventDefault()
        setPanel((p) => (p?.kind === 'inbox' ? null : { kind: 'inbox' }))
      } else if (mod && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'p' || (e.key.toLowerCase() === 'u' && !typing(e)))) {
        // Ctrl+P pins, Ctrl+U members (in the message box Ctrl+U stays underline).
        const id = routeNow()
        if (!id) return
        e.preventDefault()
        const kind = e.key.toLowerCase() === 'p' ? 'pins' : 'members'
        setPanel((p) => (p?.kind === kind && 'channelId' in p && p.channelId === id ? null : { kind, channelId: id }))
      } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        const attach = document.querySelector<HTMLElement>('.chat .composer .attach')
        if (attach) {
          e.preventDefault()
          attach.click()
        }
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        const emoji = document.querySelector<HTMLElement>('.chat .composer .emoji-button')
        if (emoji) {
          e.preventDefault()
          emoji.click()
        }
      } else if (!mod && !e.altKey && e.key.length === 1 && e.key !== ' ' && !typing(e) && !(e.target as HTMLElement).closest?.('.message') && !document.querySelector('.overlay, .sheet')) {
        // Typing anywhere goes to the message box, as in Discord.
        document.querySelector<HTMLTextAreaElement>('.chat .composer textarea')?.focus()
      } else if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const rows = [...document.querySelectorAll<HTMLElement>('.sidebar [data-nav]')].filter((r) => !e.shiftKey || r.classList.contains('unread') || r.dataset['nav'] === routeNow())
        const at = rows.findIndex((r) => r.dataset['nav'] === routeNow())
        const next = rows[at < 0 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : at + (e.key === 'ArrowDown' ? 1 : -1)]
        if (next?.dataset['nav']) {
          e.preventDefault()
          setCurrent(next.dataset['nav'])
          next.scrollIntoView({ block: 'nearest' })
        }
      } else if (e.key === 'Escape' && !e.defaultPrevented && !mod && !e.altKey && (!typing(e) || (e.target as HTMLTextAreaElement).value === '') && !document.querySelector('.overlay, .sheet, .side-panel .panel-head')) {
        const id = routeNow()
        if (!id) return
        if (e.shiftKey) {
          const guildId = store.channel(id)?.guild_id ?? store.data.state?.guild.id
          store.markAllSeen([...(store.data.state?.channels ?? []), ...(store.data.state?.threads ?? [])].filter((c) => (c.guild_id ?? store.data.state?.guild.id) === guildId).map((c) => c.id))
        } else store.markSeen(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCurrent])
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

  // Only the first nonempty session snapshot decides the landing page. Keeping
  // the whole shell subscribed afterwards also rerenders the open conversation.
  useEffect(() => {
    if (location.hash) return
    const decide = () => {
      if (location.hash) { stop(); return }
      const sessions = Object.values(store.data.sessions)
      if (!sessions.length) return
      stop()
      if (sessions.some((s) => s.state === 'waiting')) {
        setCurrent('overview')
        setDrawer(false)
      }
    }
    const stop = store.subscribe(decide)
    decide()
    return () => void stop()
  }, [setCurrent])

  // Every Markdown block reads its text again when this context changes, so it must change
  // only when a name it resolves can. `state` itself is replaced by any message anywhere (a
  // channel's last_message_id moves) and by every presence update; the lookups read it live.
  const names = useStore((d) => nameVersion(d.state))
  const users = useStore((d) => d.state?.users)
  const aliases = useStore((d) => d.state?.user_aliases)
  const roles = useStore((d) => d.state?.roles)
  const sessionThreads = useStore((d) => d.state?.sessionThreads)
  const ctx: MarkdownContext = useMemo(
    () => {
      const live = () => store.data.state
      return {
        userName: (raw) => {
          // A Discord id the mirror maps to a hub user (state.user_aliases) resolves to that user.
          const id = live()?.user_aliases?.[raw] ?? raw
          const user = live()?.users.find((u) => u.id === id)
          return user ? (user.global_name ?? user.username) : null
        },
        channelName: (id) => live()?.channels.find((c) => c.id === id)?.name ?? live()?.threads.find((c) => c.id === id)?.name ?? null,
        openChannel: (id) => setCurrent(id),
        isThread: (id) => Boolean(live()?.threads.some((c) => c.id === id)),
        role: (id) => {
          for (const list of Object.values(live()?.roles ?? {})) {
            const role = list.find((r) => r.id === id)
            if (role) return { name: role.name, color: role.color }
          }
          return null
        },
        sessionThread: (sessionId) => live()?.sessionThreads?.[sessionId] ?? null,
        selectOptions: (type, channelTypes) => {
          const state = live()
          if (!state) return []
          const users = state.users.map((u) => ({ label: u.global_name ?? u.username, value: u.id, description: u.bot ? 'App' : `@${u.username}` }))
          const roles = Object.entries(state.roles ?? {}).flatMap(([guildId, list]) => list.filter((r) => r.id !== guildId).map((r) => ({ label: `@${r.name}`, value: r.id, description: 'Role' })))
          if (type === 5) return users
          if (type === 6) return roles
          if (type === 7) return [...users, ...roles]
          const wanted = channelTypes?.length ? new Set(channelTypes) : new Set([0, 2, 5, 10, 11, 12, 13, 15, 16])
          return [...state.channels, ...state.threads]
            .filter((c) => wanted.has(c.type) && !c.thread_metadata?.archived)
            .map((c) => ({ label: `${c.type >= 10 && c.type <= 12 ? '' : '#'}${plain(c.name ?? '')}`, value: c.id, description: state.channels.find((p) => p.id === c.parent_id)?.name ?? undefined }))
        },
        linkMenu: ({ url, channelId }, at) =>
          setLinkSheet({
            at,
            title: channelId ? plain(live()?.threads.find((c) => c.id === channelId)?.name ?? live()?.channels.find((c) => c.id === channelId)?.name ?? 'Link') : 'Link',
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
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the values are read live; these say when a name changed
    [names, users, aliases, roles, sessionThreads, setCurrent],
  )

  if (!state)
    return (
      <div className="splash">
        <LoadingMark />
      </div>
    )
  const overview = current === 'overview'
  const inbox = current === 'inbox'
  const page = current?.startsWith('x:') ? extensions.find((e) => e.id === current.slice(2) && e.Page && (!e.ownerOnly || state.hub_owner === true)) : undefined
  const jump = (channelId: string, messageId: string) => {
    setJumpTo({ channelId, messageId, nonce: Date.now() })
    setCurrent(channelId)
    setDrawer(false)
    // On a phone the panel covers the thread: close it so the jump is visible.
    if (window.matchMedia('(max-width: 767px)').matches) setPanel(null)
  }
  const routed = current && (state.channels.find((c) => c.id === current) ?? state.threads.find((c) => c.id === current))
  // Direct messages picked with none open: their own empty page, not some server's channel.
  const dmHome = !overview && !inbox && !page && guildPick === DM_GUILD && !routed
  const channel = overview || inbox || page || dmHome ? undefined : routed || state.channels.find((c) => c.type === 0 && (c.guild_id ?? state.guild.id) === guildPick) || state.channels.find((c) => c.type === 0)
  // The server shown in the sidebar: the open channel's, else the one picked last.
  const guildIds = [...store.guilds().map((g) => g.id), ...(state.private_channels ? [DM_GUILD] : [])]
  const activeGuild = guildIds.includes(guildPick) ? guildPick : channel?.guild_id && guildIds.includes(channel.guild_id) ? channel.guild_id : state.guild.id
  // Reads the hub's live lists: the sidebar can keep an earlier copy of this callback.
  const pickGuild = (id: string) => {
    const state = store.data.state!
    setGuildPick(id)
    localStorage.setItem('guild', id)
    if (window.matchMedia('(max-width: 767px)').matches) return
    const last = JSON.parse(localStorage.getItem('lastByGuild') ?? '{}')[id] as string | undefined
    const newest = (list: Channel[]) => [...list].sort((a, b) => (snowflakeGt(a.last_message_id ?? a.id, b.last_message_id ?? b.id) ? -1 : 1))[0]
    const target = [...state.channels, ...state.threads].find((c) => c.id === last) ?? (id === DM_GUILD ? newest(state.channels.filter(isDm)) : state.channels.find((c) => c.type === 0 && c.guild_id === id))
    if (target) setCurrent(target.id)
    // No conversations yet: leave the open channel for the direct messages' own page.
    else if (id === DM_GUILD) location.hash = '#/dms'
  }
  const open = (id: string) => {
    setModal(null)
    setCurrent(id)
    setDrawer(false)
  }

  useAppBadge()

  // Where you are, for the desktop app's title bar and the browser tab (Discord's "#general | Server").
  const placeName = overview ? 'Overview' : inbox ? 'Mentions' : page ? (page.title ?? page.id) : activeGuild === DM_GUILD ? 'Direct messages' : (store.guilds().find((g) => g.id === activeGuild)?.name ?? state.guild.name)
  const here = overview || inbox || page || !channel ? null : isDm(channel) ? `@${dmName(channel, state.me.id)}` : THREAD_TYPES.has(channel.type) ? plain(channel.name ?? '') : `#${channel.name ?? ''}`
  useEffect(() => {
    setPlace(placeName)
    document.title = here && activeGuild !== DM_GUILD ? `${here} | ${placeName}` : here ?? placeName
  }, [placeName, here, activeGuild])

  return (
    <div className={`app${wide ? ' wide-screen' : ''}`}>
      <OfflineNotice />
      {/* Discord's first Tab stop: straight to the conversation. */}
      <button className="skip-link" onClick={() => (document.querySelector<HTMLElement>('.composer textarea') ?? document.querySelector<HTMLElement>('.messages'))?.focus()}>
        Skip to the conversation
      </button>
      <Tooltips />
      <WhenHost />
      <Profiler id="sidebar" onRender={rendered}>
        <Sidebar state={state} current={overview ? 'overview' : inbox ? 'inbox' : page ? current : (channel?.id ?? null)} open={drawer} onOpen={open} ctx={ctx} guild={activeGuild} onGuild={pickGuild} onThreads={(channelId) => setPanel({ kind: 'threads', channelId })} />
      </Profiler>
      {overview ? (
        <Overview onMenu={showChannels} onOpen={open} onSearch={() => setPanel({ kind: 'search' })} />
      ) : page?.Page ? (
        <page.Page key={`x${page.id}`} onMenu={showChannels} onOpen={open} />
      ) : inbox ? (
        <Inbox guildId={activeGuild} onMenu={showChannels} onJump={jump} onSearch={() => setPanel({ kind: 'search' })} />
      ) : channel && channel.type === 2 ? (
        <VoiceView
          key={`v${channel.id}`}
          channel={channel}
          state={state}
          onMenu={showChannels}
          // The room's own chat: the same Chat as everywhere, without a second header.
          chat={(onClose) => (
            <Chat
              key={`vc${channel.id}`}
              channel={channel}
              state={state}
              ctx={ctx}
              onMenu={() => {}}
              onModal={(m) => setModal(m)}
              jumpTo={jumpTo?.channelId === channel.id ? jumpTo : null}
              onJumpStarted={(request) => setJumpTo((pending) => pending === request ? null : pending)}
              split={{ onClose, headless: true }}
              onSearch={() => setPanel({ kind: 'search' })}
              onPins={() => setPanel({ kind: 'pins', channelId: channel.id })}
              onLinks={() => setPanel({ kind: 'links', channelId: channel.id })}
              onThreads={() => setPanel({ kind: 'threads', channelId: channel.id })}
              onMembers={() => setPanel({ kind: 'members', channelId: channel.id })}
              onServices={() => setPanel({ kind: 'services', threadId: channel.id })}
            />
          )}
        />
      ) : channel && channel.type === 15 ? (
        <Forum key={`f${channel.id}`} channel={channel} state={state} onMenu={showChannels} onOpen={open} onSearch={() => setPanel({ kind: 'search' })} />
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
          onJumpStarted={(request) => setJumpTo((pending) => pending === request ? null : pending)}
          onSearch={() => setPanel({ kind: 'search' })}
          open={panel && (!('channelId' in panel) || panel.channelId === channel.id || panel.kind === 'threads') ? (panel.kind === 'services' && panel.threadId !== channel.id ? null : panel.kind) : null}
          onPins={() => togglePanel({ kind: 'pins', channelId: channel.id })}
          onLinks={() => togglePanel({ kind: 'links', channelId: channel.id })}
          onThreads={() => togglePanel({ kind: 'threads', channelId: channel.parent_id && state.threads.some((t) => t.id === channel.id) ? channel.parent_id : channel.id })}
          onMembers={() => togglePanel({ kind: 'members', channelId: channel.id })}
          onServices={() => setPanel((p) => (p?.kind === 'services' && p.threadId === channel.id ? null : { kind: 'services', threadId: channel.id }))}
          onWorkspace={() => setBoardLocation(state.me.id, channel.id, !(panel?.kind === 'workspace' && panel.channelId === channel.id))}
        />
      ) : (
        <section className="chat no-channel">
          <button className="icon-button menu" onClick={() => setDrawer(true)} aria-label="Channels">
            <Icon name="back" />
          </button>
          {dmHome ? (
            <Empty icon="chat" title="No conversation open">
              Pick someone on the left, or{' '}
              <button className="link-button" onClick={(e) => setLinkSheet(newDmSheet(state, below(e.currentTarget), open))}>
                start a new message
              </button>
              .
            </Empty>
          ) : can(P.MANAGE_GUILD, null, activeGuild) ? (
            <Welcome name={state.guilds?.find((g) => g.id === activeGuild)?.name ?? state.guild.name} />
          ) : (
            <Empty icon="hash" title="No channels yet">Channels shared with you show here.</Empty>
          )}
        </section>
      )}
      {panel?.kind === 'search' && <SearchPanel key="search" initial={panel.q} onClose={() => setPanel(null)} onJump={jump} />}
      {linkSheet && <Sheet spec={linkSheet} onClose={() => setLinkSheet(null)} />}
      <CallPill state={state} current={channel?.id ?? null} onOpen={open} />
      <Notice state={state} current={current} onOpen={(channelId, messageId) => jump(channelId, messageId)} />
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
      {panel?.kind === 'scheduled' && <ScheduledPanel key={`sch${panel.channelId ?? ''}`} channelId={panel.channelId} onClose={() => setPanel(null)} onJump={jump} onOpen={(id) => { setCurrent(id); setDrawer(false); if (window.matchMedia('(max-width: 767px)').matches) setPanel(null) }} />}
      {panel?.kind === 'inbox' && <InboxPanel onClose={() => setPanel(null)} onJump={(c, m) => { jump(c, m); setPanel(null) }} onOpen={(id) => { setCurrent(id); setDrawer(false); setPanel(null) }} />}
      {panel?.kind === 'mentions' && store.channel(panel.channelId) && can(P.READ_MESSAGE_HISTORY, panel.channelId) && <ChatMentions key={panel.channelId} channelId={panel.channelId} onClose={() => setPanel(null)} onJump={jump}/>}
      {panel?.kind === 'threads' && <ThreadsPanel key={`t${panel.channelId}`} channelId={panel.channelId} onClose={() => setPanel(null)} onOpen={(id) => { setCurrent(id); setDrawer(false); setPanel(null) }} onCreate={() => startThread(panel.channelId)} />}
      {panel?.kind === 'workspace' && channel?.id === panel.channelId && <WorkspacePanel key={`w${panel.channelId}`} channelId={panel.channelId} ctx={ctx} onClose={() => setBoardLocation(state.me.id, panel.channelId, false)} onJump={jump} onOpen={(id) => { setCurrent(id); setDrawer(false) }} onServices={() => setPanel({ kind: 'services', threadId: panel.channelId })} />}
      {wider && autoBoard && !panel && channel && sessionMap[channel.id] && <WorkspacePanel key={`aw${channel.id}`} channelId={channel.id} ctx={ctx} onClose={() => (localStorage.setItem('wide:workspace', 'off'), setAutoBoard(false))} onJump={jump} onOpen={(id) => { setCurrent(id); setDrawer(false) }} onServices={() => setPanel({ kind: 'services', threadId: channel.id })} />}
      {panel?.kind === 'members' && <MembersPanel key={`m${panel.channelId}`} channelId={panel.channelId} onClose={() => setPanel(null)} />}
      {panel?.kind === 'pins' && <PinsPanel key={`p${panel.channelId}`} channelId={panel.channelId} ctx={ctx} onClose={() => setPanel(null)} onJump={(c, m) => { jump(c, m); setPanel(null) }} />}
      {wide && !overview && !page && (!panel || (wider && panel.kind === 'workspace')) && <ActivityPane onOpen={open} />}
      {switcher === 'switcher' && <QuickSwitcher current={channel?.id ?? null} onOpen={open} onGuild={pickGuild} onClose={() => setSwitcher(null)} />}
      {switcher === 'shortcuts' && <ShortcutSheet onClose={() => setSwitcher(null)} />}
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
  // Signed in but in no server (never added, or removed from the last one): nothing to
  // open, and nothing wrong to retry.
  const noServer = useStore((d) => d.state !== null && !d.state.guild)
  const [error, setError] = useState('')
  const check = async () => {
    try {
      let status = await api.status()
      if (!status.signedIn && status.open) {
        await api.openSignIn()
        status = await api.status()
      }
      if (!status.signedIn) return setPhase('login')
      signedIn.local = Boolean(status.local)
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
  if (noServer)
    return (
      <div className="login">
        <div className="login-card" role="status">
          <div className="login-head">
            <h1>No servers yet</h1>
            <p>You're signed in, but no server on this hub has you in it yet. Ask the person who runs the hub to add you. Your servers show here once they do.</p>
          </div>
          <button className="button primary wide" onClick={() => void check()}>
            Check again
          </button>
          <button className="link-button login-help" onClick={() => void api.logout().then(() => location.reload())}>
            Sign out
          </button>
        </div>
      </div>
    )
  if (phase === 'login') return <Login onDone={() => void check()} />
  return <Main />
}

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const change = () => setMatch(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [query])
  return match
}
