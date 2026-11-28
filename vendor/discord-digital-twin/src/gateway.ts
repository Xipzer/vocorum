// Discord Gateway WebSocket server.
// Implements the minimum Gateway protocol needed for discord.js to connect:
// Hello -> Identify -> Ready -> GUILD_CREATE, plus heartbeat keep-alive.
// REST routes call gateway.broadcast() to push events to connected clients.

import crypto from 'node:crypto'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import {
  GatewayOpcodes,
  GatewayDispatchEvents,
  GatewayIntentBits,
  ApplicationFlags,
} from 'discord-api-types/v10'
import type {
  GatewaySendPayload,
  GatewayHelloData,
  GatewayReadyDispatchData,
  GatewayGuildCreateDispatchData,
  GatewayMessageCreateDispatchData,
  GatewayPresenceUpdate,
  APIUser,
  APIGuild,
  APIGuildMember,
  APIChannel,
  APIMessage,
  APIVoiceState,
  APIStageInstance,
  APIGuildScheduledEvent,
  APISoundboardSound,
  GatewayVoiceServerUpdateDispatchData,
} from 'discord-api-types/v10'
import type { DiscordVoiceServer } from './voice.js'

interface ConnectedClient {
  ws: WebSocket
  sessionId: string
  sequence: number
  identified: boolean
  intents: number
  // Guilds this connection may see. null = all (the real bot token).
  guilds: ReadonlySet<string> | null
  token: string | null
  // Live events that arrive while the READY sequence is sent; null once sent.
  held: Array<{ event: string; data: unknown }> | null
  // Remote address, for the per-address limit on connections that have not identified.
  address: string
  // The Host it connected with, for its resume URL.
  host?: string
  // The bot user this connection is: the shared bot, or the client's own user.
  userId?: string
  // What the bot says it is doing (op 3: a custom status, else its activity name), and when it said so.
  activity?: { text: string | null; at: number }
}

// Result of authenticating a token: the guilds it may see, null = all guilds,
// false = rejected.
export type GatewayAuthorize = (token: string) => ReadonlySet<string> | null | false

// gateway-proxy mode: every registered client token with its guilds. Events
// for a client with no live connection are buffered and replayed on IDENTIFY.
export type GatewayOfflineClients = () => Iterable<[token: string, guilds: ReadonlySet<string>]>

// Same events and cap as gateway-proxy/src/dispatch.rs and state.rs.
const BUFFERED_EVENTS = new Set<string>([
  GatewayDispatchEvents.MessageCreate,
  GatewayDispatchEvents.MessageUpdate,
  GatewayDispatchEvents.MessageDelete,
  GatewayDispatchEvents.ThreadCreate,
  GatewayDispatchEvents.ThreadUpdate,
  GatewayDispatchEvents.ThreadDelete,
])
const OFFLINE_EVENT_BUFFER_LIMIT = 200

// Gateway limits for peers that have not proven who they are.
const MAX_FRAME = 1 << 20
const IDENTIFY_TIMEOUT_MS = 3_000
const MAX_PENDING = 32
const MAX_PENDING_PER_ADDRESS = 8

type BufferedEvent = { event: string; data: unknown; guildId: string }

// Sees every dispatch the twin sends, before guild filtering (a hub client UI).
export type GatewayObserver = (event: string, data: unknown) => void

// Handles WebSocket upgrades for paths other than /gateway. Returns false to reject.
export type UpgradeFallback = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean

export interface GatewayGuildState {
  id: string
  apiGuild: APIGuild
  joinedAt: string
  members: APIGuildMember[]
  channels: APIChannel[]
}

export interface GatewayState {
  botUser: APIUser
  guilds: GatewayGuildState[]
}

// What a bot says it is doing: a custom status (type 4) gives its state, else the first activity's name.
function activityText(activities: ReadonlyArray<{ type?: number; name?: string; state?: string | null }>): string | null {
  const custom = activities.find((a) => a.type === 4)
  const raw = custom ? (custom.state ?? null) : (activities[0]?.name ?? null)
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 128) : null
}

export class DiscordGateway {
  wss: WebSocketServer
  clients: ConnectedClient[] = []
  private loadState: () => Promise<GatewayState>
  private port: number
  private authorize: GatewayAuthorize
  private offlineClients: GatewayOfflineClients | null
  // Client token -> events it missed while offline, oldest first.
  private offlineEvents = new Map<string, BufferedEvent[]>()
  private botUserId: string
  private voice: DiscordVoiceServer | null
  // `${guildId}:${userId}` -> voice state, for users and the bot in a voice channel.
  private voiceStates = new Map<string, APIVoiceState>()
  // userId -> what others see of a user who is not offline (status, activities, client_status).
  private presences = new Map<string, Omit<GatewayPresenceUpdate, 'guild_id'>>()
  private observers = new Set<GatewayObserver>()
  private resumeUrl: string | null
  private gatewayUrlFor: ((host: string | undefined) => string | undefined) | null
  private tokenKey: (token: string) => string
  private directAudience: ((channelId: string) => ReadonlySet<string> | null) | null
  private clientUser: ((token: string) => string | null) | null

  constructor({
    httpServer,
    port,
    loadState,
    authorize,
    offlineClients,
    botUserId,
    voice,
    upgradeFallback,
    acceptUpgrade,
    gatewayUrlFor,
    resumeUrl,
    tokenKey,
    directAudience,
    clientUser,
  }: {
    httpServer: http.Server
    port: number
    loadState: () => Promise<GatewayState>
    authorize: GatewayAuthorize
    // Only in gateway-proxy mode. Real Discord has no offline buffer.
    offlineClients?: GatewayOfflineClients
    botUserId: string
    // Voice server for op 4 joins. Without it, op 4 is ignored.
    voice?: DiscordVoiceServer
    upgradeFallback?: UpgradeFallback
    acceptUpgrade?: (request: http.IncomingMessage) => boolean
    gatewayUrlFor?: (host: string | undefined) => string | undefined
    // resume_gateway_url in READY. Default: this server on loopback.
    resumeUrl?: string
    // Maps a presented token to the key clients are registered under (e.g. a hash).
    tokenKey?: (token: string) => string
    // Direct message channels: the client keys that may see one (null: not one).
    directAudience?: (channelId: string) => ReadonlySet<string> | null
    // A client token that is its own bot user (null: the shared bot).
    clientUser?: (token: string) => string | null
  }) {
    this.clientUser = clientUser ?? null
    this.tokenKey = tokenKey ?? ((token) => token)
    this.directAudience = directAudience ?? null
    this.port = port
    this.resumeUrl = resumeUrl ?? null
    this.gatewayUrlFor = gatewayUrlFor ?? null
    this.loadState = loadState
    this.authorize = authorize
    this.offlineClients = offlineClients ?? null
    this.botUserId = botUserId
    this.voice = voice ?? null
    // Use noServer mode so we can accept both /gateway and /gateway/
    // (twilight-gateway appends /?v=10&encoding=json, creating path /gateway/)
    // Discord's own limits are far below 1 MiB per frame.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
    this.wss.on('connection', (ws, request: http.IncomingMessage) => {
      this.handleConnection(ws, request?.socket?.remoteAddress ?? '', request?.headers?.host)
    })
    httpServer.on('upgrade', (request, socket, head) => {
      // Never throws: a malformed request only loses its own socket.
      try {
        if (acceptUpgrade && !acceptUpgrade(request)) {
          socket.destroy()
          return
        }
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        if (pathname === '/gateway' || pathname === '/gateway/') {
          // Never refuse: a full queue drops its oldest connection that has
          // not identified, so idle sockets cannot lock real bots out.
          // Loopback is shared by every local bot and tailscale serve, so it has no per-address share.
          const address = request.socket.remoteAddress ?? ''
          const pending = this.clients.filter((c) => !c.identified)
          const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
          const mine = loopback ? [] : pending.filter((c) => c.address === address)
          const victim = mine.length >= MAX_PENDING_PER_ADDRESS ? mine[0] : pending.length >= MAX_PENDING ? pending[0] : undefined
          victim?.ws.terminate()
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request)
          })
        } else if (!upgradeFallback?.(request, socket, head)) {
          socket.destroy()
        }
      } catch {
        socket.destroy()
      }
    })
  }

  observe(observer: GatewayObserver): () => void {
    this.observers.add(observer)
    return () => this.observers.delete(observer)
  }

  // Called when a client identifies or an identified client disconnects.
  private connectionObservers = new Set<() => void>()
  observeConnections(observer: () => void): () => void {
    this.connectionObservers.add(observer)
    return () => this.connectionObservers.delete(observer)
  }
  private connectionsChanged() {
    for (const observer of this.connectionObservers) observer()
  }

  // Events only observers see (bots never get them), e.g. typing of the bot itself.
  notifyObservers(event: string, data: unknown): void {
    for (const observer of this.observers) {
      try {
        observer(event, data)
      } catch {
        // An observer must never break dispatch to bots.
      }
    }
  }

  // Tokens with at least one identified connection right now.
  // Each identified client token's latest activity text (null: cleared).
  connectedActivities(): Map<string, { text: string | null; at: number }> {
    const out = new Map<string, { text: string | null; at: number }>()
    for (const client of this.clients) {
      if (!client.identified || !client.token || !client.activity) continue
      const known = out.get(client.token)
      if (!known || known.at < client.activity.at) out.set(client.token, client.activity)
    }
    return out
  }

  connectedTokens(): Set<string> {
    return new Set(this.clients.flatMap((client) => (client.identified && client.token ? [client.token] : [])))
  }

  // Ends every live connection of a client token (after its access was revoked).
  disconnectToken(token: string): void {
    for (const client of this.clients) {
      if (client.token === token) client.ws.close(4004, 'Authentication failed')
    }
    this.offlineEvents.delete(token)
  }

  // Ends a client token's sessions so it identifies again (4009: session timed out, a fresh session).
  reidentifyToken(token: string): void {
    for (const client of this.clients) {
      if (client.token === token) client.ws.close(4009, 'Session timed out')
    }
  }

  broadcast<T>(event: string, data: T): void {
    this.notifyObservers(event, data)
    // gateway-proxy forwards guild events only to clients authorized for that guild.
    const guildId =
      data && typeof data === 'object' && 'guild_id' in data && typeof data.guild_id === 'string'
        ? data.guild_id
        : null
    // No guild: a direct message channel's events go only to the clients it is with.
    const direct = !guildId && this.directAudience ? this.directAudience(directChannelOf(data) ?? '') : null
    for (const client of this.clients) {
      if (!client.identified) continue
      if (guildId && client.guilds && !client.guilds.has(guildId)) continue
      if (event === GatewayDispatchEvents.PresenceUpdate && !(client.intents & GatewayIntentBits.GuildPresences)) continue
      if (direct && !(client.token && direct.has(client.token))) continue
      // Still sending READY: deliver after it and after the missed events, in order.
      if (client.held) {
        client.held.push({ event, data })
        continue
      }
      this.sendDispatch(client, event, data)
    }
    if (guildId) this.bufferForOfflineClients({ event, data, guildId })
  }

  // Mirrors buffer_event_for_disconnected_clients in gateway-proxy dispatch.rs.
  private bufferForOfflineClients(buffered: BufferedEvent): void {
    if (!this.offlineClients || !BUFFERED_EVENTS.has(buffered.event)) return
    for (const [token, guilds] of this.offlineClients()) {
      if (!guilds.has(buffered.guildId)) continue
      if (this.clients.some((client) => client.identified && client.token === token)) continue
      const events = this.offlineEvents.get(token) ?? []
      if (events.length >= OFFLINE_EVENT_BUFFER_LIMIT) events.shift()
      events.push(buffered)
      this.offlineEvents.set(token, events)
    }
  }

  // A user's presence: PRESENCE_UPDATE in each of their guilds, and in GUILD_CREATE from now on.
  setPresence(presence: Omit<GatewayPresenceUpdate, 'guild_id'>, guildIds: readonly string[]): void {
    if (presence.status === 'offline') this.presences.delete(presence.user.id)
    else this.presences.set(presence.user.id, presence)
    for (const guildId of guildIds) this.broadcast(GatewayDispatchEvents.PresenceUpdate, { ...presence, guild_id: guildId })
  }

  broadcastMessageCreate(message: APIMessage, guildId: string): void {
    const data: GatewayMessageCreateDispatchData = {
      ...message,
      guild_id: guildId,
      mentions: message.mentions ?? [],
    }
    this.broadcast(GatewayDispatchEvents.MessageCreate, data)
  }

  // Everyone in a voice channel now (people and bots).
  currentVoiceStates(): APIVoiceState[] {
    return [...this.voiceStates.values()]
  }

  // Moves a user (or the bot) into a voice channel, or out with channelId null,
  // and broadcasts VOICE_STATE_UPDATE to the guild.
  setVoiceState({
    guildId,
    channelId,
    userId,
    sessionId,
    selfMute = false,
    selfDeaf = false,
  }: {
    guildId: string
    channelId: string | null
    userId: string
    sessionId: string
    selfMute?: boolean
    selfDeaf?: boolean
  }): void {
    const key = `${guildId}:${userId}`
    const state: APIVoiceState = {
      guild_id: guildId,
      channel_id: channelId,
      user_id: userId,
      session_id: sessionId,
      deaf: false,
      mute: false,
      self_deaf: selfDeaf,
      self_mute: selfMute,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    }
    if (channelId) this.voiceStates.set(key, state)
    else this.voiceStates.delete(key)
    this.broadcast(GatewayDispatchEvents.VoiceStateUpdate, state)
  }

  // Gateway op 4 from the bot session.
  private handleVoiceStateUpdate(
    client: ConnectedClient,
    { guildId, channelId, selfMute, selfDeaf }: { guildId: string; channelId: string | null; selfMute: boolean; selfDeaf: boolean },
  ): void {
    if (!this.voice) return
    const userId = client.userId ?? this.botUserId
    if (client.guilds && !client.guilds.has(guildId)) return
    const current = this.voiceStates.get(`${guildId}:${userId}`)
    // Like Discord: a join for the channel this session is already in only
    // updates mute/deaf, with no new voice token. No change sends no events.
    if (channelId && current?.channel_id === channelId && current.session_id === client.sessionId) {
      if (current.self_mute === selfMute && current.self_deaf === selfDeaf) return
      this.setVoiceState({ guildId, channelId, userId: userId, sessionId: client.sessionId, selfMute, selfDeaf })
      return
    }
    if (!channelId) {
      if (!current) return
      this.voice.revoke({ guildId, userId: userId })
      this.setVoiceState({ guildId, channelId: null, userId: userId, sessionId: client.sessionId })
      return
    }
    this.setVoiceState({ guildId, channelId, userId: userId, sessionId: client.sessionId, selfMute, selfDeaf })
    const token = this.voice.grant({ guildId, channelId, userId: userId, sessionId: client.sessionId })
    const server: GatewayVoiceServerUpdateDispatchData = { token, guild_id: guildId, endpoint: this.voice.endpoint }
    // Only the session that asked gets the voice token.
    this.sendDispatch(client, GatewayDispatchEvents.VoiceServerUpdate, server)
  }

  close(): void {
    // terminate, not close: a peer that never answers the close handshake
    // would keep the socket open for ws's 30s close timeout.
    for (const client of this.clients) {
      client.ws.terminate()
    }
    this.clients = []
    this.wss.close()
  }

  private send(client: ConnectedClient, payload: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload))
    }
  }

  private sendHello(client: ConnectedClient): void {
    this.send(client, {
      op: GatewayOpcodes.Hello,
      d: { heartbeat_interval: 45000 } satisfies GatewayHelloData,
      s: null,
      t: null,
    })
  }

  private sendHeartbeatAck(client: ConnectedClient): void {
    this.send(client, {
      op: GatewayOpcodes.HeartbeatAck,
      s: null,
      t: null,
    })
  }

  private sendDispatch<T>(
    client: ConnectedClient,
    event: string,
    data: T,
  ): void {
    client.sequence++
    this.send(client, {
      op: GatewayOpcodes.Dispatch,
      t: event,
      s: client.sequence,
      d: data,
    })
  }

  private handleConnection(ws: WebSocket, address = '', host?: string): void {
    const client: ConnectedClient = {
      ws,
      address,
      host,
      sessionId: crypto.randomUUID(),
      sequence: 0,
      identified: false,
      intents: 0,
      guilds: null,
      token: null,
      held: [],
    }
    this.clients.push(client)
    this.sendHello(client)
    // A connection that never identifies is closed, like Discord's 4003.
    const identifyTimer = setTimeout(() => {
      if (!client.identified) ws.close(4003, 'Not authenticated')
    }, IDENTIFY_TIMEOUT_MS)
    identifyTimer.unref?.()
    ws.on('close', () => clearTimeout(identifyTimer))
    // Oversized frames and protocol errors end this connection, never the process.
    ws.on('error', () => ws.terminate())

    ws.on('message', (raw) => {
      void this.handleMessage(client, raw.toString())
    })

    ws.on('close', () => {
      const idx = this.clients.indexOf(client)
      if (idx !== -1) {
        this.clients.splice(idx, 1)
      }
      if (client.identified) this.connectionsChanged()
      // The bot leaves voice when the gateway session that joined ends.
      for (const state of [...this.voiceStates.values()]) {
        const userId = client.userId ?? this.botUserId
        if (state.user_id !== userId || state.session_id !== client.sessionId || !state.guild_id) continue
        this.voice?.revoke({ guildId: state.guild_id, userId })
        this.setVoiceState({ guildId: state.guild_id, channelId: null, userId, sessionId: client.sessionId })
      }
    })
  }

  private async handleMessage(
    client: ConnectedClient,
    raw: string,
  ): Promise<void> {
    // JSON.parse returns unknown -- `as` is the only option for untyped JSON
    const payload = JSON.parse(raw) as GatewaySendPayload

    switch (payload.op) {
      case GatewayOpcodes.Heartbeat: {
        this.sendHeartbeatAck(client)
        break
      }
      case GatewayOpcodes.Identify: {
        // Switch on `op` narrows GatewaySendPayload to GatewayIdentify,
        // so payload.d is already GatewayIdentifyData -- no cast needed
        const { token, intents } = payload.d
        const bareToken = token.replace(/^Bot\s+/i, '')
        const guilds = this.authorize(bareToken)
        if (guilds === false) {
          client.ws.close(4004, 'Authentication failed')
          return
        }
        client.guilds = guilds
        client.token = this.tokenKey(bareToken)
        client.userId = this.clientUser?.(bareToken) ?? this.botUserId
        // The presence it identifies with (discord.js: the presence client option).
        const initial = activityText(Array.isArray(payload.d.presence?.activities) ? payload.d.presence.activities : [])
        if (initial) client.activity = { text: initial, at: Date.now() }
        client.identified = true
        client.intents = intents
        await this.sendReadySequence(client)
        this.connectionsChanged()
        break
      }
      case GatewayOpcodes.PresenceUpdate: {
        if (!client.identified) return
        const activities = Array.isArray(payload.d.activities) ? payload.d.activities : []
        const text = activityText(activities)
        if (client.activity?.text === text) return
        client.activity = { text, at: Date.now() }
        this.connectionsChanged()
        break
      }
      case GatewayOpcodes.VoiceStateUpdate: {
        if (!client.identified) return
        const { guild_id, channel_id, self_mute, self_deaf } = payload.d
        this.handleVoiceStateUpdate(client, { guildId: guild_id, channelId: channel_id, selfMute: self_mute, selfDeaf: self_deaf })
        break
      }
    }
  }

  private async sendReadySequence(client: ConnectedClient): Promise<void> {
    const loaded = await this.loadState()
    const state = {
      ...loaded,
      guilds: loaded.guilds.filter((guild) => !client.guilds || client.guilds.has(guild.id)),
    }

    // A client with its own bot user is that user (a member of its guilds); the application stays shared.
    const own = client.userId && client.userId !== state.botUser.id ? state.guilds.flatMap((g) => g.members).find((m) => m.user?.id === client.userId)?.user : undefined
    const readyData: GatewayReadyDispatchData = {
      v: 10,
      user: own ?? state.botUser,
      guilds: state.guilds.map((g) => ({
        id: g.id,
        unavailable: true,
      })),
      session_id: client.sessionId,
      resume_gateway_url: this.gatewayUrlFor?.(client.host) ?? this.resumeUrl ?? `ws://127.0.0.1:${this.port}/gateway`,
      application: {
        id: state.botUser.id,
        flags:
          ApplicationFlags.GatewayPresence |
          ApplicationFlags.GatewayGuildMembers |
          ApplicationFlags.GatewayMessageContent,
      },
    }
    this.sendDispatch(client, GatewayDispatchEvents.Ready, readyData)

    for (const guild of state.guilds) this.sendDispatch(client, GatewayDispatchEvents.GuildCreate, this.guildCreateData(guild, client))

    // Like forward_shard in gateway-proxy server.rs: READY, GUILD_CREATEs,
    // then the events missed while offline, then the live stream.
    const missed = client.token ? (this.offlineEvents.get(client.token) ?? []) : []
    if (client.token) this.offlineEvents.delete(client.token)
    for (const buffered of missed) {
      if (client.guilds && !client.guilds.has(buffered.guildId)) continue
      this.sendDispatch(client, buffered.event, buffered.data)
    }
    const held = client.held ?? []
    client.held = null
    for (const live of held) this.sendDispatch(client, live.event, live.data)
  }

  // The bot was added to (GUILD_CREATE) or removed from (GUILD_DELETE) a guild
  // after READY: tell every live connection of this client token.
  async sendGuildMembership(token: string, guildId: string, member: boolean): Promise<void> {
    const clients = this.clients.filter((client) => client.identified && client.token === token)
    if (clients.length === 0) return
    const data: unknown = { id: guildId }
    let guild: GatewayState['guilds'][number] | undefined
    if (member) {
      guild = (await this.loadState()).guilds.find((g) => g.id === guildId)
      if (!guild) return
    }
    const event = member ? GatewayDispatchEvents.GuildCreate : GatewayDispatchEvents.GuildDelete
    for (const client of clients) {
      const sent = guild ? this.guildCreateData(guild, client) : data
      if (client.held) client.held.push({ event, data: sent })
      else this.sendDispatch(client, event, sent)
    }
  }

  private guildCreateData(guild: GatewayState['guilds'][number], client: ConnectedClient): GatewayGuildCreateDispatchData {
    // Like Discord: the presences of members who are not offline, with the GUILD_PRESENCES intent.
    const presences: GatewayPresenceUpdate[] = client.intents & GatewayIntentBits.GuildPresences ? guild.members.flatMap((m) => {
      const p = m.user && this.presences.get(m.user.id)
      return p ? [{ ...p, guild_id: guild.id }] : []
    }) : []
    // Typed empty arrays so TS doesn't infer never[]
    const emptyStageInstances: APIStageInstance[] = []
    const emptyScheduledEvents: APIGuildScheduledEvent[] = []
    const emptySoundboardSounds: APISoundboardSound[] = []
    {
      // GatewayGuildCreateDispatchData narrows channels to non-thread types
      // and threads to thread types. Our channels from the DB are all guild
      // channels (not threads), so the cast is safe. Threads are always empty
      // at GUILD_CREATE time in this test server.
      type GuildCreateChannels = GatewayGuildCreateDispatchData['channels']
      type GuildCreateThreads = GatewayGuildCreateDispatchData['threads']

      const guildData: GatewayGuildCreateDispatchData = {
        ...guild.apiGuild,
        joined_at: guild.joinedAt,
        large: false,
        unavailable: false,
        member_count: guild.members.length,
        voice_states: [...this.voiceStates.values()]
          .filter((voiceState) => voiceState.guild_id === guild.id)
          .map(({ guild_id: _guildId, ...voiceState }) => voiceState),
        members: guild.members,
        // Like Discord: channels without threads, and only the active (unarchived) threads.
        channels: guild.channels.filter((c) => !THREAD_CHANNEL_TYPES.has(c.type)) as GuildCreateChannels,
        threads: guild.channels.filter((c) => THREAD_CHANNEL_TYPES.has(c.type) && !(c as { thread_metadata?: { archived?: boolean } }).thread_metadata?.archived) as GuildCreateThreads,
        presences,
        stage_instances: emptyStageInstances,
        guild_scheduled_events: emptyScheduledEvents,
        // soundboard_sounds is missing in Gelbpunkt/twilight 0.16 used by the
        // gateway-proxy main branch. Our remorses/twilight 0.16-updated fork
        // ignores unknown struct fields, so this is safe.
        soundboard_sounds: emptySoundboardSounds,
      }
      return guildData
    }
  }
}

// The channel a guildless event is about: channel_id, or the id of a DM channel itself.
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12])

function directChannelOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const record = data as { channel_id?: unknown; id?: unknown; type?: unknown }
  if (typeof record.channel_id === 'string') return record.channel_id
  if ((record.type === 1 || record.type === 3) && typeof record.id === 'string') return record.id
  return null
}
