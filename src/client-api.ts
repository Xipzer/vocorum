// /client/*: the PWA's API. Every route needs the network gate (checked by the
// hub) and, except /client/auth/*, a device session; the device's person is the
// viewer. Mutations check Origin. Every channel, message and search goes
// through Access: a person only reaches channels they can view, and acts only
// where their permissions allow. Human actions go through the twin's
// simulate* methods as that person, so bots see exactly what Discord would send.

import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import { ChannelType, MessageFlags, MessageType } from 'discord-api-types/v10'
import type { APIAttachment, APIMessage } from 'discord-api-types/v10'
import { generateSnowflake, withThreads } from 'discord-digital-twin/src'
import { channelToAPI, messageToAPI, roleToAPI, userToAPI } from 'discord-digital-twin/src/serializers'
import { toOggOpus } from './attachments.ts'
import { HttpError } from './auth.ts'
import { endJson, match, readBody, readJson, sendJson, UPLOAD_LIMIT } from './http.ts'
import type { Hub } from './hub.ts'
import type { DeviceRow, NotificationSetting } from './store.ts'
import { DEFAULT_LEVEL } from './notifications.ts'
import { P } from './access.ts'

const THREAD_TYPES = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]
const INTERACTION_WAIT_MS = 3000

export type ClientReaction = { emoji: string; count: number; me: boolean }
export type ClientMessage = APIMessage & { reactions_summary?: ClientReaction[] }

type Body = Record<string, unknown>
export type Viewer = { userId: string; device: DeviceRow }
const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${name} is required`)
  return value
}

export class ClientApi {
  constructor(
    private readonly hub: Hub,
    readonly webDir: string,
  ) {}

  private get prisma() {
    return this.hub.twin.prisma
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const method = req.method ?? 'GET'
    const mutating = method !== 'GET' && method !== 'HEAD'
    if (pathname.startsWith('/client/auth/')) return this.handleAuth(req, res, pathname, method)
    if (mutating) this.hub.auth.checkCsrf(req)
    const device = await this.hub.auth.requireDevice(req)
    const v: Viewer = { userId: this.hub.userOf(device), device }
    this.hub.checkIdentity(req, v.userId)
    const send = (status: number, value: unknown) => endJson(res, status, value === undefined ? '' : this.hub.relativize(JSON.stringify(value)))
    let params: Record<string, string> | null
    if (method === 'GET' && pathname === '/client/state') return send(200, await this.state(v))
    if (method === 'GET' && pathname === '/client/overview') return send(200, await this.overview(v))
    if (method === 'PUT' && pathname === '/client/read') {
      const body = await readJson(req)
      const visible = await this.hub.access.visibleChannels(v.userId)
      const pick = (value: unknown) => Object.entries((value ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => /^\d{1,20}$/.test(e[0]) && visible.has(e[0]) && typeof e[1] === 'string' && /^\d{1,20}$/.test(e[1])).slice(0, 5000)
      const entries = pick(body['read'])
      await this.hub.store.markRead(v.userId, entries)
      // "Mark unread": read up to just before that message, even if that moves back.
      const unread = pick(body['unread']).map(([channelId, messageId]): [string, string] => [channelId, String(BigInt(messageId) - 1n)])
      await this.hub.store.setRead(v.userId, unread)
      // The person's other devices follow (Discord's MESSAGE_ACK).
      const position = await this.hub.store.readState(v.userId)
      for (const [channelId] of [...entries, ...unread]) this.hub.events.send('MESSAGE_ACK', { channel_id: channelId, message_id: position[channelId] ?? null, manual: unread.some(([id]) => id === channelId) }, { userId: v.userId })
      return send(204, undefined)
    }
    if ((params = match('/client/channels/:id/output', pathname)) && (method === 'PUT' || method === 'DELETE')) {
      await this.channel(v, params['id']!)
      const output = method === 'PUT' ? (await readJson(req))['output'] === true : null
      await this.hub.store.setOutputView(v.userId, params['id']!, output)
      this.hub.events.send('OUTPUT_VIEW', { id: params['id'], output }, { userId: v.userId })
      return send(204, undefined)
    }
    if ((params = match('/client/favourites/:id', pathname)) && (method === 'PUT' || method === 'DELETE')) {
      if (method === 'PUT') await this.channel(v, params['id']!)
      await this.hub.store.setFavourite(v.userId, params['id']!, method === 'PUT')
      return send(204, undefined)
    }
    // Profile pictures stored with the hub (<hub dir>/media/avatar-<user id>.png), of people the viewer shares a guild with.
    if ((params = match('/client/avatars/:id', pathname)) && method === 'GET') {
      const id = params['id']!.replace(/\D/g, '')
      const user = await this.prisma.user.findUnique({ where: { id } })
      if (!user || (!user.bot && id !== v.userId && !(await this.hub.access.peers(v.userId)).has(id))) throw new HttpError(404, 'No avatar')
      return this.hub.settings.serveImage(res, path.join(this.hub.options.paths.media, `avatar-${id}.png`))
    }
    if ((params = match('/client/channels/:id/messages', pathname))) {
      if (method === 'GET') return send(200, await this.messages(v, params['id']!, new URL(req.url ?? '/', 'http://x').searchParams))
      if (method === 'POST') return send(200, await this.postMessage(v, params['id']!, await readJson(req)))
    }
    if ((params = match('/client/channels/:id/messages/:mid', pathname))) {
      if (method === 'PATCH') return send(200, await this.editMessage(v, params['id']!, params['mid']!, await readJson(req)))
      if (method === 'DELETE') return send(204, await this.deleteMessage(v, params['id']!, params['mid']!))
    }
    if ((params = match('/client/channels/:id/messages/:mid/reactions/:emoji', pathname)) && (method === 'PUT' || method === 'DELETE')) {
      await this.messageIn(v, params['id']!, params['mid']!, method === 'PUT' ? P.ADD_REACTIONS : 0n)
      await this.hub.twin.simulateUserReaction({ channelId: params['id']!, messageId: params['mid']!, userId: v.userId, emoji: params['emoji']!, remove: method === 'DELETE' })
      return send(204, undefined)
    }
    if ((params = match('/client/channels/:id', pathname)) && method === 'PATCH') return send(200, await this.patchThread(v, params['id']!, await readJson(req)))
    if (method === 'GET' && pathname === '/client/search') {
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      return send(200, await this.search(v, query.get('q') ?? '', { offset: Number(query.get('offset')) || 0, order: query.get('order') === 'oldest' ? 'oldest' : 'newest' }))
    }
    // The hub machine's services are the hub owner's alone.
    if (pathname.startsWith('/client/services') && !this.hub.access.isHubOwner(v.userId)) throw new HttpError(403, 'Only the hub owner manages services')
    if (method === 'GET' && pathname === '/client/services') return send(200, { available: await this.hub.sessions.services.available, services: this.hub.sessions.services.list() })
    if ((params = match('/client/services/:unit/events', pathname)) && method === 'GET') return send(200, { events: await this.hub.store.serviceEvents(decodeURIComponent(params['unit']!)) })
    if ((params = match('/client/services/:unit/:verb', pathname)) && method === 'POST') {
      const verb = params['verb']
      if (verb !== 'start' && verb !== 'stop' && verb !== 'restart') throw new HttpError(400, 'Bad action')
      await this.hub.sessions.services.control(decodeURIComponent(params['unit']!), verb).catch((e: Error) => {
        throw new HttpError(e.message === 'Unknown service' ? 404 : 500, e.message)
      })
      return send(200, { services: this.hub.sessions.services.list() })
    }
    if ((params = match('/client/channels/:id/links', pathname)) && method === 'GET') {
      await this.channel(v, params['id']!)
      const visible = await this.hub.access.visibleChannels(v.userId)
      return send(200, { links: (await this.hub.sessions.links.of(params['id']!)).filter((link) => visible.has(link.id) && visible.has(link.messageChannelId)) })
    }
    const handled = await this.hub.settings.handle(req, res, pathname, v)
    if (handled === null) return
    if (handled !== undefined) return send(200, handled)
    const icon = await this.hub.machineIcons.handle(req, res, pathname, v)
    if (icon === null) return
    if (icon !== undefined) return send(200, icon)
    const requested = await this.hub.requests.handleClient(req, pathname, v, typeof req.headers.origin === 'string' ? req.headers.origin : null)
    if (requested !== undefined) return send(200, requested)
    const managed = await this.hub.members.handle(req, pathname, v)
    if (managed !== undefined) return send(200, managed)
    if (method === 'GET' && pathname === '/client/inbox') return send(200, await this.inbox(v))
    if (method === 'GET' && pathname === '/client/notifications') return send(200, await this.notificationState(v))
    if ((params = match('/client/notifications/:scope', pathname)) && method === 'PUT') return send(200, await this.setNotification(v, params['scope']!, await readJson(req)))
    if (pathname === '/client/push' && method === 'PUT') {
      const body = await readJson(req)
      const keys = (body['keys'] ?? {}) as Record<string, unknown>
      const endpoint = str(body['endpoint'], 'endpoint')
      if (!this.hub.notifications.allowEndpoint(endpoint)) throw new HttpError(400, 'Not a known push service')
      const target = { endpoint, p256dh: str(keys['p256dh'], 'keys.p256dh'), auth: str(keys['auth'], 'keys.auth') }
      if (!/^[A-Za-z0-9_-]{86,88}$/.test(target.p256dh) || !/^[A-Za-z0-9_-]{22,24}$/.test(target.auth)) throw new HttpError(400, 'Bad subscription keys')
      await this.hub.store.setPushSubscription(device.id, target)
      return send(204, undefined)
    }
    if (pathname === '/client/push' && method === 'DELETE') {
      await this.hub.store.deletePushSubscription(device.id)
      return send(204, undefined)
    }
    if (pathname === '/client/push/test' && method === 'POST') {
      const payload = { kind: 'mention' as const, title: 'Vocorum', body: `Notifications work on ${device.name}.`, tag: 'test', url: '/', channel_id: '', guild_id: null, message_id: null }
      return send(200, await this.hub.notifications.pushAll(payload, { deviceId: device.id }))
    }
    if ((params = match('/client/channels/:id/pins', pathname)) && method === 'GET') return send(200, await this.pins(v, params['id']!))
    if ((params = match('/client/channels/:id/pins/:mid', pathname)) && (method === 'PUT' || method === 'DELETE')) {
      const message = await this.messageIn(v, params['id']!, params['mid']!)
      if (!(await this.hub.access.can(v.userId, params['id']!, P.MANAGE_MESSAGES)) && !(await this.hub.access.can(v.userId, params['id']!, P.PIN_MESSAGES))) throw new HttpError(403, 'You cannot pin messages here')
      await this.hub.twin.simulateUserPin({ channelId: message.channelId, messageId: message.id, userId: v.userId, pinned: method === 'PUT' })
      return send(204, undefined)
    }
    if (method === 'POST' && pathname === '/client/uploads') return send(200, await this.upload(req, device))
    if (method === 'POST' && pathname === '/client/interactions') return send(200, await this.interaction(v, await readJson(req)))
    if (method === 'POST' && pathname === '/client/commands') return send(200, await this.command(v, await readJson(req)))
    if (method === 'POST' && pathname === '/client/autocomplete') return send(200, await this.autocomplete(v, await readJson(req)))
    throw new HttpError(404, 'Not found')
  }

  private async handleAuth(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, method: string) {
    const auth = this.hub.auth
    if (method === 'GET' && pathname === '/client/auth/status') {
      const device = await auth.device(req)
      return sendJson(res, 200, { signedIn: Boolean(device), device: device && { id: device.id, name: device.name }, userId: device ? this.hub.userOf(device) : null })
    }
    if (method !== 'POST') throw new HttpError(404, 'Not found')
    const peer = `${req.socket.remoteAddress ?? ''} ${this.hub.identityOf(req) ?? ''}`
    // Apps: no ambient credentials, so no Origin check; never a cookie.
    if (pathname.startsWith('/client/auth/app/')) {
      const body = await readJson(req)
      if (pathname === '/client/auth/app/register') return sendJson(res, 200, await auth.registerApp(body, peer))
      if (pathname === '/client/auth/app/challenge') return sendJson(res, 200, auth.appChallenge())
      if (pathname === '/client/auth/app/login') return sendJson(res, 200, await auth.loginApp(body))
      throw new HttpError(404, 'Not found')
    }
    if (auth.usesBearer(req)) {
      if (pathname !== '/client/auth/logout') throw new HttpError(400, 'Passkey routes do not take a bearer token')
      await auth.logout(req)
      return sendJson(res, 200, { ok: true })
    }
    const origin = auth.checkOrigin(req)
    const body = await readJson(req)
    switch (pathname) {
      case '/client/auth/register/options':
        // The transport address plus the Tailscale login the network gate verified; never a raw header.
        return sendJson(res, 200, await auth.registrationOptions(origin, body, peer))
      case '/client/auth/register/verify': {
        const { device, cookie } = await auth.register(origin, body)
        return sendJson(res, 200, { device: { id: device.id, name: device.name } }, { 'set-cookie': cookie })
      }
      case '/client/auth/login/options':
        return sendJson(res, 200, await auth.loginOptions(origin))
      case '/client/auth/login/verify': {
        const { device, cookie } = await auth.login(origin, body)
        return sendJson(res, 200, { device: { id: device.id, name: device.name } }, { 'set-cookie': cookie })
      }
      case '/client/auth/logout':
        await auth.logout(req)
        return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() })
    }
    throw new HttpError(404, 'Not found')
  }

  // --- reads

  async state(v: Viewer) {
    const { config } = this.hub.options
    const view = await this.hub.access.view(v.userId)
    const guilds = this.hub.guilds.filter((g) => view.guilds.has(g.id))
    const channels = (await this.prisma.channel.findMany({ where: { guildId: { in: guilds.map((g) => g.id) } }, orderBy: [{ position: 'asc' }, { id: 'asc' }] })).filter((c) => view.channels.has(c.id))
    const overwrites = await this.hub.store.overwrites()
    const members = await this.prisma.guildMember.findMany({ where: { guildId: { in: guilds.map((g) => g.id) } } })
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set([...members.map((m) => m.userId), v.userId, config.botUserId])] } } })
    const roles = await this.prisma.role.findMany({ where: { guildId: { in: guilds.map((g) => g.id) } }, orderBy: [{ position: 'desc' }, { id: 'asc' }] })
    const profiles = await this.hub.store.profiles()
    const guildCommands = Object.fromEntries(await Promise.all(guilds.map(async (g) => [g.id, await this.hub.twin.getRegisteredCommands({ guildId: g.id })] as const)))
    const primary = guilds.find((g) => g.id === config.guildId) ?? guilds[0]
    const visible = new Set(view.channels.keys())
    const read = await this.hub.store.readState(v.userId)
    const withPerms = (c: (typeof channels)[number]) => ({ ...channelToAPI(c), permission_overwrites: overwrites.get(c.id) ?? [], permissions: String(view.channels.get(c.id) ?? 0n) })
    const machines = await this.hub.sessions.machines()
    const categoryMachines = new Set(channels.filter((c) => c.type === ChannelType.GuildCategory).map((c) => this.hub.sessions.machineOf(c.name ?? '')?.toLowerCase()))
    return {
      device: { id: v.device.id, name: v.device.name },
      me: { id: v.userId },
      // True for the person who runs the hub: services, bots and guild registration.
      hub_owner: this.hub.access.isHubOwner(v.userId),
      bot: { id: config.botUserId },
      // The guilds this person is in, primary first. Channels and threads carry guild_id.
      guilds: guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon, owner_id: config.ownerUserId, permissions: String(view.guilds.get(g.id)!.perms) })),
      // Primary guild only: kept for older clients, use guilds and guildCommands.
      guild: primary ? { id: primary.id, name: primary.name } : null,
      channels: channels.filter((c) => !THREAD_TYPES.includes(c.type)).map(withPerms),
      threads: channels.filter((c) => THREAD_TYPES.includes(c.type)).map((c) => ({ ...withPerms(c), last_message_id: c.lastMessageId })),
      // color: the name colour from the user's profile (0xRRGGBB or null).
      users: users.map((u) => ({ ...userToAPI(u), color: profiles[u.id]?.color ?? null })),
      // Per guild: roles (highest first) and members with their roles.
      roles: Object.fromEntries(guilds.map((g) => [g.id, roles.filter((r) => r.guildId === g.id).map(roleToAPI)])),
      members: Object.fromEntries(guilds.map((g) => [g.id, members.filter((m) => m.guildId === g.id).map((m) => ({ user_id: m.userId, roles: JSON.parse(m.roles) as string[], nick: m.nick, joined_at: m.joinedAt.toISOString() }))])),
      commands: primary ? (guildCommands[primary.id] ?? []) : [],
      guildCommands,
      read: Object.fromEntries(Object.entries(read).filter(([id]) => visible.has(id))),
      mentions: await this.hub.search.mentionCounts(v.userId, read, visible),
      links: Object.fromEntries(Object.entries(await this.hub.sessions.links.counts()).filter(([id]) => visible.has(id))),
      sessionThreads: (await this.hub.sessions.links.whenReady(), Object.fromEntries(Object.entries(this.hub.sessions.links.sessionThreads()).filter(([, thread]) => visible.has(thread)))),
      favourites: (await this.hub.store.favourites(v.userId)).filter((id) => visible.has(id)),
      presence: await this.hub.presence.snapshotFor(v.userId),
      notifications: await this.notificationState(v),
      output: await this.hub.store.outputViews(v.userId),
      machines: machines.map((m) => m.name).filter((name) => this.hub.access.isHubOwner(v.userId) || categoryMachines.has(name.toLowerCase())),
      privacy: await this.hub.settings.privacy(v.userId),
      // Per machine: hashes of its bot avatar and Discord server icon; images at
      // /client/machine-icons/:machine/avatar|guild_icon?v=<hash>.
      machine_icons: await this.machineIconsFor(v),
      // Each machine's own Discord bot (its Kimaki on Discord): messages by that user are the machine's.
      machine_bots: await this.machineBotsFor(v),
      // Discord user ids that are a hub user here (the owner's Discord account): resolve <@id> through it.
      user_aliases: this.hub.mirror.aliases(),
    }
  }

  private async machineBotsFor(v: Viewer) {
    const visible = await this.hub.visibleMachines(v.userId)
    return Object.fromEntries(Object.entries(await this.hub.mirror.machineBots()).filter(([machine]) => visible.has(machine.toLowerCase())))
  }

  private async machineIconsFor(v: Viewer) {
    const visible = await this.hub.visibleMachines(v.userId)
    return Object.fromEntries(Object.entries(await this.hub.machineIcons.list()).filter(([machine]) => visible.has(machine.toLowerCase())))
  }

  // Sessions in threads the viewer can see; machines only where they can see a category of it.
  async overview(v: Viewer) {
    const visible = await this.hub.access.visibleChannels(v.userId)
    const machines = await this.hub.sessions.machines()
    if (this.hub.access.isHubOwner(v.userId)) return { machines, sessions: this.hub.sessions.list() }
    const sessions = this.hub.sessions.list().filter((s) => visible.has(s.id))
    const names = new Set(sessions.map((s) => s.machine?.toLowerCase()))
    return { machines: machines.filter((m) => names.has(m.name.toLowerCase())), sessions }
  }

  async notificationState(v: Viewer) {
    return {
      settings: await this.hub.store.notificationSettings(v.userId),
      default_level: DEFAULT_LEVEL,
      vapid_public_key: this.hub.notifications.keys.publicKey,
      push_subscribed: (await this.hub.store.pushSubscriptions()).some((s) => s.deviceId === v.device.id),
    }
  }

  // Body: { level: 'all' | 'mentions' | 'nothing' | null, muted_until: ms | null }; omitted fields keep their value.
  async setNotification(v: Viewer, scopeId: string, body: Record<string, unknown>) {
    if (!(await this.hub.access.guild(v.userId, scopeId))) await this.channel(v, scopeId)
    const current = (await this.hub.store.notificationSettings(v.userId))[scopeId] ?? { level: null, muted_until: null }
    const level = body['level'] === undefined ? current.level : body['level']
    if (level !== null && level !== 'all' && level !== 'mentions' && level !== 'nothing') throw new HttpError(400, 'level must be all, mentions, nothing or null')
    const mutedUntil = body['muted_until'] === undefined ? current.muted_until : body['muted_until']
    if (mutedUntil !== null && (typeof mutedUntil !== 'number' || !Number.isFinite(mutedUntil))) throw new HttpError(400, 'muted_until must be a timestamp in ms or null')
    const setting: NotificationSetting = { level, muted_until: mutedUntil }
    await this.hub.store.setNotificationSetting(v.userId, scopeId, setting)
    this.hub.events.send('NOTIFICATION_SETTINGS_UPDATE', { scope_id: scopeId, ...setting }, { userId: v.userId })
    return { scope_id: scopeId, ...setting }
  }

  // Messages by id, each with the channel (or thread) it is in, in the given order.
  private async withChannels(v: Viewer, ids: string[]) {
    const visible = await this.hub.access.visibleChannels(v.userId)
    const rows = await this.prisma.message.findMany({ where: { id: { in: ids } } })
    const channels = new Map((await this.prisma.channel.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.channelId))] } } })).map((c) => [c.id, c]))
    const messages = new Map((await this.toClient(v, rows.filter((r) => visible.has(r.channelId)), (channelId) => channels.get(channelId)?.guildId ?? undefined)).map((m) => [m.id, m]))
    return ids.flatMap((id) => {
      const message = messages.get(id)
      const channel = message && channels.get(message.channel_id)
      if (!message || !channel || !visible.has(channel.id)) return []
      return [{ message, channel: { id: channel.id, name: channel.name, type: channel.type, parent_id: channel.parentId, guild_id: channel.guildId } }]
    })
  }

  async search(v: Viewer, q: string, options: { offset: number; order: 'newest' | 'oldest' }) {
    const { total, results } = await this.hub.search.search(q.slice(0, 500), { ...options, userId: v.userId, channels: await this.hub.access.visibleChannels(v.userId) })
    const found = await this.withChannels(v, results.map((r) => r.messageId))
    const snippets = new Map(results.map((r) => [r.messageId, r.snippet]))
    return { total, results: found.map((entry) => ({ ...entry, snippet: snippets.get(entry.message.id) ?? null })) }
  }

  async inbox(v: Viewer) {
    const read = await this.hub.store.readState(v.userId)
    const mentions = await this.hub.search.mentions(v.userId, await this.hub.access.visibleChannels(v.userId), read)
    const newer = (a: string, b: string | undefined) => !b || a.length > b.length || (a.length === b.length && a > b)
    const found = await this.withChannels(v, mentions.map((m) => m.messageId))
    return { mentions: found.map((entry) => ({ ...entry, read: !newer(entry.message.id, read[entry.channel.id]) })) }
  }

  async pins(v: Viewer, channelId: string) {
    const channel = await this.channel(v, channelId, P.READ_MESSAGE_HISTORY)
    const rows = await this.prisma.message.findMany({ where: { channelId, pinned: true }, orderBy: { id: 'desc' }, take: 250 })
    return { messages: await this.toClient(v, rows, () => channel.guildId ?? undefined) }
  }

  private async toClient(v: Viewer, rows: Awaited<ReturnType<typeof this.prisma.message.findMany>>, guildOf: (channelId: string) => string | undefined): Promise<ClientMessage[]> {
    // Authors, and the people mentioned in the text (Discord lists those in `mentions`).
    const mentioned = (row: { content: string }) => [...new Set([...row.content.matchAll(/<@!?(\d{1,20})>/g)].map((m) => m[1]!))]
    const authorIds = [...new Set([...rows.map((row) => row.authorId), ...rows.flatMap(mentioned)])]
    const authors = new Map((await this.prisma.user.findMany({ where: { id: { in: authorIds } } })).map((user) => [user.id, user]))
    const reactions = await this.prisma.reaction.findMany({ where: { messageId: { in: rows.map((row) => row.id) } } })
    // origin: 'discord' for messages mirrored from Discord; discord_echo: the Discord copy of one typed here.
    const origins = await this.hub.mirror.origins(rows.map((row) => row.id))
    // The thread started from a message rides on it, as on Discord.
    return withThreads(this.prisma, rows.map((row) => {
      const author = authors.get(row.authorId)
      if (!author) throw new Error(`missing author ${row.authorId}`)
      const summary = new Map<string, ClientReaction>()
      for (const reaction of reactions) {
        if (reaction.messageId !== row.id) continue
        const entry = summary.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, me: false }
        entry.count++
        entry.me ||= reaction.userId === v.userId
        summary.set(reaction.emoji, entry)
      }
      const api = messageToAPI(row, author, guildOf(row.channelId))
      if (api.mentions.length === 0) api.mentions = mentioned(row).flatMap((id) => (authors.has(id) ? [userToAPI(authors.get(id)!)] : []))
      return { ...api, ...(summary.size > 0 && { reactions_summary: [...summary.values()] }), ...origins.get(row.id) }
    }))
  }

  // Oldest first. A thread's first page starts with its starter message, like Discord.
  async messages(v: Viewer, channelId: string, query: URLSearchParams) {
    const channel = await this.channel(v, channelId, P.READ_MESSAGE_HISTORY)
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 100)
    const before = query.get('before')
    const rows = await this.prisma.message.findMany({
      where: { channelId, ...(before && { id: { lt: before } }) },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: limit,
    })
    rows.reverse()
    const hasMore = rows.length === limit
    if (!hasMore && channel.starterMessageId && !rows.some((row) => row.id === channel.starterMessageId)) {
      const starter = await this.prisma.message.findUnique({ where: { id: channel.starterMessageId } })
      if (starter) rows.unshift(starter)
    }
    return { messages: await this.toClient(v, rows, () => channel.guildId ?? undefined), hasMore }
  }

  // A channel the viewer can view (404 otherwise, so hidden channels do not
  // even exist for them) and where they hold `perm` (403 otherwise).
  private async channel(v: Viewer, channelId: string, perm = 0n) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } })
    if (!channel || !this.hub.guildIds.has(channel.guildId ?? '') || !(await this.hub.access.can(v.userId, channelId, 0n))) throw new HttpError(404, 'Unknown channel')
    if (perm && !(await this.hub.access.can(v.userId, channelId, perm))) throw new HttpError(403, 'Missing permissions')
    return channel
  }

  private async messageIn(v: Viewer, channelId: string, messageId: string, perm = 0n) {
    await this.channel(v, channelId, perm)
    const message = await this.prisma.message.findUnique({ where: { id: messageId } })
    if (!message) throw new HttpError(404, 'Unknown message')
    // A thread's starter message lives in the parent channel.
    if (message.channelId !== channelId) {
      const thread = await this.prisma.channel.findUnique({ where: { id: channelId } })
      if (thread?.starterMessageId !== messageId) throw new HttpError(404, 'Unknown message')
    }
    return message
  }

  // --- writes

  async postMessage(v: Viewer, channelId: string, body: Body) {
    const channel = await this.channel(v, channelId)
    if (channel.type === ChannelType.GuildCategory || channel.type === ChannelType.GuildVoice) throw new HttpError(400, 'Cannot post here')
    const thread = THREAD_TYPES.includes(channel.type)
    if (!(await this.hub.access.can(v.userId, channelId, thread ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES))) throw new HttpError(403, 'You cannot send messages here')
    if (Array.isArray(body['attachmentIds']) && body['attachmentIds'].length && !(await this.hub.access.can(v.userId, channelId, P.ATTACH_FILES))) throw new HttpError(403, 'You cannot attach files here')
    const content = typeof body['content'] === 'string' ? body['content'].slice(0, 4000) : ''
    const attachments = await this.attachmentsFor(v, body['attachmentIds'], body['descriptions'])
    if (!content.trim() && attachments.length === 0) throw new HttpError(400, 'Empty message')
    const voice = body['voice'] === true && attachments.length === 1 && attachments[0]!.content_type?.startsWith('audio/')
    const replyTo = typeof body['replyTo'] === 'string' ? body['replyTo'] : null
    if (replyTo) await this.messageIn(v, channelId, replyTo)
    const message = await this.hub.twin.simulateUserMessage({
      channelId,
      userId: v.userId,
      content: voice ? '' : content,
      attachments,
      ...(voice && { flags: MessageFlags.IsVoiceMessage }),
      ...(replyTo && { type: MessageType.Reply, messageReference: { message_id: replyTo, channel_id: channelId, guild_id: channel.guildId ?? undefined } }),
    })
    return message
  }

  // Files this device uploaded, as Discord attachment objects with signed URLs.
  // descriptions: optional alt text per attachment id, as Discord's `description`.
  private async attachmentsFor(v: Viewer, value: unknown, descriptions?: unknown): Promise<APIAttachment[]> {
    const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 10) : []
    const alt = descriptions && typeof descriptions === 'object' ? (descriptions as Record<string, unknown>) : {}
    const attachments: APIAttachment[] = []
    for (const id of ids) {
      const row = await this.hub.store.getAttachment(id)
      if (!row || row.uploadedBy !== `device:${v.device.id}`) throw new HttpError(400, 'Unknown attachment')
      const url = this.hub.attachments.url(row.id, row.filename)
      attachments.push({
        id: row.id,
        filename: row.filename,
        size: row.size,
        content_type: row.contentType,
        url,
        proxy_url: url,
        ...(row.width != null && row.height != null && { width: row.width, height: row.height }),
        ...(row.durationSecs != null && { duration_secs: row.durationSecs }),
        ...(row.waveform && { waveform: row.waveform }),
        ...(typeof alt[row.id] === 'string' && (alt[row.id] as string).trim() && { description: (alt[row.id] as string).trim().slice(0, 1024) }),
      })
    }
    return attachments
  }

  async editMessage(v: Viewer, channelId: string, messageId: string, body: Body) {
    const message = await this.messageIn(v, channelId, messageId)
    if (message.authorId !== v.userId) throw new HttpError(403, 'You can only edit your own messages')
    return this.hub.twin.simulateUserMessageEdit({ channelId: message.channelId, messageId, content: str(body['content'], 'content').slice(0, 4000) })
  }

  // Your own messages, or anyone's with Manage Messages.
  async deleteMessage(v: Viewer, channelId: string, messageId: string) {
    const message = await this.messageIn(v, channelId, messageId)
    if (message.authorId !== v.userId && !(await this.hub.access.can(v.userId, channelId, P.MANAGE_MESSAGES))) throw new HttpError(403, 'You can only delete your own messages')
    await this.hub.twin.simulateUserMessageDelete({ channelId: message.channelId, messageId })
  }

  // The thread's starter, or anyone with Manage Threads.
  async patchThread(v: Viewer, channelId: string, body: Body) {
    const channel = await this.channel(v, channelId)
    if (!THREAD_TYPES.includes(channel.type)) throw new HttpError(400, 'Only threads can be renamed or archived here')
    if (channel.ownerId !== v.userId && !(await this.hub.access.can(v.userId, channelId, P.MANAGE_THREADS))) throw new HttpError(403, 'You cannot manage this thread')
    if (typeof body['name'] === 'string' && body['name'].trim()) {
      await this.hub.twin.simulateThreadRename({ channelId, userId: v.userId, name: body['name'].trim().slice(0, 100) })
    }
    if (typeof body['archived'] === 'boolean') await this.hub.twin.simulateThreadArchive({ channelId, archived: body['archived'] })
    return channelToAPI(await this.prisma.channel.findUniqueOrThrow({ where: { id: channelId } }))
  }

  async upload(req: http.IncomingMessage, device: DeviceRow) {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('multipart/form-data')) throw new HttpError(400, 'Expected multipart/form-data')
    const raw = await readBody(req, UPLOAD_LIMIT + 64 * 1024)
    const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': contentType } }).formData().catch(() => {
      throw new HttpError(400, 'Bad multipart body')
    })
    const file = form.get('file')
    if (!file || typeof file === 'string') throw new HttpError(400, 'file is required')
    if (file.size > UPLOAD_LIMIT) throw new HttpError(413, 'File too large (25 MB max)')
    let data: Buffer = Buffer.from(await file.arrayBuffer())
    let type = file.type || 'application/octet-stream'
    let filename = file.name || 'file'
    const voice = form.get('voice') === '1'
    if (voice) {
      const converted = await toOggOpus(data, type)
      if (converted) {
        data = converted.data
        type = converted.contentType
        filename = 'voice-message.ogg'
      }
    }
    const duration = Number(form.get('durationSecs'))
    const waveform = form.get('waveform')
    const saved = await this.hub.attachments.save({
      id: generateSnowflake(),
      filename,
      contentType: type,
      data,
      uploadedBy: `device:${device.id}`,
      durationSecs: voice && Number.isFinite(duration) && duration > 0 ? duration : null,
      waveform: voice && typeof waveform === 'string' && /^[A-Za-z0-9+/=]{0,400}$/.test(waveform) ? waveform : null,
    })
    return { id: saved.id, filename: saved.filename, size: saved.size, content_type: saved.contentType, url: saved.url, width: saved.width, height: saved.height }
  }

  // Discord gives a bot 3 seconds to acknowledge. Returns the ack (a modal
  // to open, a message update, a deferral) or {acknowledged: false}.
  private async waitForAck(interactionId: string) {
    const deadline = Date.now() + INTERACTION_WAIT_MS
    while (Date.now() < deadline) {
      const row = await this.prisma.interactionResponse.findUnique({ where: { interactionId } })
      if (row?.acknowledged) return { interactionId, acknowledged: true, type: row.type, data: row.data ? (JSON.parse(row.data) as unknown) : null }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return { interactionId, acknowledged: false, type: null, data: null }
  }

  async interaction(v: Viewer, body: Body) {
    const channelId = str(body['channelId'], 'channelId')
    await this.channel(v, channelId)
    const customId = str(body['customId'], 'customId')
    const messageId = typeof body['messageId'] === 'string' ? body['messageId'] : undefined
    const source = messageId ? await this.messageIn(v, channelId, messageId) : null
    // Like Discord: a button or menu can only be used if it is on that message.
    if ((body['type'] === 'button' || body['type'] === 'select') && !(source && hasComponent(JSON.parse(source.components) as unknown[], customId))) throw new HttpError(400, 'No such component on this message')
    const base = { channelId, userId: v.userId, customId }
    let started: { id: string }
    switch (body['type']) {
      case 'button':
        started = await this.hub.twin.simulateButtonClick({ ...base, messageId: str(messageId, 'messageId') })
        break
      case 'select': {
        let values = Array.isArray(body['values']) ? body['values'].filter((value): value is string => typeof value === 'string').slice(0, 25) : []
        const componentType = findComponent(JSON.parse(source!.components) as unknown[], customId)?.['type']
        const entity = componentType === 5 || componentType === 6 || componentType === 7 || componentType === 8 ? componentType : undefined
        // A channel menu can only pick channels the person can see.
        if (entity === 8) {
          const visible = await this.hub.access.visibleChannels(v.userId)
          values = values.filter((id) => visible.has(id))
        }
        started = await this.hub.twin.simulateSelectMenu({ ...base, messageId: str(messageId, 'messageId'), values, ...(entity && { componentType: entity }) })
        break
      }
      case 'modal': {
        const fields = Array.isArray(body['fields'])
          ? body['fields'].flatMap((field) => (field && typeof field === 'object' && typeof field.customId === 'string' && typeof field.value === 'string' ? [{ customId: field.customId, value: field.value.slice(0, 4000) }] : []))
          : []
        // File upload fields (a Label with a FileUpload): [{customId, attachmentIds}].
        const files = []
        for (const field of Array.isArray(body['files']) ? body['files'] : []) {
          if (field && typeof field === 'object' && typeof field.customId === 'string') files.push({ customId: field.customId, attachments: await this.attachmentsFor(v, field.attachmentIds) })
        }
        started = await this.hub.twin.simulateModalSubmit({ ...base, fields, messageId, files })
        break
      }
      default:
        throw new HttpError(400, 'type must be button, select or modal')
    }
    return this.waitForAck(started.id)
  }

  // Discord hides a command from members without its default_member_permissions; so does the hub.
  private async checkCommand(v: Viewer, channelId: string, name: string) {
    const channel = await this.channel(v, channelId, P.USE_APPLICATION_COMMANDS)
    const commands = await this.hub.twin.getRegisteredCommands({ guildId: channel.guildId })
    const command = commands.find((c) => c.name === name)
    const required = command?.default_member_permissions
    if (required === undefined || required === null) return
    // "0" means administrators only.
    const allowed = BigInt(required) === 0n ? await this.hub.access.canGuild(v.userId, channel.guildId!, P.ADMINISTRATOR) : await this.hub.access.can(v.userId, channelId, BigInt(required))
    if (!allowed) throw new HttpError(403, 'You do not have permission to use this command')
  }

  async command(v: Viewer, body: Body) {
    const channelId = str(body['channelId'], 'channelId')
    await this.checkCommand(v, channelId, str(body['name'], 'name'))
    const started = await this.hub.twin.simulateSlashCommand({ channelId, userId: v.userId, name: str(body['name'], 'name'), options: commandOptions(body['options']) })
    return this.waitForAck(started.id)
  }

  async autocomplete(v: Viewer, body: Body) {
    const channelId = str(body['channelId'], 'channelId')
    await this.checkCommand(v, channelId, str(body['name'], 'name'))
    const choices = await this.hub.twin
      .simulateAutocomplete({ channelId, userId: v.userId, name: str(body['name'], 'name'), options: commandOptions(body['options']), focused: str(body['focused'], 'focused'), timeout: INTERACTION_WAIT_MS })
      .catch(() => [])
    return { choices }
  }
}

function hasComponent(components: unknown[], customId: string): boolean {
  return findComponent(components, customId) !== undefined
}

function findComponent(components: unknown[], customId: string): Record<string, unknown> | undefined {
  for (const c of components) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    if (o['custom_id'] === customId) return o
    for (const child of [o['components'], o['accessory'] ? [o['accessory']] : undefined, o['component'] ? [o['component']] : undefined]) {
      const found = Array.isArray(child) ? findComponent(child, customId) : undefined
      if (found) return found
    }
  }
  return undefined
}

type CommandOption = { name: string; type: number; value?: string | number | boolean; options?: CommandOption[] }
function commandOptions(value: unknown): CommandOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((option) => {
    if (!option || typeof option !== 'object' || typeof option.name !== 'string' || typeof option.type !== 'number') return []
    const v = option.value
    return [{ name: option.name, type: option.type, ...((typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && { value: v }), ...(Array.isArray(option.options) && { options: commandOptions(option.options) }) }]
  })
}
