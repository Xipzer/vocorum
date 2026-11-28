// Discord's Create Thread (a message starts a thread named by you) and Forward
// (the message, and an optional note, sent to up to five channels or DMs).

import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type Channel, type Message } from './api.ts'
import { DmAvatar } from './Avatar.tsx'
import { Icon } from './icons.tsx'
import type { MarkdownContext } from './markdown.tsx'
import { can, P } from './perms.ts'
import { sessionActions } from './Sheet.tsx'
import { dmName, isDm, store, THREAD_TYPES, useStore } from './store.ts'
import { recentVisits, score } from './Switcher.tsx'
import { leave, plain } from './text.ts'

const MAX_TARGETS = 5

function Dialog({ title, sub, className, onClose, onSubmit, children, footer }: { title: string; sub?: string; className: string; onClose: () => void; onSubmit: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  const overlay = useRef<HTMLDivElement>(null)
  const close = () => leave(overlay.current, onClose)
  return createPortal(
    <div ref={overlay} className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
      <form className={`modal ${className}`} role="dialog" aria-label={title} onSubmit={(e) => (e.preventDefault(), onSubmit())}>
        <div className="grab" />
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={close} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        {sub && <p className="modal-sub">{sub}</p>}
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </form>
    </div>,
    document.body,
  )
}

// The message being acted on, as one quoted line.
function Quote({ message, name, ctx }: { message: Message; name: string; ctx: MarkdownContext }) {
  const text = plain(message.content, ctx.userName, ctx.channelName) || (message.attachments.length ? `${message.attachments.length} attachment${message.attachments.length > 1 ? 's' : ''}` : '')
  return (
    <div className="message-quote">
      <strong>{name}</strong>
      <span>{text}</span>
    </div>
  )
}

/** Where Create Thread is offered: a text or announcement channel, with the permission, on a message without one. */
export function canStartThread(message: Message, channel: Channel | undefined) {
  return Boolean(channel && (channel.type === 0 || channel.type === 5) && message.channel_id === channel.id && !(message as Message & { thread?: unknown }).thread && can(P.CREATE_PUBLIC_THREADS, channel.id))
}

export function CreateThreadDialog({ message, name, ctx, onClose }: { message: Message; name: string; ctx: MarkdownContext; onClose: () => void }) {
  // As Discord: the message's text names the thread until you change it.
  const [title, setTitle] = useState(() => plain(message.content.trim().split('\n')[0]!, ctx.userName, ctx.channelName).trim().slice(0, 100))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = title.trim().length > 0 && !busy
  const create = () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    api.startThread(message.channel_id, message.id, title.trim()).then(
      (thread) => {
        store.apply('THREAD_CREATE', thread)
        onClose()
        sessionActions.openThread?.(thread.id)
      },
      (e: Error) => {
        setError(e.message)
        setBusy(false)
      },
    )
  }
  return (
    <Dialog
      title="Create Thread"
      className="message-dialog"
      onClose={onClose}
      onSubmit={create}
      footer={
        <>
          <button type="button" className="button medium" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button medium primary" disabled={!ready}>
            {busy ? 'Creating…' : 'Create Thread'}
          </button>
        </>
      }
    >
      <Quote message={message} name={name} ctx={ctx} />
      <label className="field">
        <span className="field-label">Thread Name</span>
        <input value={title} maxLength={100} autoFocus placeholder="New Thread" onFocus={(e) => e.target.select()} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {error && <div className="error">{error}</div>}
    </Dialog>
  )
}

type Target = { channel: Channel; label: string; sub: string }

export function ForwardDialog({ message, name, ctx, onClose }: { message: Message; name: string; ctx: MarkdownContext; onClose: () => void }) {
  const state = useStore((d) => d.state)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targets = useMemo(() => {
    if (!state) return []
    const guilds = store.guilds()
    const recent = recentVisits()
    const q = query.trim().toLowerCase().replace(/^[#@]/, '')
    const out: Array<Target & { rank: number }> = []
    for (const c of [...state.channels, ...state.threads]) {
      const dm = isDm(c)
      const thread = THREAD_TYPES.has(c.type)
      if (!dm && c.type !== 0 && c.type !== 5 && !thread) continue
      if (c.thread_metadata?.archived || c.thread_metadata?.locked) continue
      if (!dm && !can(thread ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES, c.id)) continue
      const label = dm ? dmName(c, state.me.id) : plain(c.name ?? '', ctx.userName, ctx.channelName) || 'untitled'
      const s = score(label, q)
      if (!s) continue
      const parent = thread ? state.channels.find((p) => p.id === c.parent_id)?.name : null
      const server = dm ? 'Direct Message' : (guilds.find((g) => g.id === c.guild_id)?.name ?? '')
      const at = recent.indexOf(c.id)
      out.push({ channel: c, label, sub: [parent, server].filter(Boolean).join(' · '), rank: s * 10 + (at < 0 ? 0 : 30 - at) })
    }
    return out.sort((a, b) => b.rank - a.rank).slice(0, 50)
  }, [state, query, ctx])
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_TARGETS ? [...p, id] : p))
  const send = async () => {
    if (!picked.length || busy) return
    setBusy(true)
    setError(null)
    try {
      for (const id of picked) {
        await api.forward(id, { channel_id: message.channel_id, message_id: message.id })
        // Discord sends the note as its own message, just after the forward.
        if (note.trim()) await api.send(id, { content: note.trim() })
      }
      onClose()
      store.notice(picked.length > 1 ? `Message forwarded to ${picked.length} places.` : 'Message forwarded.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Forward To"
      sub="Select where you want to share this message."
      className="message-dialog forward-dialog"
      onClose={onClose}
      onSubmit={() => void send()}
      footer={
        <>
          <input className="forward-note" value={note} maxLength={2000} placeholder="Add an optional message..." aria-label="Add an optional message" onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="button medium primary" disabled={!picked.length || busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </>
      }
    >
      <input className="forward-search" value={query} autoFocus placeholder="Search" aria-label="Search" spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), targets[0] && toggle(targets[0].channel.id))} />
      <div className="forward-list" role="listbox" aria-multiselectable="true" aria-label="Destinations">
        {targets.map(({ channel, label, sub }) => {
          const on = picked.includes(channel.id)
          return (
            <button type="button" key={channel.id} role="option" aria-selected={on} className={`forward-item${on ? ' on' : ''}`} onClick={() => toggle(channel.id)}>
              {isDm(channel) ? <DmAvatar channel={channel} size="inline" /> : <Icon name={THREAD_TYPES.has(channel.type) ? 'thread' : 'hash'} size={18} />}
              <span className="forward-label">{label}</span>
              {sub && <span className="forward-sub">{sub}</span>}
              <span className="forward-check">{on && <Icon name="check" size={14} />}</span>
            </button>
          )
        })}
        {targets.length === 0 && <div className="switcher-empty">Nothing matches.</div>}
      </div>
      <Quote message={message} name={name} ctx={ctx} />
      {error && <div className="error">{error}</div>}
    </Dialog>
  )
}
