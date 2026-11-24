// The Overview: every session across machines that needs the owner, failed,
// is running, or finished since he last looked. Derived on the hub with no
// model; buttons are mirrored only when it is safe to answer from a summary.

import { isMac } from './columns.ts'
import { useEffect, useState } from 'react'
import { api, type SessionSummary } from './api.ts'
import { Icon } from './icons.tsx'
import { Empty } from './Panels.tsx'
import { snowflakeGt, store, useStore } from './store.ts'
import { plain, machineLabel } from './text.ts'

function age(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

const STYLE: Record<number, string> = { 1: ' primary', 3: ' success', 4: ' danger' }

// Dismissed items stay hidden until the session changes again (its `since` moves on).
const dismissed: Record<string, string> = JSON.parse(localStorage.getItem('dismissed') ?? '{}')
function dismiss(session: SessionSummary) {
  if (session.state === 'done') store.markSeen(session.id)
  dismissed[session.id] = session.since
  localStorage.setItem('dismissed', JSON.stringify(dismissed))
}

function Row({ session, now, onOpen, names, onDismiss }: { session: SessionSummary; now: number; onOpen: (id: string) => void; names: (text: string) => string; onDismiss: () => void }) {
  const [chose, setChose] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const raw = session.state === 'waiting' ? session.ask?.text : session.state === 'failed' ? session.error : session.state === 'busy' ? (session.lastStep ? `Last step: ${session.lastStep}` : 'Working') : undefined
  const line = raw && names(raw)
  const choose = async (customId: string, label: string) => {
    if (busy || !session.ask) return
    setBusy(true)
    setFailed(null)
    try {
      const result = await api.interaction({ type: 'button', customId, channelId: session.id, messageId: session.ask.messageId })
      if (result.type === 9) onOpen(session.id)
      else if (!result.acknowledged) setFailed('This interaction failed')
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
          <span className="ov-where">{[session.project, session.machine && machineLabel(session.machine)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="ov-age num">{age(session.since, now)}</span>
      </button>
      <button className="icon-button ov-dismiss" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        <Icon name="close" size={16} />
      </button>
      {line && <div className="ov-line">{line}</div>}
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

export function Overview({ onMenu, onOpen, onSearch }: { onMenu: () => void; onOpen: (id: string) => void; onSearch: () => void }) {
  const sessions = useStore((d) => d.sessions)
  const machines = useStore((d) => d.machines)
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
  const active = list.filter((s) => s.state === 'waiting' || s.state === 'busy' || s.state === 'failed').length
  return (
    <section className="chat overview">
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
        <div className="ov">
          {machines.length > 0 && (
            <div className="ov-machines">
              {machines.map((m) => (
                <span key={m.name}>
                  <i className={`dot${m.online === false ? ' off' : ''}`} />
                  <b>{machineLabel(m.name)}</b> {m.online === false ? 'offline' : m.failed ? `${m.failed} failed` : m.running ? `${m.running} running` : m.waiting ? `${m.waiting} waiting` : 'idle'}
                </span>
              ))}
            </div>
          )}
          {groups.every((g) => g.items.length === 0) && <Empty icon="check" title="Nothing needs you">{running ? `${running} running.` : undefined}</Empty>}
          {groups.map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.state} className="ov-section">
                <h3>
                  {group.title} · <span className="num">{group.items.length}</span>
                </h3>
                {group.items.map((session) => (
                  <Row key={session.id} session={session} now={now} onOpen={onOpen} names={names} onDismiss={() => (dismiss(session), setNow(Date.now()))} />
                ))}
              </div>
            ),
          )}
        </div>
      </div>
    </section>
  )
}
