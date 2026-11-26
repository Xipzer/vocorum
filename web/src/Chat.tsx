// The message pane: header, messages (grouped like Discord, tool lines folded
// into steps) and the footer, which is the whole input area.

import { isMac } from './columns.ts'
import { memo, Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { api, type Channel, type Component, type HubState, type InteractionResult, type Message } from './api.ts'
import { Avatar, DmAvatar, machineIcon } from './Avatar.tsx'
import { profileSheet } from './Profile.tsx'
import { EmojiPicker } from './EmojiPicker.tsx'
import { Components, uniqueGallery, type Interact } from './components.tsx'
import { Attachments, Embeds, Forwarded, onlyEmbedLink, PollCard, stamp, Stickers } from './Media.tsx'
import { Composer } from './Composer.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { recordingOf } from './recording.ts'
import './voice-note.css'
import { isModelReceipt, modelReceipt, switchedLine } from './ModelBadge.tsx'
import { agentName, dmName, dmUser, isDm, KEEP_AT_BOTTOM, machineOf, snowflakeGt, store, THREAD_TYPES, useStore } from './store.ts'
import { workspaceWaiting } from './Workspace.tsx'
import { Icon, type IconName } from './icons.tsx'
import { E, Emoji, emojify } from './emoji.tsx'
import { clock, displayName, glide, pageStep, plain, wallHue, motion, type Glide } from './text.ts'
import { shareOrigin } from './native.ts'
import { remindSheet, remindTime } from './remind.ts'
import { useMessageHistory } from './useMessageHistory.ts'
import { useMessageToolbar } from './useMessageToolbar.ts'
import { PickRow, SelectionDock, useMessageSelection } from './MessageSelection.tsx'
import { parsePermission, PermissionCard } from './Permission.tsx'
import { RequestCard } from './Panels.tsx'
import type { HubRequest } from './api.ts'

const NO_REQUESTS: HubRequest[] = []
import { bellSheet, effective } from './notify.ts'
import { below, beside, Sheet, sessionActions, usePress, type SheetAction, type SheetAt, type SheetSpec } from './Sheet.tsx'
import { can, isHubOwner, P } from './perms.ts'
import { rendered } from './perf.ts'
import { isToolOnly, stepLines, stepText } from './steps.ts'

// Up arrow in an empty composer edits your last message: each shown message registers here.
const editors = new Map<string, () => void>()

const IS_COMPONENTS_V2 = 1 << 15
const IS_VOICE = 1 << 13
const SPEEDS = [1, 1.5, 2]

function VoiceMessage({ url, duration, waveform }: { url: string; duration?: number; waveform?: string }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
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
  if (failed) return <span className="voice-transcript" role="status">Recording unavailable</span>
  return (
    <div className="voice-message">
      <button className="voice-play" onClick={() => (playing ? audio.current?.pause() : void audio.current?.play().catch(() => setFailed(true)))} aria-label={playing ? 'Pause voice note' : 'Play voice note'}>
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
        onError={() => setFailed(true)}
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

// A turn footer, which may end with a ping of the owner (a notification, not a question).
const FOOTER = /^(-#|>) \*?[^\n]*⋅[^\n]*\d+%[^\n]*?\*?(\s*<@!?\d+>)?\s*$/m

type RenderMessage = (m: Message, compact: boolean) => ReactNode

// Discord's placeholder while older history loads: grey avatars and bars above the oldest
// message, swapped for the real ones in place (useMessageHistory holds the view).
const SKELETON = [
  { name: 96, lines: [62, 38] },
  { name: 120, lines: [44], block: true },
  { name: 80, lines: [70, 56, 30] },
  { name: 104, lines: [48] },
]
function HistorySkeleton() {
  return (
    <div className="history-skeleton" role="status" aria-label="Loading earlier messages">
      {SKELETON.map((g, i) => (
        <div key={i} className="skeleton-message" aria-hidden="true">
          <i className="skeleton-avatar" />
          <i className="skeleton-bar name" style={{ width: g.name }} />
          {g.lines.map((w, j) => <i key={j} className="skeleton-bar" style={{ width: `${w}%` }} />)}
          {g.block && <i className="skeleton-block" />}
        </div>
      ))}
    </div>
  )
}
// The newest run of steps at the bottom of a chat whose agent is still working keeps its
// latest step outside the fold, so the owner sees what is happening now. It folds in when
// the agent writes text (a checkpoint) or stops working.
function Steps({ messages, ctx, render, picked, tailOf = '' }: { messages: Message[]; ctx: MarkdownContext; render: RenderMessage; picked: Set<string> | null; tailOf?: string }) {
  const [open, setOpen] = useState(false)
  const holdsPick = messages.some((m) => picked?.has(m.id))
  const all = stepLines(messages)
  const live = useWorking(tailOf).some((w) => w.bot) && !open && !holdsPick
  const lines = live && all.length > 1 ? all.slice(0, -1) : all
  if (live && all.length === 1)
    return (
      <div className="message compact">
        <div className="steps-live"><Markdown text={all[0]!} ctx={ctx} /></div>
      </div>
    )
  // The newest step says what the agent is doing: "Add the session.links route…".
  const latest = stepText(lines.at(-1)!)
  const summary = latest.replace(/^(shell|bash|write|edit|read|grep|glob|task|subagent|webfetch|websearch|thinking|todowrite|apply_patch)\s+/i, '') || latest.split(/\s+/).slice(0, 2).join(' ')
  return (
    <div className="message compact">
      <button className={`steps${open || holdsPick ? ' open' : ''}`} disabled={holdsPick} onClick={() => setOpen(!open)} aria-expanded={open || holdsPick}>
        <Icon name="chevron" size={14} />
        <b>
          {lines.length} {lines.length === 1 ? 'step' : 'steps'}
        </b>
        <span className="what">{summary}</span>
      </button>
      {(open || holdsPick) && (picked ? messages.map((m) => render(m, true)) : (
        <div className="steps-list">
          <Markdown text={lines.join('\n')} ctx={ctx} />
        </div>
      ))}
      {live && <div className="steps-live"><Markdown text={all.at(-1)!} ctx={ctx} /></div>}
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
function systemLine(message: Message, name: string, place: 'thread' | 'group', guildName: string, ctx: MarkdownContext): { icon: IconName; text: ReactNode; tone?: string } | null {
  const who = <strong>{name}</strong>
  const other = message.mentions?.[0]
  const otherName = other ? <strong>{other.global_name ?? other.username}</strong> : <strong>someone</strong>
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
      const tier = message.type > 8 ? <> {guildName} has achieved <strong>Level {message.type - 8}!</strong></> : null
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

// One message row. Memoised, and it reads only the hub data it shows: the workspace
// state object is replaced by every message anywhere, and redrawing every row for that
// was the main cost of a new message in a long chat.
const MessageItem = memo(function MessageItem({
  message,
  compact,
  ctx,
  channelId,
  reference,
  onReply,
  onJump,
  onResult,
  onError,
  botName,
  onSheet,
  onSelect,
  current,
  feed = false,
  switched,
}: {
  feed?: boolean
  /** Kimaki's "Switched model to" line, folded into this /model receipt. */
  switched?: Message
  current: boolean
  botName: string | null
  onSheet: (spec: SheetSpec) => void
  onSelect?: (messageId: string) => void
  message: Message
  compact: boolean
  ctx: MarkdownContext
  channelId: string
  /** The message this one replies to, when it is loaded. */
  reference?: Message
  onReply: (m: Message) => void
  onJump: (id: string) => void
  onResult: (result: InteractionResult, messageId: string) => void
  onError: (text: string) => void
}) {
  const me = useStore((d) => d.state!.me.id)
  const users = useStore((d) => d.state!.users)
  const icons = useStore((d) => d.state!.machine_icons)
  const bots = useStore((d) => d.state!.machine_bots)
  const guildName = useStore((d) => d.state!.guild.name)
  const inThread = useStore((d) => Boolean(d.state?.threads.some((t) => t.id === message.channel_id)))
  const [editing, setEditing] = useState<string | null>(null)
  const answeredFrom = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const button = answeredFrom.current
    if (!button) return
    answeredFrom.current = null
    if (button.isConnected || document.activeElement !== document.body) return
    const row = document.getElementById(`m-${message.id}`)
    ;(row?.querySelector<HTMLElement>('.select-trigger:not(:disabled)') ?? row)?.focus({ preventScroll: true })
  }, [message.components, message.id])
  const [picker, setPicker] = useState<DOMRect | null>(null)
  useEffect(() => {
    editors.set(message.id, () => {
      setEditing(message.content)
      document.getElementById(`m-${message.id}`)?.scrollIntoView({ block: 'nearest' })
    })
    return () => void editors.delete(message.id)
  }, [message.id, message.content])
  const { hot, warm } = useMessageToolbar()
  // Reactions toggle like Discord's: yours lights up; clicking it again (on the message or
  // the toolbar) takes it off.
  const mineOn = (emoji: string) => Boolean(message.reactions_summary?.find((r) => r.emoji === emoji)?.me)
  const toggle = (emoji: string) => void api.react(channelId, message.id, emoji, !mineOn(emoji)).catch((e: Error) => onError(e.message))
  const canManage = can(P.MANAGE_MESSAGES, channelId)
  const mine = message.author.id === me
  const pinOk = can(P.PIN_MESSAGES, channelId) || can(P.MANAGE_MESSAGES, channelId)
  const profile = users.find((u) => u.id === message.author.id)
  const name = (message.author.bot && botName && agentName(bots, botName)) || (message.author.global_name ?? message.author.username)
  const v2 = ((message.flags ?? 0) & IS_COMPONENTS_V2) !== 0
  // type 1 references are forwards; the original rides along as a snapshot.
  const forward = message.message_reference?.type === 1 ? message.message_snapshots?.[0]?.message : undefined
  const forwardChannel = forward && message.message_reference?.channel_id ? ctx.channelName(message.message_reference.channel_id) : null
  const forwardSource = forwardChannel ? `#${forwardChannel}` : null
  const replyId = replyTarget(message)
  const embeds = message.embeds.filter((embed) => !feed || !embed.type || embed.type === 'rich')
  const used = message.interaction_metadata ?? message.interaction
  const usedName = message.interaction_metadata?.name ?? message.interaction?.name
  const receipt = message.author.bot && usedName === 'model' && !message.components?.length ? modelReceipt(message.content, switched && switchedLine(switched.content)) : null
  // Kimaki's permission prompt shows as an approval card.
  const ask = message.author.bot ? parsePermission(message.content) : null
  // A link to one of the hub's requests (an agent filed it) carries the request's card,
  // so the owner approves it in the conversation.
  const requestIds = message.author.bot ? [...new Set([...message.content.matchAll(/#\/requests\/([0-9a-f]{12})\b/g)].map((m) => m[1]!))] : []
  const allRequests = useStore((d) => (requestIds.length ? d.requests : NO_REQUESTS))
  const linked = requestIds.length ? allRequests.filter((r) => requestIds.includes(r.id)) : NO_REQUESTS
  const privateReply = message.private_reply
  const spoken = Boolean((message.flags ?? 0) & IS_VOICE)
  const recording = spoken ? recordingOf(message) : undefined
  const needs = !ask && !used && !privateReply && current && message.author.bot && (hasOpenComponents(message.components) || (message.content.includes(`<@${me}>`) && !FOOTER.test(message.content)))
  // Kimaki's errors start with a cross: they read red, and an actionable one gets a red band.
  const failed = message.author.bot && /^\s*[×✗✕❌]\s/.test(message.content)
  const interact: Interact = async (body) => {
    if (body.type === 'select' && document.activeElement instanceof HTMLElement && document.activeElement.matches('.select-trigger')) answeredFrom.current = document.activeElement
    try {
      const result = await api.interaction({ ...body, channelId, messageId: message.id })
      onResult(result, message.id)
      if (!result.acknowledged) return false
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      return false
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
          ...(onSelect ? [{ label: 'Select messages', icon: 'check' as const, run: () => onSelect(message.id) }] : []),
        ],
        [
          ...(message.content ? [{ label: 'Copy text', icon: 'copy' as const, run: () => void navigator.clipboard?.writeText(message.content) }] : []),
          ...(store.data.reminders ? [{ label: 'Remind me', icon: 'clock' as const, run: () => onSheet(remindSheet(at, { channelId, messageId: message.id }, onError, (r) => store.notice(`Reminder set for ${remindTime(r.at)}.`))) }] : []),
          { label: 'Mark unread', icon: 'eye', run: () => store.markUnread(channelId, message.id) },
          { label: 'Copy message link', icon: 'link', run: () => void navigator.clipboard?.writeText(`${shareOrigin()}/#/c/${channelId}/${message.id}`) },
          { label: 'Copy message ID', icon: 'hash', run: () => void navigator.clipboard?.writeText(message.id) },
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
  // The author's name or picture opens their profile beside it, as in Discord.
  const author = profile && { user: profile, machine: message.author.bot ? botName : null }
  const openProfile = (e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
    if (!author || ('altKey' in e && e.altKey) || ('key' in e && e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    e.stopPropagation()
    onSheet(profileSheet(author, beside(e.currentTarget.firstElementChild?.matches('.avatar') ? e.currentTarget.firstElementChild : e.currentTarget, 'right'), channelId))
  }
  // A focused message takes Discord's keys: arrows move, R reply, E edit, P pin,
  // + react, Delete delete, Esc back to the message box.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
    const el = e.currentTarget
    const go = (to: Element | undefined) => to instanceof HTMLElement && (to.focus(), to.scrollIntoView({ block: 'nearest' }))
    const all = () => [...(el.closest('.messages')?.querySelectorAll('.message[tabindex]') ?? [])]
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (key === 'ArrowUp' || key === 'ArrowDown') go(all()[all().indexOf(el) + (key === 'ArrowUp' ? -1 : 1)])
    else if (key === 'r') onReply(message)
    else if (key === 'e' && mine && message.content) setEditing(message.content)
    else if (key === 'p' && pinOk) void api.pin(channelId, message.id, !message.pinned).catch((err: Error) => onError(err.message))
    else if (key === '+' || key === '=') setPicker(el.getBoundingClientRect())
    else if ((key === 'Delete' || key === 'Backspace') && (mine || canManage)) confirmDelete(below(el))
    else if (key === 'Escape') el.closest('.chat')?.querySelector<HTMLElement>('.composer textarea')?.focus()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  // Alt+click marks unread from here, as in Discord.
  const markOnAlt = (e: React.MouseEvent) => {
    if (!e.altKey || (e.target as HTMLElement).closest('a, button')) return
    e.preventDefault()
    store.markUnread(channelId, message.id)
  }
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
  if (message.type === 18) return <ThreadCreated message={message} name={name} ctx={ctx} />
  const system = systemLine(message, name, inThread ? 'thread' : 'group', guildName, ctx)
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
          <strong>{name}</strong> renamed the {inThread ? 'session' : 'channel'} to <strong>{plain(message.content, ctx.userName, ctx.channelName)}</strong>
        </span>
        <span className="message-time">{clock(message.timestamp)}</span>
      </div>
    )
  }
  return (
    <div id={`m-${message.id}`} className={`message${compact ? ' compact' : ''}${mine ? ' you' : ''}${needs ? ' needs' : ''}${failed ? ' failed' : ''}${privateReply ? ' private-reply' : ''}${message.local ? ' sending' : ''}`} {...(privateReply ? {} : press)} {...warm} tabIndex={-1} onKeyDown={privateReply ? undefined : onKey} onClick={privateReply ? undefined : markOnAlt}>
      {replyId &&
        (reference ? (
          <div className="reply-preview" onClick={() => onJump(reference.id)}>
            <span className="reply-spine" />
            <span className="reply-avatar">
              <Avatar id={reference.author.id} name={reference.author.global_name ?? reference.author.username} size="inline" version={users.find((u) => u.id === reference.author.id)?.avatar} src={reference.author.bot ? machineIcon(icons, botName, 'avatar') : null} />
            </span>
            <strong>{(reference.author.bot && botName && agentName(bots, botName)) || (reference.author.global_name ?? reference.author.username)}</strong>
            <span className="reply-text">{plain(reference.content, ctx.userName, ctx.channelName) || attachmentLabel(reference)}</span>
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
            <Avatar id={used.user.id} name={used.user.global_name ?? used.user.username} size="inline" version={users.find((u) => u.id === used.user.id)?.avatar} />
          </span>
          <strong>{used.user.global_name ?? used.user.username}</strong>
          <span className="reply-text">
            used <span className="used-command">{usedName ? `/${usedName}` : 'a command'}</span>
          </span>
        </div>
      )}
      {compact && <span className="row-time" title={stamp(message.timestamp)}>{clock(message.timestamp)}</span>}
      <div className="message-body">
        {!compact && (
          <div className="message-head">
            <span className="author-avatar" onClick={author ? openProfile : undefined}>
              <Avatar id={message.author.id} name={name} size="inline" version={profile?.avatar} src={message.author.bot ? machineIcon(icons, botName, 'avatar') : null} />
            </span>
            <span className="author" {...(author ? { role: 'button', tabIndex: 0, onClick: openProfile, onKeyDown: openProfile } : {})} style={profile?.color != null ? { color: `#${profile.color.toString(16).padStart(6, '0')}` } : undefined} title={message.author.bot && botName ? (message.author.global_name ?? message.author.username) : undefined}>
              <E>{name}</E>
            </span>
            {message.author.bot && <span className="bot-tag">BOT</span>}
            <span className="message-time" title={receipt && message.edited_timestamp ? `Edited ${stamp(message.edited_timestamp)}` : undefined}>{clock(message.timestamp)}</span>
          </div>
        )}
        {spoken && <div className="voice-note-label"><Icon name="mic" size={16} />Voice note</div>}
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
          spoken ? (message.content && <div className="voice-transcript">{message.content}</div>) : ask ? <PermissionCard ask={ask} components={message.components} interact={interact} /> : !v2 && !onlyEmbedLink(message.content, embeds) && (receipt || <Markdown text={message.content} ctx={ctx} runFooter={message.author.bot} />)
        )}
        {editing === null && !receipt && message.edited_timestamp && (!message.author.bot || used) && (
          <span className="edited-tail" title={`Edited ${stamp(message.edited_timestamp)}`}>
            (edited)
          </span>
        )}
        {forward && <Forwarded snapshot={forward} ctx={ctx} source={forwardSource} onSource={message.message_reference?.channel_id && ctx.openChannel ? () => ctx.openChannel!(message.message_reference!.channel_id!) : undefined} />}
        <Embeds embeds={embeds} ctx={ctx} />
        {recording && <VoiceMessage key={recording.url} url={recording.url} duration={recording.duration_secs ?? message.voice_note?.duration_secs} waveform={recording.waveform} />}
        <Attachments attachments={spoken ? message.attachments.filter(a => a.id !== message.voice_note?.attachment_id && !/^(audio\/|application\/ogg)/i.test(a.content_type ?? '') && !/\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(a.filename)) : message.attachments} />
        {message.sticker_items?.length ? <Stickers items={message.sticker_items} /> : null}
        {message.poll && <PollCard poll={message.poll} />}
        {linked.length > 0 && (
          <div className="inline-requests">
            {linked.map((r) => (
              <RequestCard key={r.id} request={r} />
            ))}
          </div>
        )}
        {message.components?.length && !ask ? <Components components={uniqueGallery(message.components, message.attachments)} ctx={ctx} interact={interact} /> : null}
        {privateReply && <div className="ephemeral"><Icon name="eye" size={14} /><span>Only you can see this</span><span aria-hidden="true">·</span><button onClick={() => void api.dismissReply(channelId, message.id).then(() => store.dismissPrivateReply(channelId, message.id), (e: Error) => onError(e.message))}>Dismiss message</button></div>}
        {message.reactions_summary?.length ? (
          <div className="reactions">
            {message.reactions_summary.map((r) => (
              <button key={r.emoji} className={`reaction${r.me ? ' me' : ''}`} onClick={() => toggle(r.emoji)} aria-pressed={r.me} title={r.me ? (r.count > 1 ? `You and ${r.count - 1} more reacted (click to remove)` : 'You reacted (click to remove)') : `${r.count} reacted (click to add yours)`}>
                <span className="reaction-emoji">{emojify(r.emoji)}</span>
                <span className="num">{r.count}</span>
              </button>
            ))}
            <button className="reaction add" onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())} aria-label="Add reaction" title="Add reaction">
              <Icon name="smile" size={20} />
            </button>
          </div>
        ) : null}
        {picker && <EmojiPicker anchor={picker} guildId={store.guildOf(channelId)} onPick={(e) => !mineOn(e) && toggle(e)} onClose={() => setPicker(null)} />}
        {!feed && (message as Message & { thread?: { id: string } }).thread?.id !== channelId && message.id !== channelId && <StarterThread messageId={message.id} threadId={(message as Message & { thread?: { id: string } }).thread?.id} ctx={ctx} />}
      </div>
      {hot && !privateReply && <div className="message-actions" role="toolbar" aria-label="Message actions">
        {QUICK.map((emoji) => (
          <button key={emoji} className={`quick${mineOn(emoji) ? ' on' : ''}`} onClick={() => toggle(emoji)} aria-pressed={mineOn(emoji)} aria-label={`React ${emoji}`} title={mineOn(emoji) ? `Remove ${emoji}` : `React ${emoji}`}>
            <Emoji emoji={emoji} />
          </button>
        ))}
        <i className="actions-rule" />
        <button onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())} aria-label="Add reaction" title="Add reaction">
          <Icon name="smile" size={20} />
        </button>
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
      </div>}
    </div>
  )
})

// The message a reply points at. Forwards (reference type 1) carry a snapshot instead.
function replyTarget(message: Message) {
  return message.message_reference?.type === 1 ? undefined : message.message_reference?.message_id
}

// "X started a thread": the thread as a card you can open, like Discord's.
function ThreadCreated({ message, name, ctx }: { message: Message; name: string; ctx: MarkdownContext }) {
  const id = message.message_reference?.channel_id
  const thread = useStore((d) => (id ? d.state?.threads.find((t) => t.id === id) : undefined))
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
function StarterThread({ messageId, threadId, ctx }: { messageId: string; threadId?: string; ctx: MarkdownContext }) {
  const thread = useStore((d) => d.state?.threads.find((t) => t.id === (threadId ?? messageId)))
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
        <span className="thread-card-title">{name}</span>
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
export function SearchField({ onSearch }: { onSearch: () => void }) {
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

// The callback and the first visible reply are two different events. A late
// reply can be fetched without sending the command (and its side effects) twice.
function CommandReceipt({ name, id, channelId, dismiss }: { name: string; id: string; channelId: string; dismiss: () => void }) {
  const [late, setLate] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), 10_000)
    return () => window.clearTimeout(timer)
  }, [])
  const refresh = async () => {
    setChecking(true); setError(false)
    try { await store.loadMessages(channelId, { refresh: true }) } catch { setError(true) } finally { setChecking(false) }
  }
  return <div className="footer-line command-receipt">
    <span role="status">{error ? 'Could not check the thread.' : late ? `The bot accepted /${name}. No reply yet.` : `Waiting for /${name}…`}</span>
    {late && <><small>Ref {id}</small><button className="link-button" disabled={checking} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check for reply'}</button></>}
    <button className="icon-button" aria-label="Dismiss command status" onClick={dismiss}><Icon name="close" size={14} /></button>
  </div>
}

const when = (iso: string) => {
  const label = dayLabel(iso)
  return label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : `on ${label}`
}

type Item = { kind: 'message'; message: Message; compact: boolean; switched?: Message } | { kind: 'steps'; id: string; messages: Message[] } | { kind: 'day'; id: string; label: string; count?: number }

// `breaks`: messages a gap follows, so no group runs across it.
function items(list: Message[], breaks?: Set<string>): Item[] {
  const out: Item[] = []
  let prev: Message | undefined
  let cut = false
  for (const message of list) {
    if (!prev || new Date(prev.timestamp).toDateString() !== new Date(message.timestamp).toDateString()) {
      out.push({ kind: 'day', id: `day-${message.id}`, label: dayLabel(message.timestamp) })
      prev = undefined
    }
    if (cut) prev = undefined
    const last = cut ? undefined : out.at(-1)
    cut = Boolean(breaks?.has(message.id))
    if (!message.private_reply && !message.interaction_metadata && isToolOnly(message)) {
      if (last?.kind === 'steps') last.messages.push(message)
      else out.push({ kind: 'steps', id: message.id, messages: [message] })
      prev = message
      continue
    }
    // Kimaki's "Switched model to …" line right after a /model receipt says the same thing again.
    if (last?.kind === 'message' && !last.switched && message.author.bot && message.author.id === last.message.author.id && (last.message.interaction_metadata ?? last.message.interaction)?.name === 'model' && !last.message.components?.length && isModelReceipt(last.message.content) && switchedLine(message.content)) {
      last.switched = message
      prev = message
      continue
    }
    const compact = Boolean(prev && !prev.private_reply && !message.private_reply && prev.author.id === message.author.id && !message.message_reference && !message.interaction_metadata && !message.interaction && (prev.type === 0 || prev.type === 19 || prev.type === 20) && new Date(message.timestamp).getTime() - new Date(prev.timestamp).getTime() < 7 * 60_000)
    out.push({ kind: 'message', message, compact })
    prev = message
  }
  return out
}

type FeedItem = Item | { kind: 'run'; id: string; messages: Message[] }

// The headline shape of a post, numbers and hashes blanked: "Deployed build #".
function signature(m: Message): string {
  if (m.private_reply || m.interaction_metadata || m.interaction) return ''
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
function usePanel(channelId: string, output: boolean) {
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
  return [pin ? (list?.find((m) => m.id === pin.id) ?? pin) : null, (ids: readonly string[]) => setPins((prev) => prev.filter((m) => !ids.includes(m.id)))] as const
}

// Look-alike posts folded behind the newest: "83 more like this".
function Run({ messages, render, picked }: { messages: Message[]; render: RenderMessage; picked: Set<string> | null }) {
  const [open, setOpen] = useState(false)
  const latest = messages.at(-1)!
  const earlier = messages.slice(0, -1)
  const holdsPick = earlier.some((m) => picked?.has(m.id))
  return (
    <div className="run">
      <button className="run-fold" disabled={holdsPick} onClick={() => setOpen(!open)} aria-expanded={open || holdsPick}>
        <Icon name="chevron" size={14} />
        <span className="num">
          {open || holdsPick ? 'Hide' : `${earlier.length} more like this`} · since {clock(earlier[0]!.timestamp)}
        </span>
      </button>
      {(open || holdsPick) && earlier.map((m) => render(m, true))}
      {render(latest, false)}
    </div>
  )
}

// Who is typing or working in a chat, kept current as each entry expires. The two
// indicators below are their own components: typing arrives every few seconds for as long
// as an agent works, and it must redraw a line of text, never the message list.
function useWorking(channelId: string) {
  const typing = useStore((d) => d.typing[channelId])
  const users = useStore((d) => d.state?.users)
  const [, expired] = useState(0)
  const now = Date.now()
  const live = Object.entries(typing ?? {}).filter(([, until]) => until > now)
  const next = live.length ? Math.min(...live.map(([, until]) => until)) : 0
  useEffect(() => {
    if (!next) return
    const id = window.setTimeout(() => expired((n) => n + 1), Math.max(0, next - Date.now()) + 20)
    return () => window.clearTimeout(id)
  }, [next])
  return live.map(([id]) => {
    const user = users?.find((u) => u.id === id)
    const state = store.data.state
    const channel = user?.bot && state ? store.channel(channelId) : undefined
    const machine = channel && state ? machineOf(state, channel) : null
    return { name: machine ? agentName(state!.machine_bots, machine) : (user?.global_name ?? user?.username ?? 'Someone'), bot: Boolean(user?.bot) }
  })
}

// Discord's typing dots, in the busy colour.
const WorkingDots = () => <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>

// Under the newest message while an agent works: moving dots and the time since its last
// message, so a long tool or a long think still reads as alive. Gone once it stops.
function WorkingTail({ channelId, since }: { channelId: string; since: string | undefined }) {
  const bot = useWorking(channelId).some((w) => w.bot)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!bot) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [bot])
  if (!bot) return null
  const s = since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000)) : 0
  const took = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return (
    <div className="message compact working-tail" role="status">
      <WorkingDots />
      <span className="num">working · {took}</span>
    </div>
  )
}

// The header's second line: who is working, else what the caller shows there.
function WorkingTitle({ channelId, children }: { channelId: string; children: ReactNode }) {
  const working = useWorking(channelId)
  return working.length > 0 ? <span className="chat-sub">{working[0]!.name} is working</span> : <>{children}</>
}

// Above the message box: who is working or typing, else what is scheduled here.
function FooterStatus({ channelId, scheduled }: { channelId: string; scheduled: number }) {
  const working = useWorking(channelId)
  if (working.length > 0)
    return (
      <div className="footer-line">
        {working.some((w) => w.bot) ? <WorkingDots /> : <span className="busy-dot" />}
        <span className="num">
          <strong>{working.map((w) => w.name).join(', ')}</strong> {working.some((w) => w.bot) ? 'is working' : 'is typing'}
        </span>
      </div>
    )
  if (scheduled <= 0) return null
  return (
    <div className="footer-line">
      <button className="link-button scheduled-link num" onClick={() => sessionActions.scheduled?.(channelId)}>
        <Icon name="clock" size={14} />
        {scheduled} scheduled {scheduled === 1 ? 'message' : 'messages'}
      </button>
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
  onJumpStarted,
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
  onJumpStarted?: (request: NonNullable<typeof jumpTo>) => void
  onSearch: () => void
  onPins: () => void
  onLinks: () => void
  onThreads: () => void
  onMembers: () => void
  onServices: () => void
  onWorkspace?: () => void
  /** Shown beside its channel (Discord's split view): a compact header with open-full and close.
   *  headless: inside a host that has the header already (a voice channel's call screen). */
  split?: { onClose: () => void; headless?: boolean }
  /** The side panel open for this chat, so its toolbar button shows as on. */
  open?: string | null
}) {
  const entry = useStore((d) => d.messages[channel.id])
  const waiting = workspaceWaiting(entry?.list, state.me.id)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [receipts, setReceipts] = useState<Array<{ id: string; name: string; channelId: string }>>([])
  const [sheet, setSheet] = useState<SheetSpec | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const notice = useStore((d) => d.notice)
  const scheduledHere = useStore((d) => d.scheduled.filter((s) => s.channel_id === channel.id && s.status === 'pending').length)
  const schedulesOn = useStore((d) => d.reminders !== null)
  // Scrolled a screen or more above the newest, and the "New messages" line out of sight above.
  const [away, setAway] = useState(false)
  const [newAbove, setNewAbove] = useState(false)
  const [caughtUp, setCaughtUp] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const followFrame = useRef(0)
  const lastArrival = useRef(entry?.arrival)
  // Paging keys and Jump to present: Discord's 580 ms glide.
  const paging = useRef<Glide>({ frame: 0, to: 0 })
  useEffect(() => () => { cancelAnimationFrame(followFrame.current); cancelAnimationFrame(paging.current.frame) }, [])
  const history = useMessageHistory(channel.id, entry, scroller, pinned)
  const isThread = THREAD_TYPES.has(channel.type)
  const manageThread = isThread && (can(P.MANAGE_THREADS, channel) || channel.owner_id === state.me.id)
  const sendOk = can(isThread ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES, channel)
  const linkCount = useStore((d) => d.links[channel.id] ?? 0)
  const serviceCount = useStore((d) => d.services?.filter((x) => x.threads.includes(channel.id) && !x.timer).length ?? 0)
  const favourite = useStore((d) => d.favourites.includes(channel.id))
  const muted = useStore((d) => (d.state ? effective(d.state, channel).mutedUntil !== null : false))
  const phone = () => window.matchMedia('(max-width: 767px)').matches
  const header = useRef<HTMLElement>(null)
  // Matches the header's container query: below 640px of chat, some buttons live in More.
  const narrow = () => (header.current?.getBoundingClientRect().width ?? window.innerWidth) <= 640
  // Title tap: everything the header holds, as one sheet (the only way in on phones).
  // The More menu (desktop "…", phone title tap): everything that isn't on the toolbar.
  const threadSheet = (at: SheetAt) =>
    setSheet({
      at,
      plain: true,
      title,
      subtitle: [parent ? `#${parent.name}` : null, project.topic].filter(Boolean).join(' · ') || undefined,
      groups: [
        !selection.picked && (list.some(selectable) || (panel && selectable(panel))) ? [{ label: 'Select messages', icon: 'check' as const, run: () => selection.start() }] : [],
        (phone()
          ? [
              { label: 'Threads', icon: 'threads', run: onThreads },
              { label: 'Notifications', icon: 'bell', run: () => setSheet(bellSheet(state, channel, at, setToast)) },
              { label: 'Pinned messages', icon: 'pin', run: onPins },
              { label: 'Members', icon: 'members', run: onMembers },
              { label: 'Search', icon: 'search', run: onSearch },
            ]
          : []) as SheetAction[],
        schedulesOn ? [{ label: `Scheduled${scheduledHere ? ` (${scheduledHere})` : ''}`, icon: 'clock' as const, run: () => sessionActions.scheduled?.(channel.id) }] : [],
        [
          // Below 1100px wide these leave the toolbar for this menu, so the title keeps room.
          ...(!dm && narrow() ? [...(onWorkspace ? [{ label: 'Workspace', icon: 'sidebar' as const, run: onWorkspace }] : []), { label: `Linked sessions${linkCount ? ` (${linkCount})` : ''}`, icon: 'link' as const, run: onLinks }, ...(isHubOwner() ? [{ label: `Services${serviceCount ? ` (${serviceCount})` : ''}`, icon: 'server' as const, run: onServices }] : [])] : []),
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
  const [panel, removePins] = usePanel(channel.id, output)
  const selection = useMessageSelection(channel.id, (ids) => { store.removeMessages(channel.id, ids); removePins(ids) })
  const manageMessages = can(P.MANAGE_MESSAGES, channel)
  const selectable = (m: Message) => m.channel_id === channel.id && !m.private_reply && (m.author.id === state.me.id || manageMessages)
  // Read up to here when the thread was opened: the "New messages" line goes after it.
  // Marking a message unread moves the line to it.
  const heldAt = useStore((d) => d.held[channel.id])
  const seen = useStore((d) => d.seen[channel.id])
  // A chat remounts on navigation. Keep the initial backlog bounded to what was
  // there on entry; later arrivals follow the live read cursor.
  const [onEntry] = useState(() => ({ after: seen, through: channel.last_message_id }))
  useEffect(() => () => store.release(channel.id), [channel.id])
  useEffect(() => store.show(channel.id), [channel.id])
  const parent = isThread ? state.channels.find((c) => c.id === channel.parent_id) : undefined
  const project = parent ?? channel
  const privateReplies = useStore((d) => d.privateReplies[channel.id])
  const list = useMemo(() => privateReplies?.length ? [...entry?.list ?? [], ...privateReplies].sort((a, b) => snowflakeGt(a.id, b.id) ? 1 : -1) : entry?.list ?? [], [entry?.list, privateReplies])
  useEffect(() => {
    if (!receipts.length) return
    const keep = receipts.filter((r) => !list.some((m) => (m.interaction_metadata ?? m.interaction)?.id === r.id))
    if (keep.length !== receipts.length) setReceipts(keep)
  }, [list, receipts])
  const category = state.channels.find((c) => c.id === project.parent_id)
  const botName = machineOf(state, channel)

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
    void store.loadMessages(channel.id).catch((e: Error) => setToast(e.message))
  }, [channel.id])

  // An arrival changes channel.last_message_id even when the reader is pages
  // back or in another app. Acknowledge only a committed, visible tail.
  const renderedTail = useRef<Message | undefined>(undefined)
  const readVisibleEnd = useCallback(() => {
    const el = scroller.current, last = renderedTail.current
    if (!el?.clientHeight || !pinned.current || !last || last.channel_id !== channel.id) return
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 3) store.markSeen(channel.id, last.id)
  }, [channel.id])
  useEffect(() => store.follow(channel.id, () => {
    const el = scroller.current
    return Boolean(el?.clientHeight && pinned.current && document.visibilityState === 'visible' && document.hasFocus() && el.scrollHeight - el.scrollTop - el.clientHeight <= 3)
  }), [channel.id])
  useEffect(() => {
    window.addEventListener('focus', readVisibleEnd)
    document.addEventListener('visibilitychange', readVisibleEnd)
    return () => {
      window.removeEventListener('focus', readVisibleEnd)
      document.removeEventListener('visibilitychange', readVisibleEnd)
    }
  }, [readVisibleEnd])
  // History that arrived without live events (an import, a state refetch) loads when the
  // channel's last message moves past what is shown. Opening loads fresh; while open, what
  // the reader has stays and anything out of reach becomes a gap.
  const opened = useRef<string | null>(null)
  useEffect(() => {
    const inPlace = opened.current === channel.id
    opened.current = channel.id
    void store.loadMessages(channel.id, { inPlace }).catch(() => {})
  }, [channel.id, channel.last_message_id])
  // A gap opened under the reader (back from sleep): like Discord, they stay where they were,
  // even if that was the bottom, and the jump bar takes them to the newest.
  const gapKey = entry?.gaps?.map((g) => g.after).join() ?? ''
  const seenGaps = useRef(gapKey)
  if (seenGaps.current !== gapKey) {
    if (gapKey.split(',').some((after) => after && !seenGaps.current.split(',').includes(after))) pinned.current = false
    seenGaps.current = gapKey
  }
  const [filling, setFilling] = useState<string | null>(null)
  const fillGap = async (after: string) => {
    const el = scroller.current
    if (!el) return
    // New rows go in below the bar; what is above it, and on screen, stays put.
    pinned.current = false
    el.dataset.prepending = 'true'
    setFilling(after)
    try { await store.fillGap(channel.id, after) }
    catch (e) { setToast((e as Error).message) }
    finally {
      setFilling(null)
      requestAnimationFrame(() => { delete el.dataset.prepending; measure(el) })
    }
  }

  useLayoutEffect(() => {
    renderedTail.current = entry?.list.findLast((m) => !m.local)
    const el = scroller.current
    if (!el) return
    const fresh = entry?.arrival && entry.arrival !== lastArrival.current
    lastArrival.current = entry?.arrival
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop
    if (pinned.current && gap > 1 && !followFrame.current) {
      // Discord places someone else's new message at once; only the owner's own send glides.
      const own = fresh && entry?.list.find((m) => m.id === entry.arrival)?.author.id === state.me.id
      if (own && gap <= Math.min(180, el.clientHeight / 2) && document.hasFocus() && motion() === 'smooth') {
        // Ease only a live append at the tail. Loading history, switching chats
        // and reduced motion still place the reader directly at the right row.
        const start = performance.now()
        const advance = (now: number) => {
          followFrame.current = 0
          if (!pinned.current) return
          const t = Math.min(1, (now - start) / 120)
          el.scrollTop = el.scrollHeight - el.clientHeight - gap * (1 - t) ** 3
          if (t < 1) followFrame.current = requestAnimationFrame(advance)
          else { measure(el); readVisibleEnd() }
        }
        followFrame.current = requestAnimationFrame(advance)
      } else el.scrollTop = el.scrollHeight
    }
    measure(el)
    readVisibleEnd()
  }, [list, entry?.list, entry?.arrival, readVisibleEnd])

  const interruptFollow = () => {
    if (!followFrame.current) return
    cancelAnimationFrame(followFrame.current)
    followFrame.current = 0
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 3
  }

  const measure = (el: HTMLDivElement) => {
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > Math.max(el.clientHeight, 400))
    const divider = el.querySelector('.new-divider')
    setNewAbove(Boolean(divider && divider.getBoundingClientRect().bottom < el.getBoundingClientRect().top))
  }
  const toPresent = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    setCaughtUp(true)
    setAway(false)
    glide(el, () => el.scrollHeight - el.clientHeight, paging.current)
  }
  const stopGlide = () => {
    cancelAnimationFrame(paging.current.frame)
    paging.current.frame = 0
  }
  const page = (el: HTMLDivElement, key: string) => {
    const max = () => el.scrollHeight - el.clientHeight
    const base = paging.current.frame ? paging.current.to : el.scrollTop
    const to = Math.min(max(), Math.max(0, base + (key === 'PageUp' ? -1 : 1) * pageStep(el)))
    glide(el, key === 'Home' ? () => 0 : key === 'End' ? max : () => to, paging.current)
  }

  // Late images, expanding steps and the keyboard change heights: keep a reader at the bottom.
  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (pinned.current && !followFrame.current && el.scrollHeight - el.clientHeight - el.scrollTop > 1) el.scrollTop = el.scrollHeight
    })
    observer.observe(inner)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 8000)
    return () => window.clearTimeout(id)
  }, [toast])

  const onResult = (result: InteractionResult, messageId?: string) => {
    if (result.type === 9 && result.data) onModal({ channelId: channel.id, messageId, data: result.data })
    else if (!result.acknowledged) setToast("The bot didn't answer. Try again, or type your reply.")
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
      const gap = loaded.gaps?.find((g) => snowflakeGt(id, g.after) && snowflakeGt(g.before, id))
      if (gap) {
        pinned.current = false
        pages++
        await store.fillGap(channel.id, gap.after).catch(() => {})
        continue
      }
      if (!loaded.hasMore) break
      pinned.current = false
      pages++
      await store.loadMessages(channel.id, { older: true }).catch(() => {})
    }
    const el = document.getElementById(`m-${id}`)
    if (!el) return setToast('That message is no longer here')
    const pane = scroller.current
    if (!pane?.contains(el)) return
    // Highlighting the last row can be a no-op scroll. No scroll event will
    // arrive to restore following if the reader is already at the visible tail.
    const atTail = id === renderedTail.current?.id && pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 3
      && el.getBoundingClientRect().top >= pane.getBoundingClientRect().top
    pinned.current = atTail
    if (!atTail) el.scrollIntoView({ block: 'center', behavior: motion() })
    el.classList.add('highlight')
    window.setTimeout(() => el.classList.remove('highlight'), 1800)
  }
  useEffect(() => {
    if (!jumpTo) return
    const t = window.setTimeout(() => {
      onJumpStarted?.(jumpTo)
      void jump(jumpTo.messageId)
    }, 50)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo?.nonce])

  const byId = new Map(list.map((m) => [m.id, m]))
  // Only the current turn can still be waiting: an answer from the owner settles everything above it.
  const following = pinned.current && document.visibilityState === 'visible' && document.hasFocus()
  const unread = entry?.list.filter((m) => {
    if (m.channel_id !== channel.id || m.private_reply) return false
    if (heldAt) return !snowflakeGt(heldAt, m.id)
    if (m.author.id === state.me.id) return false
    const onReturn = !caughtUp && onEntry.after && onEntry.through && snowflakeGt(m.id, onEntry.after) && !snowflakeGt(m.id, onEntry.through)
    return Boolean(onReturn || (!following && seen && snowflakeGt(m.id, seen)))
  })
  const firstNew = unread?.[0]?.id
  const newCount = unread?.length ?? 0
  // The oldest loaded message is already new and older history is not loaded, or new messages
  // run into a gap that is not loaded: there are more.
  const moreNew = Boolean(unread?.length && ((entry?.hasMore && unread[0]!.id === entry.list.find((m) => m.channel_id === channel.id && !m.private_reply)?.id) || entry?.gaps?.some((g) => !snowflakeGt(firstNew, g.before))))
  const markRead = () => {
    setCaughtUp(true)
    store.release(channel.id)
    store.markSeen(channel.id)
  }
  const firstNewAt = firstNew ? byId.get(firstNew)?.timestamp : undefined
  const lastOwnerId = list.findLast((m) => m.author.id === state.me.id && !m.local && (m.type === 0 || m.type === 19))?.id
  const lastEditable = list.findLast((m) => m.author.id === state.me.id && !m.local && (m.type === 0 || m.type === 19) && m.content && !((m.flags ?? 0) & IS_VOICE))?.id
  useEffect(() => {
    const onEditLast = (e: Event) => {
      if ((e as CustomEvent<string>).detail === channel.id && lastEditable) editors.get(lastEditable)?.()
    }
    window.addEventListener('vocorum:edit-last', onEditLast)
    return () => window.removeEventListener('vocorum:edit-last', onEditLast)
  }, [channel.id, lastEditable])
  // The private Admin server: marked apart so it is never taken for an ordinary server.
  const adminHere = Boolean(state.admin_guild_id) && (channel.guild_id ?? state.guild.id) === state.admin_guild_id
  // A direct message is named after the other person, as in Discord.
  const dm = isDm(channel)
  const dmWith = dm ? dmUser(channel, state.me.id) : undefined
  const title = dm ? dmName(channel, state.me.id) : plain(channel.name ?? '', ctx.userName, ctx.channelName)
  // Why this channel takes no messages, with the machine named as everywhere else.
  const note = channel.note ? (channel.machine ? channel.note.replace(channel.machine, agentName(state.machine_bots, channel.machine)) : channel.note) : null

  // Row callbacks that never change identity, so a memoised row skips redrawing when
  // nothing it shows has changed. They call the latest versions of these functions.
  const latest = useRef({ jump, onResult, start: selection.start })
  latest.current = { jump, onResult, start: selection.start }
  const rowJump = useCallback((id: string) => void latest.current.jump(id), [])
  const rowResult = useCallback((result: InteractionResult, messageId: string) => latest.current.onResult(result, messageId), [])
  const rowSelect = useCallback((id: string) => latest.current.start(id), [])
  const message = (m: Message, compact: boolean, inPanel = false, switched?: Message) => {
    const allowed = selectable(m)
    const row = <MessageItem key={m.id} feed={output} current={!inPanel && (!lastOwnerId || snowflakeGt(m.id, lastOwnerId))} botName={botName} onSheet={setSheet} onSelect={allowed ? rowSelect : undefined} message={m} compact={compact} ctx={ctx} channelId={channel.id} reference={byId.get(replyTarget(m) ?? '')} onReply={setReplyTo} onJump={rowJump} onResult={rowResult} onError={setToast} switched={switched} />
    return selection.picked ? <PickRow key={m.id} message={m} allowed={allowed} selection={selection}>{row}</PickRow> : row
  }

  return (
    <section ref={selection.pane} className={`chat${split ? ' split' : ''}${adminHere ? ' admin' : ''}${selection.picked ? ' picking' : ''}`} style={{ '--wall': adminHere ? '245 166 35' : wallHue(project.name ?? '') } as CSSProperties} onKeyDownCapture={(e) => {
      if (e.key === 'Escape' && selection.picked && !sheet && !selection.review && !document.querySelector('.overlay,.sheet')) {
        e.preventDefault(); e.stopPropagation(); selection.cancel()
      }
      // As Discord: Page Up and Page Down in the message box page the messages, the browser's own step and glide.
      const el = scroller.current
      if ((e.key === 'PageUp' || e.key === 'PageDown') && el && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.target as Element).closest('.composer textarea')) {
        e.preventDefault()
        interruptFollow()
        history.key(e.key, false)
        page(el, e.key)
      }
    }}>
      {!split?.headless && <header className="chat-header" ref={header}>
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
                  <a className="crumb-parent desk-only wide-only" href={`#/c/${parent.id}`} title={`Go to #${parent.name}`}>
                    <Icon name="hash" size={18} />
                    <span className="crumb-parent-label">{parent.name}</span>
                  </a>
                  <Icon name="chevron" size={14} className="crumb-sep desk-only wide-only" />
                </>
              )}
              <button className="chat-title" onClick={(e) => phone() && threadSheet(below(e.currentTarget, 'start'))} aria-label={`${title}: options`}>
                {dm ? (
                  <span className="title-avatar">
                    <DmAvatar channel={channel} size="inline" />
                  </span>
                ) : (
                  <Icon name={isThread ? 'threadCrumb' : 'hash'} size={isThread ? 20 : 18} className="title-icon" />
                )}
                <span className="title-text"><E>{title}</E></span>
              </button>
            </div>
          )}
          <WorkingTitle channelId={channel.id}>
            {((project.topic && !isThread) || (isThread && parent)) && (
              <span className="chat-sub">
                {isThread && parent && <span className="sub-parent">#{parent.name}</span>}
                {project.topic && !isThread && <span className="sub-topic">{project.topic}</span>}
              </span>
            )}
          </WorkingTitle>
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
            {onWorkspace && !dm && (
              <button className={`icon-button desk-only fold${waiting ? ' with-dot' : ''}`} onClick={onWorkspace} aria-pressed={open === 'workspace'} aria-label="Workspace" title="Workspace: what this thread made and what it waits on">
                <Icon name="sidebar" />
              </button>
            )}
            {!dm && (
              <button className="icon-button desk-only" onClick={onThreads} aria-pressed={open === 'threads'} aria-label="Threads" title="Threads">
                <Icon name="threads" />
              </button>
            )}
            <button className={`icon-button desk-only${muted ? ' muted-bell' : ''}`} onClick={(e) => setSheet(bellSheet(state, channel, below(e.currentTarget), setToast))} aria-label="Notification settings" title="Notification settings">
              <Icon name="bell" />
            </button>
            <button className="icon-button desk-only" onClick={onPins} aria-pressed={open === 'pins'} aria-label="Pinned messages" title="Pinned messages">
              <Icon name="pin" />
            </button>
{!dm && (
            <button className={`icon-button desk-only fold${linkCount ? ' with-count' : ''}`} onClick={onLinks} aria-pressed={open === 'links'} aria-label={`Linked sessions: ${linkCount}`} title="Linked sessions: agents this one works with">
              <Icon name="link" />
              {linkCount > 0 && <span className="num">{linkCount}</span>}
            </button>
            )}
            {isHubOwner() && !dm && (
              <button className={`icon-button desk-only fold${serviceCount ? ' with-count' : ''}`} onClick={onServices} aria-pressed={open === 'services'} aria-label={`Services: ${serviceCount}`} title="Services this agent started or runs">
                <Icon name="server" />
                {serviceCount > 0 && <span className="num">{serviceCount}</span>}
              </button>
            )}
            {!dm && (
              <button className="icon-button desk-only" onClick={onMembers} aria-pressed={open === 'members'} aria-label="Members" title="Members">
                <Icon name="members" />
              </button>
            )}
            <button className="icon-button desk-only" onClick={(e) => threadSheet(below(e.currentTarget))} aria-label="More" title="More">
              <Icon name="more" />
            </button>
            <SearchField onSearch={onSearch} />
          </span>
        )}
      </header>}
      {output && panel && (
        <div className="output-panel">
          {message(panel, false, true)}
          <div className="panel-fresh num">Updated {ago(panel.edited_timestamp ?? panel.timestamp)}</div>
        </div>
      )}
      <div className="jump-dock top">
        {firstNew && newAbove && (
          <div className="new-bar" role="status">
            <button className="new-bar-jump" onClick={() => {
              if (scroller.current?.querySelector(`#m-${firstNew}`)) return void jump(firstNew)
              // A folded run has a visible divider but no individual message row.
              pinned.current = false
              scroller.current?.querySelector('.new-divider')?.scrollIntoView({ block: 'center', behavior: motion() })
            }}>
              {newCount}{moreNew ? '+' : ''} new {newCount === 1 && !moreNew ? 'message' : 'messages'} since {firstNewAt ? `${clock(firstNewAt)}${dayLabel(firstNewAt) === 'Today' ? '' : ` ${when(firstNewAt)}`}` : 'you were last here'}
            </button>
            <button className="new-bar-read" onClick={markRead}>
              Mark as read
              <Icon name="check" size={16} />
            </button>
            <button className="new-bar-close" onClick={markRead} aria-label="Mark as read">
              <Icon name="close" size={24} />
            </button>
          </div>
        )}
      </div>
      <div
        className={`messages chat-history${output ? ' feed' : ''}`}
        ref={scroller}
        tabIndex={0}
        aria-label="Messages"
        onWheelCapture={() => { interruptFollow(); stopGlide() }}
        onTouchStartCapture={() => { interruptFollow(); stopGlide() }}
        onPointerDownCapture={() => { interruptFollow(); stopGlide() }}
        onWheel={history.onWheel}
        onTouchStart={history.onTouchStart}
        onTouchMove={history.onTouchMove}
        onPointerDown={history.onPointerDown}
        onKeyDownCapture={(e) => {
          interruptFollow()
          if (e.altKey || e.ctrlKey || e.metaKey || (e.target as Element).closest('textarea,input,[role=dialog]')) return
          history.key(e.key, e.shiftKey)
          if (['PageUp', 'PageDown', 'Home', 'End'].includes(e.key) && !e.shiftKey) {
            e.preventDefault()
            page(e.currentTarget, e.key)
          } else stopGlide()
        }}
        onKeyDown={(e) => {
          // Arrows on the list itself pick the newest message on screen; from there they move.
          if (e.target !== e.currentTarget || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.metaKey || e.ctrlKey) return
          const box = e.currentTarget.getBoundingClientRect()
          const shown = [...e.currentTarget.querySelectorAll<HTMLElement>('.message[tabindex]')].filter((m) => m.getBoundingClientRect().bottom <= box.bottom + 1)
          const pick = shown.at(-1)
          if (!pick) return
          e.preventDefault()
          pick.focus()
        }}
        onScroll={(e) => {
          const el = e.currentTarget
          const wasPinned = pinned.current
          pinned.current = !!followFrame.current || el.scrollHeight - el.scrollTop - el.clientHeight <= 3
          if (!wasPinned && pinned.current && document.hasFocus()) setCaughtUp(true)
          if (pinned.current) readVisibleEnd()
          // Back at the newest after reading far back: let the old pages go.
          if (pinned.current && !selection.picked && list.length > 2 * KEEP_AT_BOTTOM) store.trimMessages(channel.id, KEEP_AT_BOTTOM)
          measure(el)
          history.scrolled(el)
        }}
      >
        <div ref={content}>
          {entry?.hasMore && entry.list.length > 0 && (history.state === 'loading' && entry.loading ? <HistorySkeleton /> : <div className="history-edge" aria-live="polite"><button aria-label="Load earlier messages" onClick={() => void history.older()}>
            <Icon name="back" size={14} /><span>{history.state === 'error' ? 'Could not load history. Try again' : 'Load earlier messages'}</span>
          </button></div>)}
          {entry && !entry.hasMore && dm && (
            <div className="channel-start dm-start">
              <DmAvatar channel={channel} size="panel" />
              <h2>{title}</h2>
              <span className="dm-start-user">{channel.machine ? 'Agent' : dmWith?.username}</span>
              <p>
                {channel.machine ? (
                  <>
                    Direct messages from the agent on <b>{title}</b> show here.
                  </>
                ) : (
                  <>
                    This is the beginning of your direct message history with <b>{title}</b>.
                  </>
                )}
              </p>
            </div>
          )}
          {entry && !entry.hasMore && !dm && !split?.headless && (
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
          {(output ? feedItems(list.filter((m) => m.id !== panel?.id && m.type !== 6)) : items(list, entry?.gaps && new Set(entry.gaps.map((g) => g.after)))).map((item) => {
            const render = () => {
              if (item.kind === 'steps') return <Steps key={item.id} messages={item.messages} ctx={ctx} render={message} picked={selection.picked} tailOf={item.messages.at(-1) === list.at(-1) ? channel.id : ''} />
              if (item.kind === 'day')
                return (
                  <div key={item.id} className="day-divider">
                    <span>
                      {item.label}
                      {item.count !== undefined && <span className="num"> · {item.count} {item.count === 1 ? 'post' : 'posts'}</span>}
                    </span>
                  </div>
                )
              if (item.kind === 'run') return <Run key={item.id} messages={item.messages} render={message} picked={selection.picked} />
              return message(item.message, item.compact && item.message.id !== firstNew, false, item.kind === 'message' ? item.switched : undefined)
            }
            const holds = firstNew && (item.kind === 'message' ? item.message.id === firstNew : item.kind !== 'day' && item.messages.some((m) => m.id === firstNew))
            const gap = entry?.gaps?.find((g) => (item.kind === 'message' ? item.message.id === g.after : item.kind !== 'day' && item.messages.some((m) => m.id === g.after)))
            const bar = gap && (
              <div key={`gap-${gap.after}`} className="gap-bar" data-gap={gap.after}>
                <button disabled={filling === gap.after} onClick={() => void fillGap(gap.after)}>{filling === gap.after ? 'Loading messages…' : 'Load more messages'}</button>
              </div>
            )
            if (!holds) return bar ? [render(), bar] : render()
            return [
              <div key={`new-${firstNew}`} className="new-divider" role="separator" aria-label="New messages">
                <span aria-hidden="true">New</span>
              </div>,
              render(),
              ...(bar ? [bar] : []),
            ]
          })}
          {!output && <WorkingTail channelId={channel.id} since={list.at(-1)?.timestamp} />}
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
        {away && (
          <button className="present-button" onClick={toPresent} aria-label="Jump to present">
            <Icon name="arrowDown" />
          </button>
        )}
      </div>
      {selection.picked && <SelectionDock selection={selection} />}
      {output || note ? (
        <div className="output-bar">
          {toast ? (
            <div className="snackbar" role="alert">
              <Icon name="error" size={18} />
              <span>{toast}</span>
              <button className="icon-button" onClick={() => setToast(null)} aria-label="Dismiss">
                <Icon name="close" size={16} />
              </button>
            </div>
          ) : (
            notice && (
              <div className="snackbar ok" role="status">
                <Icon name="check" size={18} />
                <span>{notice}</span>
              </div>
            )
          )}
          <span>{note ?? 'Output only. Agents post here; there is nothing to reply to.'}</span>
          {!note && (
            <button className="link-button" onClick={() => void store.setOutput(channel, false)}>
              Allow replies
            </button>
          )}
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
        <div className="footer" onChange={(event) => {
          if (event.target instanceof HTMLTextAreaElement && !heldAt && pinned.current && document.hasFocus()) setCaughtUp(true)
        }}>
          {toast ? (
            <div className="snackbar" role="alert">
              <Icon name="error" size={18} />
              <span>{toast}</span>
              <button className="icon-button" onClick={() => setToast(null)} aria-label="Dismiss">
                <Icon name="close" size={16} />
              </button>
            </div>
          ) : (
            notice && (
              <div className="snackbar ok" role="status">
                <Icon name="check" size={18} />
                <span>{notice}</span>
              </div>
            )
          )}
          <FooterStatus channelId={channel.id} scheduled={scheduledHere} />
          {receipts.filter((r) => r.channelId === channel.id).map((r) => <CommandReceipt key={r.id} {...r} dismiss={() => setReceipts((rows) => rows.filter((x) => x.id !== r.id))} />)}
          <Profiler id="composer" onRender={rendered}>
            <Composer
              channelId={channel.id}
              placeholder={adminHere && !isThread ? 'Ask your admin agent' : `Message ${dm ? `@${title}` : isThread ? clip(title, window.matchMedia('(max-width: 767px)').matches ? 22 : 36) : `#${channel.name ?? ''}`}`}
              commands={store.commandsFor(channel.id)}
              channels={state.channels.filter((c) => c.type === 0 && (c.guild_id ?? state.guild.id) === (channel.guild_id ?? state.guild.id)).map((c) => ({ id: c.id, name: c.name ?? '' }))}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              onResult={(result, name) => {
                if (result.acknowledged && (result.type === 4 || result.type === 5)) setReceipts((rows) => [...rows.slice(-4), { id: result.interactionId, name, channelId: channel.id }])
                onResult(result)
              }}
              onError={setToast}
            />
          </Profiler>
        </div>
      )}
      {sheet && <Sheet spec={sheet} onClose={() => setSheet(null)} />}
    </section>
  )
}
