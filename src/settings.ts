// Settings routes for the app: the person's profile (display name, avatar, name
// colour, privacy, status), their own devices, server settings (name, icon; Manage
// Server) and channel settings (create, edit, move, delete; Manage Channels).

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { HttpError, isLocalDevice } from './auth.ts'
import { match, readBody, readJson } from './http.ts'
import type { Hub } from './hub.ts'
import { P, parseBits } from './access.ts'
import { generateSnowflake } from 'discord-digital-twin/src'
import type { ChosenStatus, Overwrite } from './store.ts'
import type { Viewer } from './client-api.ts'

const IMAGE_LIMIT = 4 * 1024 * 1024
const STATUSES = new Set(['online', 'idle', 'dnd', 'invisible'])
const CHANNEL_TYPES = new Set([0, 2, 4, 5, 15]) // text, voice, category, announcement, forum
const THREAD_TYPES = new Set([10, 11, 12])

// Only real images, by their first bytes (never the declared type).
export function imageType(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const text = (value: unknown, field: string, max: number) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`)
  if (value.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`)
  return value.trim()
}

// Discord's text channel names: lower case, no spaces.
export function channelName(name: string, type: number) {
  if (type === 4 || type === 2) return name
  const clean = name.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-{2,}/g, '-').slice(0, 100)
  if (!clean) throw new HttpError(400, 'name has no usable characters')
  return clean
}

export class Settings {
  constructor(private readonly hub: Hub) {}

  private get prisma() {
    return this.hub.twin.prisma
  }

  private mediaFile(kind: 'avatar' | 'guild-icon', id: string) {
    return path.join(this.hub.options.paths.media, `${kind}-${id.replace(/\D/g, '')}.png`)
  }

  // Returns undefined when the route is not a settings route.
  async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, v: Viewer): Promise<unknown | undefined> {
    const method = req.method ?? 'GET'
    let params: Record<string, string> | null
    if (pathname === '/client/me' && method === 'GET') return this.me(v)
    if (pathname === '/client/me' && method === 'PATCH') return this.patchMe(await readJson(req), v)
    if (pathname === '/client/me/avatar' && method === 'PUT') return this.setImage('avatar', v.userId, await readBody(req, IMAGE_LIMIT), v)
    if (pathname === '/client/me/avatar' && method === 'DELETE') return this.setImage('avatar', v.userId, null, v)
    if (pathname === '/client/devices' && method === 'GET') return this.devices(v)
    if ((params = match('/client/devices/:id', pathname)) && method === 'PATCH') return this.renameDevice(params['id']!, await readJson(req), v)
    if ((params = match('/client/devices/:id', pathname)) && method === 'DELETE') return this.revokeDevice(params['id']!, v)
    if ((params = match('/client/guilds/:id', pathname)) && method === 'PATCH') return this.patchGuild(await this.guild(v, params['id']!, P.MANAGE_GUILD), await readJson(req))
    if ((params = match('/client/guilds/:id/icon', pathname)) && method === 'PUT') return this.setImage('guild-icon', await this.guild(v, params['id']!, P.MANAGE_GUILD), await readBody(req, IMAGE_LIMIT), v)
    if ((params = match('/client/guilds/:id/icon', pathname)) && method === 'DELETE') return this.setImage('guild-icon', await this.guild(v, params['id']!, P.MANAGE_GUILD), null, v)
    if ((params = match('/client/guilds/:id/channels', pathname)) && method === 'POST') return this.createChannel(v, await this.guild(v, params['id']!, P.MANAGE_CHANNELS), await readJson(req))
    if ((params = match('/client/guilds/:id/channels', pathname)) && method === 'PATCH') return this.reorder(v, await this.guild(v, params['id']!, P.MANAGE_CHANNELS), await readJson<unknown>(req))
    if ((params = match('/client/channels/:id/settings', pathname)) && method === 'PATCH') return this.patchChannel(v, params['id']!, await readJson(req))
    if ((params = match('/client/channels/:id', pathname)) && method === 'DELETE') return this.deleteChannel(v, params['id']!)
    if ((params = match('/client/emojis/:id', pathname)) && method === 'GET') {
      this.hub.community.serveEmoji(res, params['id']!)
      return null
    }
    if ((params = match('/client/guilds/:id/emojis', pathname)) && method === 'GET') return this.hub.community.emojiOf(await this.guild(v, params['id']!))
    if ((params = match('/client/guild-icons/:id', pathname)) && method === 'GET') {
      this.serveImage(res, this.mediaFile('guild-icon', await this.guild(v, params['id']!)))
      return null
    }
    return undefined
  }

  serveImage(res: http.ServerResponse, file: string) {
    if (!fs.existsSync(file)) throw new HttpError(404, 'No image')
    const data = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': imageType(data) ?? 'application/octet-stream', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
    res.end(data)
  }

  // A guild the viewer is in (404 otherwise) where they hold `perm` (403 otherwise).
  async guild(v: Viewer, id: string, perm = 0n) {
    const guild = await this.hub.access.guild(v.userId, id)
    if (!guild) throw new HttpError(404, 'Unknown guild')
    if ((guild.perms & perm) !== perm) throw new HttpError(403, 'Missing permissions')
    return id
  }

  private async channel(v: Viewer, id: string, perm = 0n) {
    const channel = await this.prisma.channel.findUnique({ where: { id } })
    if (!channel || !(await this.hub.access.can(v.userId, id, 0n))) throw new HttpError(404, 'Unknown channel')
    if (perm && !(await this.hub.access.can(v.userId, id, perm))) throw new HttpError(403, 'Missing permissions')
    return channel
  }

  // --- profile

  async profile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })
    const color = (await this.hub.store.profiles())[userId]?.color ?? null
    return { id: user.id, username: user.username, global_name: user.globalName, avatar: user.avatar, color }
  }

  // Whether others see this person's status and where they are.
  async privacy(userId: string) {
    const profile = (await this.hub.store.profiles())[userId]
    return { show_presence: profile?.showPresence ?? true, show_activity: profile?.showActivity ?? true }
  }

  private async me(v: Viewer) {
    return { user: await this.profile(v.userId), privacy: await this.privacy(v.userId), user_status: this.hub.presence.settingsOf(v.userId), device: { id: v.device.id, name: v.device.name } }
  }

  // { global_name?: string | null, color?: 0xRRGGBB | null, show_presence?: boolean, show_activity?: boolean,
  //   status?: 'online' | 'idle' | 'dnd' | 'invisible', custom_status?: { text: string, expires_at: ms | null } | null }
  private async patchMe(body: Record<string, unknown>, v: Viewer) {
    if (body['global_name'] !== undefined) {
      const name = body['global_name'] === null ? null : text(body['global_name'], 'global_name', 32)
      await this.hub.twin.simulateUserUpdate({ userId: v.userId, globalName: name })
    }
    if (body['color'] !== undefined) {
      const color = body['color']
      if (color !== null && (!Number.isInteger(color) || (color as number) < 0 || (color as number) > 0xffffff)) throw new HttpError(400, 'color must be 0xRRGGBB as a number, or null')
      await this.hub.store.setProfileColor(v.userId, color as number | null)
    }
    for (const [field, key] of [['show_presence', 'showPresence'], ['show_activity', 'showActivity']] as const) {
      if (body[field] === undefined) continue
      if (typeof body[field] !== 'boolean') throw new HttpError(400, `${field} must be true or false`)
      await this.hub.store.setProfile(v.userId, { [key]: body[field] })
      this.hub.presence.forget(v.userId)
    }
    const status = body['status']
    const custom = body['custom_status'] as { text?: unknown; expires_at?: unknown } | null | undefined
    if (status !== undefined || custom !== undefined) {
      if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) throw new HttpError(400, 'status must be online, idle, dnd or invisible')
      const expires = custom?.expires_at ?? null
      if (custom !== undefined && custom !== null && (typeof custom !== 'object' || (expires !== null && !Number.isInteger(expires)))) throw new HttpError(400, 'custom_status must be { text, expires_at } or null')
      const customStatus = custom === undefined ? undefined : custom === null ? null : { text: text(custom.text, 'custom_status.text', 128), expiresAt: expires as number | null }
      await this.hub.presence.choose(v.userId, { ...(status !== undefined && { status: status as ChosenStatus }), ...(customStatus !== undefined && { customStatus }) })
      this.hub.events.send('USER_SETTINGS_UPDATE', this.hub.presence.settingsOf(v.userId), { userId: v.userId })
    }
    return this.userChanged(v)
  }

  private async userChanged(v: Viewer) {
    const user = await this.profile(v.userId)
    this.hub.events.send('USER_UPDATE', user, { users: await this.hub.access.peers(v.userId) })
    return { user, privacy: await this.privacy(v.userId), user_status: this.hub.presence.settingsOf(v.userId), device: { id: v.device.id, name: v.device.name } }
  }

  private async setImage(kind: 'avatar' | 'guild-icon', id: string, data: Buffer | null, v: Viewer) {
    const file = this.mediaFile(kind, id)
    let hash: string | null = null
    if (data) {
      if (!imageType(data)) throw new HttpError(400, 'Send a PNG, JPEG, GIF or WebP image')
      fs.mkdirSync(this.hub.options.paths.media, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, data, { mode: 0o600 })
      hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)
    } else {
      fs.rmSync(file, { force: true })
    }
    if (kind === 'avatar') {
      await this.hub.twin.simulateUserUpdate({ userId: id, avatar: hash })
      return this.userChanged(v)
    }
    await this.hub.store.setGuildIcon(id, hash)
    await this.hub.refreshGuilds()
    return this.hub.guilds.find((g) => g.id === id)
  }

  // The avatar of a user mirrored from Discord (its Discord avatar bytes).
  async setMirroredAvatar(userId: string, data: Buffer) {
    if (!imageType(data)) throw new HttpError(400, 'Send a PNG, JPEG, GIF or WebP image')
    if (!(await this.prisma.user.findUnique({ where: { id: userId } }))) throw new HttpError(404, 'Unknown user')
    fs.mkdirSync(this.hub.options.paths.media, { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.mediaFile('avatar', userId), data, { mode: 0o600 })
    return { user_id: userId }
  }

  // A guild icon set by a machine mirroring its Discord server.
  async setGuildIcon(guildId: string, data: Buffer) {
    if (!imageType(data)) throw new HttpError(400, 'Send a PNG, JPEG, GIF or WebP image')
    const file = this.mediaFile('guild-icon', guildId)
    fs.mkdirSync(this.hub.options.paths.media, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, data, { mode: 0o600 })
    await this.hub.store.setGuildIcon(guildId, crypto.createHash('sha256').update(data).digest('hex').slice(0, 32))
    await this.hub.refreshGuilds()
    return this.hub.guilds.find((g) => g.id === guildId)
  }

  // --- devices

  // The viewer's own devices only.
  private async devices(v: Viewer) {
    const online = new Set(this.hub.events.connections().map((c) => c.deviceId))
    // An app is notified over its socket, so it has push while connected.
    const pushed = new Set((await this.hub.store.pushSubscriptions()).map((s) => s.deviceId))
    const devices = (await this.hub.store.listDevices()).filter((d) => !d.revokedAt && this.hub.userOf(d) === v.userId)
    const open = this.hub.options.config.localAccess === 'open'
    return {
      // open: the row open access signs this computer's browsers in as; no pairing to undo.
      devices: devices.map((d) => ({ id: d.id, name: d.name, created_at: d.createdAt, last_seen_at: d.lastSeenAt, kind: d.kind, current: d.id === v.device.id, online: online.has(d.id), push: pushed.has(d.id) || (d.kind === 'app' && online.has(d.id)), ...(open && isLocalDevice(d, this.hub.options.config.ownerUserId) && { open: true }) })),
    }
  }

  private async ownDevice(v: Viewer, id: string) {
    const device = await this.hub.store.getDevice(id)
    if (!device || device.revokedAt || this.hub.userOf(device) !== v.userId) throw new HttpError(404, 'Unknown device')
    return device
  }

  private async renameDevice(id: string, body: Record<string, unknown>, v: Viewer) {
    await this.ownDevice(v, id)
    await this.hub.store.renameDevice(id, text(body['name'], 'name', 64))
    this.hub.presence.changed()
    return this.devices(v)
  }

  // Signs the device out everywhere: sessions, push subscription, open sockets.
  private async revokeDevice(id: string, v: Viewer) {
    const device = await this.ownDevice(v, id)
    await this.hub.store.revokeDevice(device.id)
    this.hub.events.disconnectDevice(device.id)
    return { revoked: device.id, signed_out: device.id === v.device.id }
  }

  // --- guild and channels

  // { name?: string }
  private async patchGuild(id: string, body: Record<string, unknown>) {
    if (body['name'] !== undefined) await this.hub.store.renameGuild(id, text(body['name'], 'name', 100))
    await this.hub.refreshGuilds()
    return this.hub.guilds.find((g) => g.id === id)
  }

  private async parent(guildId: string, parentId: unknown) {
    if (parentId === null || parentId === undefined) return null
    if (typeof parentId !== 'string') throw new HttpError(400, 'parent_id must be a category id or null')
    const parent = await this.prisma.channel.findUnique({ where: { id: parentId } })
    if (!parent || parent.guildId !== guildId || parent.type !== 4) throw new HttpError(400, 'parent_id must be a category in this guild')
    return parent.id
  }

  // { name, type?: 0 | 4 | 5 | 15, topic?, parent_id?, position?, permission_overwrites?: [{ id, type, allow, deny }] }
  // Overwrites are in place before CHANNEL_CREATE goes out, so a private channel is never briefly public.
  private async createChannel(v: Viewer, guildId: string, body: Record<string, unknown>) {
    const type = body['type'] === undefined ? 0 : body['type']
    if (typeof type !== 'number' || !CHANNEL_TYPES.has(type)) throw new HttpError(400, 'type must be 0 (text), 2 (voice), 4 (category), 5 (announcement) or 15 (forum)')
    const parentId = type === 4 ? null : await this.parent(guildId, body['parent_id'])
    const topic = body['topic'] == null ? null : text(body['topic'], 'topic', 1024)
    const position = body['position'] === undefined ? undefined : this.position(body['position'])
    const id = generateSnowflake()
    const overwrites = await this.overwritesFor(v, guildId, body['permission_overwrites'])
    for (const overwrite of overwrites) await this.hub.store.setOverwrite(id, overwrite)
    if (overwrites.length) this.hub.access.invalidate()
    return { ...(await this.hub.twin.simulateChannelCreate({ id, guildId, name: channelName(text(body['name'], 'name', 100), type), type, topic, parentId, position })), permission_overwrites: overwrites }
  }

  private async overwritesFor(v: Viewer, guildId: string, value: unknown): Promise<Overwrite[]> {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'permission_overwrites must be a list')
    const actor = (await this.hub.access.guild(v.userId, guildId))!
    const grantable = actor.owner || (actor.perms & P.ADMINISTRATOR) !== 0n ? ~0n : actor.perms
    return value.map((entry: Record<string, unknown>) => {
      const type = entry?.['type']
      if (typeof entry?.['id'] !== 'string' || (type !== 0 && type !== 1)) throw new HttpError(400, 'Each overwrite needs an id and type 0 (role) or 1 (member)')
      let allow: bigint
      let deny: bigint
      try {
        allow = parseBits(entry['allow'] ?? '0')
        deny = parseBits(entry['deny'] ?? '0')
      } catch {
        throw new HttpError(400, 'allow and deny must be decimal strings')
      }
      if ((allow | deny) & ~grantable) throw new HttpError(403, 'You cannot set permissions you do not have')
      return { id: entry['id'], type, allow: String(allow), deny: String(deny) }
    })
  }

  private position(value: unknown) {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10_000) throw new HttpError(400, 'position must be a whole number')
    return value as number
  }

  // { name?, topic?, parent_id?, position? }; threads take a name only.
  private async patchChannel(v: Viewer, id: string, body: Record<string, unknown>) {
    const channel = await this.channel(v, id)
    const thread = THREAD_TYPES.has(channel.type)
    const need = thread ? P.MANAGE_THREADS : P.MANAGE_CHANNELS
    if (!(thread && channel.ownerId === v.userId) && !(await this.hub.access.can(v.userId, id, need))) throw new HttpError(403, 'Missing permissions')
    const update: { channelId: string; name?: string; topic?: string | null; parentId?: string | null; position?: number } = { channelId: id }
    if (body['name'] !== undefined) update.name = thread ? text(body['name'], 'name', 100) : channelName(text(body['name'], 'name', 100), channel.type)
    if (!thread) {
      if (body['topic'] !== undefined) update.topic = body['topic'] === null || body['topic'] === '' ? null : text(body['topic'], 'topic', 1024)
      if (body['parent_id'] !== undefined && channel.type !== 4) update.parentId = await this.parent(channel.guildId!, body['parent_id'])
      if (body['position'] !== undefined) update.position = this.position(body['position'])
    }
    return this.hub.twin.simulateChannelUpdate(update)
  }

  // Discord's bulk move: [{ id, position?, parent_id? }]
  private async reorder(v: Viewer, guildId: string, body: unknown) {
    if (!Array.isArray(body) || body.length > 500) throw new HttpError(400, 'Send a list of { id, position, parent_id }')
    const updated = []
    for (const entry of body as Array<Record<string, unknown>>) {
      const channel = await this.channel(v, String(entry?.['id']), P.MANAGE_CHANNELS)
      if (channel.guildId !== guildId || THREAD_TYPES.has(channel.type)) throw new HttpError(400, 'Only this guild\'s channels and categories can be moved')
      const update: { channelId: string; parentId?: string | null; position?: number } = { channelId: channel.id }
      if (entry['position'] !== undefined) update.position = this.position(entry['position'])
      if (entry['parent_id'] !== undefined && channel.type !== 4) update.parentId = await this.parent(guildId, entry['parent_id'])
      updated.push(await this.hub.twin.simulateChannelUpdate(update))
    }
    return { channels: updated }
  }

  private async deleteChannel(v: Viewer, id: string) {
    const channel = await this.channel(v, id)
    const thread = THREAD_TYPES.has(channel.type)
    if (!(await this.hub.access.can(v.userId, id, thread ? P.MANAGE_THREADS : P.MANAGE_CHANNELS))) throw new HttpError(403, 'Missing permissions')
    await this.hub.twin.simulateChannelDelete({ channelId: id })
    return { deleted: id }
  }
}
