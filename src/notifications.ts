// Notification settings and Web Push. Settings are per user and per guild,
// category, channel or thread (Discord's levels: all messages, mentions only,
// nothing; plus mute until). Pushes go to installed PWAs for messages the
// settings allow and for sessions that start waiting on the owner ("needs
// you"), unless a device is in front: then the open app shows it.

import { getMessageVisibleText } from 'discord-digital-twin/src'
import type { Hub } from './hub.ts'
import { isPushEndpoint, loadVapidKeys, sendPush, type PushTarget, type VapidKeys } from './push.ts'
import type { SessionSummary } from './sessions.ts'
import type { NotificationLevel, NotificationSetting } from './store.ts'

export const DEFAULT_LEVEL: NotificationLevel = 'mentions'
const DEFAULT_SUBJECT = 'mailto:hub@vocorum.invalid'
const REPEAT_MS = 3000
const SUPPRESS_NOTIFICATIONS = 1 << 12

export type PushKind = 'message' | 'mention' | 'needs_you' | 'reminder'
export type PushPayload = { kind: PushKind; title: string; body: string; tag: string; url: string; channel_id: string; guild_id: string | null; message_id: string | null }

// The first level set along thread, channel, category, guild; muted if any is.
export function effectiveSetting(chain: string[], settings: Record<string, NotificationSetting>, now = Date.now()) {
  const level = chain.map((id) => settings[id]?.level).find((l) => l) ?? DEFAULT_LEVEL
  const muted = chain.some((id) => (settings[id]?.muted_until ?? 0) > now)
  return { level, muted }
}

// Mentions and "needs you" come through a muted channel, like Discord; plain
// messages only with "all" and no mute; "nothing" silences everything.
export function shouldNotify(kind: PushKind, { level, muted }: { level: NotificationLevel; muted: boolean }) {
  if (level === 'nothing') return false
  return kind !== 'message' || (level === 'all' && !muted)
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

export class Notifications {
  readonly keys: VapidKeys
  private unobserve: (() => void) | null = null
  private waiting = new Set<string>()
  private lastPush = new Map<string, { at: number; kind: PushKind }>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly hub: Hub,
    vapidFile: string,
    private readonly options: { subject?: string; allowEndpoint?: (url: URL) => boolean } = {},
  ) {
    this.keys = loadVapidKeys(vapidFile)
  }

  get owner() {
    return this.hub.options.config.ownerUserId
  }

  allowEndpoint(endpoint: string) {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      return false
    }
    return (this.options.allowEndpoint ?? isPushEndpoint)(url)
  }

  start() {
    for (const s of this.hub.sessions.list()) if (s.state === 'waiting') this.waiting.add(s.id)
    this.unobserve = this.hub.twin.observeDispatches((event, data) => {
      if (event === 'MESSAGE_CREATE') this.enqueue(() => this.onMessage(data as MessageData))
    })
  }

  stop() {
    this.unobserve?.()
  }

  // Resolves when queued pushes have been sent (tests).
  flush() {
    return this.queue
  }

  // Hub events: a session that starts waiting on the owner.
  hubEvent(event: string, data: unknown) {
    if (event !== 'SESSION_STATE') return
    const summary = data as SessionSummary & { removed?: boolean }
    const was = this.waiting.has(summary.id)
    if (summary.removed || summary.state !== 'waiting') {
      this.waiting.delete(summary.id)
      return
    }
    this.waiting.add(summary.id)
    if (!was) this.enqueue(() => this.onWaiting(summary))
  }

  private enqueue(job: () => Promise<void>) {
    this.queue = this.queue.then(job).catch((error) => console.error('[push]', error))
  }

  // thread, channel, category, guild
  async chain(channelId: string): Promise<{ chain: string[]; guildId: string | null; name: string; guildName: string | null } | null> {
    const prisma = this.hub.twin.prisma
    const chain: string[] = []
    let channel = await prisma.channel.findUnique({ where: { id: channelId } })
    if (channel && this.hub.dms.get(channelId)) return { chain: [channelId], guildId: null, name: 'direct message', guildName: null }
    if (!channel || !this.hub.guildIds.has(channel.guildId ?? '')) return null
    const name = channel.name ?? ''
    const guildId = channel.guildId
    for (let depth = 0; channel && depth < 3; depth++) {
      chain.push(channel.id)
      channel = channel.parentId ? await prisma.channel.findUnique({ where: { id: channel.parentId } }) : null
    }
    if (guildId) chain.push(guildId)
    return { chain, guildId, name, guildName: this.hub.guilds.find((g) => g.id === guildId)?.name ?? null }
  }

  // People (not bots) in the channel's guild who can view it.
  private async readers(channelId: string, guildId: string | null) {
    if (this.hub.dms.get(channelId)) return this.hub.dms.people(channelId)
    if (!guildId) return []
    const members = await this.hub.twin.prisma.guildMember.findMany({ where: { guildId, user: { bot: false } }, select: { userId: true } })
    const out: string[] = []
    for (const { userId } of members) if (await this.hub.access.can(userId, channelId, 0n)) out.push(userId)
    return out
  }

  private async onMessage(message: MessageData) {
    // Mirrored from Discord: the Discord app already notified about it.
    if (!message.author || message.origin === 'discord') return
    // @silent (SUPPRESS_NOTIFICATIONS): unread and mention badges only, never a push, like Discord.
    if (((message.flags ?? 0) & SUPPRESS_NOTIFICATIONS) !== 0) return
    const where = await this.chain(message.channel_id)
    if (!where) return
    const text = getMessageVisibleText({ content: message.content ?? '', components: message.components ?? [] })
    const author = message.author.global_name ?? message.author.username ?? 'someone'
    for (const userId of await this.readers(message.channel_id, where.guildId)) {
      if (userId === message.author.id) continue
      const you = new RegExp(`<@!?${userId}>`, 'g')
      // A direct message notifies like a mention, as on Discord.
      const direct = this.hub.dms.get(message.channel_id) !== null
      const mention = direct || message.mention_everyone || (message.mentions ?? []).some((u) => u.id === userId) || you.test(`${message.content ?? ''}\n${text}`)
      if (!mention && ![0, 19].includes(message.type ?? 0)) continue
      const body = clip(text.replace(you, '@you').replace(/\s+/g, ' ').trim() || '(attachment)', 180)
      await this.deliver(userId, where, { kind: mention ? 'mention' : 'message', title: direct ? author : `${author} in #${where.name}`, body, message_id: message.id })
    }
  }

  // The owner, and whoever started the thread, if they can see it.
  private async onWaiting(summary: SessionSummary) {
    const where = await this.chain(summary.id)
    if (!where) return
    const thread = await this.hub.twin.prisma.channel.findUnique({ where: { id: summary.id } })
    const starter = thread?.ownerId ? await this.hub.twin.prisma.user.findUnique({ where: { id: thread.ownerId } }) : null
    const people = new Set([this.owner, ...(starter && !starter.bot ? [starter.id] : [])])
    const body = clip((summary.ask?.text ?? 'Waiting for you').replace(/\s+/g, ' ').trim(), 180)
    for (const userId of people) {
      if (!(await this.hub.access.can(userId, summary.id, 0n))) continue
      await this.deliver(userId, where, { kind: 'needs_you', title: `Needs you: ${summary.title}${summary.machine ? ` (${summary.machine})` : ''}`, body, message_id: summary.ask?.messageId ?? summary.lastMessageId })
    }
  }

  // One push to a person about a channel, if their settings allow it and no device of theirs is in front.
  async deliver(userId: string, where: NonNullable<Awaited<ReturnType<Notifications['chain']>>>, n: { kind: PushKind; title: string; body: string; message_id: string | null }) {
    const channelId = where.chain[0]!
    if (!shouldNotify(n.kind, effectiveSetting(where.chain, await this.hub.store.notificationSettings(userId)))) return
    // A device in front shows it in the app (Discord also holds phone pushes while the desktop is active).
    if (this.hub.presence.visibleDevices(userId).size > 0) return
    const key = `${userId}:${channelId}`
    const previous = this.lastPush.get(key)
    const rank = { message: 0, mention: 1, needs_you: 2, reminder: 2 }
    if (previous && Date.now() - previous.at < REPEAT_MS && rank[n.kind] <= rank[previous.kind]) return
    this.lastPush.set(key, { at: Date.now(), kind: n.kind })
    const payload: PushPayload = {
      ...n,
      title: where.guildName && this.hub.guilds.length > 1 ? `${n.title} · ${where.guildName}` : n.title,
      tag: channelId,
      url: `/?channel=${channelId}${n.message_id ? `&message=${n.message_id}` : ''}`,
      channel_id: channelId,
      guild_id: where.guildId,
    }
    await this.pushAll(payload, { userId })
  }

  async pushAll(payload: PushPayload, only: { userId?: string; deviceId?: string }) {
    const targets = (await this.hub.store.pushSubscriptions()).filter((t) => (!only.deviceId || t.deviceId === only.deviceId) && (!only.userId || (t.userId ?? this.owner) === only.userId))
    const results = await Promise.all(targets.map((t) => this.pushOne(t, payload)))
    const apps = this.hub.events.notifyApps(payload, only)
    return { sent: results.filter((r) => r === 'sent').length + apps, failed: results.filter((r) => r !== 'sent').length }
  }

  private async pushOne(target: PushTarget & { deviceId: string }, payload: PushPayload) {
    if (!this.allowEndpoint(target.endpoint)) return 'failed' as const
    const result = await sendPush(target, payload, { keys: this.keys, subject: this.options.subject ?? DEFAULT_SUBJECT, topic: payload.tag, ttl: payload.kind === 'message' ? 3600 : 24 * 3600 })
    // The browser dropped the subscription (uninstalled, permission revoked).
    if (result === 'gone') await this.hub.store.deletePushSubscription(target.deviceId)
    return result
  }
}

type MessageData = {
  id: string
  channel_id: string
  type?: number
  content?: string
  components?: unknown[]
  mention_everyone?: boolean
  flags?: number
  mentions?: Array<{ id: string }>
  author?: { id: string; username?: string; global_name?: string | null; bot?: boolean }
  origin?: string
}
