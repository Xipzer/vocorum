// A Discord community's shape on the hub: roles, members and their roles,
// channel permission overwrites, who is in each private thread, reactions and
// custom emoji. The importer sends these through /admin/mirror/*.
//
// The first import of each thing sets it as Discord has it. Later imports only
// add what is new: a role, member or channel the owner already has on the hub
// keeps what the hub says, so a role taken away on the hub is never handed back
// by the next import. What differs is counted for the report.

import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { generateSnowflake } from 'discord-digital-twin/src'
import { P } from './access.ts'
import { HttpError } from './auth.ts'
import type { Viewer } from './client-api.ts'
import type { Hub } from './hub.ts'
import { imageType } from './settings.ts'

const FORUMS = new Set([15, 16])
const WELCOME_TTL_MS = 24 * 3600_000

type Role = { id: string; name: string; color?: number; hoist?: boolean; position?: number; permissions?: string; managed?: boolean; mentionable?: boolean; flags?: number }
type Member = { user: { id: string; username?: string; global_name?: string | null; avatar?: string | null; bot?: boolean }; nick?: string | null; roles?: string[]; joined_at?: string }
type Overwrite = { id: string; type: number; allow: string; deny: string }
const ID = /^\d{1,20}$/

export type StructureInput = { roles: Role[]; members: Member[]; channels: Array<{ id: string; permission_overwrites?: Overwrite[] }> }

export class Community {
  private ready: Promise<void> | null = null

  constructor(private readonly hub: Hub) {}

  private get prisma() {
    return this.hub.twin.prisma
  }

  private get db() {
    return this.hub.store.db
  }

  private init() {
    this.ready ??= (async () => {
      // What an import set once (kind: role, member, overwrites); later imports leave those alone.
      await this.db.execute('CREATE TABLE IF NOT EXISTS discord_imported (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (kind, id))')
      await this.db.execute('CREATE TABLE IF NOT EXISTS guild_emoji (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, animated INTEGER NOT NULL DEFAULT 0)')
    })()
    return this.ready
  }

  private async imported(kind: string, ids: string[]) {
    if (!ids.length) return new Set<string>()
    const rows = await this.db.execute({ sql: 'SELECT id FROM discord_imported WHERE kind = ? AND id IN (SELECT value FROM json_each(?))', args: [kind, JSON.stringify(ids)] })
    return new Set(rows.rows.map((r) => String(r['id'])))
  }

  private async mark(kind: string, ids: string[]) {
    if (ids.length) await this.db.batch(ids.map((id) => ({ sql: 'INSERT OR IGNORE INTO discord_imported (kind, id) VALUES (?, ?)', args: [kind, id] })), 'write')
  }

  // The owner's Discord accounts are the hub owner.
  private userId(discordId: string) {
    const config = this.hub.options.config
    return (config.ownerDiscordIds ?? []).includes(discordId) ? config.ownerUserId : discordId
  }

  async structure(guildId: string, input: StructureInput) {
    await this.init()
    if (!this.hub.guildIds.has(guildId)) throw new HttpError(404, 'Unknown guild: mirror it first')
    const out = { roles_added: 0, roles_kept: 0, members_added: 0, members_kept: 0, overwrites_set: 0, overwrites_kept: 0 }

    // Roles, @everyone (the guild's own id) included.
    const roles = (input.roles ?? []).filter((r) => ID.test(r.id) && typeof r.name === 'string')
    const rolesDone = await this.imported('role', roles.map((r) => r.id))
    for (const r of roles) {
      if (rolesDone.has(r.id)) {
        out.roles_kept++
        continue
      }
      const existing = await this.prisma.role.findUnique({ where: { id: r.id } })
      if (existing && existing.guildId !== guildId) throw new HttpError(409, `Role ${r.id} belongs to another guild`)
      const data = { name: r.name.slice(0, 100), color: r.color ?? 0, hoist: r.hoist ?? false, position: r.position ?? 0, permissions: /^\d{1,20}$/.test(r.permissions ?? '') ? r.permissions! : '0', managed: r.managed ?? false, mentionable: r.mentionable ?? false, flags: r.flags ?? 0 }
      await this.prisma.role.upsert({ where: { id: r.id }, create: { id: r.id, guildId, ...data }, update: data })
      out.roles_added++
    }
    await this.mark('role', roles.filter((r) => !rolesDone.has(r.id)).map((r) => r.id))
    const known = new Set((await this.prisma.role.findMany({ where: { guildId }, select: { id: true } })).map((r) => r.id))

    // Members: a person or bot with their roles and nickname. The owner keeps the hub's view of themself.
    const owner = this.hub.options.config.ownerUserId
    const members = (input.members ?? []).filter((m) => ID.test(m.user?.id ?? ''))
    const keys = members.map((m) => `${guildId}:${this.userId(m.user.id)}`)
    const membersDone = await this.imported('member', keys)
    for (const m of members) {
      const id = this.userId(m.user.id)
      if (id === owner) continue
      if (membersDone.has(`${guildId}:${id}`)) {
        out.members_kept++
        continue
      }
      await this.hub.twin.mirrorUser({ id, username: m.user.username ?? 'unknown', globalName: m.user.global_name ?? null, avatar: m.user.avatar ?? null, bot: m.user.bot ?? false })
      const data = { nick: m.nick ?? null, roles: JSON.stringify((m.roles ?? []).filter((r) => known.has(r) && r !== guildId)), ...(m.joined_at && { joinedAt: new Date(m.joined_at) }) }
      await this.prisma.guildMember.upsert({ where: { guildId_userId: { guildId, userId: id } }, create: { guildId, userId: id, ...data }, update: data })
      out.members_added++
    }
    await this.mark('member', keys.filter((k) => !membersDone.has(k) && !k.endsWith(`:${owner}`)))

    // Channel overwrites, on channels of this guild only.
    const channels = (input.channels ?? []).filter((c) => ID.test(c.id))
    const inGuild = new Set((await this.prisma.channel.findMany({ where: { id: { in: channels.map((c) => c.id) }, guildId }, select: { id: true } })).map((c) => c.id))
    const overwritesDone = await this.imported('overwrites', channels.map((c) => c.id))
    for (const c of channels) {
      if (!inGuild.has(c.id)) continue
      if (overwritesDone.has(c.id)) {
        out.overwrites_kept++
        continue
      }
      for (const o of c.permission_overwrites ?? []) {
        if (!ID.test(o.id) || ![0, 1].includes(o.type) || !ID.test(String(o.allow)) || !ID.test(String(o.deny))) continue
        await this.hub.store.setOverwrite(c.id, { id: o.type === 1 ? this.userId(o.id) : o.id, type: o.type as 0 | 1, allow: String(o.allow), deny: String(o.deny) })
        out.overwrites_set++
      }
    }
    await this.mark('overwrites', channels.filter((c) => inGuild.has(c.id) && !overwritesDone.has(c.id)).map((c) => c.id))
    this.hub.access.invalidate()
    return out
  }

  // Who is in each private thread: only they (and people who manage threads) see it.
  async threadMembers(list: Array<{ thread_id: string; user_ids: string[] }>) {
    let added = 0
    for (const { thread_id, user_ids } of list ?? []) {
      if (!ID.test(thread_id) || !(await this.prisma.channel.findUnique({ where: { id: thread_id } }))) continue
      for (const raw of user_ids ?? []) {
        if (!ID.test(raw)) continue
        const userId = this.userId(raw)
        if (!(await this.prisma.user.findUnique({ where: { id: userId } }))) continue
        await this.prisma.threadMember.upsert({ where: { channelId_userId: { channelId: thread_id, userId } }, create: { channelId: thread_id, userId }, update: {} })
        added++
      }
    }
    this.hub.access.invalidate()
    return { added }
  }

  // Reactions with who reacted. emoji: the character, or <:name:id> for a custom one.
  async reactions(list: Array<{ message_id: string; emoji: string; user_ids: string[] }>) {
    let added = 0
    for (const { message_id, emoji, user_ids } of list ?? []) {
      if (!ID.test(message_id) || typeof emoji !== 'string' || !emoji || emoji.length > 100) continue
      if (!(await this.prisma.message.findUnique({ where: { id: message_id }, select: { id: true } }))) continue
      for (const raw of user_ids ?? []) {
        if (!ID.test(raw)) continue
        const userId = this.userId(raw)
        await this.prisma.reaction.upsert({ where: { messageId_userId_emoji: { messageId: message_id, userId, emoji } }, create: { messageId: message_id, userId, emoji }, update: {} })
        added++
      }
    }
    return { added }
  }

  private emojiFile(id: string) {
    return path.join(this.hub.options.paths.media, `emoji-${id.replace(/\D/g, '')}`)
  }

  async saveEmoji(guildId: string, id: string, name: string, animated: boolean, data: Buffer) {
    await this.init()
    if (!this.hub.guildIds.has(guildId)) throw new HttpError(404, 'Unknown guild')
    if (!ID.test(id) || !/^\w{1,64}$/.test(name)) throw new HttpError(400, 'Bad emoji')
    if (!imageType(data)) throw new HttpError(400, 'Send a PNG, GIF or WebP image')
    fs.mkdirSync(this.hub.options.paths.media, { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.emojiFile(id), data, { mode: 0o600 })
    await this.db.execute({ sql: 'INSERT INTO guild_emoji (id, guild_id, name, animated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, animated = excluded.animated', args: [id, guildId, name, animated ? 1 : 0] })
    return { id, name }
  }

  // The hub's copy of a custom emoji, for anyone signed in (emoji are not secret, and a
  // message can show one from a server the viewer is not in, as on Discord).
  serveEmoji(res: http.ServerResponse, id: string) {
    if (!ID.test(id)) throw new HttpError(404, 'No emoji')
    this.hub.settings.serveImage(res, this.emojiFile(id))
  }

  // A new post in a forum: a thread whose opening message has the thread's id, as on Discord.
  async forumPost(v: Viewer, forumId: string, body: Record<string, unknown>) {
    const forum = await this.prisma.channel.findUnique({ where: { id: forumId } })
    if (!forum || !FORUMS.has(forum.type) || !(await this.hub.access.can(v.userId, forumId, P.VIEW_CHANNEL))) throw new HttpError(404, 'Unknown forum')
    if (!(await this.hub.access.can(v.userId, forumId, P.SEND_MESSAGES))) throw new HttpError(403, 'You cannot post in this forum')
    const name = typeof body['name'] === 'string' ? body['name'].trim().slice(0, 100) : ''
    const content = typeof body['content'] === 'string' ? body['content'].slice(0, 4000) : ''
    if (!name) throw new HttpError(400, 'A post needs a title (name)')
    if (!content.trim()) throw new HttpError(400, 'A post needs a first message (content)')
    const id = generateSnowflake()
    const thread = await this.hub.twin.mirrorChannel({ id, guildId: forum.guildId!, type: 11, name, parentId: forumId, ownerId: v.userId })
    await this.prisma.threadMember.create({ data: { channelId: id, userId: v.userId } })
    const message = await this.hub.twin.simulateUserMessage({ id, channelId: id, userId: v.userId, content })
    this.hub.access.invalidate()
    return { thread: { ...thread, owner_id: v.userId }, message }
  }

  // People who have never had a device: imported from Discord, or invited and not yet joined.
  async pending(): Promise<Set<string>> {
    const joined = new Set((await this.hub.store.listDevices()).map((d) => this.hub.userOf(d)))
    const users = await this.prisma.user.findMany({ where: { bot: false }, select: { id: true } })
    return new Set(users.map((u) => u.id).filter((id) => !joined.has(id) && id !== this.hub.options.config.ownerUserId))
  }

  // A code for someone who has not joined yet, from the owner's own device (never the CLI's
  // admin API, so an agent cannot get one). Earlier unused codes of theirs stop working.
  async welcome(v: Viewer, userId: string) {
    if (!this.hub.access.isHubOwner(v.userId)) throw new HttpError(403, 'Only the hub owner can welcome people')
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || user.bot) throw new HttpError(404, 'Unknown person')
    if (!(await this.pending()).has(userId)) throw new HttpError(409, 'They have already joined. To add a device, they make a code from a device they have.')
    await this.db.execute({ sql: 'DELETE FROM pairings WHERE user_id = ? AND used_at IS NULL', args: [userId] })
    const code = await this.hub.store.createPairing(`${user.username}'s first device`, { userId, ttlMs: WELCOME_TTL_MS })
    return { code, expires_at: Date.now() + WELCOME_TTL_MS }
  }

  async emojiOf(guildId: string) {
    await this.init()
    return (await this.db.execute({ sql: 'SELECT id, name, animated FROM guild_emoji WHERE guild_id = ? ORDER BY name', args: [guildId] })).rows.map((r) => ({ id: String(r['id']), name: String(r['name']), animated: Boolean(Number(r['animated'])) }))
  }
}
