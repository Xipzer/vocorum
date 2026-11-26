// In-app notifications, as Discord's: a message elsewhere that would notify you drops in at
// the top while the app is open. Who sent it (in their colour) · where, then the message;
// a bar runs down for 5 seconds (paused while touched or hovered). Tap opens it; swipe it
// up or aside to dismiss. A newer one replaces it.

import { useEffect, useRef, useState } from 'react'
import { Avatar, machineIcon } from './Avatar.tsx'
import type { HubState, Message } from './api.ts'
import { emojify } from './emoji.tsx'
import { Icon } from './icons.tsx'
import { effective } from './notify.ts'
import { agentName, dmName, isDm, machineOf, onIncoming, store, THREAD_TYPES } from './store.ts'
import { plain } from './text.ts'

const SHOWN_MS = 5000

type Shown = { message: Message; key: number }

// Whether this message would notify: someone else, a place that is not on screen, and the
// place's notification level (all; or mentions and it names you) and no mute.
function wanted(state: HubState, message: Message, current: string | null) {
  if (message.author.id === state.me.id || message.channel_id === current || document.visibilityState !== 'visible') return false
  const channel = state.channels.find((c) => c.id === message.channel_id) ?? state.threads.find((c) => c.id === message.channel_id)
  if (!channel) return false
  if (isDm(channel)) return true
  const { level, mutedUntil } = effective(state, channel)
  if (mutedUntil) return false
  if (level === 'all') return true
  if (level === 'nothing') return false
  const content = message.content ?? ''
  return content.includes(`<@${state.me.id}>`) || content.includes(`<@!${state.me.id}>`) || /@(everyone|here)\b/.test(content)
}

export function Notice({ state, current, onOpen }: { state: HubState; current: string | null; onOpen: (channelId: string, messageId: string) => void }) {
  const [shown, setShown] = useState<Shown | null>(null)
  const latest = useRef({ state, current })
  latest.current = { state, current }
  useEffect(
    () =>
      onIncoming((message) => {
        const { state, current } = latest.current
        if (wanted(state, message, current)) setShown({ message, key: Date.now() })
      }),
    [],
  )
  if (!shown) return null
  return <Card key={shown.key} state={state} message={shown.message} onOpen={onOpen} onClose={() => setShown(null)} />
}

function Card({ state, message, onOpen, onClose }: { state: HubState; message: Message; onOpen: (channelId: string, messageId: string) => void; onClose: () => void }) {
  const [paused, setPaused] = useState(false)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const left = useRef(SHOWN_MS)
  // The countdown, paused while held.
  useEffect(() => {
    if (paused) return
    const began = Date.now()
    const timer = setTimeout(onClose, left.current)
    return () => {
      clearTimeout(timer)
      left.current -= Date.now() - began
    }
  }, [paused])

  const channel = state.channels.find((c) => c.id === message.channel_id) ?? state.threads.find((c) => c.id === message.channel_id)!
  const thread = THREAD_TYPES.has(channel.type)
  const parent = thread ? state.channels.find((c) => c.id === channel.parent_id) : undefined
  const guildName = state.guilds?.find((g) => g.id === channel.guild_id)?.name ?? state.guild.name
  const machine = message.author.bot ? machineOf(state, channel) : null
  const name = machine ? agentName(state.machine_bots, machine) : (message.author.global_name ?? message.author.username)
  const color = state.users.find((u) => u.id === message.author.id)?.color
  const userName = (id: string) => state.users.find((u) => u.id === id)?.global_name ?? state.users.find((u) => u.id === id)?.username ?? null
  const channelName = (id: string) => state.channels.find((c) => c.id === id)?.name ?? state.threads.find((c) => c.id === id)?.name ?? null
  const text = plain(message.content ?? '', userName, channelName) || (message.attachments?.length ? 'Sent a file' : message.embeds?.[0]?.title ?? message.embeds?.[0]?.description ?? 'Sent a message')
  const where = isDm(channel) ? null : thread ? (
    <>
      <Icon name="thread" size={14} />
      <span className="notice-clip">{emojify(plain(channel.name ?? ''))}</span>
    </>
  ) : (
    <span className="notice-clip">
      #{channel.name}, {guildName}
    </span>
  )

  const open = () => {
    onClose()
    onOpen(message.channel_id, message.id)
  }
  return (
    <div
      className={`notice${paused ? ' paused' : ''}`}
      role="status"
      aria-live="polite"
      style={drag ? { transform: `translate(${drag.x}px, ${Math.min(0, drag.y)}px)`, opacity: Math.max(0.2, 1 - (Math.abs(drag.x) + Math.abs(Math.min(0, drag.y))) / 200), transition: 'none' } : undefined}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setPaused(false)}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY }
        setPaused(true)
      }}
      onPointerMove={(e) => start.current && e.buttons && setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y })}
      onPointerUp={() => {
        const moved = drag && (Math.abs(drag.x) > 60 || drag.y < -30)
        const tapped = !drag || (Math.abs(drag.x) < 6 && Math.abs(drag.y) < 6)
        start.current = null
        setDrag(null)
        setPaused(false)
        if (moved) onClose()
        else if (tapped) open()
      }}
      onPointerCancel={() => {
        start.current = null
        setDrag(null)
        setPaused(false)
      }}
    >
      <span className="notice-avatar">
        <Avatar id={message.author.id} name={name} size="panel" version={state.users.find((u) => u.id === message.author.id)?.avatar} src={machine ? machineIcon(state.machine_icons, machine, 'avatar') : null} />
      </span>
      <span className="notice-body">
        <span className="notice-head">
          <b style={color != null ? { color: `#${color.toString(16).padStart(6, '0')}` } : undefined}>{isDm(channel) ? dmName(channel, state.me.id) : emojify(name)}</b>
          {where && (
            <>
              <span className="notice-dot">·</span>
              <span className="notice-where">{where}</span>
            </>
          )}
        </span>
        <span className="notice-text">{emojify(text)}</span>
      </span>
      <button
        className="notice-close"
        aria-label="Dismiss"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <Icon name="close" size={16} />
      </button>
      <i className="notice-bar" style={{ animationDuration: `${SHOWN_MS}ms` }} />
    </div>
  )
}
