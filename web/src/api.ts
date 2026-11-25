// Client API + event socket. Cookies carry the device session (same origin).
// In the app the same paths are served by Rust, which signs in with the device key.

import { connectNativeEvents, native, sendNativeFocus } from './native.ts'

export type User = { id: string; username: string; global_name?: string | null; bot?: boolean; avatar?: string | null; color?: number | null }
export type Attachment = { id: string; filename: string; size: number; url: string; proxy_url?: string; content_type?: string; duration_secs?: number; waveform?: string; width?: number | null; height?: number | null; flags?: number; description?: string; spoiler?: boolean; missing?: boolean }
export type EmbedMedia = { url: string; proxy_url?: string; width?: number; height?: number }
export type Embed = {
  type?: string
  title?: string
  description?: string
  url?: string
  color?: number
  timestamp?: string
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  author?: { name: string; url?: string; icon_url?: string; proxy_icon_url?: string }
  footer?: { text: string; icon_url?: string; proxy_icon_url?: string }
  provider?: { name?: string; url?: string }
  image?: EmbedMedia
  thumbnail?: EmbedMedia
  video?: EmbedMedia
}
export type Snapshot = { content: string; timestamp: string; edited_timestamp?: string | null; attachments?: Attachment[]; embeds?: Embed[]; flags?: number; type?: number; sticker_items?: StickerItem[] }
export type StickerItem = { id: string; name: string; format_type: number }
export type Poll = {
  question: { text?: string }
  answers: Array<{ answer_id: number; poll_media: { text?: string; emoji?: { id?: string | null; name?: string | null } } }>
  expiry: string | null
  allow_multiselect?: boolean
  results?: { is_finalized: boolean; answer_counts: Array<{ id: number; count: number; me_voted: boolean }> }
}
export type InteractionMeta = { id: string; type: number; name?: string; command_type?: number; user: User }
export type Component = { type: number; [key: string]: any }
export type Reaction = { emoji: string; count: number; me: boolean }
export type Message = {
  id: string
  channel_id: string
  author: User
  content: string
  timestamp: string
  edited_timestamp: string | null
  type: number
  flags?: number
  attachments: Attachment[]
  embeds: Embed[]
  components?: Component[]
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string }
  message_snapshots?: Array<{ message: Snapshot }>
  sticker_items?: StickerItem[]
  poll?: Poll
  mentions?: User[]
  call?: { participants: string[]; ended_timestamp?: string | null }
  interaction_metadata?: InteractionMeta
  interaction?: { id: string; type: number; name: string; user: User }
  reactions_summary?: Reaction[]
  pending?: boolean
  pinned?: boolean
}
export type Channel = {
  id: string
  type: number
  guild_id?: string
  name?: string
  topic?: string | null
  parent_id?: string | null
  position?: number
  last_message_id?: string | null
  thread_metadata?: { archived: boolean; locked?: boolean; archive_timestamp?: string }
  message_count?: number
  owner_id?: string
  // Who may do what here (type 0 role, 1 member), and what the viewer may do (decimal bits).
  permission_overwrites?: Overwrite[]
  permissions?: string
  // Direct messages (type 1): the other person, or the machine whose agent it is with.
  recipients?: User[]
  machine?: string
  // Why this channel takes no messages (a DM with a machine: agents work in project channels).
  note?: string | null
}
export type Overwrite = { id: string; type: 0 | 1; allow: string; deny: string }
export type Role = { id: string; name: string; color: number; hoist: boolean; position: number; permissions: string; managed?: boolean; mentionable: boolean }
export type GuildMember = { user_id: string; roles: string[]; nick: string | null; joined_at: string }
export type Privacy = { show_presence: boolean; show_activity: boolean }
export type CommandOption = { name: string; description: string; type: number; required?: boolean; autocomplete?: boolean; choices?: Array<{ name: string; value: string | number }>; options?: CommandOption[] }
export type Command = { id: string; name: string; description: string; options: CommandOption[] }
export type PresenceStatus = 'online' | 'idle' | 'offline'
export type Presence = { user_id: string; status: PresenceStatus; devices?: Array<{ id: string; name: string; channel_id: string | null; visible: boolean }>; machines?: Array<{ machine: string; online: boolean }> }
export type NotifyLevel = 'all' | 'mentions' | 'nothing'
export type NotifySetting = { level: NotifyLevel | null; muted_until: number | null }
export type NotificationState = { settings: Record<string, NotifySetting>; default_level: NotifyLevel; vapid_public_key: string; push_subscribed: boolean }
export type MachineIcon = { avatar: string | null; guild_icon: string | null }
// The hub's schedules, per person: a message posted later, or a reminder about a message
// (or with a note). A reminder that has fired is "done" until it is dismissed.
export type Schedule = { id: string; kind: 'message' | 'reminder'; channel_id: string; message_id: string | null; content: string; cron: string | null; next_at: number | null; status: 'pending' | 'done' | 'failed' | 'cancelled' | 'dismissed'; last_run_at: number | null; last_result?: string | null; created_at: number; message?: { content: string; author: { id: string; username: string; global_name: string | null } | null } | null }
// Kimaki's own routines on each machine, read-only here (they are edited in Kimaki).
export type Routine = { id: string; prompt: string; schedule: string; channel_id: string | null; thread_id: string | null; agent: string | null; model: string | null; next_run: string | null; status: string | null }
export type MachineRoutines = { machine: string; updated_at?: number; routines: Routine[] }
export type Reminder = { id: string; channel_id: string; message_id: string | null; at: number; note: string | null; due: boolean; message: Schedule['message'] }
export const toReminder = (s: Schedule): Reminder => ({ id: s.id, channel_id: s.channel_id, message_id: s.message_id, at: s.next_at ?? s.last_run_at ?? s.created_at, note: s.content || null, due: s.status !== 'pending', message: s.message ?? null })

export type HubState = {
  machine_icons?: Record<string, MachineIcon>
  presence?: Record<string, Presence>
  notifications?: NotificationState
  device: { id: string; name: string }
  me: { id: string }
  bot: { id: string }
  guild: { id: string; name: string }
  guilds?: Guild[]
  guildCommands?: Record<string, Command[]>
  channels: Channel[]
  threads: Channel[]
  // Direct messages, as in Discord's READY; absent on a hub without them.
  private_channels?: Channel[]
  users: User[]
  commands: Command[]
  read: Record<string, string>
  mentions?: Record<string, number>
  links?: Record<string, number>
  sessionThreads?: Record<string, string>
  favourites: string[]
  user_aliases?: Record<string, string>
  output?: Record<string, boolean>
  machines: string[]
  // Several people on one hub: who runs it, roles and members per guild, and this person's privacy.
  hub_owner?: boolean
  admin_guild_id?: string
  roles?: Record<string, Role[]>
  members?: Record<string, GuildMember[]>
  privacy?: Privacy
}
export type FoundChannel = { id: string; name: string | null; type: number; parent_id: string | null }
export type SearchResult = { message: Message; channel: FoundChannel; snippet: string | null }
export type Mention = { message: Message; channel: FoundChannel; read: boolean }
export type LinkKind = 'liaison' | 'spawned' | 'parent' | 'mentions' | 'mentioned'
export type SessionLink = { id: string; kind: LinkKind; count: number; last: string; messageId: string; messageChannelId: string }
export type ServiceStatus = 'running' | 'waiting' | 'stopped' | 'failed' | 'restarting' | 'starting'
export type Service = { unit: string; kind: 'service' | 'timer'; description: string; status: ServiceStatus; sub: string; pid: number | null; since: string | null; restarts: number; enabled: boolean; transient: boolean; version: string | null; next: string | null; threads: string[]; timer: string | null; runs: string | null }
export type HubRequest = { id: string; kind: string; summary: string; reason: string; origin: string; status: 'pending' | 'approved' | 'denied' | 'failed' | 'expired'; created_at: number; expires_at: number; decided_at?: number | null; result: unknown; undoable?: boolean }
export type ServiceEvent = { unit: string; at: number; kind: string; detail: string | null }
export type Guild = { id: string; name: string; icon: string | null; owner_id?: string; permissions?: string }
export type DeviceInfo = { id: string; name: string; created_at: number | string; last_seen_at: number | string | null; current: boolean; online: boolean; push: boolean }
export type Me = { user: User; device: { id: string; name: string }; privacy?: Privacy }
export type SessionState = 'waiting' | 'failed' | 'busy' | 'done' | 'idle'
export type SessionSummary = {
  id: string
  title: string
  projectId: string | null
  project: string | null
  machine: string | null
  state: SessionState
  since: string
  lastMessageId: string | null
  ask?: { text: string; messageId: string; choices?: Array<{ customId: string; label: string; style: number }>; openOnly?: boolean }
  lastStep?: string
  error?: string
}
export type MachineSummary = { name: string; online: boolean | null; waiting: number; running: number; failed: number }
export type InteractionResult = { interactionId: string; acknowledged: boolean; type: number | null; data: any }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  let body = init.body
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  // A dropped connection surfaces as the browser's own words ("Load failed" in Safari,
  // "Failed to fetch" in Chrome); say what it means instead.
  const response = await fetch(path, { ...init, headers, body, credentials: 'same-origin' }).catch(() => {
    throw new ApiError(0, "Can't reach the hub. Check the connection and try again.")
  })
  const text = await response.text()
  if (!response.ok) {
    let message = text
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {}
    throw new ApiError(response.status, message || `HTTP ${response.status}`)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  status: () => call<{ signedIn: boolean; device: { id: string; name: string } | null }>('/client/auth/status'),
  registerOptions: (code: string) => call<{ challengeId: string; options: any }>('/client/auth/register/options', { method: 'POST', json: { code } }),
  register: (challengeId: string, response: unknown) => call('/client/auth/register/verify', { method: 'POST', json: { challengeId, response } }),
  loginOptions: () => call<{ challengeId: string; options: any }>('/client/auth/login/options', { method: 'POST', json: {} }),
  login: (challengeId: string, response: unknown) => call('/client/auth/login/verify', { method: 'POST', json: { challengeId, response } }),
  logout: () => call('/client/auth/logout', { method: 'POST', json: {} }),
  state: () => call<HubState>('/client/state'),
  messages: (channelId: string, before?: string) =>
    call<{ messages: Message[]; hasMore: boolean }>(`/client/channels/${channelId}/messages?limit=50${before ? `&before=${before}` : ''}`),
  send: (channelId: string, body: { content: string; attachmentIds?: string[]; descriptions?: Record<string, string>; replyTo?: string; voice?: boolean }) =>
    call<Message>(`/client/channels/${channelId}/messages`, { method: 'POST', json: body }),
  edit: (channelId: string, messageId: string, content: string) => call<Message>(`/client/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', json: { content } }),
  remove: (channelId: string, messageId: string) => call(`/client/channels/${channelId}/messages/${messageId}`, { method: 'DELETE' }),
  react: (channelId: string, messageId: string, emoji: string, on: boolean) =>
    call(`/client/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: on ? 'PUT' : 'DELETE' }),
  patchThread: (channelId: string, body: { name?: string; archived?: boolean }) => call<Channel>(`/client/channels/${channelId}`, { method: 'PATCH', json: body }),
  upload: (file: Blob, filename: string, voice?: { durationSecs: number; waveform: string }) => {
    const form = new FormData()
    form.append('file', file, filename)
    if (voice) {
      form.append('voice', '1')
      form.append('durationSecs', String(voice.durationSecs))
      form.append('waveform', voice.waveform)
    }
    return call<Attachment>('/client/uploads', { method: 'POST', body: form })
  },
  search: (q: string, offset = 0, order: 'newest' | 'oldest' = 'newest') => call<{ total: number; results: SearchResult[] }>(`/client/search?q=${encodeURIComponent(q)}&offset=${offset}&order=${order}`),
  links: (channelId: string) => call<{ links: SessionLink[] }>(`/client/channels/${channelId}/links`),
  services: () => call<{ available: boolean; services: Service[] }>('/client/services'),
  serviceEvents: (unit: string) => call<{ events: ServiceEvent[] }>(`/client/services/${encodeURIComponent(unit)}/events`),
  serviceControl: (unit: string, verb: 'start' | 'stop' | 'restart') => call<{ services: Service[] }>(`/client/services/${encodeURIComponent(unit)}/${verb}`, { method: 'POST' }),
  inbox: () => call<{ mentions: Mention[] }>('/client/inbox'),
  pins: (channelId: string) => call<{ messages: Message[] }>(`/client/channels/${channelId}/pins`),
  pin: (channelId: string, messageId: string, on: boolean) => call(`/client/channels/${channelId}/pins/${messageId}`, { method: on ? 'PUT' : 'DELETE' }),
  overview: () => call<{ machines: MachineSummary[]; sessions: SessionSummary[] }>('/client/overview'),
  markRead: (read: Record<string, string>) => call('/client/read', { method: 'PUT', json: { read } }),
  routines: () => call<{ machines: MachineRoutines[] }>('/client/routines'),
  schedules: () => call<{ schedules: Schedule[] }>('/client/schedules'),
  schedule: (body: { channel_id: string; content: string; at?: number; cron?: string }) => call<Schedule>('/client/schedules', { method: 'POST', json: { kind: 'message', ...body } }),
  remind: (body: { channel_id: string; message_id?: string | null; at: number; content?: string }) => call<Schedule>('/client/schedules', { method: 'POST', json: { kind: 'reminder', ...body } }),
  forget: (id: string) => call('/client/schedules/' + id, { method: 'DELETE' }),
  snooze: (id: string, at: number) => call<Schedule>('/client/schedules/' + id, { method: 'PATCH', json: { at } }),
  dms: () => call<{ channels: Channel[] }>('/client/dms'),
  openDm: (to: { recipient_id: string } | { machine: string }) => call<Channel>('/client/dms', { method: 'POST', json: to }),
  markUnread: (channelId: string, messageId: string) => call('/client/read', { method: 'PUT', json: { unread: { [channelId]: messageId } } }),
  setOutput: (channelId: string, output: boolean | null) => call(`/client/channels/${channelId}/output`, output === null ? { method: 'DELETE' } : { method: 'PUT', json: { output } }),
  notifications: () => call<NotificationState>('/client/notifications'),
  setNotification: (scopeId: string, body: { level?: NotifyLevel | null; muted_until?: number | null }) => call(`/client/notifications/${scopeId}`, { method: 'PUT', json: body }),
  pushSubscribe: (subscription: unknown) => call('/client/push', { method: 'PUT', json: subscription }),
  pushUnsubscribe: () => call('/client/push', { method: 'DELETE' }),
  pushTest: () => call<{ sent: number; failed: number }>('/client/push/test', { method: 'POST' }),
  favourite: (channelId: string, on: boolean) => call(`/client/favourites/${channelId}`, { method: on ? 'PUT' : 'DELETE' }),
  interaction: (body: Record<string, unknown>) => call<InteractionResult>('/client/interactions', { method: 'POST', json: body }),
  command: (channelId: string, name: string, options: unknown[]) => call<InteractionResult>('/client/commands', { method: 'POST', json: { channelId, name, options } }),
  autocomplete: (channelId: string, name: string, options: unknown[], focused: string) =>
    call<{ choices: Array<{ name: string; value: string | number }> }>('/client/autocomplete', { method: 'POST', json: { channelId, name, options, focused } }),
  me: () => call<Me>('/client/me'),
  patchMe: (body: { global_name?: string | null; color?: number | null; show_presence?: boolean; show_activity?: boolean }) => call<Me>('/client/me', { method: 'PATCH', json: body }),
  setAvatar: (image: Blob | null) => call<Me>('/client/me/avatar', image ? { method: 'PUT', body: image } : { method: 'DELETE' }),
  devices: () => call<{ devices: DeviceInfo[] }>('/client/devices'),
  renameDevice: (id: string, name: string) => call<{ devices: DeviceInfo[] }>(`/client/devices/${id}`, { method: 'PATCH', json: { name } }),
  revokeDevice: (id: string) => call<{ revoked: string; signed_out: boolean }>(`/client/devices/${id}`, { method: 'DELETE' }),
  patchGuild: (id: string, body: { name: string }) => call<Guild>(`/client/guilds/${id}`, { method: 'PATCH', json: body }),
  setGuildIcon: (id: string, image: Blob | null) => call<Guild>(`/client/guilds/${id}/icon`, image ? { method: 'PUT', body: image } : { method: 'DELETE' }),
  createChannel: (guildId: string, body: { name: string; type?: 0 | 4 | 5 | 15; topic?: string | null; parent_id?: string | null; position?: number; permission_overwrites?: Overwrite[] }) => call<Channel>(`/client/guilds/${guildId}/channels`, { method: 'POST', json: body }),
  patchChannel: (id: string, body: { name?: string; topic?: string | null; parent_id?: string | null; position?: number }) => call<Channel>(`/client/channels/${id}/settings`, { method: 'PATCH', json: body }),
  reorderChannels: (guildId: string, moves: Array<{ id: string; position?: number; parent_id?: string | null }>) => call<{ channels: Channel[] }>(`/client/guilds/${guildId}/channels`, { method: 'PATCH', json: moves }),
  deleteChannel: (id: string) => call<{ deleted: string }>(`/client/channels/${id}`, { method: 'DELETE' }),
  requests: () => call<{ requests: HubRequest[] }>('/client/requests'),
  approveOptions: (id: string) => call<{ challengeId: string; options: any }>(`/client/requests/${id}/approve/options`, { method: 'POST', json: {} }),
  approve: (id: string, challengeId: string, response: unknown) => call<{ result: unknown }>(`/client/requests/${id}/approve`, { method: 'POST', json: { challengeId, response } }),
  deny: (id: string) => call(`/client/requests/${id}/deny`, { method: 'POST', json: {} }),
  undo: (id: string) => call<HubRequest>(`/client/requests/${id}/undo`, { method: 'POST', json: {} }),
  pairDevice: (name: string) => call<{ code: string; expires_at: number }>('/client/devices/pair', { method: 'POST', json: { name } }),
  invite: (guildId: string, body: { username: string; global_name?: string } | { user_id: string }) => call<{ user: User; code: string | null; expires_at: number | null }>(`/client/guilds/${guildId}/invites`, { method: 'POST', json: body }),
  removeMember: (guildId: string, userId: string) => call<{ removed: string }>(`/client/guilds/${guildId}/members/${userId}`, { method: 'DELETE' }),
  setMemberRoles: (guildId: string, userId: string, roles: string[]) => call<{ user_id: string; roles: string[] }>(`/client/guilds/${guildId}/members/${userId}/roles`, { method: 'PUT', json: { roles } }),
  createRole: (guildId: string, body: { name: string; color?: number; permissions?: string; hoist?: boolean; mentionable?: boolean }) => call<Role>(`/client/guilds/${guildId}/roles`, { method: 'POST', json: body }),
  patchRole: (guildId: string, roleId: string, body: { name?: string; color?: number; permissions?: string; hoist?: boolean; mentionable?: boolean; position?: number }) => call<Role>(`/client/guilds/${guildId}/roles/${roleId}`, { method: 'PATCH', json: body }),
  deleteRole: (guildId: string, roleId: string) => call<{ deleted: string }>(`/client/guilds/${guildId}/roles/${roleId}`, { method: 'DELETE' }),
  setOverwrite: (channelId: string, targetId: string, body: { type: 0 | 1; allow: string; deny: string } | null) =>
    call<{ channel_id: string; permission_overwrites: Overwrite[] }>(`/client/channels/${channelId}/permissions/${targetId}`, body ? { method: 'PUT', json: body } : { method: 'DELETE' }),
}

// Where this window is, for presence: sent on change and again after every reconnect.
let liveSocket: WebSocket | null = null
let focus: { channel_id: string | null; visible: boolean } = { channel_id: null, visible: true }
export function reportFocus(next: { channel_id: string | null; visible: boolean }) {
  if (next.channel_id === focus.channel_id && next.visible === focus.visible) return
  focus = next
  if (native) return sendNativeFocus(focus)
  if (liveSocket?.readyState === WebSocket.OPEN) liveSocket.send(JSON.stringify({ op: 'focus', d: focus }))
}

// Reconnecting event socket. `onOpen` runs after every (re)connect so the app can resync.
export function connectEvents(onEvent: (t: string, d: any) => void, onOpen: () => void, onStatus: (online: boolean) => void): () => void {
  if (native) {
    sendNativeFocus(focus)
    return connectNativeEvents(onEvent, onOpen, onStatus)
  }
  let socket: WebSocket | null = null
  let closed = false
  let delay = 500
  const open = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/client/events`)
    socket.onmessage = (message) => {
      const { t, d } = JSON.parse(String(message.data)) as { t: string; d: any }
      if (t === 'HELLO') {
        delay = 500
        liveSocket = socket
        socket?.send(JSON.stringify({ op: 'focus', d: focus }))
        onStatus(true)
        onOpen()
        return
      }
      onEvent(t, d)
    }
    socket.onclose = () => {
      onStatus(false)
      if (closed) return
      setTimeout(open, delay)
      delay = Math.min(delay * 2, 15_000)
    }
  }
  open()
  const wake = () => {
    if (document.visibilityState === 'visible' && socket?.readyState === WebSocket.CLOSED) open()
  }
  document.addEventListener('visibilitychange', wake)
  return () => {
    closed = true
    document.removeEventListener('visibilitychange', wake)
    socket?.close()
  }
}
