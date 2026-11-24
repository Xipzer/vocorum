// Mirroring real Discord into the hub, so the same channels and threads can be
// used from both. A machine's Kimaki, connected to Discord and to the hub,
// copies what it sees on Discord here with the Discord ids (guilds, channels,
// threads, messages). Mirrored messages reach people's devices, search and the
// inbox, but never bots on the hub gateway, so no prompt runs twice. A message
// typed in the hub goes to the machine's Kimaki over the gateway; it posts an
// echo on Discord and mirrors that back with `echo_of`, which links the two
// instead of showing it twice. The archive import uses the same code.

import type http from 'node:http'
import { generateSnowflake } from 'discord-digital-twin/src'
import { HttpError } from './auth.ts'
import { match, readBody, readJson, UPLOAD_LIMIT } from './http.ts'
import type { Hub } from './hub.ts'

const THREAD_TYPES = new Set([10, 11, 12])

type DiscordUser = { id: string; username?: string; global_name?: string | null; avatar?: string | null; bot?: boolean }
type DiscordAttachment = { id: string; filename: string; size?: number; url?: string; proxy_url?: string; content_type?: string; width?: number | null; height?: number | null; duration_secs?: number; waveform?: string; missing?: boolean }
export type DiscordMessage = {
  id: string
  channel_id: string
  author: DiscordUser
  content?: string
  timestamp?: string
  edited_timestamp?: string | null
  type?: number
  flags?: number
  embeds?: unknown[]
  components?: unknown[]
  attachments?: DiscordAttachment[]
  mentions?: DiscordUser[]
  mention_everyone?: boolean
  pinned?: boolean
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string } | null
  echo_of?: string
  [field: string]: unknown
}

// Discord message fields the hub keeps as they are (forwards, polls, stickers,
// calls, who used which command).
const PASSTHROUGH = ['message_snapshots', 'poll', 'sticker_items', 'call', 'interaction_metadata', 'interaction', 'activity', 'application_id', 'webhook_id']
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])
function isDiscordCdn(url: string | undefined) {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'https:' && CDN_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

// Incoming attachments, with the hub's copy kept where one exists.
function keepCopies(stored: string, incoming: string) {
  const copies = new Map((JSON.parse(stored) as DiscordAttachment[]).filter((a) => a.missing || (a.url && !isDiscordCdn(a.url))).map((a) => [a.id, a]))
  return JSON.stringify((JSON.parse(incoming) as DiscordAttachment[]).map((a) => copies.get(a.id) ?? a))
}

const passthrough = (m: DiscordMessage) => Object.fromEntries(PASSTHROUGH.filter((k) => m[k] !== undefined && m[k] !== null).map((k) => [k, m[k]]))
export type DiscordChannel = { id: string; guild_id?: string; type: number; name?: string | null; topic?: string | null; parent_id?: string | null; position?: number; owner_id?: string | null; last_message_id?: string | null; thread_metadata?: { archived?: boolean; locked?: boolean; auto_archive_duration?: number } }

export class Mirror {
  constructor(private readonly hub: Hub) {}

  private get prisma() {
    return this.hub.twin.prisma
  }

  // Discord ids of the owner map to the hub owner.
  private userId(discordId: string) {
    return (this.hub.options.config.ownerDiscordIds ?? []).includes(discordId) ? this.hub.options.config.ownerUserId : discordId
  }

  private rewriteMentions(text: string) {
    let out = text
    for (const id of this.hub.options.config.ownerDiscordIds ?? []) out = out.replace(new RegExp(`<@!?${id}>`, 'g'), `<@${this.hub.options.config.ownerUserId}>`)
    return out
  }

  // A file from Discord's CDN (only there: never an arbitrary URL), or null when
  // it is gone, too big or unreachable. Replaceable in tests.
  download = async (url: string | undefined): Promise<Buffer | null> => {
    if (!isDiscordCdn(url)) return null
    try {
      const res = await fetch(url!, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
      if (!res.ok || Number(res.headers.get('content-length') ?? 0) > UPLOAD_LIMIT * 2) return null
      const data = Buffer.from(await res.arrayBuffer())
      return data.length > UPLOAD_LIMIT * 2 ? null : data
    } catch {
      return null
    }
  }

  private rewriteDeep<T>(value: T): T {
    if ((this.hub.options.config.ownerDiscordIds ?? []).length === 0) return value
    return JSON.parse(this.rewriteMentions(JSON.stringify(value))) as T
  }

  // Discord user ids that stand for a hub user (the owner's Discord accounts).
  aliases(): Record<string, string> {
    return Object.fromEntries((this.hub.options.config.ownerDiscordIds ?? []).map((id) => [id, this.hub.options.config.ownerUserId]))
  }

  // Older imports kept the owner's Discord id in embeds and components: rewrite those once.
  async rewriteStoredMentions() {
    let fixed = 0
    for (const id of this.hub.options.config.ownerDiscordIds ?? []) {
      for (;;) {
        const mention = [`<@${id}>`, `<@!${id}>`]
        const rows = await this.prisma.message.findMany({ where: { OR: mention.flatMap((m) => [{ embeds: { contains: m } }, { components: { contains: m } }]) }, take: 500 })
        const changed = rows.filter((r) => this.rewriteMentions(r.embeds) !== r.embeds || this.rewriteMentions(r.components) !== r.components)
        if (changed.length === 0) break
        for (const r of changed) await this.prisma.message.update({ where: { id: r.id }, data: { embeds: this.rewriteMentions(r.embeds), components: this.rewriteMentions(r.components) } })
        await this.hub.search.writeMany(changed.map((r) => ({ ...r, embeds: this.rewriteMentions(r.embeds), components: this.rewriteMentions(r.components) })))
        fixed += changed.length
      }
    }
    return { fixed }
  }

  // --- guilds

  async guild(machine: string | null, id: string, name: string) {
    if (!/^\d{1,20}$/.test(id)) throw new HttpError(400, 'Bad guild id')
    const existing = this.hub.guilds.find((g) => g.id === id)
    if (!existing) {
      this.hub.mirroredGuilds.add(id)
      await this.hub.store.addGuild(name, { id })
    }
    else if (name && existing.name !== name) await this.hub.store.renameGuild(id, name)
    if (machine) {
      const memberships = (await this.hub.store.botGuilds()).get(machine) ?? [this.hub.options.config.guildId]
      if (!memberships.includes(id)) await this.hub.store.setBotGuilds(machine, [...memberships, id])
    }
    await this.hub.reload()
    return this.hub.guilds.find((g) => g.id === id)
  }

  private async ownGuild(machine: string | null, guildId: string | null | undefined) {
    if (!guildId || !this.hub.guildIds.has(guildId)) throw new HttpError(404, 'Unknown guild: mirror it first')
    if (machine === null) return guildId
    const memberships = (await this.hub.store.botGuilds()).get(machine) ?? [this.hub.options.config.guildId]
    if (!memberships.includes(guildId)) throw new HttpError(403, 'This machine has not joined that guild')
    return guildId
  }

  // --- channels

  async channel(machine: string | null, channel: DiscordChannel) {
    if (!/^\d{1,20}$/.test(channel.id)) throw new HttpError(400, 'Bad channel id')
    let guildId = channel.guild_id
    if (!guildId && channel.parent_id) guildId = (await this.prisma.channel.findUnique({ where: { id: channel.parent_id } }))?.guildId ?? undefined
    await this.ownGuild(machine, guildId)
    const existing = await this.prisma.channel.findUnique({ where: { id: channel.id } })
    if (existing && existing.guildId !== guildId) throw new HttpError(409, 'That id belongs to another guild')
    const meta = channel.thread_metadata
    return this.hub.twin.mirrorChannel({
      id: channel.id,
      guildId: guildId!,
      type: channel.type,
      name: channel.name ?? null,
      topic: channel.topic ?? null,
      parentId: channel.parent_id ?? null,
      position: channel.position ?? 0,
      ownerId: channel.owner_id ? this.userId(channel.owner_id) : null,
      archived: meta?.archived ?? false,
      locked: meta?.locked ?? false,
      autoArchiveDuration: meta?.auto_archive_duration ?? 1440,
    })
  }

  async deleteChannel(machine: string | null, id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id } })
    if (!channel) return { deleted: id }
    await this.ownGuild(machine, channel.guildId)
    await this.hub.twin.simulateChannelDelete({ channelId: id })
    return { deleted: id }
  }

  // --- messages

  private async user(guildId: string, author: DiscordUser) {
    const id = this.userId(author.id)
    if (id === author.id) await this.hub.twin.mirrorUser({ id, username: author.username ?? 'unknown', globalName: author.global_name ?? null, avatar: author.avatar ?? null, bot: author.bot ?? false })
    await this.hub.twin.mirrorMember({ guildId, userId: id })
    return id
  }

  // files: attachment id -> bytes (multipart uploads). Without them the hub
  // downloads the file from Discord's CDN while its signed link still works.
  async message(machine: string | null, message: DiscordMessage, { files = new Map<string, Buffer>(), quiet = false }: { files?: Map<string, Buffer>; quiet?: boolean } = {}) {
    if (!/^\d{1,20}$/.test(message.id) || !message.author?.id) throw new HttpError(400, 'Bad message')
    const channel = await this.prisma.channel.findUnique({ where: { id: message.channel_id } })
    if (!channel) throw new HttpError(404, 'Unknown channel: mirror it first')
    const guildId = await this.ownGuild(machine, channel.guildId)
    // A Discord echo of a message typed in the hub: link it, do not show it twice.
    if (message.echo_of) {
      const original = await this.prisma.message.findUnique({ where: { id: message.echo_of } })
      if (!original || original.channelId !== message.channel_id) throw new HttpError(404, 'Unknown hub message for echo_of')
      await this.hub.store.db.execute({ sql: "INSERT INTO message_origins (message_id, origin, echo_of) VALUES (?, 'echo', ?) ON CONFLICT(message_id) DO UPDATE SET echo_of = excluded.echo_of", args: [message.id, message.echo_of] })
      return { linked: message.echo_of }
    }
    // Unchanged since the last copy (a re-run import, a repeated PUT): nothing to do.
    const before = await this.prisma.message.findUnique({ where: { id: message.id }, select: { content: true, editedTimestamp: true, pinned: true, attachments: true } })
    const edited = message.edited_timestamp ? new Date(message.edited_timestamp).getTime() : null
    if (before && before.content === this.rewriteMentions(message.content ?? '') && (before.editedTimestamp?.getTime() ?? null) === edited && before.pinned === (message.pinned ?? false) && files.size === 0) return { id: message.id, created: false }
    const authorId = await this.user(guildId, message.author)
    const mentions = []
    for (const m of message.mentions ?? []) mentions.push({ ...m, id: this.userId(m.id) })
    const attachments = []
    const copies = new Map(before ? (JSON.parse(before.attachments) as DiscordAttachment[]).filter((a) => a.missing || !isDiscordCdn(a.url)).map((a) => [a.id, a]) : [])
    for (const a of message.attachments ?? []) {
      if (!files.has(a.id) && copies.has(a.id)) {
        attachments.push(copies.get(a.id)!)
        continue
      }
      const data = files.get(a.id) ?? (await this.download(a.url))
      if (!data) {
        attachments.push(a)
        continue
      }
      const saved = await this.hub.attachments.save({ id: /^\d{1,20}$/.test(a.id) ? a.id : generateSnowflake(), filename: a.filename, contentType: a.content_type ?? 'application/octet-stream', data, uploadedBy: 'mirror', durationSecs: a.duration_secs ?? null, waveform: a.waveform ?? null })
      attachments.push({ ...a, id: saved.id, url: saved.url, proxy_url: saved.url, size: saved.size })
    }
    // Recorded first: everything that reacts to the message can tell where it came from.
    await this.hub.store.db.execute({ sql: "INSERT OR IGNORE INTO message_origins (message_id, origin) VALUES (?, 'discord')", args: [message.id] })
    const created = await this.hub.twin.mirrorMessage(
      {
        id: message.id,
        channelId: message.channel_id,
        authorId,
        content: this.rewriteMentions(message.content ?? ''),
        timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
        editedTimestamp: message.edited_timestamp ? new Date(message.edited_timestamp) : null,
        type: message.type ?? 0,
        flags: message.flags ?? 0,
        // Mentions inside embeds and components (Kimaki's status lines) too.
        embeds: this.rewriteDeep(message.embeds ?? []),
        components: this.rewriteDeep(message.components ?? []),
        attachments,
        mentions,
        mentionEveryone: message.mention_everyone ?? false,
        pinned: message.pinned ?? false,
        messageReference: message.message_reference ?? null,
        passthrough: passthrough(message),
      },
      { quiet, extra: { origin: 'discord' } },
    )
    if (quiet) this.hub.search.queueIndex(message.id)
    return { id: message.id, created }
  }

  async deleteMessage(machine: string | null, id: string) {
    const link = (await this.hub.store.db.execute({ sql: 'SELECT echo_of FROM message_origins WHERE message_id = ?', args: [id] })).rows[0]
    if (link?.['echo_of']) {
      await this.hub.store.db.execute({ sql: 'DELETE FROM message_origins WHERE message_id = ?', args: [id] })
      return { unlinked: id }
    }
    const message = await this.prisma.message.findUnique({ where: { id }, include: { channel: true } })
    if (!message) return { deleted: id }
    await this.ownGuild(machine, message.channel.guildId)
    await this.hub.twin.mirrorMessageDelete(id)
    await this.hub.store.db.execute({ sql: 'DELETE FROM message_origins WHERE message_id = ?', args: [id] })
    return { deleted: id }
  }

  async latest(machine: string | null, channelId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } })
    if (!channel) throw new HttpError(404, 'Unknown channel')
    await this.ownGuild(machine, channel.guildId)
    const row = await this.prisma.message.findFirst({ where: { channelId }, orderBy: { id: 'desc' }, select: { id: true } })
    return { message_id: row?.id ?? null }
  }

  // An import batch, written in a few statements: new messages in one insert,
  // changed ones updated, unchanged ones skipped, and the new and changed ones
  // indexed for search before answering (back-pressure for the importer).
  async bulk(messages: DiscordMessage[]) {
    const prisma = this.prisma
    const channelIds = [...new Set(messages.map((m) => m.channel_id))]
    const channels = new Map((await prisma.channel.findMany({ where: { id: { in: channelIds } } })).map((c) => [c.id, c]))
    for (const id of channelIds) if (!channels.has(id)) throw new HttpError(404, `Unknown channel ${id}: mirror it first`)
    const existing = new Map((await prisma.message.findMany({ where: { id: { in: messages.map((m) => m.id) } }, select: { id: true, content: true, editedTimestamp: true, pinned: true, extra: true, attachments: true } })).map((m) => [m.id, m]))
    const authors = new Map<string, string>()
    for (const m of messages) {
      const key = `${channels.get(m.channel_id)!.guildId}:${m.author.id}`
      if (!authors.has(key)) authors.set(key, await this.user(channels.get(m.channel_id)!.guildId!, m.author))
    }
    const rows = messages.map((m) => ({
      id: m.id,
      channelId: m.channel_id,
      authorId: authors.get(`${channels.get(m.channel_id)!.guildId}:${m.author.id}`)!,
      content: this.rewriteMentions(m.content ?? ''),
      timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
      editedTimestamp: m.edited_timestamp ? new Date(m.edited_timestamp) : null,
      type: m.type ?? 0,
      flags: m.flags ?? 0,
      embeds: JSON.stringify(this.rewriteDeep(m.embeds ?? [])),
      components: JSON.stringify(this.rewriteDeep(m.components ?? [])),
      attachments: JSON.stringify(m.attachments ?? []),
      mentions: JSON.stringify((m.mentions ?? []).map((u) => ({ ...u, id: this.userId(u.id) }))),
      mentionEveryone: m.mention_everyone ?? false,
      pinned: m.pinned ?? false,
      messageReference: m.message_reference ? JSON.stringify(m.message_reference) : null,
      extra: Object.keys(passthrough(m)).length ? JSON.stringify(passthrough(m)) : null,
    }))
    const fresh = rows.filter((r) => !existing.has(r.id))
    const changed = rows.filter((r) => {
      const before = existing.get(r.id)
      return before && (before.content !== r.content || (before.editedTimestamp?.getTime() ?? null) !== (r.editedTimestamp?.getTime() ?? null) || before.pinned !== r.pinned || (before.extra ?? null) !== r.extra)
    })
    if (fresh.length) await prisma.message.createMany({ data: fresh })
    // Files already copied to the hub keep their hub links.
    for (const r of changed) await prisma.message.update({ where: { id: r.id }, data: { ...r, attachments: keepCopies(existing.get(r.id)!.attachments, r.attachments) } })
    for (const [channelId, channel] of channels) {
      const added = fresh.filter((r) => r.channelId === channelId)
      if (!added.length) continue
      const newest = added.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b)).id
      const later = !channel.lastMessageId || BigInt(newest) > BigInt(channel.lastMessageId)
      await prisma.channel.update({ where: { id: channelId }, data: { messageCount: { increment: added.length }, totalMessageSent: { increment: added.length }, ...(later && { lastMessageId: newest }) } })
    }
    if (fresh.length) await this.hub.store.db.batch(fresh.map((r) => ({ sql: "INSERT OR IGNORE INTO message_origins (message_id, origin) VALUES (?, 'discord')", args: [r.id] })), 'write')
    await this.hub.search.writeMany([...fresh, ...changed].map((r) => ({ ...r, components: r.components, embeds: r.embeds, attachments: r.attachments })))
    return { messages: messages.length, created: fresh.length, updated: changed.length }
  }

  // Origins for the client: 'discord' for mirrored messages; hub messages that have a Discord echo carry its id.
  async origins(ids: string[]): Promise<Map<string, { origin: 'discord' } | { discord_echo: string }>> {
    const out = new Map<string, { origin: 'discord' } | { discord_echo: string }>()
    if (ids.length === 0) return out
    const json = JSON.stringify(ids)
    const rows = await this.hub.store.db.execute({ sql: 'SELECT message_id, origin, echo_of FROM message_origins WHERE message_id IN (SELECT value FROM json_each(?)) OR echo_of IN (SELECT value FROM json_each(?))', args: [json, json] })
    for (const row of rows.rows) {
      if (row['origin'] === 'discord') out.set(String(row['message_id']), { origin: 'discord' })
      else if (row['echo_of']) out.set(String(row['echo_of']), { discord_echo: String(row['message_id']) })
    }
    return out
  }

  // /admin/mirror/* (CLI and import scripts, admin token): the same as a
  // machine would send, for any guild, with messages written quietly in bulk.
  async handleAdmin(req: http.IncomingMessage, pathname: string) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
    if (pathname === '/admin/mirror/guild') {
      const body = await readJson(req)
      return this.guild(null, String(body['id']), String(body['name'] ?? 'Discord server'))
    }
    if (pathname === '/admin/mirror/channels') {
      const channels = await readJson<DiscordChannel[]>(req)
      for (const channel of channels) await this.channel(null, channel)
      return { channels: channels.length }
    }
    if (pathname === '/admin/mirror/messages') return this.bulk(await readJson<DiscordMessage[]>(req))
    // Raw bytes of one attachment of an imported message: stored on the hub,
    // and the message's attachment URL points at the hub copy from then on.
    const attachment = /^\/admin\/mirror\/attachments\/(\d{1,20})\/(\d{1,20})$/.exec(pathname)
    if (attachment) {
      const [, messageId, attachmentId] = attachment
      const message = await this.prisma.message.findUnique({ where: { id: messageId! } })
      if (!message) throw new HttpError(404, 'Unknown message')
      const list = JSON.parse(message.attachments) as DiscordAttachment[]
      const index = list.findIndex((a) => a.id === attachmentId)
      if (index < 0) throw new HttpError(404, 'Unknown attachment')
      const data = await readBody(req, UPLOAD_LIMIT * 2)
      const original = list[index]!
      const saved = await this.hub.attachments.save({ id: attachmentId!, filename: original.filename, contentType: original.content_type ?? 'application/octet-stream', data, uploadedBy: 'mirror', durationSecs: original.duration_secs ?? null, waveform: original.waveform ?? null })
      list[index] = { ...original, url: saved.url, proxy_url: saved.url, size: saved.size }
      await this.prisma.message.update({ where: { id: messageId! }, data: { attachments: JSON.stringify(list) } })
      return { url: saved.url }
    }
    // A file Discord no longer has (its message was deleted): the attachment stays
    // listed, marked missing, and no longer points at Discord.
    const missing = /^\/admin\/mirror\/attachments\/(\d{1,20})\/(\d{1,20})\/missing$/.exec(pathname)
    if (missing) {
      const [, messageId, attachmentId] = missing
      const message = await this.prisma.message.findUnique({ where: { id: messageId! } })
      if (!message) throw new HttpError(404, 'Unknown message')
      const list = JSON.parse(message.attachments) as DiscordAttachment[]
      const index = list.findIndex((a) => a.id === attachmentId)
      if (index < 0) throw new HttpError(404, 'Unknown attachment')
      list[index] = { ...list[index]!, url: '', proxy_url: '', missing: true }
      await this.prisma.message.update({ where: { id: messageId! }, data: { attachments: JSON.stringify(list) } })
      return { missing: true }
    }
    const guildIcon = /^\/admin\/mirror\/guilds\/(\d{1,20})\/icon$/.exec(pathname)
    if (guildIcon) return this.hub.settings.setGuildIcon(await this.ownGuild(null, guildIcon[1]), await readBody(req, 4 * 1024 * 1024))
    const avatar = /^\/admin\/mirror\/avatars\/(\d{1,20})$/.exec(pathname)
    if (avatar) return this.hub.settings.setMirroredAvatar(avatar[1]!, await readBody(req, 4 * 1024 * 1024))
    const machineBot = /^\/admin\/mirror\/machine-bots\/([^/]+)$/.exec(pathname)
    if (machineBot) return this.machineBot(decodeURIComponent(machineBot[1]!), await readJson(req))
    if (pathname === '/admin/mirror/rewrite-mentions') return this.rewriteStoredMentions()
    if (pathname === '/admin/mirror/finish') {
      const body = await readJson(req)
      const threads = Array.isArray(body['threads']) ? (body['threads'] as string[]) : []
      for (const id of threads) await this.hub.sessions.recompute(id, { quiet: true })
      // Imported history is old news: read for the owner, so it shows no unread or mention badges.
      if (typeof body['guild_id'] === 'string') {
        const channels = await this.prisma.channel.findMany({ where: { guildId: body['guild_id'], lastMessageId: { not: null } }, select: { id: true, lastMessageId: true } })
        await this.hub.store.markRead(this.hub.options.config.ownerUserId, channels.map((c) => [c.id, c.lastMessageId!] as [string, string]))
      }
      await this.hub.search.flush()
      this.hub.access.invalidate()
      for (const guild of this.hub.guilds) this.hub.events.send('ACCESS_CHANGED', { guild_id: guild.id }, { guildId: guild.id })
      return { ok: true }
    }
    throw new HttpError(404, 'Not found')
  }

  // Which Discord bot is this machine's Kimaki on Discord: { discord_user_id, name }.
  async machineBot(machine: string, body: Record<string, unknown>) {
    const id = String(body['discord_user_id'] ?? '')
    const name = String(body['name'] ?? '').trim().slice(0, 64)
    if (!/^\d{1,20}$/.test(id) || !name) throw new HttpError(400, 'discord_user_id and name are required')
    await this.hub.store.db.execute({ sql: 'INSERT INTO machine_bots (machine, discord_user_id, name) VALUES (?, ?, ?) ON CONFLICT(machine) DO UPDATE SET discord_user_id = excluded.discord_user_id, name = excluded.name', args: [machine, id, name] })
    const bots = await this.machineBots()
    await this.hub.sessions.reloadBots()
    this.hub.events.send('MACHINE_BOTS_UPDATE', { machine, ...bots[machine] }, { shape: async (userId) => ((await this.hub.visibleMachines(userId)).has(machine.toLowerCase()) ? { machine, ...bots[machine] } : null) })
    return { machine, ...bots[machine] }
  }

  async machineBots(): Promise<Record<string, { discord_user_id: string; name: string }>> {
    const rows = await this.hub.store.db.execute('SELECT machine, discord_user_id, name FROM machine_bots')
    return Object.fromEntries(rows.rows.map((r) => [String(r['machine']), { discord_user_id: String(r['discord_user_id']), name: String(r['name']) }]))
  }

  // /hub/mirror/* with a machine's bot token.
  async handleBot(req: http.IncomingMessage, pathname: string, machine: string) {
    const method = req.method ?? 'GET'
    let params: Record<string, string> | null
    if ((params = match('/hub/mirror/guilds/:id', pathname)) && method === 'PUT') {
      const body = await readJson(req)
      return this.guild(machine, params['id']!, typeof body['name'] === 'string' ? body['name'] : 'Discord server')
    }
    if ((params = match('/hub/mirror/guilds/:id/icon', pathname)) && method === 'PUT') {
      const guildId = await this.ownGuild(machine, params['id']!)
      return this.hub.settings.setGuildIcon(guildId, await readBody(req, 4 * 1024 * 1024))
    }
    if (pathname === '/hub/mirror/machine-bot' && method === 'PUT') return this.machineBot(machine, await readJson(req))
    if ((params = match('/hub/mirror/channels/:id', pathname)) && method === 'PUT') return this.channel(machine, { ...(await readJson<DiscordChannel>(req)), id: params['id']! })
    if ((params = match('/hub/mirror/channels/:id', pathname)) && method === 'DELETE') return this.deleteChannel(machine, params['id']!)
    if ((params = match('/hub/mirror/channels/:id/latest', pathname)) && method === 'GET') return this.latest(machine, params['id']!)
    if ((params = match('/hub/mirror/messages/:id', pathname)) && method === 'PUT') {
      const { message, files } = await this.readMessage(req)
      return this.message(machine, { ...message, id: params['id']! }, { files })
    }
    if ((params = match('/hub/mirror/messages/:id', pathname)) && method === 'DELETE') return this.deleteMessage(machine, params['id']!)
    throw new HttpError(404, 'Not found')
  }

  // JSON, or multipart with payload_json and files[n] in the order of attachments.
  private async readMessage(req: http.IncomingMessage): Promise<{ message: DiscordMessage; files: Map<string, Buffer> }> {
    const type = req.headers['content-type'] ?? ''
    if (!type.startsWith('multipart/form-data')) return { message: await readJson<DiscordMessage>(req), files: new Map() }
    const raw = await readBody(req, UPLOAD_LIMIT * 4)
    const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': type } }).formData().catch(() => {
      throw new HttpError(400, 'Bad multipart body')
    })
    const payload = form.get('payload_json')
    if (typeof payload !== 'string') throw new HttpError(400, 'payload_json is required')
    const message = JSON.parse(payload) as DiscordMessage
    const files = new Map<string, Buffer>()
    for (const [index, attachment] of (message.attachments ?? []).entries()) {
      const file = form.get(`files[${index}]`)
      if (file && typeof file !== 'string') files.set(attachment.id, Buffer.from(await file.arrayBuffer()))
    }
    return { message, files }
  }
}
