// People, roles and permissions from the app, like Discord's Server Settings:
// invite a person (a new account with a pairing code) or add one already on
// the hub, remove members, create and edit roles, give members roles, and set
// channel permission overwrites. Discord's rules hold: you can only manage
// roles below your highest one, and never grant a permission you lack
// yourself (the guild owner and Administrators excepted).

import type http from 'node:http'
import { HttpError } from './auth.ts'
import { match, readJson } from './http.ts'
import type { Hub } from './hub.ts'
import { ALL, P, parseBits } from './access.ts'
import type { Viewer } from './client-api.ts'

const INVITE_TTL_MS = 24 * 3600_000
// Kimaki gives agent (shell) access to members with a role of this name, and
// takes it away with the other: only the hub owner may create or name them.
const RESERVED_ROLE_NAMES = new Set(['kimaki', 'no-kimaki'])
const THREAD_TYPES = new Set([10, 11, 12])

const bits = (value: unknown, field: string) => {
  try {
    return parseBits(value)
  } catch {
    throw new HttpError(400, `${field} must be a permission bit set as a decimal string`)
  }
}

export class Members {
  constructor(private readonly hub: Hub) {}

  private get prisma() {
    return this.hub.twin.prisma
  }

  async handle(req: http.IncomingMessage, pathname: string, v: Viewer): Promise<unknown | undefined> {
    const method = req.method ?? 'GET'
    let params: Record<string, string> | null
    if (pathname === '/client/devices/pair' && method === 'POST') return this.pairOwnDevice(v, await readJson(req))
    if ((params = match('/client/guilds/:id/invites', pathname)) && method === 'POST') return this.invite(v, params['id']!, await readJson(req))
    if ((params = match('/client/guilds/:id/members/:user', pathname)) && method === 'DELETE') return this.removeMember(v, params['id']!, params['user']!)
    if ((params = match('/client/guilds/:id/members/:user/roles', pathname)) && method === 'PUT') return this.setRoles(v, params['id']!, params['user']!, await readJson(req))
    if ((params = match('/client/guilds/:id/roles', pathname)) && method === 'POST') return this.createRole(v, params['id']!, await readJson(req))
    if ((params = match('/client/guilds/:id/roles/:role', pathname)) && method === 'PATCH') return this.updateRole(v, params['id']!, params['role']!, await readJson(req))
    if ((params = match('/client/guilds/:id/roles/:role', pathname)) && method === 'DELETE') return this.deleteRole(v, params['id']!, params['role']!)
    if ((params = match('/client/channels/:id/permissions/:target', pathname)) && (method === 'PUT' || method === 'DELETE')) return this.setOverwrite(v, params['id']!, params['target']!, method === 'PUT' ? await readJson(req) : null)
    return undefined
  }

  private async me(v: Viewer, guildId: string, perm: bigint) {
    const guild = await this.hub.access.guild(v.userId, guildId)
    if (!guild) throw new HttpError(404, 'Unknown guild')
    if ((guild.perms & perm) !== perm) throw new HttpError(403, 'Missing permissions')
    return guild
  }

  // Bits the actor may hand out: everything for the owner and Administrators.
  private grantable(actor: { perms: bigint; owner: boolean }) {
    return actor.owner || (actor.perms & P.ADMINISTRATOR) !== 0n ? ~0n : actor.perms
  }

  private checkGrant(actor: { perms: bigint; owner: boolean }, before: bigint, after: bigint) {
    const added = after & ~before
    if (added & ~this.grantable(actor)) throw new HttpError(403, 'You cannot grant permissions you do not have')
  }

  // --- people

  // A code for another device of the viewer (10 minutes).
  private async pairOwnDevice(v: Viewer, body: Record<string, unknown>) {
    const name = typeof body['name'] === 'string' && body['name'].trim() ? body['name'].trim().slice(0, 64) : 'device'
    const userId = v.userId === this.hub.options.config.ownerUserId ? null : v.userId
    const code = await this.hub.store.createPairing(name, { userId })
    return { code, expires_at: Date.now() + 10 * 60_000 }
  }

  // { username, global_name? }: a new person, with a pairing code for their first device.
  // { user_id }: someone already on the hub joins this guild.
  async invite(v: Viewer, guildId: string, body: Record<string, unknown>) {
    await this.me(v, guildId, P.MANAGE_GUILD)
    if (guildId === this.hub.options.config.adminGuildId) throw new HttpError(400, 'The Admin server is only for you and your admin agent')
    if (typeof body['user_id'] === 'string') {
      const user = await this.prisma.user.findUnique({ where: { id: body['user_id'] } })
      if (!user || user.bot || !(await this.hub.access.peers(v.userId)).has(user.id)) throw new HttpError(404, 'Unknown user')
      await this.hub.twin.addGuildMember({ guildId, userId: user.id })
      return { user: await this.hub.settings.profile(user.id), code: null, expires_at: null }
    }
    const username = typeof body['username'] === 'string' ? body['username'].trim().toLowerCase() : ''
    if (!/^[a-z0-9_.]{2,32}$/.test(username)) throw new HttpError(400, 'username must be 2 to 32 letters, digits, dots or underscores')
    if (await this.prisma.user.findFirst({ where: { username } })) throw new HttpError(409, 'That username is taken')
    const globalName = typeof body['global_name'] === 'string' && body['global_name'].trim() ? body['global_name'].trim().slice(0, 32) : null
    const userId = await this.hub.twin.createUser({ username, globalName })
    await this.hub.twin.addGuildMember({ guildId, userId })
    const code = await this.hub.store.createPairing(`${username}'s first device`, { userId, ttlMs: INVITE_TTL_MS })
    return { user: await this.hub.settings.profile(userId), code, expires_at: Date.now() + INVITE_TTL_MS }
  }

  // Kick (Manage Server, and only people below you), or leave (yourself).
  private async removeMember(v: Viewer, guildId: string, userId: string) {
    const actor = await this.me(v, guildId, userId === v.userId ? 0n : P.MANAGE_GUILD)
    const target = await this.hub.access.guild(userId, guildId)
    if (!target) throw new HttpError(404, 'Unknown member')
    if (target.owner) throw new HttpError(403, 'The owner cannot be removed')
    if (userId !== v.userId && !actor.owner && target.topRole >= actor.topRole) throw new HttpError(403, 'You can only remove people below your highest role')
    await this.hub.twin.removeGuildMember({ guildId, userId })
    return { removed: userId }
  }

  // --- roles

  private async role(guildId: string, roleId: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } })
    if (!role || role.guildId !== guildId) throw new HttpError(404, 'Unknown role')
    return role
  }

  private below(actor: { owner: boolean; topRole: number }, position: number) {
    if (!actor.owner && position >= actor.topRole) throw new HttpError(403, 'You can only manage roles below your highest role')
  }

  private reserved(v: Viewer, name: string | undefined) {
    if (name !== undefined && RESERVED_ROLE_NAMES.has(name.trim().toLowerCase()) && !this.hub.access.isHubOwner(v.userId)) {
      throw new HttpError(403, `Only the hub owner can create or name a role "${name}": it controls agent access on the machines`)
    }
  }

  // A member ranked at or above the actor is out of reach (their own roles excepted).
  private async reachable(v: Viewer, actor: { owner: boolean; topRole: number }, guildId: string, userId: string) {
    if (actor.owner || userId === v.userId) return
    const target = await this.hub.access.guild(userId, guildId)
    if (target && (target.owner || target.topRole >= actor.topRole)) throw new HttpError(403, 'You can only manage people below your highest role')
  }

  private fields(body: Record<string, unknown>) {
    const out: { name?: string; color?: number; permissions?: bigint; hoist?: boolean; mentionable?: boolean; position?: number } = {}
    if (body['name'] !== undefined) {
      if (typeof body['name'] !== 'string' || !body['name'].trim() || body['name'].length > 100) throw new HttpError(400, 'name must be 1 to 100 characters')
      out.name = body['name'].trim()
    }
    if (body['color'] !== undefined) {
      if (!Number.isInteger(body['color']) || (body['color'] as number) < 0 || (body['color'] as number) > 0xffffff) throw new HttpError(400, 'color must be 0xRRGGBB as a number')
      out.color = body['color'] as number
    }
    if (body['permissions'] !== undefined) out.permissions = bits(body['permissions'], 'permissions')
    for (const flag of ['hoist', 'mentionable'] as const) {
      if (body[flag] === undefined) continue
      if (typeof body[flag] !== 'boolean') throw new HttpError(400, `${flag} must be true or false`)
      out[flag] = body[flag] as boolean
    }
    if (body['position'] !== undefined) {
      if (!Number.isInteger(body['position']) || (body['position'] as number) < 1 || (body['position'] as number) > 250) throw new HttpError(400, 'position must be 1 to 250')
      out.position = body['position'] as number
    }
    return out
  }

  // { name, color?, permissions?, hoist?, mentionable? }: placed just below the actor's highest role.
  private async createRole(v: Viewer, guildId: string, body: Record<string, unknown>) {
    const actor = await this.me(v, guildId, P.MANAGE_ROLES)
    const fields = this.fields(body)
    if (!fields.name) throw new HttpError(400, 'name is required')
    this.reserved(v, fields.name)
    const permissions = fields.permissions ?? 0n
    this.checkGrant(actor, 0n, permissions)
    const top = actor.owner ? undefined : Math.max(1, actor.topRole - 1)
    if (top !== undefined) await this.makeRoom(guildId, top)
    const role = await this.hub.twin.createRole({ guildId, name: fields.name, color: fields.color, hoist: fields.hoist, mentionable: fields.mentionable, permissions: String(permissions), position: top })
    this.hub.access.invalidate()
    return role
  }

  // Moves roles at `position` and above up by one, so a new role fits under the actor.
  private async makeRoom(guildId: string, position: number) {
    const above = await this.prisma.role.findMany({ where: { guildId, position: { gte: position }, id: { not: guildId } }, orderBy: { position: 'desc' } })
    for (const role of above) await this.hub.twin.updateRole({ guildId, roleId: role.id, position: role.position + 1 })
  }

  // @everyone (the guild id) takes permissions only.
  private async updateRole(v: Viewer, guildId: string, roleId: string, body: Record<string, unknown>) {
    const actor = await this.me(v, guildId, P.MANAGE_ROLES)
    const role = await this.role(guildId, roleId)
    const everyone = roleId === guildId
    if (!everyone) this.below(actor, role.position)
    const fields = this.fields(body)
    this.reserved(v, fields.name)
    if (!this.hub.access.isHubOwner(v.userId) && RESERVED_ROLE_NAMES.has(role.name.toLowerCase()) && Object.keys(fields).length) throw new HttpError(403, 'Only the hub owner can change this role')
    if (everyone && (fields.name !== undefined || fields.position !== undefined)) throw new HttpError(400, '@everyone can only change permissions')
    if (fields.position !== undefined) this.below(actor, fields.position)
    if (fields.permissions !== undefined) this.checkGrant(actor, BigInt(role.permissions), fields.permissions)
    const updated = await this.hub.twin.updateRole({ guildId, roleId, ...fields, permissions: fields.permissions === undefined ? undefined : String(fields.permissions) })
    this.hub.access.invalidate()
    return updated
  }

  private async deleteRole(v: Viewer, guildId: string, roleId: string) {
    const actor = await this.me(v, guildId, P.MANAGE_ROLES)
    if (roleId === guildId) throw new HttpError(400, '@everyone cannot be deleted')
    const role = await this.role(guildId, roleId)
    this.below(actor, role.position)
    await this.hub.twin.deleteRole({ guildId, roleId })
    for (const [channelId] of [...(await this.hub.store.overwrites())].filter(([, list]) => list.some((o) => o.id === roleId))) {
      await this.hub.store.setOverwrite(channelId, { id: roleId, remove: true })
    }
    this.hub.access.invalidate()
    return { deleted: roleId }
  }

  // { roles: [roleId] }: only roles below the actor's highest change hands.
  private async setRoles(v: Viewer, guildId: string, userId: string, body: Record<string, unknown>) {
    const actor = await this.me(v, guildId, P.MANAGE_ROLES)
    const member = await this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId } } })
    if (!member) throw new HttpError(404, 'Unknown member')
    await this.reachable(v, actor, guildId, userId)
    if (!Array.isArray(body['roles']) || body['roles'].some((r) => typeof r !== 'string')) throw new HttpError(400, 'roles must be a list of role ids')
    const wanted = new Set((body['roles'] as string[]).filter((r) => r !== guildId))
    const before = new Set(JSON.parse(member.roles) as string[])
    const roles = new Map((await this.prisma.role.findMany({ where: { guildId } })).map((r) => [r.id, r]))
    for (const id of new Set([...wanted, ...before])) {
      if (wanted.has(id) === before.has(id)) continue
      const role = roles.get(id)
      if (!role) throw new HttpError(400, `Unknown role ${id}`)
      this.below(actor, role.position)
      if (RESERVED_ROLE_NAMES.has(role.name.toLowerCase()) && !this.hub.access.isHubOwner(v.userId)) throw new HttpError(403, `Only the hub owner gives or takes the "${role.name}" role`)
      if (wanted.has(id)) this.checkGrant(actor, 0n, BigInt(role.permissions))
    }
    await this.hub.twin.setMemberRoles({ guildId, userId, roles: [...wanted] })
    this.hub.access.invalidate()
    return { user_id: userId, roles: [...wanted] }
  }

  // --- channel overwrites (Discord's "Manage Permissions" is Manage Roles in the channel)

  // { type: 0 role | 1 member, allow, deny } or null to remove.
  private async setOverwrite(v: Viewer, channelId: string, targetId: string, body: Record<string, unknown> | null) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } })
    if (!channel || !(await this.hub.access.can(v.userId, channelId, 0n))) throw new HttpError(404, 'Unknown channel')
    if (THREAD_TYPES.has(channel.type)) throw new HttpError(400, 'Threads follow their channel\'s permissions')
    const guildId = channel.guildId!
    const actor = await this.me(v, guildId, 0n)
    const inChannel = await this.hub.access.channel(v.userId, channelId)
    if (!actor.owner && (inChannel & P.ADMINISTRATOR) === 0n && (inChannel & P.MANAGE_ROLES) === 0n) throw new HttpError(403, 'Missing permissions')
    const existing = (await this.hub.store.overwrites()).get(channelId)?.find((o) => o.id === targetId)
    if (body === null) {
      if (existing) {
        if (existing.type === 0 && targetId !== guildId) this.below(actor, (await this.role(guildId, targetId)).position)
        if (existing.type === 1) await this.reachable(v, actor, guildId, targetId)
        this.checkGrant({ owner: actor.owner, perms: actor.owner ? ALL : inChannel }, 0n, BigInt(existing.deny))
        await this.hub.store.setOverwrite(channelId, { id: targetId, remove: true })
      }
    } else {
      const type = body['type']
      if (type !== 0 && type !== 1) throw new HttpError(400, 'type must be 0 (role) or 1 (member)')
      if (type === 0) {
        const role = await this.role(guildId, targetId)
        if (targetId !== guildId) this.below(actor, role.position)
      } else {
        if (!(await this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId: targetId } } }))) throw new HttpError(404, 'Unknown member')
        await this.reachable(v, actor, guildId, targetId)
      }
      const allow = bits(body['allow'] ?? '0', 'allow')
      const deny = bits(body['deny'] ?? '0', 'deny')
      if (allow & deny) throw new HttpError(400, 'A permission cannot be both allowed and denied')
      const scope = { owner: actor.owner, perms: actor.owner ? ALL : inChannel }
      this.checkGrant(scope, BigInt(existing?.allow ?? '0'), allow)
      this.checkGrant(scope, BigInt(existing?.deny ?? '0'), deny)
      await this.hub.store.setOverwrite(channelId, { id: targetId, type, allow: String(allow), deny: String(deny) })
    }
    // Who can see what changed: devices refetch, and the channel's overwrites go to those who still see it.
    this.hub.access.invalidate()
    const permission_overwrites = (await this.hub.store.overwrites()).get(channelId) ?? []
    this.hub.events.send('CHANNEL_PERMISSIONS_UPDATE', { channel_id: channelId, guild_id: guildId, permission_overwrites }, { channelId })
    this.hub.events.send('ACCESS_CHANGED', { guild_id: guildId }, { guildId })
    return { channel_id: channelId, permission_overwrites }
  }
}
