// One external store for hub state, message caches and typing, fed by the
// REST API and the event socket.

import { useSyncExternalStore } from 'react'
import { forgetMissingImages } from './Avatar.tsx'
import { api, type HubRequest, type Channel, type HubState, type MachineSummary, type Message, type Command, type Guild, type Service, type SessionLink, type SessionSummary, type User, type Role, type GuildMember, type Overwrite } from './api.ts'

export type ChannelMessages = { list: Message[]; hasMore: boolean; loading: boolean }

type Data = {
  state: HubState | null
  messages: Record<string, ChannelMessages>
  // channel id -> user id -> typing until (ms)
  typing: Record<string, Record<string, number>>
  online: boolean
  seen: Record<string, string>
  sessions: Record<string, SessionSummary>
  machines: MachineSummary[]
  favourites: string[]
  mentions: Record<string, number>
  links: Record<string, number>
  output: Record<string, boolean>
  services: Service[] | null
  // Changes agents asked for, waiting on the hub owner (owner only).
  requests: HubRequest[]
  linked: Record<string, SessionLink[]>
}

export const THREAD_TYPES = new Set([10, 11, 12])

export function snowflakeGt(a: string | null | undefined, b: string | null | undefined) {
  if (!a) return false
  if (!b) return true
  return a.length !== b.length ? a.length > b.length : a > b
}

class Store {
  data: Data = { state: null, messages: {}, typing: {}, online: false, seen: JSON.parse(localStorage.getItem('seen') ?? '{}'), sessions: {}, machines: [], favourites: [], mentions: {}, links: {}, output: {}, services: null, linked: {}, requests: [] }
  private unsentRead: Record<string, string> = {}
  private readTimer: number | undefined
  private accessTimer: number | undefined
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<Data>) {
    this.data = { ...this.data, ...patch }
    for (const listener of this.listeners) listener()
  }

  async loadState() {
    const state = await api.state()
    // Read state lives on the hub so every device agrees; localStorage is the offline copy.
    let seen = mergeSeen(this.data.seen, state.read ?? {})
    // First sight is read: an owner who has never read anything starts with nothing unread.
    if (Object.keys(state.read ?? {}).length === 0 && Object.keys(this.data.seen).length === 0) {
      seen = {}
      for (const c of [...state.channels, ...state.threads]) if (c.last_message_id) seen[c.id] = c.last_message_id
      void api.markRead(seen).catch(() => {})
    }
    localStorage.setItem('seen', JSON.stringify(seen))
    this.set({ state, seen, favourites: state.favourites ?? [], mentions: state.mentions ?? {}, links: state.links ?? {}, output: state.output ?? {} })
    void this.loadOverview()
    // Services and machine health are the hub owner's alone.
    if (state.hub_owner !== false) {
      void this.loadServices().catch(() => {})
      void this.loadRequests().catch(() => {})
    } else this.set({ services: null, requests: [] })
  }

  async loadOverview() {
    const overview = await api.overview().catch(() => null)
    if (overview) this.set({ sessions: Object.fromEntries(overview.sessions.map((s) => [s.id, s])), machines: overview.machines })
  }

  async setNotification(scopeId: string, body: { level?: 'all' | 'mentions' | 'nothing' | null; muted_until?: number | null }) {
    const state = this.data.state
    const n = state?.notifications
    if (state && n) {
      const prev = n.settings[scopeId] ?? { level: null, muted_until: null }
      this.set({ state: { ...state, notifications: { ...n, settings: { ...n.settings, [scopeId]: { ...prev, ...body } } } } })
    }
    await api.setNotification(scopeId, body)
  }

  setPushSubscribed(on: boolean) {
    const state = this.data.state
    if (state?.notifications) this.set({ state: { ...state, notifications: { ...state.notifications, push_subscribed: on } } })
  }

  async toggleFavourite(channelId: string) {
    const on = !this.data.favourites.includes(channelId)
    this.set({ favourites: on ? [...this.data.favourites, channelId] : this.data.favourites.filter((id) => id !== channelId) })
    await api.favourite(channelId, on)
  }

  setOnline(online: boolean) {
    this.set({ online })
  }

  async loadMessages(channelId: string, { older = false, refresh = false } = {}) {
    const current = this.data.messages[channelId]
    // A cached list older than the channel's last message (opened mid-import, or missed
    // events while away) is refreshed on open instead of shown stale or empty.
    const last = this.channel(channelId)?.last_message_id
    if (current && !older && !refresh && !current.loading && last && snowflakeGt(last, current.list.at(-1)?.id ?? '0')) refresh = true
    if (current?.loading || (current && !older && !refresh)) return
    if (older && (!current || !current.hasMore)) return
    this.setMessages(channelId, { list: current?.list ?? [], hasMore: current?.hasMore ?? true, loading: true })
    try {
      const before = older ? current?.list[0]?.id : undefined
      const page = await api.messages(channelId, before)
      const latest = this.data.messages[channelId]?.list ?? []
      const list = older ? [...page.messages, ...latest] : mergeById(page.messages, refresh ? latest.filter((m) => snowflakeGt(m.id, page.messages.at(-1)?.id)) : [])
      this.setMessages(channelId, { list, hasMore: page.hasMore, loading: false })
    } catch (error) {
      this.setMessages(channelId, { list: current?.list ?? [], hasMore: false, loading: false })
      throw error
    }
  }

  private setMessages(channelId: string, value: ChannelMessages) {
    this.set({ messages: { ...this.data.messages, [channelId]: value } })
  }

  markSeen(channelId: string, messageId?: string) {
    const last = messageId ?? this.channel(channelId)?.last_message_id
    if (!last || !snowflakeGt(last, this.data.seen[channelId])) return
    const seen = { ...this.data.seen, [channelId]: last }
    localStorage.setItem('seen', JSON.stringify(seen))
    const { [channelId]: _, ...mentions } = this.data.mentions
    this.set({ seen, mentions })
    // Sent 400 ms later, batched, so a quick pass through threads costs one request.
    this.unsentRead[channelId] = last
    window.clearTimeout(this.readTimer)
    this.readTimer = window.setTimeout(() => {
      const batch = this.unsentRead
      this.unsentRead = {}
      void api.markRead(batch).catch(() => Object.assign(this.unsentRead, batch))
    }, 400)
  }

  markAllSeen(channelIds: string[]) {
    for (const id of channelIds) this.markSeen(id)
  }

  channel(id: string): Channel | undefined {
    const state = this.data.state
    return state?.channels.find((c) => c.id === id) ?? state?.threads.find((c) => c.id === id)
  }

  private upsertChannel(channel: Channel) {
    const state = this.data.state
    if (!state) return
    const key = THREAD_TYPES.has(channel.type) ? 'threads' : 'channels'
    const list = state[key]
    const index = list.findIndex((c) => c.id === channel.id)
    const merged = index >= 0 ? { ...list[index], ...channel } : channel
    const next = index >= 0 ? list.map((c, i) => (i === index ? merged : c)) : [...list, merged]
    this.set({ state: { ...state, [key]: next } })
  }

  private patchMessages(channelId: string, fn: (list: Message[]) => Message[]) {
    const current = this.data.messages[channelId]
    if (current) this.setMessages(channelId, { ...current, list: fn(current.list) })
  }

  private bumpLastMessage(channelId: string, messageId: string) {
    const channel = this.channel(channelId)
    if (channel && snowflakeGt(messageId, channel.last_message_id)) this.upsertChannel({ ...channel, last_message_id: messageId })
  }

  // Applies one gateway dispatch from the event socket.
  apply(t: string, d: any) {
    switch (t) {
      case 'MESSAGE_CREATE': {
        const message = d as Message
        const me = this.data.state?.me.id
        if (me && message.author.id !== me && (message.content ?? '').includes(`<@${me}>`) && snowflakeGt(message.id, this.data.seen[message.channel_id]))
          this.set({ mentions: { ...this.data.mentions, [message.channel_id]: (this.data.mentions[message.channel_id] ?? 0) + 1 } })
        this.patchMessages(message.channel_id, (list) => mergeById(list, [message]))
        this.bumpLastMessage(message.channel_id, message.id)
        const typing = this.data.typing[message.channel_id]
        if (typing?.[message.author.id]) {
          const { [message.author.id]: _, ...rest } = typing
          this.set({ typing: { ...this.data.typing, [message.channel_id]: rest } })
        }
        break
      }
      case 'MESSAGE_UPDATE':
        {
          // Full replacement: Discord omits empty fields (components: []).
          const replace = (list: Message[]) => list.map((m) => (m.id === d.id ? { ...(d as Message), reactions_summary: m.reactions_summary } : m))
          this.patchMessages(d.channel_id, replace)
          // A thread starter is shown inside its thread too.
          for (const thread of this.data.state?.threads ?? []) if (thread.parent_id === d.channel_id) this.patchMessages(thread.id, replace)
        }
        break
      case 'MESSAGE_DELETE':
        this.patchMessages(d.channel_id, (list) => list.filter((m) => m.id !== d.id))
        break
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE': {
        const add = t === 'MESSAGE_REACTION_ADD'
        const me = d.user_id === this.data.state?.me.id
        const update = (list: Message[]) =>
          list.map((m) => {
            if (m.id !== d.message_id) return m
            const reactions = [...(m.reactions_summary ?? [])]
            const index = reactions.findIndex((r) => r.emoji === d.emoji.name)
            const current = index >= 0 ? reactions[index]! : { emoji: d.emoji.name as string, count: 0, me: false }
            if (add && me && current.me) return m
            const next = { ...current, count: current.count + (add ? 1 : -1), me: me ? add : current.me }
            if (index >= 0) reactions[index] = next
            else reactions.push(next)
            return { ...m, reactions_summary: reactions.filter((r) => r.count > 0) }
          })
        for (const [channelId] of Object.entries(this.data.messages)) this.patchMessages(channelId, update)
        break
      }
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
        this.upsertChannel(d as Channel)
        break
      case 'THREAD_DELETE':
      case 'CHANNEL_DELETE': {
        const state = this.data.state
        if (state) this.set({ state: { ...state, channels: state.channels.filter((c) => c.id !== d.id), threads: state.threads.filter((c) => c.id !== d.id) } })
        break
      }
      case 'SERVICES': {
        this.set({ services: (d as { services: Service[] }).services })
        break
      }
      case 'GUILD_CREATE':
        void this.loadState()
        break
      case 'GUILD_UPDATE': {
        const g = d as { id: string; name: string; icon?: string | null }
        const state = this.data.state
        const icon = g.icon === undefined ? {} : { icon: g.icon }
        if (state?.guilds) this.set({ state: { ...state, guilds: state.guilds.map((x) => (x.id === g.id ? { ...x, name: g.name, ...icon } : x)), guild: state.guild.id === g.id ? { ...state.guild, name: g.name } : state.guild } })
        break
      }
      // Who may see what changed: refetch, once for a burst.
      case 'ACCESS_CHANGED':
        window.clearTimeout(this.accessTimer)
        this.accessTimer = window.setTimeout(() => void this.loadState().catch(() => {}), 150)
        break
      case 'CHANNEL_PERMISSIONS_UPDATE': {
        const channel = this.channel(d.channel_id)
        if (channel) this.upsertChannel({ ...channel, permission_overwrites: d.permission_overwrites as Overwrite[] })
        break
      }
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE':
      case 'GUILD_ROLE_DELETE': {
        const state = this.data.state
        if (!state) break
        const id = t === 'GUILD_ROLE_DELETE' ? (d.role_id as string) : (d.role as Role).id
        const others = (state.roles?.[d.guild_id] ?? []).filter((r) => r.id !== id)
        const roles = t === 'GUILD_ROLE_DELETE' ? others : [...others, d.role as Role].sort((a, b) => b.position - a.position)
        const members = t === 'GUILD_ROLE_DELETE' ? (state.members?.[d.guild_id] ?? []).map((m) => ({ ...m, roles: m.roles.filter((r) => r !== id) })) : state.members?.[d.guild_id]
        this.set({ state: { ...state, roles: { ...state.roles, [d.guild_id]: roles }, members: members ? { ...state.members, [d.guild_id]: members } : state.members } })
        break
      }
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE':
      case 'GUILD_MEMBER_REMOVE': {
        const state = this.data.state
        const user = d.user as User | undefined
        if (!state || !user) break
        const list = (state.members?.[d.guild_id] ?? []).filter((m) => m.user_id !== user.id)
        const previous = state.members?.[d.guild_id]?.find((m) => m.user_id === user.id)
        const member: GuildMember = { user_id: user.id, roles: d.roles ?? previous?.roles ?? [], nick: d.nick ?? previous?.nick ?? null, joined_at: d.joined_at ?? previous?.joined_at ?? new Date().toISOString() }
        const members = t === 'GUILD_MEMBER_REMOVE' ? list : [...list, member]
        const users = t === 'GUILD_MEMBER_REMOVE' || state.users.some((u) => u.id === user.id) ? state.users : [...state.users, user]
        this.set({ state: { ...state, users, members: { ...state.members, [d.guild_id]: members } } })
        break
      }
      case 'MACHINE_ICONS_UPDATE': {
        const state = this.data.state
        if (state) this.set({ state: { ...state, machine_icons: { ...state.machine_icons, [d.machine]: { avatar: d.avatar, guild_icon: d.guild_icon } } } })
        break
      }
      case 'USER_UPDATE': {
        const user = d as User
        const state = this.data.state
        if (state) this.set({ state: { ...state, users: state.users.some((u) => u.id === user.id) ? state.users.map((u) => (u.id === user.id ? { ...u, ...user } : u)) : [...state.users, user] } })
        break
      }
      case 'OUTPUT_VIEW': {
        const { id, output } = d as { id: string; output: boolean | null }
        const { [id]: _, ...rest } = this.data.output
        this.set({ output: output === null ? rest : { ...rest, [id]: output } })
        break
      }
      case 'SESSION_LINKS': {
        const counts = d as Record<string, number>
        // Only views that are showing links refetch; the rest read the counts.
        const stale = Object.keys(this.data.linked)
        this.set({ links: counts })
        for (const id of stale) void this.loadLinks(id).catch(() => {})
        break
      }
      case 'SESSION_STATE': {
        const { [d.id]: _, ...rest } = this.data.sessions
        this.set({ sessions: d.removed ? rest : { ...this.data.sessions, [d.id]: d as SessionSummary } })
        break
      }
      case 'PRESENCE_UPDATE': {
        const state = this.data.state
        if (state) this.set({ state: { ...state, presence: { ...state.presence, [d.user_id]: d } } })
        break
      }
      case 'NOTIFICATION_SETTINGS_UPDATE': {
        const state = this.data.state
        const n = state?.notifications
        if (state && n) this.set({ state: { ...state, notifications: { ...n, settings: { ...n.settings, [d.scope_id]: { level: d.level, muted_until: d.muted_until } } } } })
        break
      }
      case 'REQUEST_CREATE':
      case 'REQUEST_UPDATE':
        this.upsertRequest(d as HubRequest)
        break
      case 'MACHINES_UPDATE':
        this.set({ machines: d as MachineSummary[] })
        break
      case 'TYPING_START': {
        const channel = { ...(this.data.typing[d.channel_id] ?? {}), [d.user_id]: Date.now() + 10_000 }
        this.set({ typing: { ...this.data.typing, [d.channel_id]: channel } })
        break
      }
    }
  }

  // After a reconnect: refetch state and every loaded channel.
  // Every guild on the hub, primary first; older hubs only send the one.
  guilds(): Guild[] {
    const state = this.data.state
    return state ? (state.guilds?.length ? state.guilds : [{ ...state.guild, icon: null }]) : []
  }

  guildOf(channelId: string): string | undefined {
    const state = this.data.state
    return [...(state?.channels ?? []), ...(state?.threads ?? [])].find((c) => c.id === channelId)?.guild_id ?? state?.guild.id
  }

  // Slash commands registered in the channel's guild.
  commandsFor(channelId: string): Command[] {
    const state = this.data.state
    const guild = this.guildOf(channelId)
    return (guild ? state?.guildCommands?.[guild] : undefined) ?? state?.commands ?? []
  }

  // Output-only view: the owner's choice, else Discord-locked threads (read-only feeds).
  isOutput(channel: Channel): boolean {
    return this.data.output[channel.id] ?? Boolean(channel.thread_metadata?.locked)
  }

  async setOutput(channel: Channel, output: boolean) {
    const auto = Boolean(channel.thread_metadata?.locked)
    const value = output === auto ? null : output
    const { [channel.id]: _, ...rest } = this.data.output
    this.set({ output: value === null ? rest : { ...rest, [channel.id]: value } })
    await api.setOutput(channel.id, value)
  }

  async loadRequests() {
    const { requests } = await api.requests()
    this.set({ requests })
  }

  upsertRequest(request: HubRequest) {
    this.set({ requests: [request, ...this.data.requests.filter((r) => r.id !== request.id)].sort((a, b) => b.created_at - a.created_at) })
  }

  async loadServices() {
    const { services } = await api.services()
    this.set({ services })
  }

  async controlService(unit: string, verb: 'start' | 'stop' | 'restart') {
    const { services } = await api.serviceControl(unit, verb)
    this.set({ services })
  }

  async loadLinks(channelId: string) {
    const { links } = await api.links(channelId)
    const counts = { ...this.data.links, [channelId]: links.length }
    this.set({ linked: { ...this.data.linked, [channelId]: links }, links: counts })
  }


  async resync() {
    forgetMissingImages()
    await this.loadState()
    if (this.data.services) void this.loadServices().catch(() => {})
    await Promise.all(Object.keys(this.data.messages).map((id) => this.loadMessages(id, { refresh: true }).catch(() => {})))
  }
}

function mergeSeen(a: Record<string, string>, b: Record<string, string>) {
  const out = { ...a }
  for (const [id, value] of Object.entries(b)) if (snowflakeGt(value, out[id])) out[id] = value
  return out
}

function mergeById(base: Message[], incoming: Message[]) {
  const map = new Map(base.map((m) => [m.id, m]))
  for (const m of incoming) map.set(m.id, { ...map.get(m.id), ...m })
  return [...map.values()].sort((a, b) => (snowflakeGt(a.id, b.id) ? 1 : a.id === b.id ? 0 : -1))
}

export const store = new Store()

export function useStore<T>(select: (data: Data) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.data))
}
