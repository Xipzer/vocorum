// Direct messages, as on Discord: a channel of type 1 with no guild, between
// two people who share a server, or between a person and one machine's agent.
// Private by default: only the two sides see it (the hub owner included only
// when they are one of them). Agents do not take DMs: a Kimaki session needs
// a project directory, which the machine's project channels give. A machine
// DM carries a note saying so and does not accept messages, and no bot ever
// receives a DM (the twin's directAudience hook).

import type http from 'node:http'
import { ChannelType } from 'discord-api-types/v10'
import { generateSnowflake } from 'discord-digital-twin/src/snowflake'
import { channelToAPI, userToAPI } from 'discord-digital-twin/src/serializers'
import { HttpError } from './auth.ts'
import { readJson } from './http.ts'
import type { Hub } from './hub.ts'
import type { Viewer } from './client-api.ts'

const NO_BOTS: ReadonlySet<string> = new Set()

export type DirectChannel = { id: string; users: [string, string]; machine: string | null; createdAt: number }

export class DirectMessages {
  private channels = new Map<string, DirectChannel>()

  constructor(private readonly hub: Hub) {}

  async start() {
    await this.hub.store.db.execute(`CREATE TABLE IF NOT EXISTS dm_channels (
      channel_id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      machine TEXT,
      created_at INTEGER NOT NULL
    )`)
    const rows = await this.hub.store.db.execute('SELECT channel_id, user_a, user_b, machine, created_at FROM dm_channels')
    this.channels = new Map(rows.rows.map((r) => [String(r['channel_id']), { id: String(r['channel_id']), users: [String(r['user_a']), String(r['user_b'])], machine: r['machine'] == null ? null : String(r['machine']), createdAt: Number(r['created_at']) }]))
  }

  get(channelId: string) {
    return this.channels.get(channelId) ?? null
  }

  // For the twin: which bot clients may see this channel (none: agents do not
  // take DMs); null when it is not a DM.
  audience(channelId: string): ReadonlySet<string> | null {
    return this.channels.has(channelId) ? NO_BOTS : null
  }

  // Why a DM does not take messages, or null when it does.
  closedNote(channelId: string) {
    const dm = this.channels.get(channelId)
    return dm?.machine ? `Agents on ${dm.machine} work in its project channels.` : null
  }

  isMember(userId: string, channelId: string) {
    return this.channels.get(channelId)?.users.includes(userId) ?? false
  }

  of(userId: string) {
    return [...this.channels.values()].filter((dm) => dm.users.includes(userId))
  }

  // People in a DM other than the bot side (for notifications).
  people(channelId: string) {
    const dm = this.channels.get(channelId)
    if (!dm) return []
    return dm.users.filter((id) => !(dm.machine && id === this.hub.options.config.botUserId))
  }

  async toAPI(dm: DirectChannel, viewerId: string) {
    const channel = await this.hub.twin.prisma.channel.findUnique({ where: { id: dm.id } })
    const others = await this.hub.twin.prisma.user.findMany({ where: { id: { in: dm.users.filter((id) => id !== viewerId) } } })
    return { ...(channel ? channelToAPI(channel) : { id: dm.id, type: ChannelType.DM }), type: ChannelType.DM, recipients: others.map((u) => userToAPI(u)), ...(dm.machine && { machine: dm.machine, note: this.closedNote(dm.id) }) }
  }

  // Opens (or returns) the DM with a person who shares a server, or with a machine the viewer can see.
  async open(v: Viewer, body: Record<string, unknown>) {
    const config = this.hub.options.config
    let other: string
    let machine: string | null = null
    if (typeof body['machine'] === 'string' && body['machine']) {
      machine = body['machine'].toLowerCase()
      if (!(await this.hub.visibleMachines(v.userId)).has(machine)) throw new HttpError(404, 'Unknown machine')
      other = config.botUserId
    } else if (typeof (body['recipient_id'] ?? body['user_id']) === 'string' && /^\d{1,20}$/.test(String(body['recipient_id'] ?? body['user_id']))) {
      other = String(body['recipient_id'] ?? body['user_id'])
      const user = await this.hub.twin.prisma.user.findUnique({ where: { id: other } })
      if (!user || user.bot || other === v.userId || !(await this.hub.access.peers(v.userId)).has(other)) throw new HttpError(404, 'You can only message people you share a server with')
    } else {
      throw new HttpError(400, 'recipient_id or machine is required')
    }
    const users = [v.userId, other].sort() as [string, string]
    const existing = [...this.channels.values()].find((dm) => dm.users[0] === users[0] && dm.users[1] === users[1] && dm.machine === machine)
    if (existing) return this.toAPI(existing, v.userId)
    const dm: DirectChannel = { id: generateSnowflake(), users, machine, createdAt: Date.now() }
    await this.hub.store.db.execute({ sql: 'INSERT INTO dm_channels (channel_id, user_a, user_b, machine, created_at) VALUES (?, ?, ?, ?, ?)', args: [dm.id, users[0], users[1], machine, dm.createdAt] })
    this.channels.set(dm.id, dm)
    this.hub.access.invalidate()
    // CHANNEL_CREATE reaches both people's devices and, for a machine DM, only that machine's bot.
    await this.hub.twin.createDirectChannel({ id: dm.id, recipientIds: users, extra: machine ? { machine, note: this.closedNote(dm.id) } : {} })
    return this.toAPI(dm, v.userId)
  }

  // /client/dms
  async handleClient(req: http.IncomingMessage, pathname: string, v: Viewer): Promise<unknown | undefined> {
    if (pathname !== '/client/dms') return undefined
    if (req.method === 'GET') return { channels: await Promise.all(this.of(v.userId).map((dm) => this.toAPI(dm, v.userId))) }
    if (req.method === 'POST') return this.open(v, await readJson(req))
    throw new HttpError(405, 'Method not allowed')
  }
}
