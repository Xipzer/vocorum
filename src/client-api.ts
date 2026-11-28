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
import { generateSnowflake, withThreads, type DigitalDiscordModalComponent } from 'discord-digital-twin/src'
import { channelToAPI, messageToAPI, roleToAPI, userToAPI } from 'discord-digital-twin/src/serializers'
import { toOggOpus } from './attachments.ts'
import { HttpError } from './auth.ts'
import { sendDownload } from './app-releases.ts'
import { endJson, match, readBody, readJson, sendJson, UPLOAD_LIMIT } from './http.ts'
import type { Hub } from './hub.ts'
import type { DeviceRow, NotificationSetting } from './store.ts'
import { DEFAULT_LEVEL } from './notifications.ts'
import { P } from './access.ts'
import { traceInteraction } from './interaction-trace.ts'

const THREAD_TYPES = [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]
const INTERACTION_WAIT_MS = 3000
const MAX_SELECTED_MESSAGES = 100

export type ClientReaction = { emoji: string; count: number; me: boolean }
export type ClientMessage = APIMessage & { reactions_summary?: ClientReaction[] }

type Body = Record<string, unknown>
export type Viewer = { userId: string; device: DeviceRow }
const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${name} is required`)
  return value
}

function selectedIds(body: unknown): string[] {
  const ids = body && typeof body === 'object' && Object.keys(body).length === 1 && 'message_ids' in body ? body.message_ids : null
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SELECTED_MESSAGES ||
      !ids.every((id): id is string => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, `Select 1 to ${MAX_SELECTED_MESSAGES} distinct message IDs`)
  }
  return ids
}

function requireMessageDelete(userId: string, authorId: string, permissions: bigint) {
  if (!(permissions & P.VIEW_CHANNEL)) throw new HttpError(404, 'Unknown channel')
  if (userId !== authorId && !(permissions & P.MANAGE_MESSAGES)) throw new HttpError(403, 'You can only delete your own messages')
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
    if (method === 'GET' && (params = match('/client/threads/:id/panels', pathname))) {
      const id = params['id']!
      if (!await this.hub.boards.canRead(v.userId, id)) throw new HttpError(404, 'Unknown thread')
      const snapshot = await this.hub.boards.read(id, device.id)
      if (!await this.hub.boards.canRead(v.userId, id)) throw new HttpError(404, 'Unknown thread')
      return sendJson(res, 200, snapshot)
    }
    if (method === 'POST' && (params = match('/client/threads/:id/panels/board/seen', pathname))) {
      const id = params['id']!
      if (!await this.hub.boards.canRead(v.userId, id)) throw new HttpError(404, 'Unknown thread')
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('v' in body)) throw new HttpError(400, 'Expected {v}')
      if (!await this.hub.boards.canRead(v.userId, id)) throw new HttpError(404, 'Unknown thread')
      await this.hub.boards.seen(id, device.id, body.v)
      return send(204, undefined)
    }
    // App updates (Tauri's updater format; 204 when up to date) and their files.
    if (method === 'GET' && (params = match('/client/app/update/:target/:arch/:current', pathname))) {
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      // Only one of the hub's own names: the download URL never follows a Host header elsewhere.
      const listener = this.hub.privateListener
      const own = listener && [...listener.config.names, listener.config.address].includes(host.replace(/:\d+$/, '').toLowerCase())
      const origin = listener?.owns(req) ? (own ? `https://${host}` : `https://${listener.config.names[0] ?? listener.config.address}:${listener.port}`) : (this.hub.options.config.publicUrl ?? `http://${host}`)
      const bundle = new URL(req.url ?? '/', 'http://x').searchParams.get('bundle')
      const update = this.hub.apps.update(params['target']!, params['arch']!, decodeURIComponent(params['current']!), origin, bundle)
      return update ? send(200, update) : send(204, undefined)
    }
    if ((method === 'GET' || method === 'HEAD') && (params = match('/client/app/files/:version/:file', pathname))) {
      const name = decodeURIComponent(params['file']!)
      const file = this.hub.apps.file(params['version']!, name)
      if (!file) throw new HttpError(404, 'Unknown file')
      return sendDownload(req, res, file, name)
    }
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
    // Forum posts and welcoming imported people (community.ts).
    if ((params = match('/client/channels/:id/threads', pathname)) && method === 'POST') return send(200, await this.hub.community.forumPost(v, params['id']!, await readJson(req)))
    if ((params = match('/client/users/:id/welcome', pathname)) && method === 'POST') return send(200, await this.hub.community.welcome(v, params['id']!))
    if ((params = match('/client/channels/:id/messages', pathname))) {
      if (method === 'GET') return send(200, await this.messages(v, params['id']!, new URL(req.url ?? '/', 'http://x').searchParams))
      if (method === 'POST') return send(200, await this.postMessage(v, params['id']!, await readJson(req)))
    }
    if (method === 'POST' && (params = match('/client/channels/:id/messages/bulk-delete', pathname))) {
      return send(200, await this.deleteSelectedMessages(v, params['id']!, selectedIds(await readJson(req))))
    }
    if ((params = match('/client/channels/:id/private-replies/:mid', pathname)) && method === 'DELETE') {
      const id = params['mid']!, channelId = params['id']!
      await this.channel(v, channelId)
      const privateReplies = this.hub.twin.privateReplies
      if (privateReplies?.forUser(v.userId, channelId, id)) privateReplies.remove(id)
      return send(204, undefined)
    }
    if ((params = match('/client/channels/:id/messages/:mid', pathname))) {
      if (method === 'PATCH') return send(200, await this.editMessage(v, params['id']!, params['mid']!, await readJson(req)))
      if (method === 'DELETE') return send(204, await this.deleteMessage(v, params['id']!, params['mid']!))
    }
    // Who reacted with an emoji, as Discord's GET .../reactions/{emoji}: users by ID, after= and limit= (1-100, default 25).
    if ((params = match('/client/channels/:id/messages/:mid/reactions/:emoji', pathname)) && method === 'GET') {
      const message = await this.messageIn(v, params['id']!, params['mid']!, P.READ_MESSAGE_HISTORY)
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      const limit = Math.min(Math.max(Number(query.get('limit')) || 25, 1), 100)
      const after = /^\d{1,20}$/.test(query.get('after') ?? '') ? BigInt(query.get('after')!) : -1n
      const ids = (await this.prisma.reaction.findMany({ where: { messageId: message.id, emoji: params['emoji']! }, select: { userId: true } }))
        .map((r) => r.userId).filter((id) => BigInt(id) > after).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, limit)
      const users = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } } })).map((u) => [u.id, u]))
      return send(200, ids.flatMap((id) => (users.has(id) ? [userToAPI(users.get(id)!)] : [])))
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
    const direct = await this.hub.dms.handleClient(req, pathname, v)
    if (direct !== undefined) return send(200, direct)
    if (method === 'GET' && pathname === '/client/routines') return send(200, await this.hub.routines.list(v.userId))
    const scheduled = await this.hub.schedules.handleClient(req, pathname, v)
    if (scheduled !== undefined) return send(200, scheduled)
    const requested = await this.hub.requests.handleClient(req, pathname, v, typeof req.headers.origin === 'string' ? req.headers.origin : null)
    if (requested !== undefined) return send(200, requested)
    const updating = await this.hub.updates.handleClient(req, pathname, v.userId)
    if (updating !== undefined) return send(200, updating)
    const managed = await this.hub.members.handle(req, pathname, v)
    if (managed !== undefined) return send(200, managed)
    if (method === 'GET' && pathname === '/client/inbox') return send(200, await this.inbox(v, new URL(req.url ?? '/', 'http://x').searchParams))
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
    for (const extension of this.hub.extensions) {
      if (!pathname.startsWith(`/client/x/${extension.id}/`)) continue
      const value = await extension.handleClient?.(req, pathname, v)
      if (value === null) return send(204, undefined)
      if (value !== undefined) return send(200, value)
    }
    throw new HttpError(404, 'Not found')
  }

  private async handleAuth(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, method: string) {
    const auth = this.hub.auth
    if (method === 'GET' && pathname === '/client/auth/status') {
      const device = await auth.device(req)
      // open: this computer may sign in with no code or passkey (POST /client/auth/local).
      // local: signed in that way, so signing out would only sign in again.
      return sendJson(res, 200, { signedIn: Boolean(device), device: device && { id: device.id, name: device.name }, userId: device ? this.hub.userOf(device) : null, ...(!device && this.hub.localOpen(req) && { open: true }), ...(device && auth.isLocal(req) && { local: true }) })
    }
    if (method !== 'POST') throw new HttpError(404, 'Not found')
    const peer = `${req.socket.remoteAddress ?? ''} ${this.hub.identityOf(req) ?? ''}`
    // Apps: no ambient credentials, so no Origin check; never a cookie.
    if (pathname.startsWith('/client/auth/app/')) {
      const body = await readJson(req)
      if (pathname === '/client/auth/app/register') {
        auth.checkPairingLock(peer)
        const pairing = typeof body['code'] === 'string' ? await this.hub.store.findPairing(body['code']) : null
        if (pairing && !(await this.hub.firstPairingAllowed(req, pairing.userId))) {
          // Counted like a wrong code: a refused account cannot test codes without limit.
          auth.noteWrongCode(peer)
          throw new HttpError(403, 'Forbidden: this device is not on an allowed Tailscale account')
        }
        const registered = await auth.registerApp(body, peer)
        await this.hub.bindFirstPairing(req, registered.device)
        return sendJson(res, 200, { ...registered, device: { id: registered.device.id, name: registered.device.name } })
      }
      if (pathname === '/client/auth/app/challenge') return sendJson(res, 200, auth.appChallenge())
      if (pathname === '/client/auth/app/login') return sendJson(res, 200, await auth.loginApp(body))
      throw new HttpError(404, 'Not found')
    }
    if (auth.usesBearer(req)) {
      if (pathname !== '/client/auth/logout') throw new HttpError(400, 'Passkey routes do not take a bearer token')
      await auth.logout(req)
      await this.hub.events.endExpired()
      return sendJson(res, 200, { ok: true })
    }
    const origin = auth.checkOrigin(req)
    const body = await readJson(req)
    switch (pathname) {
      case '/client/auth/register/options': {
        // From an unknown Tailscale account only a friend's own first code works, and a refused one is not spent.
        auth.checkPairingLock(peer)
        const pairing = typeof body['code'] === 'string' ? await this.hub.store.findPairing(body['code']) : null
        if (pairing && !(await this.hub.firstPairingAllowed(req, pairing.userId))) {
          // Counted like a wrong code: a refused account cannot test codes without limit.
          auth.noteWrongCode(peer)
          throw new HttpError(403, 'Forbidden: this device is not on an allowed Tailscale account')
        }
        // The transport address plus the Tailscale login the network gate verified; never a raw header.
        return sendJson(res, 200, await auth.registrationOptions(origin, body, peer))
      }
      case '/client/auth/register/verify': {
        const { device, cookie } = await auth.register(origin, body)
        await this.hub.bindFirstPairing(req, device)
        return sendJson(res, 200, { device: { id: device.id, name: device.name } }, { 'set-cookie': cookie })
      }
      case '/client/auth/local': {
        if (!this.hub.localOpen(req)) throw new HttpError(403, 'This hub asks every device to pair')
        const { device, cookie } = await auth.localSession(this.hub.options.config.ownerUserId)
        return sendJson(res, 200, { device: { id: device.id, name: device.name } }, { 'set-cookie': cookie })
      }
      case '/client/auth/login/options':
        return sendJson(res, 200, await auth.loginOptions(origin))
      case '/client/auth/login/verify': {
        const { device, cookie } = await auth.login(origin, body)
        return sendJson(res, 200, { device: { id: device.id, name: device.name } }, { 'set-cookie': cookie! })
      }
      case '/client/auth/logout':
        await auth.logout(req)
        await this.hub.events.endExpired()
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
    const activeMachines = new Set((await this.hub.store.listBots()).filter((b) => !b.revokedAt).map((b) => b.machine))
    // Each machine's guilds, or the primary one when none are set (as syncBots does).
    const botGuilds = await this.hub.store.botGuilds()
    const agentGuilds = new Set([...activeMachines].flatMap((machine) => (machine === 'admin' ? (config.adminGuildId ? [config.adminGuildId] : []) : (botGuilds.get(machine) ?? [config.guildId]))))
    const roles = await this.prisma.role.findMany({ where: { guildId: { in: guilds.map((g) => g.id) } }, orderBy: [{ position: 'desc' }, { id: 'asc' }] })
    const profiles = await this.hub.store.profiles()
    const pending = await this.hub.community.pending()
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
      // The private Admin server (owner and admin agent only), so the app can mark it apart.
      ...(this.hub.access.isHubOwner(v.userId) && this.hub.options.config.adminGuildId && { admin_guild_id: this.hub.options.config.adminGuildId }),
      bot: { id: config.botUserId },
      // The guilds this person is in, primary first. Channels and threads carry guild_id.
      guilds: guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon, owner_id: config.ownerUserId, permissions: String(view.guilds.get(g.id)!.perms) })),
      // Primary guild only: kept for older clients, use guilds and guildCommands.
      guild: primary ? { id: primary.id, name: primary.name } : null,
      channels: channels.filter((c) => !THREAD_TYPES.includes(c.type)).map(withPerms),
      threads: channels.filter((c) => THREAD_TYPES.includes(c.type)).map((c) => ({ ...withPerms(c), last_message_id: c.lastMessageId })),
      // color: the name colour from the user's profile (0xRRGGBB or null).
      // pending: never had a device (imported from Discord, or invited and not joined yet).
      users: users.map((u) => ({ ...userToAPI(u), color: profiles[u.id]?.color ?? null, ...(pending.has(u.id) && { pending: true }) })),
      // Per guild: roles (highest first) and members with their roles.
      roles: Object.fromEntries(guilds.map((g) => [g.id, roles.filter((r) => r.guildId === g.id).map(roleToAPI)])),
      // The agents' bot only where a machine's agent is (not in a server of friends).
      members: Object.fromEntries(guilds.map((g) => [g.id, members.filter((m) => m.guildId === g.id && (m.userId !== config.botUserId || agentGuilds.has(g.id))).map((m) => ({ user_id: m.userId, roles: JSON.parse(m.roles) as string[], nick: m.nick, joined_at: m.joinedAt.toISOString() }))])),
      commands: primary ? (guildCommands[primary.id] ?? []) : [],
      guildCommands,
      read: Object.fromEntries(Object.entries(read).filter(([id]) => visible.has(id))),
      mentions: await this.hub.search.mentionCounts(v.userId, read, visible),
      links: Object.fromEntries(Object.entries(await this.hub.sessions.links.counts()).filter(([id]) => visible.has(id))),
      sessionThreads: (await this.hub.sessions.links.whenReady(), Object.fromEntries(Object.entries(this.hub.sessions.links.sessionThreads()).filter(([, thread]) => visible.has(thread)))),
      favourites: (await this.hub.store.favourites(v.userId)).filter((id) => visible.has(id)),
      presence: await this.hub.presence.snapshotFor(v.userId),
      // Who is in which voice channel (people and bots), where the viewer can see it.
      voice_states: await this.hub.voice.statesFor(v.userId),
      notifications: await this.notificationState(v),
      output: await this.hub.store.outputViews(v.userId),
      machines: machines.map((m) => m.name).filter((name) => this.hub.access.isHubOwner(v.userId) || categoryMachines.has(name.toLowerCase())),
      privacy: await this.hub.settings.privacy(v.userId),
      // Per machine: hashes of its bot avatar and Discord server icon; images at
      // /client/machine-icons/:machine/avatar|guild_icon?v=<hash>.
      machine_icons: await this.machineIconsFor(v),
      // Each machine's own Discord bot (its Kimaki on Discord): messages by that user are the machine's.
      machine_bots: await this.machineBotsFor(v),
      // Direct messages the viewer is in (Discord's private_channels).
      private_channels: await Promise.all(this.hub.dms.of(v.userId).map((dm) => this.hub.dms.toAPI(dm, v.userId))),
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
    const sessions = await this.hub.sessions.forView(visible)
    const server_time_ms = Date.now()
    if (this.hub.access.isHubOwner(v.userId)) return { machines, sessions, server_time_ms }
    const names = new Set(sessions.map((s) => s.machine?.toLowerCase()))
    return { machines: machines.filter((m) => names.has(m.name.toLowerCase())), sessions, server_time_ms }
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
    const searched = await this.hub.search.search(q.slice(0, 500), { ...options, userId: v.userId, channels: await this.hub.access.visibleChannels(v.userId) })
    const { total, results } = searched
    const found = await this.withChannels(v, results.map((r) => r.messageId))
    const snippets = new Map(results.map((r) => [r.messageId, r.snippet]))
    return { total, ...('total_capped' in searched && { total_capped: true }), results: found.map((entry) => ({ ...entry, snippet: snippets.get(entry.message.id) ?? null })) }
  }

  async inbox(v: Viewer, query = new URLSearchParams()) {
    const channelId = query.get('channel_id'), guildId = query.get('guild_id')
    if ((channelId !== null && !/^\d{1,20}$/.test(channelId)) || (guildId !== null && !/^\d{1,20}$/.test(guildId)) || (channelId && guildId)) throw new HttpError(400, 'Choose one channel or server')
    const view = await this.hub.access.view(v.userId)
    if (channelId) await this.channel(v, channelId, P.READ_MESSAGE_HISTORY)
    if (guildId && !view.guilds.has(guildId)) throw new HttpError(404, 'Unknown server')
    const guildChannels = guildId ? new Set((await this.prisma.channel.findMany({ where: { guildId }, select: { id: true } })).map(c => c.id)) : null
    const channels = new Set([...view.channels].filter(([id, bits]) => (bits & P.READ_MESSAGE_HISTORY) !== 0n && (!channelId || id === channelId) && (!guildChannels || guildChannels.has(id))).map(([id]) => id))
    const read = await this.hub.store.readState(v.userId)
    const mentions = await this.hub.search.mentions(v.userId, channels, read)
    const newer = (a: string, b: string | undefined) => !b || a.length > b.length || (a.length === b.length && a > b)
    const found = await this.withChannels(v, mentions.map((m) => m.messageId))
    const final = await this.hub.access.view(v.userId)
    return { mentions: found.filter(e => channels.has(e.channel.id) && ((final.channels.get(e.channel.id) ?? 0n) & P.READ_MESSAGE_HISTORY) !== 0n).map((entry) => ({ ...entry, read: !newer(entry.message.id, read[entry.channel.id]) })) }
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
    // Discord's after=: the oldest messages newer than it, and hasMore says newer ones remain.
    const after = before ? null : query.get('after')
    const order = after ? 'asc' : 'desc'
    const rows = await this.prisma.message.findMany({
      where: { channelId, ...(before && { id: { lt: before } }), ...(after && { id: { gt: after } }) },
      orderBy: [{ timestamp: order }, { id: order }],
      take: limit,
    })
    if (!after) rows.reverse()
    const hasMore = rows.length === limit
    if (!after && !hasMore && channel.starterMessageId && !rows.some((row) => row.id === channel.starterMessageId)) {
      const starter = await this.prisma.message.findUnique({ where: { id: channel.starterMessageId } })
      if (starter) rows.unshift(starter)
    }
    return { messages: await this.toClient(v, rows, () => channel.guildId ?? undefined), hasMore, ...(!before && !after && { privateReplies: this.hub.twin.privateReplies?.list(v.userId, channelId) ?? [] }) }
  }

  // A channel the viewer can view (404 otherwise, so hidden channels do not
  // even exist for them) and where they hold `perm` (403 otherwise).
  private async channel(v: Viewer, channelId: string, perm = 0n) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } })
    const inHub = this.hub.guildIds.has(channel?.guildId ?? '') || this.hub.dms.isMember(v.userId, channelId)
    if (!channel || !inHub || !(await this.hub.access.can(v.userId, channelId, 0n))) throw new HttpError(404, 'Unknown channel')
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
    // A voice channel has its own chat, as on Discord; Send Messages decides, as in a text channel.
    if (channel.type === ChannelType.GuildCategory) throw new HttpError(400, 'Cannot post here')
    const thread = THREAD_TYPES.includes(channel.type)
    const closed = this.hub.dms.closedNote(channelId)
    if (closed) throw new HttpError(409, closed)
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
      flags: (voice ? MessageFlags.IsVoiceMessage : 0) | (Number(body['flags']) & MessageFlags.SuppressNotifications),
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
    requireMessageDelete(v.userId, message.authorId, await this.hub.access.channel(v.userId, channelId))
    await this.hub.twin.simulateUserMessageDelete({ channelId: message.channelId, messageId })
  }

  private async deleteSelectedMessages(v: Viewer, channelId: string, ids: string[]) {
    await this.channel(v, channelId)
    const access = this.hub.access
    const view = await access.view(v.userId)
    const permissions = view.channels.get(channelId) ?? 0n
    const stale = () => new HttpError(409, 'Selection changed. Refresh this chat and select again.')
    const guildId = await this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.findUnique({ where: { id: channelId }, select: { guildId: true, lastMessageId: true, messageCount: true } })
      const where = { channelId, id: { in: ids } }
      const selected = await tx.message.findMany({ where, select: { authorId: true } })
      // A missing ID and an ID from another chat are indistinguishable. This also excludes
      // a thread's parent-channel starter, even when the app displays it alongside the replies.
      if (!channel || selected.length !== ids.length || !access.isCurrent(view)) throw stale()
      for (const row of selected) requireMessageDelete(v.userId, row.authorId, permissions)
      const deleted = await tx.message.deleteMany({ where })
      if (deleted.count !== ids.length) throw stale() // roll back even a partial storage-level delete
      const replaceLast = channel.lastMessageId !== null && ids.includes(channel.lastMessageId)
      const last = replaceLast ? await tx.message.findFirst({ where: { channelId }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }], select: { id: true } }) : null
      await tx.channel.update({ where: { id: channelId }, data: {
        messageCount: Math.max(0, channel.messageCount - deleted.count), ...(replaceLast && { lastMessageId: last?.id ?? null }),
      } })
      if (!access.isCurrent(view)) throw stale()
      return channel.guildId
    })
    this.hub.twin.notifyLocalMessageDeletes(channelId, guildId, ids)
    return { deleted_ids: ids }
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
  private async waitForAck(interactionId: string, trace: { channel: string; kind: string; command?: string }) {
    const started = Date.now()
    traceInteraction('dispatched', interactionId, trace)
    const deadline = started + INTERACTION_WAIT_MS
    while (Date.now() < deadline) {
      const row = await this.prisma.interactionResponse.findUnique({ where: { interactionId } })
      if (row?.acknowledged) {
        traceInteraction('acknowledged', interactionId, { ...trace, responseType: row.type, elapsedMs: Date.now() - started })
        return { interactionId, acknowledged: true, type: row.type, data: row.data ? (JSON.parse(row.data) as unknown) : null }
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    traceInteraction('no-ack', interactionId, { ...trace, elapsedMs: Date.now() - started })
    return { interactionId, acknowledged: false, type: null, data: null }
  }

  async interaction(v: Viewer, body: Body) {
    const channelId = str(body['channelId'], 'channelId')
    if (this.hub.dms.get(channelId)) throw new HttpError(400, 'Agents do not take direct messages')
    await this.channel(v, channelId)
    const customId = str(body['customId'], 'customId')
    const messageId = typeof body['messageId'] === 'string' ? body['messageId'] : undefined
    const privateSource = messageId && this.hub.twin.privateReplies?.forUser(v.userId, channelId, messageId)
    const source = privateSource || !messageId ? null : await this.messageIn(v, channelId, messageId)
    const components = privateSource ? privateSource.components ?? [] : source ? JSON.parse(source.components) as unknown[] : []
    // Like Discord: a button or menu can only be used if it is on that message.
    if ((body['type'] === 'button' || body['type'] === 'select') && !hasComponent(components, customId)) throw new HttpError(400, 'No such component on this message')
    const base = { channelId, userId: v.userId, customId }
    let started: { id: string }
    switch (body['type']) {
      case 'button':
        started = await this.hub.twin.simulateButtonClick({ ...base, messageId: str(messageId, 'messageId') })
        break
      case 'select': {
        let values = Array.isArray(body['values']) ? body['values'].filter((value): value is string => typeof value === 'string').slice(0, 25) : []
        const componentType = findComponent(components, customId)?.['type']
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
        const components = await this.modalComponents(v, body['components'])
        started = await this.hub.twin.simulateModalSubmit({ ...base, fields, messageId, files, components })
        break
      }
      default:
        throw new HttpError(400, 'type must be button, select or modal')
    }
    return this.waitForAck(started.id, { channel: channelId, kind: String(body['type']) })
  }

  // A modal's answers in its order, as the client sends them: [{type, customId, id?, parentId?, row?, value | values | attachmentIds}].
  private async modalComponents(v: Viewer, raw: unknown) {
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 25).map((id) => id.slice(0, 100)) : [])
    const int = (value: unknown) => (Number.isInteger(value) ? (value as number) : undefined)
    let visible: Set<string> | undefined
    const out: DigitalDiscordModalComponent[] = []
    for (const item of Array.isArray(raw) ? raw.slice(0, 40) : []) {
      if (!item || typeof item !== 'object') continue
      const type = item.type
      if (type === 10) {
        out.push({ type, id: int(item.id) })
        continue
      }
      if (typeof item.customId !== 'string') continue
      const base = { customId: item.customId.slice(0, 100), id: int(item.id), parentId: int(item.parentId), row: item.row === true }
      if (type === 4) out.push({ ...base, type, value: typeof item.value === 'string' ? item.value.slice(0, 4000) : '' })
      else if (type === 19) out.push({ ...base, type, attachments: await this.attachmentsFor(v, item.attachmentIds) })
      else if (type === 3 || type === 5 || type === 6 || type === 7 || type === 22) out.push({ ...base, type, values: strings(item.values) })
      // A channel menu can only pick channels the person can see.
      else if (type === 8) {
        visible ??= await this.hub.access.visibleChannels(v.userId)
        out.push({ ...base, type, values: strings(item.values).filter((id) => visible!.has(id)) })
      } else if (type === 21) out.push({ ...base, type, value: typeof item.value === 'string' ? item.value.slice(0, 100) : null })
      else if (type === 23) out.push({ ...base, type, value: item.value === true })
    }
    return out
  }

  // Discord hides a command from members without its default_member_permissions; so does the hub.
  private async checkCommand(v: Viewer, channelId: string, name: string) {
    // Agents do not take DMs: no command or interaction there reaches a bot.
    if (this.hub.dms.get(channelId)) throw new HttpError(400, 'Agents do not take direct messages')
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
    const options = commandOptions(body['options'])
    // Attachment options carry the id of a file this device uploaded.
    const fileIds = (list: CommandOption[]): string[] => list.flatMap((o) => [...(o.type === 11 && typeof o.value === 'string' ? [o.value] : []), ...fileIds(o.options ?? [])])
    const attachments = await this.attachmentsFor(v, fileIds(options))
    const started = await this.hub.twin.simulateSlashCommand({ channelId, userId: v.userId, name: str(body['name'], 'name'), options, attachments })
    const name = String(body['name'])
    return this.waitForAck(started.id, { channel: channelId, kind: 'command', command: /^[\w-]{1,32}$/.test(name) ? name : '(command)' })
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
