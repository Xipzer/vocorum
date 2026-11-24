// The message pane: header, messages (grouped like Discord, tool lines folded
// into steps) and the footer, which is the whole input area.

import { isMac } from './columns.ts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { api, type Channel, type Component, type HubState, type InteractionResult, type Message } from './api.ts'
import { Avatar, machineIcon } from './Avatar.tsx'
import { EmojiPicker } from './EmojiPicker.tsx'
import { Components, type Interact } from './components.tsx'
import { Attachments, Embeds, Forwarded, onlyEmbedLink, PollCard, stamp, Stickers } from './Media.tsx'
import { Composer } from './Composer.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { snowflakeGt, store, THREAD_TYPES, useStore } from './store.ts'
import { workspaceWaiting } from './Workspace.tsx'
import { Icon, type IconName } from './icons.tsx'
import { clock, plain, wallHue, machineLabel } from './text.ts'
import { shareOrigin } from './native.ts'
import { bellSheet, effective } from './notify.ts'
import { below, Sheet, sessionActions, usePress, type SheetAction, type SheetAt, type SheetSpec } from './Sheet.tsx'
import { can, isHubOwner, P } from './perms.ts'

const IS_COMPONENTS_V2 = 1 << 15
const IS_VOICE = 1 << 13
const EPHEMERAL = 1 << 6
const SPEEDS = [1, 1.5, 2]

function VoiceMessage({ url, duration, waveform }: { url: string; duration?: number; waveform?: string }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [speed, setSpeed] = useState(0)
  const bars = (() => {
    try {
      const bytes = [...atob(waveform ?? '')].map((c) => c.charCodeAt(0))
      if (!bytes.length) return Array.from({ length: 48 }, () => 0.3)
      return Array.from({ length: 48 }, (_, i) => (bytes[Math.floor((i / 48) * bytes.length)] ?? 0) / 255)
    } catch {
      return Array.from({ length: 48 }, () => 0.3)
    }
  })()
  const length = duration ? `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}` : ''
  return (
    <div className="voice-message">
      <button className="voice-play" onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())} aria-label={playing ? 'Pause' : 'Play'}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <div className="voice-wave">
        {bars.map((value, index) => (
          <span key={index} className={index / bars.length < progress ? 'played' : ''} style={{ height: `${Math.max(14, value * 100)}%` }} />
        ))}
      </div>
      <span className="voice-time">{length}</span>
      <button
        className="voice-speed"
        onClick={() => {
          const next = (speed + 1) % SPEEDS.length
          setSpeed(next)
          if (audio.current) audio.current.playbackRate = SPEEDS[next]!
        }}
        aria-label="Playback speed"
      >
        {SPEEDS[speed]}×
      </button>
      <audio
        ref={audio}
        src={url}
        preload="none"
        onPlay={(e) => {
          e.currentTarget.playbackRate = SPEEDS[speed]!
          setPlaying(true)
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setProgress(0)
        }}
        onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || duration || 1))}
      />
    </div>
  )
}

// What a reply shows for a message with no text.
function attachmentLabel(message: Message) {
  const first = message.attachments[0]
  if (!first) return 'Message'
  if (((message.flags ?? 0) & IS_VOICE) !== 0) {
    const s = Math.round(first.duration_secs ?? 0)
    return s ? `Voice message, ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Voice message'
  }
  const type = first.content_type ?? ''
  const kind = type.startsWith('image/') ? 'Image' : type.startsWith('video/') ? 'Video' : type.startsWith('audio/') ? 'Audio' : first.filename
  return message.attachments.length > 1 ? `${kind} and ${message.attachments.length - 1} more` : kind
}

// A bot message still waiting on the owner: live buttons or selects, or a mention of him.
function hasOpenComponents(components: Component[] | undefined): boolean {
  return (components ?? []).some((c) => ((c.type === 2 && c['style'] !== 5) || (c.type >= 3 && c.type <= 8 && c.type !== 4)) ? !c['disabled'] : hasOpenComponents(c['components']) || (c['accessory'] ? hasOpenComponents([c['accessory']]) : false))
}

// Kimaki's tool lines: a message made only of "-# ┣ ..." / "-# ◼︎ ..." subtext lines.
// A turn footer, which may end with a ping of the owner (a notification, not a question).
const FOOTER = /^(-#|>) \*?[^\n]*⋅[^\n]*\d+%[^\n]*?\*?(\s*<@!?\d+>)?\s*$/m
const TOOL_LINE = /^-# (.*(┣|◼︎|◼|■)|\*?_?thinking\b)/
function isToolOnly(m: Message) {
  if (!m.author.bot || m.attachments.length || m.components?.length || m.embeds.length || !m.content) return false
  const lines = m.content.split('\n').filter((l) => l.trim())
  return lines.length > 0 && lines.every((l) => TOOL_LINE.test(l))
}
function toolName(line: string) {
  return plain(line.replace(/^-#\s*/, '').replace(/^(┣|◼︎|◼|■)\s*/, '')).split(/\s+/).slice(0, 2).join(' ')
}

function Steps({ messages, ctx }: { messages: Message[]; ctx: MarkdownContext }) {
  const [open, setOpen] = useState(false)
  const lines = messages.flatMap((m) => m.content.split('\n').filter((l) => l.trim()))
  // The newest step says what the agent is doing: "Add the session.links route…".
  const latest = plain(lines.at(-1)!.replace(/^-#\s*/, '').replace(/^(┣|◼︎|◼|■)\s*/, ''))
  const summary = latest.replace(/^(shell|bash|write|edit|read|grep|glob|task|subagent|webfetch|websearch|thinking|todowrite|apply_patch)\s+/i, '') || toolName(lines.at(-1)!)
  return (
    <div className="message compact">
      <button className={`steps${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={14} />
        <b>
          {lines.length} {lines.length === 1 ? 'step' : 'steps'}
        </b>
        <span className="what">{summary}</span>
      </button>
      {open && (
        <div className="steps-list">
          <Markdown text={lines.join('\n')} ctx={ctx} />
        </div>
      )}
    </div>
  )
}

// Discord's welcome lines, picked by the join time the way Discord does.
const WELCOME = [
  (n: ReactNode) => <>{n} joined the party.</>,
  (n: ReactNode) => <>{n} is here.</>,
  (n: ReactNode) => <>Welcome, {n}. We hope you brought pizza.</>,
  (n: ReactNode) => <>A wild {n} appeared.</>,
  (n: ReactNode) => <>{n} just landed.</>,
  (n: ReactNode) => <>{n} just slid into the server.</>,
  (n: ReactNode) => <>{n} just showed up!</>,
  (n: ReactNode) => <>Welcome {n}. Say hi!</>,
  (n: ReactNode) => <>{n} hopped into the server.</>,
  (n: ReactNode) => <>Everyone welcome {n}!</>,
  (n: ReactNode) => <>Glad you're here, {n}.</>,
  (n: ReactNode) => <>Good to see you, {n}.</>,
  (n: ReactNode) => <>Yay you made it, {n}!</>,
]

// Discord's system rows that are a single line with an icon.
function systemLine(message: Message, name: string, state: HubState, ctx: MarkdownContext): { icon: IconName; text: ReactNode; tone?: string } | null {
  const who = <strong>{name}</strong>
  const other = message.mentions?.[0]
  const otherName = other ? <strong>{other.global_name ?? other.username}</strong> : <strong>someone</strong>
  const place = state.threads.some((t) => t.id === message.channel_id) ? 'thread' : 'group'
  switch (message.type) {
    case 1:
      return { icon: 'join', tone: 'ok', text: <>{who} added {otherName} to the {place}.</> }
    case 2:
      return other && other.id !== message.author.id ? { icon: 'leave', tone: 'bad', text: <>{who} removed {otherName} from the {place}.</> } : { icon: 'leave', tone: 'bad', text: <>{who} left the {place}.</> }
    case 3: {
      const end = message.call?.ended_timestamp
      const minutes = end ? Math.max(1, Math.round((new Date(end).getTime() - new Date(message.timestamp).getTime()) / 60_000)) : 0
      return { icon: 'phone', tone: end ? undefined : 'ok', text: end ? <>{who} started a call that lasted {minutes} {minutes === 1 ? 'minute' : 'minutes'}.</> : <>{who} started a call.</> }
    }
    case 5:
      return { icon: 'image', text: <>{who} changed the channel icon.</> }
    case 7:
      return { icon: 'join', tone: 'ok', text: WELCOME[new Date(message.timestamp).getTime() % WELCOME.length]!(who) }
    case 8:
    case 9:
    case 10:
    case 11: {
      const times = Number(message.content) > 1 ? <> <strong>{message.content}</strong> times</> : null
      const tier = message.type > 8 ? <> {state.guild.name} has achieved <strong>Level {message.type - 8}!</strong></> : null
      return { icon: 'boost', tone: 'boost', text: <>{who} just boosted the server{times}!{tier}</> }
    }
    case 12:
      return { icon: 'join', text: <>{who} has added <strong>{plain(message.content, ctx.userName, ctx.channelName)}</strong> to this channel. Its most important updates will show up here.</> }
    case 46: {
      const field = (key: string) => message.embeds[0]?.fields?.find((f) => f.name === key)?.value
      const question = field('poll_question_text')
      const victor = field('victor_answer_text')
      return { icon: 'poll', text: <>{who}'s poll <strong>{question ?? ''}</strong> has closed.{victor ? <> <strong>{victor}</strong> won.</> : null}</> }
    }
  }
  return null
}

// Quick reactions on the hover toolbar, as in Discord.
const QUICK = ['👍', '✅', '👀']

function MessageItem({
  message,
  compact,
  ctx,
  state,
  channelId,
  byId,
  onReply,
  onJump,
  onResult,
  onError,
  botName,
  onSheet,
  current,
  feed = false,
}: {
  feed?: boolean
  current: boolean
  botName: string | null
  onSheet: (spec: SheetSpec) => void
  message: Message
  compact: boolean
  ctx: MarkdownContext
  state: HubState
  channelId: string
  byId: Map<string, Message>
  onReply: (m: Message) => void
  onJump: (id: string) => void
  onResult: (result: InteractionResult, messageId: string) => void
  onError: (text: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [picker, setPicker] = useState<DOMRect | null>(null)
  // Reactions toggle like Discord's: yours lights up; clicking it again (on the message or
  // the toolbar) takes it off.
  const mineOn = (emoji: string) => Boolean(message.reactions_summary?.find((r) => r.emoji === emoji)?.me)
  const toggle = (emoji: string) => void api.react(channelId, message.id, emoji, !mineOn(emoji)).catch((e: Error) => onError(e.message))
  const canManage = can(P.MANAGE_MESSAGES, channelId)
  const mine = message.author.id === state.me.id
  const pinOk = can(P.PIN_MESSAGES, channelId) || can(P.MANAGE_MESSAGES, channelId)
  const profile = state.users.find((u) => u.id === message.author.id)
  const name = (message.author.bot && botName && machineLabel(botName)) || (message.author.global_name ?? message.author.username)
  const v2 = ((message.flags ?? 0) & IS_COMPONENTS_V2) !== 0
  // type 1 references are forwards; the original rides along as a snapshot.
  const forward = message.message_reference?.type === 1 ? message.message_snapshots?.[0]?.message : undefined
  const forwardChannel = forward && message.message_reference?.channel_id ? ctx.channelName(message.message_reference.channel_id) : null
  const forwardSource = forwardChannel ? `#${forwardChannel}` : null
  const replyId = !forward && message.message_reference?.type !== 1 ? message.message_reference?.message_id : undefined
  const reference = replyId ? byId.get(replyId) : undefined
  const embeds = message.embeds.filter((embed) => !feed || !embed.type || embed.type === 'rich')
  const used = message.interaction_metadata ?? message.interaction
  const usedName = message.interaction_metadata?.name ?? message.interaction?.name
  const needs = current && message.author.bot && (hasOpenComponents(message.components) || (message.content.includes(`<@${state.me.id}>`) && !FOOTER.test(message.content)))
  // Kimaki's errors start with a cross: they read red, and an actionable one gets a red band.
  const failed = message.author.bot && /^\s*[×✗✕❌]\s/.test(message.content)
  const interact: Interact = async (body) => {
    try {
      const result = await api.interaction({ ...body, channelId, messageId: message.id })
      onResult(result, message.id)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }
  const openMenu = (at: SheetAt) =>
    onSheet({
      at,
      title: name,
      subtitle: plain(message.content, ctx.userName, ctx.channelName).slice(0, 80) || undefined,
      groups: [
        [
          { label: 'Add reaction', icon: 'smile', run: () => setPicker('rect' in at ? at.rect : new DOMRect(at.x, at.y, 0, 0)) },
          { label: 'Reply', icon: 'reply', run: () => onReply(message) },
        ],
        [
          ...(message.content ? [{ label: 'Copy text', icon: 'copy' as const, run: () => void navigator.clipboard?.writeText(message.content) }] : []),
          { label: 'Copy link', icon: 'link', run: () => void navigator.clipboard?.writeText(`${shareOrigin()}/#/c/${channelId}`) },
          ...(pinOk ? [{ label: message.pinned ? 'Unpin' : 'Pin', icon: 'pin' as const, run: () => void api.pin(channelId, message.id, !message.pinned).catch((e: Error) => onError(e.message)) }] : []),
        ],
        mine && message.content ? [{ label: 'Edit', icon: 'pencil', run: () => setEditing(message.content) }] : [],
        mine || canManage ? [{ label: 'Delete', icon: 'trash', red: true, run: () => confirmDelete(at) }] : [],
      ],
    })
  // As in Discord, deleting asks first: there is no undo.
  const confirmDelete = (at: SheetAt) =>
    onSheet({
      at,
      title: 'Delete message?',
      confirm: true,
      subtitle: plain(message.content, ctx.userName, ctx.channelName).slice(0, 80) || undefined,
      groups: [[{ label: 'Delete', icon: 'trash', red: true, run: () => void api.remove(channelId, message.id).catch((e: Error) => onError(e.message)) }]],
    })
  const press = usePress(openMenu)
  if (message.type === 6) {
    const target = message.message_reference?.message_id
    return (
      <div className="message system">
        <Icon name="pin" size={14} />
        <span className="clip">
          <strong>{name}</strong> pinned{' '}
          {target ? (
            <button className="link-button" onClick={() => onJump(target)}>
              a message
            </button>
          ) : (
            'a message'
          )}
        </span>
        <span className="message-time">{clock(message.timestamp)}</span>
      </div>
    )
  }
  if (message.type === 18) return <ThreadCreated message={message} name={name} state={state} ctx={ctx} />
  const system = systemLine(message, name, state, ctx)
  if (system)
    return (
      <div id={`m-${message.id}`} className={`message system ${system.tone ?? ''}`}>
        <Icon name={system.icon} size={16} />
        <span className="clip">{system.text}</span>
        <span className="message-time">{clock(message.timestamp)}</span>
      </div>
    )
  if (message.type === 4) {
    return (
      <div className="message system">
        <Icon name="pencil" size={14} />
        <span className="clip">
          <strong>{name}</strong> renamed the {state.threads.some((t) => t.id === channelId) ? 'session' : 'channel'} to <strong>{plain(message.content, ctx.userName, ctx.channelName)}</strong>
        </span>
        <span className="message-time">{clock(message.timestamp)}</span>
      </div>
    )
  }
  return (
    <div id={`m-${message.id}`} className={`message${compact ? ' compact' : ''}${mine ? ' you' : ''}${needs ? ' needs' : ''}${failed ? ' failed' : ''}`} {...press}>
      {replyId &&
        (reference ? (
          <div className="reply-preview" onClick={() => onJump(reference.id)}>
            <span className="reply-spine" />
            <span className="reply-avatar">
              <Avatar id={reference.author.id} name={reference.author.global_name ?? reference.author.username} size="inline" version={state.users.find((u) => u.id === reference.author.id)?.avatar} src={reference.author.bot ? machineIcon(state.machine_icons, botName, 'avatar') : null} />
            </span>
            <strong>{(reference.author.bot && botName && machineLabel(botName)) || (reference.author.global_name ?? reference.author.username)}</strong>
            <span className="reply-text">{plain(reference.content, ctx.userName, ctx.channelName).slice(0, 160) || attachmentLabel(reference)}</span>
            {!reference.content && (reference.attachments.length > 0 || reference.embeds.length > 0) && <Icon name="image" size={16} className="reply-media" />}
          </div>
        ) : (
          <div className="reply-preview missing" onClick={() => onJump(replyId)}>
            <span className="reply-spine" />
            <span className="reply-text">Click to see the original message</span>
          </div>
        ))}
      {!reference && used && (
        <div className="reply-preview interaction">
          <span className="reply-spine" />
          <span className="reply-avatar">
            <Avatar id={used.user.id} name={used.user.global_name ?? used.user.username} size="inline" version={state.users.find((u) => u.id === used.user.id)?.avatar} />
          </span>
          <strong>{used.user.global_name ?? used.user.username}</strong>
          <span className="reply-text">
            used <span className="used-command">{usedName ? `/${usedName}` : 'a command'}</span>
          </span>
        </div>
      )}
      <div className="message-body">
        {!compact && (
          <div className="message-head">
            <Avatar id={message.author.id} name={name} size="inline" version={profile?.avatar} src={message.author.bot ? machineIcon(state.machine_icons, botName, 'avatar') : null} />
            <span className="author" style={profile?.color != null ? { color: `#${profile.color.toString(16).padStart(6, '0')}` } : undefined} title={message.author.bot && botName ? (message.author.global_name ?? message.author.username) : undefined}>
              {name}
            </span>
            {message.author.bot && <span className="bot-tag">BOT</span>}
            <span className="message-time">{clock(message.timestamp)}</span>
          </div>
        )}
        {editing !== null ? (
          <div className="edit-box">
            <textarea
              autoFocus
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(null)
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void api.edit(channelId, message.id, editing).then(() => setEditing(null), (err: Error) => onError(err.message))
                }
              }}
            />
            <div className="subtext">Esc to cancel, Enter to save</div>
          </div>
        ) : (
          !v2 && !onlyEmbedLink(message.content, embeds) && <Markdown text={message.content} ctx={ctx} />
        )}
        {editing === null && message.edited_timestamp && !message.author.bot && (
          <span className="edited-tail" title={`Edited ${stamp(message.edited_timestamp)}`}>
            (edited)
          </span>
        )}
        {forward && <Forwarded snapshot={forward} ctx={ctx} source={forwardSource} onSource={message.message_reference?.channel_id && ctx.openChannel ? () => ctx.openChannel!(message.message_reference!.channel_id!) : undefined} />}
        <Embeds embeds={embeds} ctx={ctx} />
        <Attachments attachments={message.attachments} flags={message.flags} voice={(a) => <VoiceMessage url={a.url} duration={a.duration_secs} waveform={a.waveform} />} />
        {message.sticker_items?.length ? <Stickers items={message.sticker_items} /> : null}
        {message.poll && <PollCard poll={message.poll} />}
        {message.components?.length ? <Components components={message.components} ctx={ctx} interact={interact} /> : null}
        {((message.flags ?? 0) & EPHEMERAL) !== 0 && <div className="ephemeral">Only you can see this</div>}
        {message.reactions_summary?.length ? (
          <div className="reactions">
            {message.reactions_summary.map((r) => (
              <button key={r.emoji} className={`reaction${r.me ? ' me' : ''}`} onClick={() => toggle(r.emoji)} aria-pressed={r.me} title={r.me ? (r.count > 1 ? `You and ${r.count - 1} more reacted (click to remove)` : 'You reacted (click to remove)') : `${r.count} reacted (click to add yours)`}>
                <span className="reaction-emoji">{r.emoji}</span>
                <span className="num">{r.count}</span>
              </button>
            ))}
            <button className="reaction add" onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())} aria-label="Add reaction" title="Add reaction">
              <Icon name="smile" size={18} />
            </button>
          </div>
        ) : null}
        {picker && <EmojiPicker anchor={picker} onPick={(e) => !mineOn(e) && toggle(e)} onClose={() => setPicker(null)} />}
        {!feed && (message as Message & { thread?: { id: string } }).thread?.id !== channelId && message.id !== channelId && <StarterThread messageId={message.id} threadId={(message as Message & { thread?: { id: string } }).thread?.id} state={state} ctx={ctx} />}
      </div>
      <div className="message-actions" role="toolbar" aria-label="Message actions">
        {QUICK.map((emoji) => (
          <button key={emoji} className={`quick${mineOn(emoji) ? ' on' : ''}`} onClick={() => toggle(emoji)} aria-pressed={mineOn(emoji)} aria-label={`React ${emoji}`} title={mineOn(emoji) ? `Remove ${emoji}` : `React ${emoji}`}>
            {emoji}
          </button>
        ))}
        <button onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())} aria-label="Add reaction" title="Add reaction">
          <Icon name="smile" size={20} />
        </button>
        <i className="actions-rule" />
        <button onClick={() => onReply(message)} aria-label="Reply" title="Reply">
          <Icon name="reply" size={20} />
        </button>
        {mine && message.content && (
          <button onClick={() => setEditing(message.content)} aria-label="Edit" title="Edit">
            <Icon name="pencil" size={20} />
          </button>
        )}
        {pinOk && (
          <button onClick={() => void api.pin(channelId, message.id, !message.pinned).catch((e: Error) => onError(e.message))} aria-label={message.pinned ? 'Unpin' : 'Pin'} title={message.pinned ? 'Unpin' : 'Pin'}>
            <Icon name="pin" size={20} />
          </button>
        )}
        <button onClick={(e) => openMenu(below(e.currentTarget))} aria-label="More" title="More">
          <Icon name="more" size={20} />
        </button>
      </div>
    </div>
  )
}

// "X started a thread": the thread as a card you can open, like Discord's.
function ThreadCreated({ message, name, state, ctx }: { message: Message; name: string; state: HubState; ctx: MarkdownContext }) {
  const id = message.message_reference?.channel_id
  const thread = id ? state.threads.find((t) => t.id === id) : undefined
  const threadName = plain(thread?.name ?? message.content, ctx.userName, ctx.channelName)
  return (
    <div id={`m-${message.id}`} className="message system thread-created">
      <Icon name="thread" size={14} />
      <div className="clip">
        <span>
          <strong>{name}</strong> started a thread: <strong>{threadName}</strong>
        </span>
        <span className="message-time">{clock(message.timestamp)}</span>
        {id && <ThreadCard id={id} name={threadName} thread={thread} />}
      </div>
    </div>
  )
}

// A message that seeded a thread (the thread has the message's id) carries its card, as in Discord.
function StarterThread({ messageId, threadId, state, ctx }: { messageId: string; threadId?: string; state: HubState; ctx: MarkdownContext }) {
  const thread = state.threads.find((t) => t.id === (threadId ?? messageId))
  if (!thread) return null
  return <ThreadCard id={thread.id} name={plain(thread.name ?? '', ctx.userName, ctx.channelName)} thread={thread} />
}

function ThreadCard({ id, name, thread }: { id: string; name: string; thread?: Channel }) {
  const session = useStore((d) => d.sessions[id])
  const last = thread?.last_message_id
  const count = thread?.message_count
  return (
    <a
      className="thread-card"
      href={`#/c/${id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || !sessionActions.openThread) return
        e.preventDefault()
        sessionActions.openThread(id)
      }}
    >
      <span className="thread-card-name">
        <i className={`st ${session?.state ?? 'idle'}`} />
        {name}
        <span className="thread-card-count num">
          {count ? `${count} ${count === 1 ? 'message' : 'messages'}` : 'Open'}
          <Icon name="chevron" size={12} />
        </span>
      </span>
      {(session?.lastStep || last) && (
        <span className="thread-card-meta">
          {session?.lastStep && <span className="thread-card-last">{session.lastStep}</span>}
          {last && <span className="muted num">{ago(snowflakeDate(last))}</span>}
        </span>
      )}
    </a>
  )
}
const snowflakeDate = (id: string) => new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString()

// Desktop search: a field-shaped button in the header, like Discord's, that opens the search panel.
function SearchField({ onSearch }: { onSearch: () => void }) {
  return (
    <button className="search-field desk-only" onClick={onSearch} aria-label="Search messages">
      <span>Search</span>
      <kbd>{isMac ? '⌘F' : 'Ctrl F'}</kbd>
      <Icon name="search" size={16} />
    </button>
  )
}

const dayLabel = (iso: string) => {
  const d = new Date(iso).toDateString()
  if (new Date().toDateString() === d) return 'Today'
  if (new Date(Date.now() - 86_400_000).toDateString() === d) return 'Yesterday'
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

const when = (iso: string) => {
  const label = dayLabel(iso)
  return label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : `on ${label}`
}

type Item = { kind: 'message'; message: Message; compact: boolean } | { kind: 'steps'; id: string; messages: Message[] } | { kind: 'day'; id: string; label: string; count?: number }

function items(list: Message[]): Item[] {
  const out: Item[] = []
  let prev: Message | undefined
  for (const message of list) {
    if (!prev || new Date(prev.timestamp).toDateString() !== new Date(message.timestamp).toDateString()) {
      out.push({ kind: 'day', id: `day-${message.id}`, label: dayLabel(message.timestamp) })
      prev = undefined
    }
    const last = out.at(-1)
    if (isToolOnly(message)) {
      if (last?.kind === 'steps') last.messages.push(message)
      else out.push({ kind: 'steps', id: message.id, messages: [message] })
      prev = message
      continue
    }
    const compact = Boolean(prev && prev.author.id === message.author.id && !message.message_reference && !message.interaction_metadata && !message.interaction && (prev.type === 0 || prev.type === 19 || prev.type === 20) && new Date(message.timestamp).getTime() - new Date(prev.timestamp).getTime() < 7 * 60_000)
    out.push({ kind: 'message', message, compact })
    prev = message
  }
  return out
}

type FeedItem = Item | { kind: 'run'; id: string; messages: Message[] }

// The headline shape of a post, numbers and hashes blanked: "Deployed build #".
function signature(m: Message): string {
  const head = (m.content || m.embeds[0]?.title || m.embeds[0]?.description || '').split('\n').find((l) => l.trim()) ?? ''
  return plain(head).toLowerCase().replace(/0x[0-9a-f]+|[\d.,:%$£€+-]+/g, '#').replace(/\s+/g, ' ').slice(0, 40)
}

const RUN_MIN = 3
// An output feed: day dividers with counts, and runs of look-alike posts folded behind the newest one.
function feedItems(list: Message[]): FeedItem[] {
  const out: FeedItem[] = []
  const day = (m: Message) => new Date(m.timestamp).toDateString()
  for (let i = 0; i < list.length; ) {
    const d = day(list[i]!)
    let end = i
    while (end < list.length && day(list[end]!) === d) end++
    out.push({ kind: 'day', id: `day-${list[i]!.id}`, label: dayLabel(list[i]!.timestamp), count: end - i })
    for (let j = i; j < end; ) {
      const sig = signature(list[j]!)
      let k = j + 1
      while (k < end && sig && signature(list[k]!) === sig) k++
      if (k - j >= RUN_MIN) out.push({ kind: 'run', id: `run-${list[j]!.id}`, messages: list.slice(j, k) })
      else for (const m of list.slice(j, k)) out.push({ kind: 'message', message: m, compact: false })
      j = k
    }
    i = end
  }
  return out
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text)

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// The output panel: the newest pinned bot message, kept on top and updated in place.
function usePanel(channelId: string, output: boolean): Message | null {
  const [pins, setPins] = useState<Message[]>([])
  const list = useStore((d) => d.messages[channelId]?.list)
  const pinnedKey = (list ?? []).filter((m) => m.pinned).map((m) => m.id).join(',')
  useEffect(() => {
    if (!output) return
    let live = true
    api.pins(channelId).then((r) => live && setPins(r.messages), () => {})
    return () => {
      live = false
    }
  }, [channelId, output, pinnedKey])
  const pin = pins.find((m) => m.author.bot)
  // Prefer the loaded copy: it carries live edits.
  return pin ? (list?.find((m) => m.id === pin.id) ?? pin) : null
}

// Look-alike posts folded behind the newest: "83 more like this".
function Run({ messages, render }: { messages: Message[]; render: (m: Message, compact: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const latest = messages.at(-1)!
  const earlier = messages.slice(0, -1)
  return (
    <div className="run">
      <button className="run-fold" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={14} />
        <span className="num">
          {open ? 'Hide' : `${earlier.length} more like this`} · since {clock(earlier[0]!.timestamp)}
        </span>
      </button>
      {open && earlier.map((m) => render(m, true))}
      {render(latest, false)}
    </div>
  )
}

export function Chat({
  channel,
  state,
  ctx,
  onMenu,
  onModal,
  jumpTo,
  onSearch,
  onPins,
  onLinks,
  onThreads,
  onMembers,
  onServices,
  onWorkspace,
  split,
  open,
}: {
  channel: Channel
  state: HubState
  ctx: MarkdownContext
  onMenu: () => void
  onModal: (modal: { channelId: string; messageId?: string; data: any }) => void
  jumpTo: { messageId: string; nonce: number } | null
  onSearch: () => void
  onPins: () => void
  onLinks: () => void
  onThreads: () => void
  onMembers: () => void
  onServices: () => void
  onWorkspace?: () => void
  /** Shown beside its channel (Discord's split view): a compact header with open-full and close. */
  split?: { onClose: () => void }
  /** The side panel open for this chat, so its toolbar button shows as on. */
  open?: string | null
}) {
  const entry = useStore((d) => d.messages[channel.id])
  const waiting = workspaceWaiting(entry?.list, state.me.id)
  const typing = useStore((d) => d.typing[channel.id])
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [, tick] = useState(0)
  // Scrolled a screen or more above the newest, and the "New messages" line out of sight above.
  const [away, setAway] = useState(false)
  const [newAbove, setNewAbove] = useState(false)
  const [newRead, setNewRead] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const previousHeight = useRef(0)
  const typingSince = useRef<Record<string, number>>({})
  const isThread = THREAD_TYPES.has(channel.type)
  const manageThread = isThread && (can(P.MANAGE_THREADS, channel) || channel.owner_id === state.me.id)
  const sendOk = can(isThread ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES, channel)
  const linkCount = useStore((d) => d.links[channel.id] ?? 0)
  const serviceCount = useStore((d) => d.services?.filter((x) => x.threads.includes(channel.id) && !x.timer).length ?? 0)
  const favourite = useStore((d) => d.favourites.includes(channel.id))
  const muted = useStore((d) => (d.state ? effective(d.state, channel).mutedUntil !== null : false))
  const phone = () => window.matchMedia('(max-width: 767px)').matches
  // Title tap: everything the header holds, as one sheet (the only way in on phones).
  // The More menu (desktop "…", phone title tap): everything that isn't on the toolbar.
  const threadSheet = (at: SheetAt) =>
    setSheet({
      at,
      plain: true,
      title,
      subtitle: [parent ? `#${parent.name}` : null, project.topic].filter(Boolean).join(' · ') || undefined,
      groups: [
        (phone()
          ? [
              { label: 'Threads', icon: 'threads', run: onThreads },
              { label: 'Notifications', icon: 'bell', run: () => setSheet(bellSheet(state, channel, at, setToast)) },
              { label: 'Pinned messages', icon: 'pin', run: onPins },
              { label: 'Members', icon: 'members', run: onMembers },
              { label: 'Search', icon: 'search', run: onSearch },
            ]
          : []) as SheetAction[],
        [
          ...(phone() ? [{ label: `Linked sessions${linkCount ? ` (${linkCount})` : ''}`, icon: 'link' as const, run: onLinks }, ...(isHubOwner() ? [{ label: `Services${serviceCount ? ` (${serviceCount})` : ''}`, icon: 'server' as const, run: onServices }] : [])] : []),
        ],
        [
          ...(manageThread ? [{ label: 'Rename', icon: 'pencil' as const, run: () => setRenaming(title) }] : []),
          { label: favourite ? 'Remove from favourites' : 'Add to favourites', icon: 'star', run: () => void store.toggleFavourite(channel.id) },
          store.isOutput(channel) ? { label: 'Show as conversation', icon: 'chat', run: () => void store.setOutput(channel, false) } : { label: 'Show as output feed', icon: 'feed', run: () => void store.setOutput(channel, true) },
        ],
        manageThread ? [{ label: channel.thread_metadata?.archived ? 'Unarchive' : 'Archive', icon: channel.thread_metadata?.archived ? 'unarchive' : 'archive', run: () => void api.patchThread(channel.id, { archived: !channel.thread_metadata?.archived }).catch((e: Error) => setToast(e.message)) }] : [],
        [
          { label: isThread ? 'Edit thread' : 'Edit channel', icon: 'gear', run: () => sessionActions.channelSettings?.(channel.id) },
          { label: 'Copy link', icon: 'link', run: () => void navigator.clipboard?.writeText(`${shareOrigin()}/#/c/${channel.id}`) },
        ],
      ].filter((g): g is SheetAction[] => g.length > 0) as SheetAction[][],
    })
  // Mentions waiting in other channels, on the back button like Discord's.
  const elsewhere = useStore((d) => Object.entries(d.mentions).reduce((sum, [id, n]) => (id === channel.id ? sum : sum + n), 0))
  const output = useStore((d) => d.output[channel.id] ?? Boolean(channel.thread_metadata?.locked))
  const panel = usePanel(channel.id, output)
  // Read up to here when the thread was opened: the "New messages" line goes after it.
  const seenAtOpen = useMemo(() => store.data.seen[channel.id], [channel.id])
  const parent = isThread ? state.channels.find((c) => c.id === channel.parent_id) : undefined
  const project = parent ?? channel
  const list = entry?.list ?? []
  const category = state.channels.find((c) => c.id === project.parent_id)
  const botName = category ? (state.machines.find((m) => m.toLowerCase() === (category.name ?? '').toLowerCase() || `kimaki ${m.toLowerCase()}` === (category.name ?? '').toLowerCase()) ?? null) : null

  // The sheet's Rename lands here: an inline field in the header, like message edit.
  useEffect(() => {
    if (split) return
    sessionActions.rename = (id) => {
      if (id === channel.id) setRenaming(plain(channel.name ?? ''))
      else {
        sessionActions.pendingRename = id
        location.hash = `#/c/${id}`
      }
    }
    if (sessionActions.pendingRename === channel.id) {
      sessionActions.pendingRename = undefined
      setRenaming(plain(channel.name ?? ''))
    }
    return () => {
      sessionActions.rename = undefined
    }
  }, [channel.id, channel.name])

  useEffect(() => {
    pinned.current = true
    setReplyTo(null)
    setAway(false)
    setNewRead(false)
    void store.loadMessages(channel.id).catch((e: Error) => setToast(e.message))
  }, [channel.id])

  useEffect(() => {
    store.markSeen(channel.id)
  }, [channel.id, channel.last_message_id])
  // History that arrived without live events (an import, a state refetch) loads when the
  // channel's last message moves past what is shown.
  useEffect(() => {
    void store.loadMessages(channel.id).catch(() => {})
  }, [channel.id, channel.last_message_id])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (pinned.current) el.scrollTop = el.scrollHeight
    else if (previousHeight.current && el.scrollTop < 50) el.scrollTop = el.scrollHeight - previousHeight.current
    previousHeight.current = el.scrollHeight
    measure(el)
  }, [list])

  const measure = (el: HTMLDivElement) => {
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > Math.max(el.clientHeight, 400))
    const divider = el.querySelector('.new-divider')
    setNewAbove(Boolean(divider && divider.getBoundingClientRect().bottom < el.getBoundingClientRect().top))
  }
  const toPresent = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    setAway(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // Late images, expanding steps and the keyboard change heights: keep a reader at the bottom.
  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(inner)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!typing) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [typing])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 8000)
    return () => window.clearTimeout(id)
  }, [toast])

  const onResult = (result: InteractionResult, messageId?: string) => {
    if (result.type === 9 && result.data) onModal({ channelId: channel.id, messageId, data: result.data })
    else if (!result.acknowledged) setToast('This interaction failed')
  }

  // Scroll to a message, loading older pages until it is there (search, pins, replies).
  const jump = async (id: string) => {
    for (let pages = 0, i = 0; pages < 40 && i < 400 && !document.getElementById(`m-${id}`); i++) {
      const loaded = store.data.messages[channel.id]
      if (!loaded || loaded.loading) {
        await new Promise((r) => setTimeout(r, 50))
        continue
      }
      if (loaded.list.some((m) => m.id === id)) {
        await new Promise((r) => requestAnimationFrame(r))
        continue
      }
      if (!loaded.hasMore) break
      pinned.current = false
      pages++
      await store.loadMessages(channel.id, { older: true }).catch(() => {})
    }
    const el = document.getElementById(`m-${id}`)
    if (!el) return setToast('That message is no longer here')
    pinned.current = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('highlight')
    window.setTimeout(() => el.classList.remove('highlight'), 1800)
  }
  useEffect(() => {
    if (!jumpTo) return
    const t = window.setTimeout(() => void jump(jumpTo.messageId), 50)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo?.nonce])

  const byId = new Map(list.map((m) => [m.id, m]))
  // Only the current turn can still be waiting: an answer from the owner settles everything above it.
  const firstNew = seenAtOpen ? list.find((m) => snowflakeGt(m.id, seenAtOpen) && m.author.id !== state.me.id)?.id : undefined
  const newCount = seenAtOpen ? list.filter((m) => snowflakeGt(m.id, seenAtOpen) && m.author.id !== state.me.id).length : 0
  const firstNewAt = firstNew ? byId.get(firstNew)?.timestamp : undefined
  const lastOwnerId = list.findLast((m) => m.author.id === state.me.id && (m.type === 0 || m.type === 19))?.id
  const now = Date.now()
  const typers = Object.entries(typing ?? {}).filter(([, until]) => until > now)
  for (const [id] of typers) typingSince.current[id] ??= now
  for (const id of Object.keys(typingSince.current)) if (!typers.some(([t]) => t === id)) delete typingSince.current[id]
  const working = typers.map(([id]) => {
    const user = state.users.find((u) => u.id === id)
    return { name: user?.global_name ?? user?.username ?? 'Someone', bot: Boolean(user?.bot), seconds: Math.round((now - typingSince.current[id]!) / 1000) }
  })
  const title = plain(channel.name ?? '', ctx.userName, ctx.channelName)

  return (
    <section className={`chat${split ? ' split' : ''}`} style={{ '--wall': wallHue(project.name ?? '') } as CSSProperties}>
      <header className="chat-header">
        {!split && <button className="icon-button menu" onClick={onMenu} aria-label="Channels">
          <Icon name="back" size={22} className="phone-only" />
          <Icon name="sidebar" size={20} className="desk-only-icon" />
          {elsewhere > 0 && <span className="back-badge num">{elsewhere > 99 ? '99+' : elsewhere}</span>}
        </button>}
        <div className="chat-titles">
          {renaming !== null ? (
            <input
              className="rename"
              autoFocus
              maxLength={100}
              value={renaming}
              aria-label="Session name"
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRenaming(null)
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  const name = renaming.trim()
                  setRenaming(null)
                  if (name && name !== title) void api.patchThread(channel.id, { name }).catch((err: Error) => setToast(err.message))
                }
              }}
            />
          ) : (
            <div className="crumbs">
              {parent && !split && (
                <>
                  <a className="crumb-parent desk-only" href={`#/c/${parent.id}`} title={`Go to #${parent.name}`}>
                    <Icon name="hash" size={18} />
                    {parent.name}
                  </a>
                  <Icon name="chevron" size={14} className="crumb-sep desk-only" />
                </>
              )}
              <button className="chat-title" onClick={(e) => phone() && threadSheet(below(e.currentTarget, 'start'))} aria-label={`${title}: options`}>
                <Icon name={isThread ? 'thread' : 'hash'} size={18} className="title-icon" />
                <span className="title-text">{title}</span>
              </button>
            </div>
          )}
          {working.length > 0 ? (
            <span className="chat-sub">{working[0]!.name} is working</span>
          ) : (
            ((project.topic && !isThread) || (isThread && parent)) && (
              <span className="chat-sub">
                {isThread && parent && <span className="sub-parent">#{parent.name}</span>}
                {project.topic && !isThread && <span className="sub-topic">{project.topic}</span>}
              </span>
            )
          )}
        </div>
        {split ? (
          <span className="chat-actions">
            <button className={`icon-button${muted ? ' muted-bell' : ''}`} onClick={(e) => setSheet(bellSheet(state, channel, below(e.currentTarget), setToast))} aria-label="Notification settings" title="Notification settings">
              <Icon name="bell" />
            </button>
            <button className="icon-button" onClick={(e) => threadSheet(below(e.currentTarget))} aria-label="More" title="More">
              <Icon name="more" />
            </button>
            <a className="icon-button" href={`#/c/${channel.id}`} onClick={split.onClose} aria-label="Open in full view" title="Open in full view">
              <Icon name="external" />
            </a>
            <button className="icon-button" onClick={split.onClose} aria-label="Close thread" title="Close">
              <Icon name="close" size={18} />
            </button>
          </span>
        ) : (
        <span className="chat-actions">
            <button className="icon-button phone-only-button" onClick={onSearch} aria-label="Search messages">
              <Icon name="search" />
            </button>
            {onWorkspace && (
              <button className={`icon-button desk-only${waiting ? ' with-dot' : ''}`} onClick={onWorkspace} aria-pressed={open === 'workspace'} aria-label="Workspace" title="Workspace: what this thread made and what it waits on">
                <Icon name="sidebar" />
              </button>
            )}
            <button className="icon-button desk-only" onClick={onThreads} aria-pressed={open === 'threads'} aria-label="Threads" title="Threads">
              <Icon name="threads" />
            </button>
            <button className={`icon-button desk-only${muted ? ' muted-bell' : ''}`} onClick={(e) => setSheet(bellSheet(state, channel, below(e.currentTarget), setToast))} aria-label="Notification settings" title="Notification settings">
              <Icon name="bell" />
            </button>
            <button className="icon-button desk-only" onClick={onPins} aria-pressed={open === 'pins'} aria-label="Pinned messages" title="Pinned messages">
              <Icon name="pin" />
            </button>
            <button className={`icon-button desk-only${linkCount ? ' with-count' : ''}`} onClick={onLinks} aria-pressed={open === 'links'} aria-label={`Linked sessions: ${linkCount}`} title="Linked sessions: agents this one works with">
              <Icon name="link" />
              {linkCount > 0 && <span className="num">{linkCount}</span>}
            </button>
            {isHubOwner() && (
              <button className={`icon-button desk-only${serviceCount ? ' with-count' : ''}`} onClick={onServices} aria-pressed={open === 'services'} aria-label={`Services: ${serviceCount}`} title="Services this agent started or runs">
                <Icon name="server" />
                {serviceCount > 0 && <span className="num">{serviceCount}</span>}
              </button>
            )}
            <button className="icon-button desk-only" onClick={onMembers} aria-pressed={open === 'members'} aria-label="Members" title="Members">
              <Icon name="members" />
            </button>
            <button className="icon-button desk-only" onClick={(e) => threadSheet(below(e.currentTarget))} aria-label="More" title="More">
              <Icon name="more" />
            </button>
            <SearchField onSearch={onSearch} />
          </span>
        )}
      </header>
      {output && panel && (
        <div className="output-panel">
          <MessageItem feed current={false} botName={botName} onSheet={setSheet} message={panel} compact={false} ctx={ctx} state={state} channelId={channel.id} byId={byId} onReply={setReplyTo} onJump={(id) => void jump(id)} onResult={onResult} onError={setToast} />
          <div className="panel-fresh num">Updated {ago(panel.edited_timestamp ?? panel.timestamp)}</div>
        </div>
      )}
      <div className="jump-dock top">
        {firstNew && newAbove && !newRead && (
          <div className="new-bar" role="status">
            <button className="new-bar-jump" onClick={() => void jump(firstNew)}>
              {newCount} new {newCount === 1 ? 'message' : 'messages'} since {firstNewAt ? `${clock(firstNewAt)}${dayLabel(firstNewAt) === 'Today' ? '' : ` ${when(firstNewAt)}`}` : 'you were last here'}
            </button>
            <button className="new-bar-read" onClick={() => setNewRead(true)}>
              Mark as read
              <Icon name="check" size={16} />
            </button>
          </div>
        )}
      </div>
      <div
        className={`messages${output ? ' feed' : ''}`}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          measure(el)
          if (el.scrollTop < 200 && entry?.hasMore && !entry.loading) {
            previousHeight.current = el.scrollHeight
            void store.loadMessages(channel.id, { older: true })
          }
        }}
      >
        <div ref={content}>
          {entry && !entry.hasMore && (
            <div className="channel-start">
              <span className="start-icon">
                <Icon name={isThread ? 'thread' : 'hash'} size={28} />
              </span>
              <h2>{isThread ? title : `Welcome to #${title}`}</h2>
              <p>
                {isThread
                  ? `Started${list[0] ? ` ${when(list[0].timestamp)}` : ''}${parent ? ` in #${parent.name}` : ''}.`
                  : `This is the start of #${title}.`}
                {!isThread && project.topic ? ` ${project.topic}` : ''}
              </p>
            </div>
          )}
          {(output ? feedItems(list.filter((m) => m.id !== panel?.id && m.type !== 6)) : items(list)).map((item) => {
            const message = (m: Message, compact: boolean) => (
              <MessageItem key={m.id} feed={output} current={!lastOwnerId || snowflakeGt(m.id, lastOwnerId)} botName={botName} onSheet={setSheet} message={m} compact={compact} ctx={ctx} state={state} channelId={channel.id} byId={byId} onReply={setReplyTo} onJump={(id) => void jump(id)} onResult={onResult} onError={setToast} />
            )
            const render = () => {
              if (item.kind === 'steps') return <Steps key={item.id} messages={item.messages} ctx={ctx} />
              if (item.kind === 'day')
                return (
                  <div key={item.id} className="day-divider">
                    <span>
                      {item.label}
                      {item.count !== undefined && <span className="num"> · {item.count} {item.count === 1 ? 'post' : 'posts'}</span>}
                    </span>
                  </div>
                )
              if (item.kind === 'run') return <Run key={item.id} messages={item.messages} render={message} />
              return message(item.message, item.compact && item.message.id !== firstNew)
            }
            const holds = firstNew && (item.kind === 'message' ? item.message.id === firstNew : item.kind !== 'day' && item.messages.some((m) => m.id === firstNew))
            if (!holds) return render()
            return [
              <div key={`new-${firstNew}`} className="new-divider" role="separator">
                <span>New messages</span>
              </div>,
              render(),
            ]
          })}
        </div>
      </div>
      <div className="jump-dock bottom">
        {away && (
          <div className="present-bar">
            <span>You're viewing older messages</span>
            <button onClick={toPresent}>
              Jump to present
              <Icon name="down" size={16} />
            </button>
          </div>
        )}
      </div>
      {output ? (
        <div className="output-bar">
          {toast && (
            <div className="snackbar" role="alert">
              <Icon name="error" size={18} />
              <span>{toast}</span>
              <button className="icon-button" onClick={() => setToast(null)} aria-label="Dismiss">
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          <span>Output only. Agents post here; there is nothing to reply to.</span>
          <button className="link-button" onClick={() => void store.setOutput(channel, false)}>
            Allow replies
          </button>
        </div>
      ) : !sendOk ? (
        <div className="archived-bar" role="status">
          <Icon name="info" size={18} />
          You don’t have permission to send messages here.
        </div>
      ) : channel.thread_metadata?.archived ? (
        <div className="archived-bar">
          This session is archived.
          <button className="button" onClick={() => void api.patchThread(channel.id, { archived: false })}>
            Unarchive
          </button>
        </div>
      ) : (
        <div className="footer">
          {toast && (
            <div className="snackbar" role="alert">
              <Icon name="error" size={18} />
              <span>{toast}</span>
              <button className="icon-button" onClick={() => setToast(null)} aria-label="Dismiss">
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {working.length > 0 && (
            <div className="footer-line">
              <span className="busy-dot" />
              <span className="num">
                <strong>{working.map((w) => w.name).join(', ')}</strong> {working.some((w) => w.bot) ? 'is working' : 'is typing'} · {working[0]!.seconds}s
              </span>
            </div>
          )}
          <Composer
            channelId={channel.id}
            placeholder={`Message ${isThread ? clip(title, window.matchMedia('(max-width: 767px)').matches ? 22 : 36) : `#${channel.name ?? ''}`}`}
            commands={store.commandsFor(channel.id)}
            channels={state.channels.filter((c) => c.type === 0 && (c.guild_id ?? state.guild.id) === (channel.guild_id ?? state.guild.id)).map((c) => ({ id: c.id, name: c.name ?? '' }))}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onResult={(result) => onResult(result)}
            onError={setToast}
          />
        </div>
      )}
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </section>
  )
}
