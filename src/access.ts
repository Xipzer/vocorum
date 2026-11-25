// Who may see and do what, computed like Discord: the guild owner and
// Administrator get everything; otherwise @everyone plus the member's roles,
// then the channel's overwrites (@everyone, roles, the member), and no
// View Channel means nothing at all in that channel. Threads follow their
// parent channel. Every client route and every event fan-out asks this, so a
// person never receives a channel they cannot view.

import type { Hub } from './hub.ts'
import type { Overwrite } from './store.ts'

// Discord's bits (a subset the hub enforces and the UI offers).
export const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_ROLES: 1n << 28n,
  USE_APPLICATION_COMMANDS: 1n << 31n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  PIN_MESSAGES: 1n << 51n,
} as const
export type PermissionName = keyof typeof P
export const ALL = Object.values(P).reduce((a, b) => a | b, 0n)
// What a new person gets through @everyone in a new guild.
export const DEFAULT_EVERYONE = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.SEND_MESSAGES_IN_THREADS | P.CREATE_PUBLIC_THREADS | P.ADD_REACTIONS | P.ATTACH_FILES | P.READ_MESSAGE_HISTORY | P.USE_APPLICATION_COMMANDS | P.CONNECT | P.SPEAK

const THREAD_TYPES = new Set([10, 11, 12])

export function parseBits(value: unknown): bigint {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  throw new Error('permissions must be a decimal string')
}

export function applyOverwrites(base: bigint, overwrites: Overwrite[], { guildId, roles, userId }: { guildId: string; roles: string[]; userId: string }) {
  let perms = base
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId)
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow)
  let allow = 0n
  let deny = 0n
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guildId && roles.includes(o.id)) {
      allow |= BigInt(o.allow)
      deny |= BigInt(o.deny)
    }
  }
  perms = (perms & ~deny) | allow
  const member = overwrites.find((o) => o.type === 1 && o.id === userId)
  if (member) perms = (perms & ~BigInt(member.deny)) | BigInt(member.allow)
  return perms
}

const DM_PERMS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ATTACH_FILES | P.ADD_REACTIONS | P.USE_APPLICATION_COMMANDS

type View = {
  version: number
  guilds: Map<string, { perms: bigint; roles: string[]; topRole: number; owner: boolean }>
  channels: Map<string, bigint>
}

export class Access {
  private version = 0
  private views = new Map<string, View>()
  private overwriteCache: Map<string, Overwrite[]> | null = null

  constructor(private readonly hub: Hub) {}

  get owner() {
    return this.hub.options.config.ownerUserId
  }

  // The hub's owner runs the machine: services, bots and guild registration are theirs alone.
  isHubOwner(userId: string) {
    return userId === this.owner
  }

  // Anything that changes roles, members, channels or overwrites.
  invalidate() {
    this.version++
    this.overwriteCache = null
  }

  // A write using a previously computed permission view must not outlive its grants.
  isCurrent(view: View) {
    return view.version === this.version
  }

  private async overwrites() {
    this.overwriteCache ??= await this.hub.store.overwrites()
    return this.overwriteCache
  }

  async view(userId: string): Promise<View> {
    const cached = this.views.get(userId)
    if (cached && cached.version === this.version) return cached
    const version = this.version
    const prisma = this.hub.twin.prisma
    const guildIds = [...this.hub.guildIds]
    const members = await prisma.guildMember.findMany({ where: { userId, guildId: { in: guildIds } } })
    const guildRows = await prisma.guild.findMany({ where: { id: { in: members.map((m) => m.guildId) } }, include: { roles: true } })
    const overwrites = await this.overwrites()
    const view: View = { version, guilds: new Map(), channels: new Map() }
    let privateThreads: Set<string> | undefined
    for (const guild of guildRows) {
      const member = members.find((m) => m.guildId === guild.id)!
      const roles = JSON.parse(member.roles) as string[]
      const owner = guild.ownerId === userId
      const everyone = guild.roles.find((r) => r.id === guild.id)
      let perms = BigInt(everyone?.permissions ?? '0')
      let topRole = 0
      for (const role of guild.roles) {
        if (!roles.includes(role.id)) continue
        perms |= BigInt(role.permissions)
        topRole = Math.max(topRole, role.position)
      }
      const admin = owner || (perms & P.ADMINISTRATOR) !== 0n
      view.guilds.set(guild.id, { perms: admin ? ALL : perms, roles, topRole: owner ? Number.MAX_SAFE_INTEGER : topRole, owner })
      const channels = await prisma.channel.findMany({ where: { guildId: guild.id }, select: { id: true, type: true, parentId: true, ownerId: true } })
      const byId = new Map(channels.map((c) => [c.id, c]))
      for (const channel of channels) {
        if (THREAD_TYPES.has(channel.type)) continue
        const own = admin ? ALL : applyOverwrites(perms, overwrites.get(channel.id) ?? [], { guildId: guild.id, roles, userId })
        if (own & P.VIEW_CHANNEL) view.channels.set(channel.id, own)
      }
      for (const channel of channels) {
        if (!THREAD_TYPES.has(channel.type)) continue
        const parent = channel.parentId ? view.channels.get(channel.parentId) : undefined
        if (parent === undefined || !byId.has(channel.parentId!)) continue
        // A private thread: only its members, its starter, and people who manage threads (as on Discord).
        if (channel.type === 12 && !admin && !(parent & P.MANAGE_THREADS) && channel.ownerId !== userId && !(privateThreads ??= new Set((await prisma.threadMember.findMany({ where: { userId, channel: { type: 12 } }, select: { channelId: true } })).map((t) => t.channelId))).has(channel.id)) continue
        view.channels.set(channel.id, parent)
      }
    }
    // Direct messages: only their two sides, with what Discord allows in a DM.
    // With someone who no longer shares a server, only the history stays.
    const dms = this.hub.dms.of(userId)
    const peers = dms.some((dm) => !dm.machine) ? new Set((await prisma.guildMember.findMany({ where: { guildId: { in: [...view.guilds.keys()] } }, select: { userId: true } })).map((m) => m.userId)) : new Set<string>()
    for (const dm of dms) {
      const other = dm.users.find((id) => id !== userId) ?? userId
      view.channels.set(dm.id, dm.machine || peers.has(other) ? DM_PERMS : P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY)
    }
    this.views.set(userId, view)
    return view
  }

  // Permissions in a channel or thread; 0n when the user cannot view it.
  async channel(userId: string, channelId: string): Promise<bigint> {
    return (await this.view(userId)).channels.get(channelId) ?? 0n
  }

  async can(userId: string, channelId: string, perm: bigint) {
    const perms = await this.channel(userId, channelId)
    return (perms & P.VIEW_CHANNEL) !== 0n && (perms & perm) === perm
  }

  async guild(userId: string, guildId: string) {
    return (await this.view(userId)).guilds.get(guildId) ?? null
  }

  async canGuild(userId: string, guildId: string, perm: bigint) {
    const guild = await this.guild(userId, guildId)
    return Boolean(guild && (guild.perms & perm) === perm)
  }

  async visibleChannels(userId: string): Promise<Set<string>> {
    return new Set((await this.view(userId)).channels.keys())
  }

  // Answers from the view built before the latest change (for deletes).
  cachedCan(userId: string, channelId: string) {
    return this.views.get(userId)?.channels.has(channelId) ?? false
  }

  // Human users who share at least one guild with this user (or everyone for the owner).
  async peers(userId: string): Promise<Set<string>> {
    const guilds = [...(await this.view(userId)).guilds.keys()]
    const members = await this.hub.twin.prisma.guildMember.findMany({ where: { guildId: { in: guilds } }, select: { userId: true } })
    return new Set(members.map((m) => m.userId))
  }
}
