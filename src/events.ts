// WS /client/events: tees the twin's gateway dispatches for the hub's guilds to
// signed-in devices, each person only what they may see: channel events only
// for channels they can view, guild events only for guilds they are in.
// Interaction and voice events are never forwarded: they carry tokens meant
// for bots only.

import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { HttpError } from './auth.ts'
import type { Hub } from './hub.ts'
import { traceInteraction } from './interaction-trace.ts'

export const CLIENT_EVENTS = new Set([
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'THREAD_CREATE',
  'THREAD_UPDATE',
  'THREAD_DELETE',
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
  'CHANNEL_PINS_UPDATE',
  'TYPING_START',
  'VOICE_STATE_UPDATE',
  'GUILD_UPDATE',
  'GUILD_ROLE_CREATE',
  'GUILD_ROLE_UPDATE',
  'GUILD_ROLE_DELETE',
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_UPDATE',
  'GUILD_MEMBER_REMOVE',
])

// Events after which who-can-see-what may have changed.
const STRUCTURE = new Set(['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE', 'THREAD_MEMBERS_UPDATE', 'THREAD_MEMBER_UPDATE'])
// Gone after the event: who could see it is answered from before it.
const REMOVALS = new Set(['CHANNEL_DELETE', 'THREAD_DELETE'])
// Role and membership changes: devices refetch /client/state to pick up what they can now see.
const ACCESS = new Set(['GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE'])

// One open app window: which device and person, the channel it shows, and
// whether it is in front. The client reports the last two with {op: 'focus'}.
export type DeviceConnection = { deviceId: string; userId: string; name: string; kind: 'web' | 'app'; channelId: string | null; visible: boolean; session?: { token: string; kind: 'bearer' | 'cookie' } }

// Who a hub-made event is for. Absent fields do not restrict.
export type Audience = {
  userId?: string
  users?: Set<string>
  guildId?: string
  channelId?: string
  hubOwner?: boolean
  // Per recipient payload (privacy); null skips that recipient.
  shape?: (recipientUserId: string) => unknown | null | Promise<unknown | null>
}

type Data = { id?: string; channel_id?: string; parent_id?: string; guild_id?: string; user?: { id?: string } }

export class ClientEvents {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  private sockets = new Map<WebSocket, DeviceConnection>()
  private unobserve: (() => void) | null = null
  private ping: NodeJS.Timeout | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly hub: Hub) {}

  start() {
    this.unobserve = this.hub.twin.observeDispatches((event, data) => {
      // In order, one at a time: a delete must be judged before the next change.
      this.queue = this.queue.then(() => this.dispatch(event, data as Data)).catch((error) => console.error('[events]', error))
    })
    this.ping = setInterval(() => {
      for (const socket of this.sockets.keys()) socket.ping()
      void this.endExpired().catch((error) => console.error('[events]', error))
    }, 30_000)
    this.ping.unref()
  }

  stop() {
    this.unobserve?.()
    if (this.ping) clearInterval(this.ping)
    for (const socket of this.sockets.keys()) socket.terminate()
    this.sockets.clear()
    this.wss.close()
  }

  // Resolves when queued dispatches have been sent (tests).
  flush() {
    return this.queue
  }

  // A socket lives only as long as the session it opened with (logout, expiry).
  async endExpired() {
    for (const [socket, connection] of this.sockets) {
      if (!connection.session) continue
      const device = await this.hub.store.sessionDevice(connection.session.token, connection.session.kind)
      if (!device || device.id !== connection.deviceId) socket.close(4001, 'Session ended')
    }
  }

  disconnectDevice(deviceId: string) {
    for (const [socket, connection] of this.sockets) if (connection.deviceId === deviceId) socket.close(4001, 'Device revoked')
  }

  // A notification for the person's connected apps, shown natively (apps have no Web Push).
  notifyApps(payload: unknown, only: { userId?: string; deviceId?: string }) {
    let sent = 0
    for (const [ws, c] of this.sockets) {
      if (c.kind !== 'app' || (only.userId && c.userId !== only.userId) || (only.deviceId && c.deviceId !== only.deviceId)) continue
      ws.send(JSON.stringify({ t: 'NOTIFY', d: payload }))
      sent++
    }
    return sent
  }

  connections(): DeviceConnection[] {
    return [...this.sockets.values()]
  }

  // Hub-made events (session state, machine health, settings).
  send(event: string, data: unknown, audience: Audience = {}) {
    if (this.sockets.size === 0) {
      if (event === 'PRIVATE_REPLY') this.traceMessage(data, 0, true)
      return
    }
    void this.deliver(event, data, audience).catch((error) => console.error('[events]', error))
  }

  private async deliver(event: string, data: unknown, audience: Audience) {
    const decisions = new Map<string, unknown | null>()
    let sent = 0
    for (const [socket, connection] of this.sockets) {
      const userId = connection.userId
      if (!decisions.has(userId)) decisions.set(userId, (await this.allowed(userId, audience)) ? (audience.shape ? await audience.shape(userId) : data) : null)
      const payload = decisions.get(userId)
      if (payload !== null && payload !== undefined) { socket.send(this.hub.relativize(JSON.stringify({ t: event, d: payload }))); sent++ }
    }
    if (event === 'PRIVATE_REPLY') this.traceMessage(data, sent, true)
  }

  private traceMessage(data: unknown, recipients: number, privateReply: boolean, edited = false) {
    const m = data as { id?: string; channel_id?: string; edited_timestamp?: string; interaction_metadata?: { id?: string } }
    const id = m.interaction_metadata?.id
    if (id && /^\d{15,20}$/.test(id)) traceInteraction(edited || m.edited_timestamp ? 'edited' : 'published', id, { message: m.id, channel: m.channel_id, recipients, private: privateReply, elapsedMs: Math.max(0, Date.now() - Number(BigInt(id) >> 22n) - 1420070400000) })
  }

  private async allowed(userId: string, audience: Audience) {
    const access = this.hub.access
    if (audience.hubOwner && !access.isHubOwner(userId)) return false
    if (audience.userId && audience.userId !== userId) return false
    if (audience.users && !audience.users.has(userId)) return false
    if (audience.guildId && !(await access.guild(userId, audience.guildId))) return false
    if (audience.channelId && !(await access.can(userId, audience.channelId, 0n))) return false
    return true
  }

  private async dispatch(event: string, data: Data) {
    if (STRUCTURE.has(event) && !REMOVALS.has(event)) this.hub.access.invalidate()
    if (!CLIENT_EVENTS.has(event) || this.sockets.size === 0) {
      if (event === 'MESSAGE_CREATE' || event === 'MESSAGE_UPDATE') this.traceMessage(data, 0, false, event === 'MESSAGE_UPDATE')
      if (REMOVALS.has(event)) this.hub.access.invalidate()
      return
    }
    const guildId = typeof data?.guild_id === 'string' ? data.guild_id : undefined
    if (guildId && !this.hub.guildIds.has(guildId)) return
    const payload = this.hub.relativize(JSON.stringify({ t: event, d: data }))
    const users = new Map<string, boolean>()
    let sent = 0
    for (const [socket, connection] of this.sockets) {
      if (!users.has(connection.userId)) users.set(connection.userId, await this.visible(connection.userId, event, data, guildId))
      if (users.get(connection.userId)) { socket.send(payload); sent++ }
    }
    if (event === 'MESSAGE_CREATE' || event === 'MESSAGE_UPDATE') this.traceMessage(data, sent, false, event === 'MESSAGE_UPDATE')
    if (REMOVALS.has(event)) this.hub.access.invalidate()
    if (ACCESS.has(event) && guildId) this.send('ACCESS_CHANGED', { guild_id: guildId }, { guildId })
  }

  private async visible(userId: string, event: string, data: Data, guildId: string | undefined) {
    const access = this.hub.access
    if (REMOVALS.has(event)) return access.cachedCan(userId, data.id ?? '') || (event === 'THREAD_DELETE' && access.cachedCan(userId, data.parent_id ?? ''))
    if (event.startsWith('CHANNEL_') && event !== 'CHANNEL_PINS_UPDATE') return access.can(userId, data.id ?? '', 0n)
    if (event.startsWith('THREAD_')) return access.can(userId, data.id ?? '', 0n)
    if (event.startsWith('GUILD_')) {
      if (event === 'GUILD_MEMBER_REMOVE' && data.user?.id === userId) return true
      return Boolean(guildId && (await access.guild(userId, guildId)))
    }
    // Voice: who is where, if they can see that channel; a leave (no channel) to the guild's people.
    if (event === 'VOICE_STATE_UPDATE') return typeof data.channel_id === 'string' ? access.can(userId, data.channel_id, 0n) : Boolean(guildId && (await access.guild(userId, guildId)))
    const channelId = data.channel_id
    return typeof channelId === 'string' && access.can(userId, channelId, 0n)
  }

  async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      await this.hub.checkHuman(req)
      this.hub.auth.checkCsrf(req)
      const device = await this.hub.auth.requireDevice(req)
      const userId = this.hub.userOf(device)
      this.hub.checkIdentity(req, userId)
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const connection: DeviceConnection = { deviceId: device.id, userId, name: device.name, kind: device.kind, channelId: null, visible: true, session: this.hub.auth.session(req) ?? undefined }
        this.sockets.set(ws, connection)
        ws.on('error', () => ws.terminate())
        this.hub.presence.changed()
        ws.on('close', () => {
          this.sockets.delete(ws)
          this.hub.presence.changed()
        })
        // {op: 'focus', d: {channel_id: string | null, visible: boolean}}
        ws.on('message', (raw) => {
          let message: { op?: unknown; d?: { channel_id?: unknown; visible?: unknown } }
          try {
            message = JSON.parse(String(raw))
          } catch {
            return
          }
          if (message.op !== 'focus' || !message.d) return
          const channelId = message.d.channel_id
          connection.channelId = typeof channelId === 'string' && /^\d{1,20}$/.test(channelId) ? channelId : null
          connection.visible = message.d.visible !== false
          this.hub.presence.changed()
        })
        ws.send(JSON.stringify({ t: 'HELLO', d: { deviceId: device.id, userId } }))
      })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  }
}
