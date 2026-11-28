// One external store for hub state, message caches and typing, fed by the
// REST API and the event socket.

import { useSyncExternalStore } from 'react'
import { eventApplied, eventSettled } from './perf.ts'
import { BOARD_UPDATED } from './board-document.ts'
import { forgetMissingImages } from './Avatar.tsx'
import { forgetRunClocks, sampleRun } from './run-clock.ts'
import { displayName, machineLabel } from './text.ts'
import { api, type Bookmark, type HubRequest, type MachineRoutines, type Reminder, type Schedule, toReminder, type Channel, type HubState, type MachineSummary, type Message, type Command, type Guild, type Service, type SessionLink, type SessionSummary, type User, type Role, type GuildMember, type Overwrite, type ChosenStatus, type CustomStatus } from './api.ts'

// Messages not loaded between two loaded ones: more than a page arrived while this view slept.
export type Gap = { after: string; before: string }
export type ChannelMessages = { list: Message[]; hasMore: boolean; loading: boolean; arrival?: string; gaps?: Gap[] }

// Messages a channel keeps once no view shows it, and once its reader is back at the newest.
export const KEEP_HIDDEN = 100
export const KEEP_AT_BOTTOM = 200

type Data = {
  state: HubState | null
  messages: Record<string, ChannelMessages>
  // In conversation order, but never used as a history cursor or counted as unread.
  privateReplies: Record<string, Message[]>
  // channel id -> user id -> typing until (ms)
  typing: Record<string, Record<string, number>>
  online: boolean
  seen: Record<string, string>
  sessions: Record<string, SessionSummary>
  machines: MachineSummary[]
  favourites: string[]
  mentions: Record<string, number>
  // Channels marked unread by hand, to the message: they stay unread while open.
  held: Record<string, string>
  links: Record<string, number>
  output: Record<string, boolean>
  services: Service[] | null
  // Changes agents asked for, waiting on the hub owner (owner only).
  requests: HubRequest[]
  // This person's reminders, soonest first; null on a hub without them.
  reminders: Reminder[] | null
  // Messages waiting to be posted (and ones that failed), soonest first.
  scheduled: Schedule[]
  // This person's bookmarked messages, newest first; null until loaded.
  bookmarks: Bookmark[] | null
  routines: MachineRoutines[]
  // A short confirmation ("Reminder set for 15:40"), shown for a few seconds.
  notice: string | null
  linked: Record<string, SessionLink[]>
}

export const THREAD_TYPES = new Set([10, 11, 12])

export function snowflakeGt(a: string | null | undefined, b: string | null | undefined) {
  if (!a) return false
  if (!b) return true
  return a.length !== b.length ? a.length > b.length : a > b
}

export const DM_GUILD = '@me'
export const isDm = (c: { type: number } | undefined) => c?.type === 1 || c?.type === 3
// The other person in a direct message (yourself for a note to self).
export function dmUser(c: Channel, me: string) {
  return c.recipients?.find((u) => u.id !== me) ?? c.recipients?.[0]
}
// A DM is named after the person, or after the machine for one with a machine's agent.
export function dmName(c: Channel, me: string) {
  if (c.machine) return agentName(store.data.state?.machine_bots, c.machine)
  const u = dmUser(c, me)
  return u ? displayName(u) : 'Direct message'
}

class Store {
  data: Data = { state: null, messages: {}, privateReplies: {}, typing: {}, online: false, seen: JSON.parse(localStorage.getItem('seen') ?? '{}'), sessions: {}, machines: [], favourites: [], mentions: {}, links: {}, output: {}, services: null, linked: {}, requests: [], held: {}, reminders: null, scheduled: [], bookmarks: null, routines: [], notice: null }
  private unsentRead: Record<string, string> = {}
  private readTimer: number | undefined
  private accessTimer: number | undefined
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(t: string, d: any) => void>()

  // Every hub event after the store applied it; 'RESYNC' after a reconnect.
  onEvent = (listener: (t: string, d: any) => void) => {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private emit(t: string, d: any) {
    for (const listener of this.eventListeners) {
      try {
        listener(t, d)
      } catch (error) {
        console.error('[events]', error)
      }
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<Data>) {
    this.data = { ...this.data, ...patch }
    for (const listener of this.listeners) listener()
  }

  // Changes that land while a state load is on its way: its snapshot may predate them
  // (a DM opened, a role switched during a resync), so they are applied again on top.
  private loading = 0
  private late: Array<[string, any]> = []
  // New messages during a state load: a snapshot taken before one would lose its unread mark
  // and mention count, so those are put back when the snapshot is older.
  private lateMessages: Array<{ channelId: string; id: string; mention: boolean }> = []

  async loadState() {
    if (this.loading++ === 0) {
      this.late = []
      this.lateMessages = []
    }
    let state: Awaited<ReturnType<typeof api.state>>
    try {
      state = await api.state()
    } finally {
      this.loading--
    }
    // Direct messages live with the channels, under the "@me" server, as Discord routes them.
    if (state.private_channels) state.channels = [...state.channels, ...state.private_channels.map((c) => ({ ...c, guild_id: DM_GUILD }))]
    // Read state lives on the hub so every device agrees; localStorage is the offline copy.
    // The hub's positions win (one may have moved back: mark unread), except reads this
    // device has not sent yet.
    let seen = mergeSeen({ ...this.data.seen, ...(state.read ?? {}) }, this.unsentRead)
    // First sight is read: an owner who has never read anything starts with nothing unread.
    if (Object.keys(state.read ?? {}).length === 0 && Object.keys(this.data.seen).length === 0) {
      seen = {}
      for (const c of [...state.channels, ...state.threads]) if (c.last_message_id) seen[c.id] = c.last_message_id
      void api.markRead(seen).catch(() => {})
    }
    localStorage.setItem('seen', JSON.stringify(seen))
    this.set({ state, seen, favourites: state.favourites ?? [], mentions: state.mentions ?? {}, links: state.links ?? {}, output: state.output ?? {} })
    if (this.loading === 0) {
      for (const [t, d] of this.late.splice(0)) this.apply(t, d)
      for (const m of this.lateMessages.splice(0)) {
        if (!snowflakeGt(m.id, this.channel(m.channelId)?.last_message_id)) continue
        if (m.mention && snowflakeGt(m.id, this.data.seen[m.channelId])) this.set({ mentions: { ...this.data.mentions, [m.channelId]: (this.data.mentions[m.channelId] ?? 0) + 1 } })
        this.bumpLastMessage(m.channelId, m.id)
      }
    }
    void this.loadOverview()
    void api.schedules().then(
      ({ schedules }) =>
        this.set({
          reminders: sortReminders(schedules.filter((x) => x.kind === 'reminder' && x.status !== 'cancelled' && x.status !== 'dismissed').map(toReminder)),
          scheduled: sortScheduled(schedules.filter(waiting)),
        }),
      () => this.set({ reminders: null, scheduled: [] }),
    )
    void api.bookmarks().then(({ bookmarks }) => this.set({ bookmarks }), () => {})
    void api.routines().then(({ machines }) => this.set({ routines: machines }), () => this.set({ routines: [] }))
    // Services and machine health are the hub owner's alone.
    if (state.hub_owner !== false) {
      void this.loadServices().catch(() => {})
      void this.loadRequests().catch(() => {})
    } else this.set({ services: null, requests: [] })
  }

  private loadingOverview: Set<string> | null = null

  async loadOverview() {
    const changed = this.loadingOverview = new Set<string>()
    const overview = await api.overview().catch(() => null)
    if (this.loadingOverview !== changed) return
    this.loadingOverview = null
    if (!overview) return
    const sampleTime = this.data.online ? overview.server_time_ms : undefined
    const sessions = Object.fromEntries(overview.sessions.map((s) => [s.id, sampleRun(s, sampleTime)]))
    // An end/start frame received during reconnect wins over an older response.
    for (const id of changed) {
      const current = this.data.sessions[id]
      if (current) sessions[id] = current
      else delete sessions[id]
    }
    this.set({ sessions, machines: overview.machines })
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

  // Your status and custom status; your own presence follows from the hub.
  async setUserStatus(body: { status?: ChosenStatus; custom_status?: CustomStatus | null }) {
    const state = this.data.state
    const was = state?.user_status ?? { status: 'online' as const, custom_status: null }
    if (state) this.set({ state: { ...state, user_status: { ...was, ...body } } })
    const me = await api.patchMe(body)
    const now = this.data.state
    if (now && me.user_status) this.set({ state: { ...now, user_status: me.user_status } })
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
    if (online) return this.set({ online })
    this.loadingOverview = null
    forgetRunClocks()
    const sessions = Object.fromEntries(Object.entries(this.data.sessions).map(([id, s]) => [id, s.runStartedAt == null ? s : { ...s, runStartedAt: null }]))
    this.set({ online, sessions })
  }

  // `inPlace`: a view showing this channel catches up (a reconnect or wake) and keeps what it
  // shows. Discord's way: only the newest page is fetched, and if it does not reach the loaded
  // messages the space between them is a gap the reader loads on request.
  async loadMessages(channelId: string, { older = false, refresh = false, inPlace = false } = {}) {
    const current = this.data.messages[channelId]
    // A cached list older than the channel's last message (opened mid-import, or missed
    // events while away) is refreshed on open instead of shown stale or empty.
    const last = this.channel(channelId)?.last_message_id
    if (current && !older && !refresh && !current.loading && last && snowflakeGt(last, current.list.at(-1)?.id ?? '0')) refresh = true
    if (current?.loading || (current && !older && !refresh)) return
    if (older && (!current || !current.hasMore)) return
    const keep = inPlace && !older && Boolean(current?.list.length)
    this.setMessages(channelId, { ...current, list: current?.list ?? [], hasMore: current?.hasMore ?? true, loading: true })
    try {
      const before = older ? current?.list[0]?.id : undefined
      const priorPrivate = this.data.privateReplies[channelId]
      const page = await api.messages(channelId, before)
      if (page.privateReplies && this.data.privateReplies[channelId] === priorPrivate) this.set({ privateReplies: { ...this.data.privateReplies, [channelId]: page.privateReplies.map((m) => ({ ...m, private_reply: true })) } })
      const now = this.data.messages[channelId]
      const latest = now?.list ?? []
      const first = page.messages[0]?.id, end = page.messages.at(-1)?.id
      const newer = latest.filter((m) => snowflakeGt(m.id, end))
      if (older) this.setMessages(channelId, { ...now, list: [...page.messages, ...latest], hasMore: page.hasMore, loading: false })
      else if (!keep || !first) this.setMessages(channelId, { list: mergeById(page.messages, refresh ? newer : []), hasMore: page.hasMore, loading: false })
      else {
        // What is loaded stays; the page replaces its own span (so deletions there show).
        const kept = page.hasMore ? latest.filter((m) => snowflakeGt(first, m.id)) : []
        const list = mergeById(kept, [...page.messages, ...newer])
        // A gap only when the newest page starts after everything loaded: it does not overlap.
        const tail = kept.length && kept.length === latest.length - newer.length ? kept.at(-1)?.id : undefined
        const gaps = [...(now?.gaps ?? []).map((g) => ({ after: g.after, before: snowflakeGt(g.before, first) ? first : g.before })), ...(tail && !(now?.gaps ?? []).some((g) => g.after === tail) ? [{ after: tail, before: first }] : [])]
        this.setMessages(channelId, { ...now, list, hasMore: page.hasMore && (now?.hasMore ?? true), loading: false, gaps: openGaps(list, gaps) })
      }
    } catch (error) {
      const now = this.data.messages[channelId]
      this.setMessages(channelId, { ...now, list: now?.list ?? current?.list ?? [], hasMore: current?.hasMore ?? false, loading: false })
      throw error
    }
  }

  // Loads the next page into a gap; the gap closes when that page reaches the messages after it.
  async fillGap(channelId: string, after: string) {
    const current = this.data.messages[channelId]
    if (!current || current.loading || !current.gaps?.some((g) => g.after === after)) return
    this.setMessages(channelId, { ...current, loading: true })
    try {
      const page = await api.messagesAfter(channelId, after)
      const now = this.data.messages[channelId]!
      const end = page.messages.at(-1)?.id
      const gaps = (now.gaps ?? []).flatMap((g) => (g.after !== after ? [g] : page.hasMore && end && snowflakeGt(g.before, end) ? [{ after: end, before: g.before }] : []))
      const list = mergeById(now.list, page.messages)
      this.setMessages(channelId, { ...now, list, loading: false, gaps: openGaps(list, gaps) })
    } catch (error) {
      const now = this.data.messages[channelId]
      if (now) this.setMessages(channelId, { ...now, loading: false })
      throw error
    }
  }

  private setMessages(channelId: string, value: ChannelMessages) {
    this.set({ messages: { ...this.data.messages, [channelId]: value } })
  }

  // The POST and gateway acknowledge the same row in either order. A late
  // HTTP receipt must never overwrite a newer edit or create a second row.
  // The owner's message shows as soon as they press Enter, as on Discord; the hub's copy
  // replaces it when it comes back (the reply to the send or its live event, whichever is first).
  sendLocal(channelId: string, content: string, replyTo?: Message, ping = true, flags?: number) {
    const page = this.data.messages[channelId], state = this.data.state
    // The owner's name and picture come from their own last message here, else the user list.
    const me = state && (page?.list.findLast((m) => m.author.id === state.me.id && !m.local)?.author ?? state.users.find((u) => u.id === state.me.id))
    if (!page || !me) return undefined
    const now = (BigInt(Date.now()) - 1420070400000n) << 22n
    const tail = BigInt(page.list.at(-1)?.id ?? '0') + 1n
    const id = String(now > tail ? now : tail)
    const m: Message = { id, channel_id: channelId, author: me, content, timestamp: new Date().toISOString(), edited_timestamp: null, type: replyTo ? 19 : 0, attachments: [], embeds: [], mentions: replyTo && ping && replyTo.author.id !== me.id ? [replyTo.author] : [], ...(flags && { flags }), ...(replyTo && { message_reference: { message_id: replyTo.id, channel_id: channelId } }), local: true }
    this.setMessages(channelId, { ...page, list: [...page.list, m], arrival: id })
    return id
  }

  dropLocal(channelId: string, id: string) {
    const page = this.data.messages[channelId]
    if (page?.list.some((m) => m.id === id && m.local)) this.setMessages(channelId, { ...page, list: page.list.filter((m) => m.id !== id) })
  }

  confirmSent(m: Message, local?: string) {
    if (local) this.dropLocal(m.channel_id, local)
    const page = this.data.messages[m.channel_id]
    if (page && !page.list.some(row => row.id === m.id)) this.receiveMessage(m)
  }

  private receiveMessage(m: Message) {
    const page = this.data.messages[m.channel_id]
    if (!page) return
    // The hub's copy of a message shown locally takes its place.
    const local = m.author.id === this.data.state?.me.id ? page.list.find((row) => row.local && row.content === m.content) : undefined
    const list = local ? page.list.filter((row) => row !== local) : page.list
    const last = list.at(-1)
    const elapsed = Date.now() - Date.parse(m.timestamp)
    const fresh = !page.loading && last && snowflakeGt(m.id, last.id) && elapsed >= -5000 && elapsed < 60000
    this.setMessages(m.channel_id, { ...page, list: mergeById(list, [m]), ...(fresh && !local && { arrival: m.id }) })
  }

  dismissPrivateReply(channelId: string, id: string) {
    const here = this.data.privateReplies[channelId]
    if (here?.some((m) => m.id === id)) this.set({ privateReplies: { ...this.data.privateReplies, [channelId]: here.filter((m) => m.id !== id) } })
  }

  // Discord's Mark Unread: read up to just before the message, here and on every device.
  markUnread(channelId: string, messageId: string) {
    this.setSeen(channelId, String(BigInt(messageId) - 1n))
    delete this.unsentRead[channelId]
    this.set({ held: { ...this.data.held, [channelId]: messageId } })
    void api.markUnread(channelId, messageId).catch(() => {})
  }

  // Long history scrolled back through costs memory in every view of it: a channel
  // nobody shows keeps only its newest messages, and loads older ones again on scroll.
  private shown = new Map<string, number>()
  // Chats whose reader is at the newest message with the window in front. A message there is
  // read in the same update that adds it, so nothing (the sidebar above all) draws it as
  // unread for a moment and then as read again.
  private readers = new Map<string, () => boolean>()
  follow(channelId: string, atEnd: () => boolean) {
    this.readers.set(channelId, atEnd)
    return () => { if (this.readers.get(channelId) === atEnd) this.readers.delete(channelId) }
  }
  show(channelId: string) {
    this.shown.set(channelId, (this.shown.get(channelId) ?? 0) + 1)
    return () => {
      const left = (this.shown.get(channelId) ?? 1) - 1
      if (left > 0) return void this.shown.set(channelId, left)
      this.shown.delete(channelId)
      // Gaps belong to the view that slept: opening the channel again starts from the newest.
      const current = this.data.messages[channelId]
      const cut = current?.gaps?.at(-1)?.before
      if (current && cut && !current.loading) this.setMessages(channelId, { ...current, list: current.list.filter((m) => !snowflakeGt(cut, m.id)), hasMore: true, gaps: undefined })
      this.trimMessages(channelId, KEEP_HIDDEN)
    }
  }

  trimMessages(channelId: string, keep: number) {
    const current = this.data.messages[channelId]
    if (!current || current.loading || current.list.length <= keep) return
    const list = current.list.slice(-keep)
    this.setMessages(channelId, { ...current, list, hasMore: true, gaps: openGaps(list, current.gaps) })
  }

  // Leaving a channel marked unread lets reading it count again.
  release(channelId: string) {
    if (!(channelId in this.data.held)) return
    const { [channelId]: _, ...held } = this.data.held
    this.set({ held })
  }

  private setSeen(channelId: string, messageId: string | null) {
    const seen = { ...this.data.seen }
    if (messageId) seen[channelId] = messageId
    else delete seen[channelId]
    localStorage.setItem('seen', JSON.stringify(seen))
    this.set({ seen })
  }

  markSeen(channelId: string, messageId?: string) {
    if (channelId in this.data.held) return
    const last = messageId ?? this.channel(channelId)?.last_message_id
    if (!last || !snowflakeGt(last, this.data.seen[channelId])) return
    const seen = { ...this.data.seen, [channelId]: last }
    localStorage.setItem('seen', JSON.stringify(seen))
    // The mention counts stay the same object unless this chat had some: every view of them
    // (the sidebar among them) would be drawn again for nothing.
    const { [channelId]: _, ...mentions } = this.data.mentions
    this.set(channelId in this.data.mentions ? { seen, mentions } : { seen })
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

  // A direct message: the hub's one if it exists, else a new one; it joins the list at once.
  async openDm(to: { recipient_id: string } | { machine: string }) {
    const existing = this.data.state?.channels.find((c) => isDm(c) && ('machine' in to ? c.machine?.toLowerCase() === to.machine.toLowerCase() : !c.machine && c.recipients?.some((u) => u.id === to.recipient_id)))
    if (existing) return existing
    const c = await api.openDm(to)
    this.addUsers(c.recipients ?? [])
    this.upsertChannel({ ...c, guild_id: DM_GUILD })
    return c
  }

  async refreshDms() {
    const { channels } = await api.dms().catch(() => ({ channels: [] as Channel[] }))
    for (const c of channels) this.upsertChannel({ ...c, guild_id: DM_GUILD })
  }

  private addUsers(users: User[]) {
    const state = this.data.state
    if (!state) return
    const fresh = users.filter((u) => !state.users.some((x) => x.id === u.id))
    if (fresh.length) this.set({ state: { ...state, users: [...state.users, ...fresh] } })
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

  removeMessages(channelId: string, ids: readonly string[]) {
    const gone = new Set(ids)
    const remove = (list: Message[]) => list.filter((m) => !(m.channel_id === channelId && gone.has(m.id)))
    this.patchMessages(channelId, remove)
    if (this.data.bookmarks?.some((b) => gone.has(b.message.id))) this.set({ bookmarks: this.data.bookmarks.filter((b) => !gone.has(b.message.id)) })
    // A loaded thread can also show its parent's starter.
    for (const t of this.data.state?.threads ?? []) if (t.parent_id === channelId && this.data.messages[t.id]?.list.some((m) => gone.has(m.id))) this.patchMessages(t.id, remove)
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
    eventApplied(t)
    if (this.loading && REPLAYED.has(t)) this.late.push([t, d])
    switch (t) {
      case 'HUB_UPDATE':
        window.dispatchEvent(new CustomEvent('vocorum-hub-update', { detail: d }))
        break
      case 'PANEL_UPDATE':
        if (d?.slot === 'board' && typeof d.thread_id === 'string') window.dispatchEvent(new CustomEvent(BOARD_UPDATED, { detail: d.thread_id }))
        break
      case 'ROUTINES_UPDATE': {
        const m = d as MachineRoutines
        this.set({ routines: [...this.data.routines.filter((x) => x.machine !== m.machine), m].sort((a, b) => a.machine.localeCompare(b.machine)) })
        break
      }
      case 'SCHEDULE_UPDATE': {
        const s = d as Schedule
        if (s.kind === 'message') {
          this.upsertScheduled(s)
          break
        }
        if (s.status === 'cancelled' || s.status === 'dismissed') this.dropReminder(s.id)
        else this.upsertReminder(toReminder(s))
        break
      }
      // Another of this person's devices read, or marked unread, a channel.
      case 'MESSAGE_ACK': {
        const { channel_id: id, message_id: at, manual } = d as { channel_id: string; message_id: string | null; manual: boolean }
        if (manual) this.setSeen(id, at)
        else if (at && snowflakeGt(at, this.data.seen[id])) {
          this.setSeen(id, at)
          if (!snowflakeGt(this.channel(id)?.last_message_id, at)) {
            const { [id]: _, ...mentions } = this.data.mentions
            this.set({ mentions })
          }
        }
        break
      }
      case 'PRIVATE_REPLY':
      case 'PRIVATE_REPLY_DELETE': {
        const here = this.data.privateReplies[d.channel_id] ?? []
        const list = t === 'PRIVATE_REPLY' ? mergeById(here, [{ ...d, private_reply: true }]) : here.filter((m) => m.id !== d.id)
        this.set({ privateReplies: { ...this.data.privateReplies, [d.channel_id]: list } })
        break
      }
      case 'MESSAGE_CREATE': {
        const message = d as Message
        // Only fresh ones: a message older than a minute is history arriving late, not news.
        if (Date.now() - Number((BigInt(message.id) >> 22n) + 1420070400000n) < 60_000) for (const listener of incoming) listener(message)
        const me = this.data.state?.me.id
        const mention = Boolean(me && message.author.id !== me && ((message.content ?? '').includes(`<@${me}>`) || message.mentions?.some((u) => u.id === me)))
        if (this.loading) this.lateMessages.push({ channelId: message.channel_id, id: message.id, mention })
        if (mention && snowflakeGt(message.id, this.data.seen[message.channel_id]))
          this.set({ mentions: { ...this.data.mentions, [message.channel_id]: (this.data.mentions[message.channel_id] ?? 0) + 1 } })
        this.receiveMessage(message)
        this.bumpLastMessage(message.channel_id, message.id)
        if (this.readers.get(message.channel_id)?.()) this.markSeen(message.channel_id, message.id)
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
          if (this.data.bookmarks?.some((b) => b.message.id === d.id)) this.set({ bookmarks: this.data.bookmarks.map((b) => (b.message.id === d.id ? { ...b, message: { ...b.message, ...(d as Message) } } : b)) })
          // A thread starter is shown inside its thread too.
          for (const thread of this.data.state?.threads ?? []) if (thread.parent_id === d.channel_id && this.data.messages[thread.id]?.list.some(m => m.id === d.id)) this.patchMessages(thread.id, replace)
        }
        break
      // Another of this person's devices bookmarked a message, or one went.
      case 'SAVED_MESSAGE_CREATE':
        this.upsertBookmark(d as Bookmark)
        break
      case 'SAVED_MESSAGE_DELETE':
        this.set({ bookmarks: this.data.bookmarks?.filter((b) => b.message.id !== d.message_id) ?? null })
        break
      case 'MESSAGE_DELETE':
        this.removeMessages(d.channel_id, [d.id])
        break
      case 'MESSAGE_DELETE_BULK':
        this.removeMessages(d.channel_id, d.ids)
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
      case 'CHANNEL_UPDATE': {
        const c = d as Channel
        if (isDm(c)) this.addUsers(c.recipients ?? [])
        this.upsertChannel(isDm(c) ? { ...c, guild_id: DM_GUILD } : c)
        // The gateway's DM lacks the hub's own fields (machine, note): read them back.
        if (isDm(c) && !('machine' in c)) void this.refreshDms()
        break
      }
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
        this.loadingOverview?.add(d.id)
        const { [d.id]: _, ...rest } = this.data.sessions
        this.set({ sessions: d.removed ? rest : { ...this.data.sessions, [d.id]: sampleRun(d as SessionSummary, this.data.online ? d.server_time_ms : undefined) } })
        break
      }
      case 'VOICE_STATE_UPDATE': {
        const state = this.data.state
        if (!state) break
        const rest = (state.voice_states ?? []).filter((v) => v.user_id !== d.user_id)
        this.set({ state: { ...state, voice_states: d.channel_id ? [...rest, d] : rest } })
        break
      }
      case 'PRESENCE_UPDATE': {
        const state = this.data.state
        if (state) this.set({ state: { ...state, presence: { ...state.presence, [d.user_id]: d } } })
        break
      }
      case 'USER_SETTINGS_UPDATE': {
        const state = this.data.state
        if (state) this.set({ state: { ...state, user_status: d } })
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
    this.emit(t, d)
    eventSettled()
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

  private noticeTimer = 0
  notice(text: string) {
    window.clearTimeout(this.noticeTimer)
    this.set({ notice: text })
    this.noticeTimer = window.setTimeout(() => this.set({ notice: null }), 3000)
  }

  upsertScheduled(s: Schedule) {
    const rest = this.data.scheduled.filter((x) => x.id !== s.id)
    this.set({ scheduled: waiting(s) ? sortScheduled([...rest, s]) : rest })
  }

  upsertReminder(reminder: Reminder) {
    this.set({ reminders: sortReminders([reminder, ...(this.data.reminders ?? []).filter((r) => r.id !== reminder.id)]) })
  }

  isBookmarked(messageId: string) {
    return Boolean(this.data.bookmarks?.some((b) => b.message.id === messageId))
  }

  upsertBookmark(bookmark: Bookmark) {
    this.set({ bookmarks: [bookmark, ...(this.data.bookmarks ?? []).filter((b) => b.message.id !== bookmark.message.id)].sort((a, b) => b.saved_at.localeCompare(a.saved_at)) })
  }

  async toggleBookmark(channelId: string, messageId: string) {
    if (this.isBookmarked(messageId)) {
      const before = this.data.bookmarks
      this.set({ bookmarks: before!.filter((b) => b.message.id !== messageId) })
      await api.bookmark(channelId, messageId, false).catch((e: Error) => {
        this.set({ bookmarks: before })
        throw e
      })
    } else {
      const saved = await api.bookmark(channelId, messageId, true)
      if (saved) this.upsertBookmark(saved)
    }
  }

  dropReminder(id: string) {
    this.set({ reminders: (this.data.reminders ?? []).filter((r) => r.id !== id) })
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
    this.emit('RESYNC', null)
    await this.loadState()
    if (this.data.services) void this.loadServices().catch(() => {})
    await Promise.all(Object.keys(this.data.messages).map((id) => this.loadMessages(id, { refresh: true, inPlace: this.shown.has(id) }).catch(() => {})))
  }
}

// Events that only set something in the state, so applying one twice changes nothing.
// New messages as they arrive, for the in-app notification.
const incoming = new Set<(message: Message) => void>()
export const onIncoming = (listener: (message: Message) => void) => {
  incoming.add(listener)
  return () => void incoming.delete(listener)
}

const REPLAYED = new Set(['THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'CHANNEL_PERMISSIONS_UPDATE', 'GUILD_UPDATE', 'GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE', 'MACHINE_ICONS_UPDATE', 'USER_UPDATE', 'OUTPUT_VIEW', 'SESSION_LINKS', 'NOTIFICATION_SETTINGS_UPDATE', 'USER_SETTINGS_UPDATE', 'PRESENCE_UPDATE', 'VOICE_STATE_UPDATE'])

const sortReminders = (list: Reminder[]) => [...list].sort((a, b) => a.at - b.at)
// A scheduled message still to post, or one that failed and should be seen.
const waiting = (s: Schedule) => s.kind === 'message' && (s.status === 'pending' || s.status === 'failed')
const sortScheduled = (list: Schedule[]) => [...list].sort((a, b) => (a.next_at ?? Infinity) - (b.next_at ?? Infinity))

function mergeSeen(a: Record<string, string>, b: Record<string, string>) {
  const out = { ...a }
  for (const [id, value] of Object.entries(b)) if (snowflakeGt(value, out[id])) out[id] = value
  return out
}

// Gaps whose earlier side is still loaded and whose later side is not reached yet.
function openGaps(list: Message[], gaps: Gap[] | undefined) {
  if (!gaps?.length) return undefined
  const ids = new Set(list.map((m) => m.id))
  const open = gaps.filter((g) => ids.has(g.after) && snowflakeGt(g.before, g.after) && !list.some((m) => snowflakeGt(m.id, g.after) && snowflakeGt(g.before, m.id)))
  return open.length ? open : undefined
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

// The machine whose agent posts in a channel: its project's category names it (Discord's
// "Kimaki <machine>" categories). Bots there are shown by that name everywhere.
export function machineOf(state: HubState, channel: Channel): string | null {
  const project = THREAD_TYPES.has(channel.type) ? (state.channels.find((c) => c.id === channel.parent_id) ?? channel) : channel
  const category = state.channels.find((c) => c.id === project.parent_id)
  return category ? machineNamed(state, category.name ?? '') : null
}

// The machine a category stands for: "<machine>" or "Kimaki <machine>", where a mirrored
// server names the machine by its Discord bot ("Kimaki Desk PC" for "desk-pc").
export function machineNamed(state: HubState, category: string): string | null {
  const name = category.toLowerCase()
  const names = (m: string) => m.toLowerCase() === name || `kimaki ${m.toLowerCase()}` === name
  return state.machines.find(names) ?? Object.entries(state.machine_bots ?? {}).find(([, bot]) => names(bot.name))?.[0] ?? null
}

// How a machine's agent is named: its Discord bot's name ("Desk PC"), else the machine's.
export const agentName = (bots: HubState['machine_bots'], machine: string) => bots?.[machine]?.name ?? machineLabel(machine)
// A machine named as its messages show it: once, from the loaded state, or in a component that follows changes.
export const machineName = (machine: string) => agentName(store.data.state?.machine_bots, machine)
export function useMachineName() {
  const bots = useStore((d) => d.state?.machine_bots)
  return (machine: string) => agentName(bots, machine)
}
