// The Overview: every session across machines that needs the owner, failed,
// is running, or finished since he last looked. Derived on the hub with no
// model; buttons are mirrored only when it is safe to answer from a summary.

import { isMac } from './columns.ts'
import { elapsedRun } from './run-clock.ts'
import { Fragment, useEffect, useRef, useState } from 'react'
import { api, type SessionSummary } from './api.ts'
import { Icon } from './icons.tsx'
import { Empty } from './Panels.tsx'
import { extensions } from './extensions.tsx'
import { snowflakeGt, store, useMachineName, useStore } from './store.ts'
import { plain } from './text.ts'

function age(iso: string | number, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

export const STYLE: Record<number, string> = { 1: ' primary', 3: ' success', 4: ' danger' }

// Dismissed items stay hidden until the session changes again (its `since` moves on).
const dismissed: Record<string, string> = JSON.parse(localStorage.getItem('dismissed') ?? '{}')
function dismiss(session: SessionSummary) {
  if (session.state === 'done') store.markSeen(session.id)
  dismissed[session.id] = session.since
  localStorage.setItem('dismissed', JSON.stringify(dismissed))
}

function Row({ session, now, onOpen, names, onDismiss }: { session: SessionSummary; now: number; onOpen: (id: string) => void; names: (text: string) => string; onDismiss: () => void }) {
  const [chose, setChose] = useState<string | null>(null)
  const machineName = useMachineName()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const raw = session.state === 'waiting' ? session.ask?.text : session.state === 'failed' ? session.error : session.state === 'busy' ? (session.lastStep ? `Last step: ${session.lastStep}` : 'Working') : undefined
  const line = raw && names(raw)
  const runAge = elapsedRun(session)
  const choose = async (customId: string, label: string) => {
    if (busy || !session.ask) return
    setBusy(true)
    setFailed(null)
    try {
      const result = await api.interaction({ type: 'button', customId, channelId: session.id, messageId: session.ask.messageId })
      if (result.type === 9) onOpen(session.id)
      else if (!result.acknowledged) setFailed("The bot didn't answer. Try again, or type your reply.")
      else setChose(label)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ov-item">
      <button className="ov-main" onClick={() => onOpen(session.id)}>
        <i className={`st ${session.state}`} />
        <span className="ov-title">
          {names(session.title)}
          <span className="ov-where">{[session.project, session.machine && machineName(session.machine)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="ov-age num">{session.state !== 'busy' ? age(session.since, now) : runAge !== null ? age(0, runAge) : ''}</span>
      </button>
      <button className="icon-button ov-dismiss" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        <Icon name="close" size={16} />
      </button>
      {line && <div className="ov-line">{line}</div>}
      {extensions.map((e) => e.OverviewNote && <e.OverviewNote key={e.id} session={session} />)}
      {session.state === 'waiting' &&
        (chose ? (
          <div className="ov-line num">
            Chose {chose} · {new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
          </div>
        ) : session.ask?.choices ? (
          <div className="action-row ov-choices">
            {session.ask.choices.map((c, i) => (
              <button key={c.customId} className={`button${STYLE[c.style] ?? ''}${busy ? ' busy' : ''}`} disabled={busy} onClick={() => void choose(c.customId, c.label)}>
                {c.label}
              </button>
            ))}
          </div>
        ) : (
          <button className="ov-open" onClick={() => onOpen(session.id)}>
            Open to answer <Icon name="chevron" size={14} />
          </button>
        ))}
      {failed && <div className="ov-line error">{failed}</div>}
    </div>
  )
}

const SECTIONS: Array<{ state: SessionSummary['state']; title: string }> = [
  { state: 'waiting', title: 'Needs you' },
  { state: 'failed', title: 'Failed' },
  { state: 'busy', title: 'Running' },
  { state: 'done', title: 'Done since you looked' },
]

// Wide (1500px of page and up): what needs him as a band of cards, then every machine's agents
// side by side, with extensions' footers and what finished in a rail from 2400px.
function useWidth() {
  const ref = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

const RANK: Record<string, number> = { busy: 0, waiting: 1, failed: 2, done: 3, idle: 4 }

function Grid({ width, groups, list, now, onOpen, names, onDismiss }: { width: number; groups: Array<{ state: SessionSummary['state']; title: string; items: SessionSummary[] }>; list: SessionSummary[]; now: number; onOpen: (id: string) => void; names: (text: string) => string; onDismiss: (s: SessionSummary) => void }) {
  const machines = useStore((d) => d.machines)
  const machineName = useMachineName()
  const needs = [...groups[0]!.items, ...groups[1]!.items]
  const done = groups[3]!.items
  const rail = width >= 2400
  const footers = extensions.map((e) => e.OverviewFooter && <e.OverviewFooter key={e.id} onOpen={onOpen} />)
  const named = [...new Set([...machines.map((m) => m.name), ...list.map((s) => s.machine).filter((m): m is string => Boolean(m))])]
  return (
    <div className={`ovg${rail ? ' with-rail' : ''}`}>
      <div className="ovg-main">
        <div className="ovg-band">
          <h3>Needs you{needs.length > 0 && <> · <span className="num">{needs.length}</span></>}</h3>
          <div className="ovg-cards">
            {needs.length === 0 && <div className="ov-empty">Nothing from the agents needs you.</div>}
            {needs.map((session) => <Row key={session.id} session={session} now={now} onOpen={onOpen} names={names} onDismiss={() => onDismiss(session)} />)}
            {extensions.map((e) => e.OverviewSection && <e.OverviewSection key={e.id} onOpen={onOpen} />)}
          </div>
        </div>
        <div className="ovg-band">
          <h3>Agents by machine</h3>
          <div className="ovg-machines">
            {named.map((name) => {
              const m = machines.find((x) => x.name === name)
              const mine = list.filter((s) => s.machine === name).sort((a, b) => RANK[a.state]! - RANK[b.state]! || b.since.localeCompare(a.since))
              const shown = mine.slice(0, 8)
              return (
                <div key={name} className="ovg-machine">
                  <div className="ovg-machine-head">
                    <i className={`dot${m?.online === false ? ' off' : ''}`} />
                    <b>{machineName(name)}</b>
                    <span className="ovg-counts num">{m?.online === false ? 'offline' : [m?.running && `${m.running} running`, m?.waiting && `${m.waiting} waiting`, m?.failed && `${m.failed} failed`].filter(Boolean).join(' · ') || 'idle'}</span>
                  </div>
                  {shown.length === 0 && <div className="ov-empty">No sessions lately.</div>}
                  {shown.map((s) => {
                    const run = elapsedRun(s)
                    const line = s.state === 'busy' ? s.lastStep : s.state === 'waiting' ? s.ask?.text : s.state === 'failed' ? s.error : undefined
                    return (
                      <button key={s.id} className={`ovg-row ${s.state}`} onClick={() => onOpen(s.id)}>
                        <i className={`st ${s.state}`} />
                        <span className="ovg-row-text">
                          <span className="ovg-row-title">{names(s.title)}</span>
                          {line && <span className="ovg-row-line">{names(line)}</span>}
                        </span>
                        <span className="ov-age num">{s.state === 'busy' && run !== null ? age(0, run) : age(s.since, now)}</span>
                      </button>
                    )
                  })}
                  {mine.length > shown.length && <div className="ovg-more num">{mine.length - shown.length} older</div>}
                </div>
              )
            })}
          </div>
        </div>
        {!rail && footers}
      </div>
      {rail && (
        <aside className="ovg-rail">
          {footers}
          {done.length > 0 && (
            <div className="ov-section">
              <h3>Done since you looked · <span className="num">{done.length}</span></h3>
              {done.map((session) => <Row key={session.id} session={session} now={now} onOpen={onOpen} names={names} onDismiss={() => onDismiss(session)} />)}
            </div>
          )}
        </aside>
      )}
    </div>
  )
}

// What needs you across the hub, as rows: the Overview page, and on a wide screen the
// Activity column beside every conversation.
export function OverviewBody({ onOpen, footer = true, width = 0 }: { onOpen: (id: string) => void; footer?: boolean; width?: number }) {
  const sessions = useStore((d) => d.sessions)
  const machines = useStore((d) => d.machines)
  const machineName = useMachineName()
  const seen = useStore((d) => d.seen)
  const users = useStore((d) => d.state?.users)
  const channels = useStore((d) => d.state?.channels)
  const names = (text: string) =>
    plain(
      text,
      (id) => {
        const u = users?.find((x) => x.id === id)
        return u ? (u.global_name ?? u.username) : null
      },
      (id) => channels?.find((c) => c.id === id)?.name ?? null,
    )
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const list = Object.values(sessions)
  const groups = SECTIONS.map((section) => ({
    ...section,
    items: list
      .filter((s) => s.state === section.state && dismissed[s.id] !== s.since && (section.state !== 'done' || snowflakeGt(s.lastMessageId, seen[s.id])))
      .sort((a, b) => (section.state === 'waiting' ? a.since.localeCompare(b.since) : b.since.localeCompare(a.since))),
  }))
  const running = groups[2]!.items.length
  // Items an extension holds for the person (its Inbox count): the Overview is not empty while there are any.
  const more = extensions.reduce((sum, e) => sum + (e.useInboxCount?.() ?? 0), 0)
  if (width >= 1500) return <Grid width={width} groups={groups} list={list} now={now} onOpen={onOpen} names={names} onDismiss={(session) => (dismiss(session), setNow(Date.now()))} />
  return (
    <div className="ov">
      {machines.length > 0 && (
        <div className="ov-machines">
          {machines.map((m) => {
            const inner = (
              <>
                <i className={`dot${m.online === false ? ' off' : ''}`} />
                <b>{machineName(m.name)}</b> {m.online === false ? 'offline' : m.failed ? `${m.failed} failed` : m.running ? `${m.running} running` : m.waiting ? `${m.waiting} waiting` : 'idle'}
              </>
            )
            return <span key={m.name}>{inner}</span>
          })}
        </div>
      )}
      {groups.every((g) => g.items.length === 0) && more === 0 && <Empty icon="check" title="Nothing needs you">{running ? `${running} running.` : undefined}</Empty>}
      {groups.map((group) => (
        <Fragment key={group.state}>
          {group.items.length > 0 && (
            <div className="ov-section">
              <h3>
                {group.title} · <span className="num">{group.items.length}</span>
              </h3>
              {group.items.map((session) => (
                <Row key={session.id} session={session} now={now} onOpen={onOpen} names={names} onDismiss={() => (dismiss(session), setNow(Date.now()))} />
              ))}
            </div>
          )}
          {group.state === 'waiting' && extensions.map((e) => e.OverviewSection && <e.OverviewSection key={e.id} onOpen={onOpen} />)}
        </Fragment>
      ))}
      {footer && extensions.map((e) => e.OverviewFooter && <e.OverviewFooter key={e.id} onOpen={onOpen} />)}
    </div>
  )
}

// Wide screens (2400px and up): the Overview as a column beside the open conversation.
export function ActivityPane({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <aside className="side-panel activity-pane" role="complementary" aria-label="Activity">
      <header className="panel-head">
        <Icon name="eye" size={20} className="panel-icon" />
        <button className="panel-title link-title" onClick={() => onOpen('overview')} title="Open the Overview">Activity</button>
      </header>
      <div className="panel-body">
        <OverviewBody onOpen={onOpen} />
      </div>
    </aside>
  )
}

export function Overview({ onMenu, onOpen, onSearch }: { onMenu: () => void; onOpen: (id: string) => void; onSearch: () => void }) {
  const sessions = useStore((d) => d.sessions)
  const machines = useStore((d) => d.machines)
  const list = Object.values(sessions)
  const active = list.filter((s) => s.state === 'waiting' || s.state === 'busy' || s.state === 'failed').length
  const [page, width] = useWidth()
  return (
    <section ref={page} className="chat overview">
      <header className="chat-header">
        <button className="icon-button menu" onClick={onMenu} aria-label="Channels">
          <Icon name="back" size={22} className="phone-only" />
          <Icon name="sidebar" size={20} className="desk-only-icon" />
        </button>
        <div className="chat-titles">
          <span className="chat-title">
            <Icon name="eye" size={20} className="title-icon" />
            Overview
          </span>
          <span className="chat-sub">
            {machines.length} {machines.length === 1 ? 'machine' : 'machines'} · {active} active {active === 1 ? 'session' : 'sessions'}
          </span>
        </div>
        <span className="chat-actions">
          <button className="icon-button" onClick={onSearch} aria-label="Search messages" title={`Search (${isMac ? "⌘F" : "Ctrl+F"})`}>
            <Icon name="search" />
          </button>
        </span>
      </header>
      <div className="messages">
        <OverviewBody onOpen={onOpen} width={width} />
      </div>
    </section>
  )
}
