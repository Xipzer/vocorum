// DigitalDiscord - Local Discord API test server.
// Creates a fake Discord server (REST + Gateway WebSocket) that discord.js
// can connect to. Used for automated testing of the Kimaki bot without
// hitting real Discord.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import url from 'node:url'
import {
  ChannelType,
  GatewayDispatchEvents,
  InteractionType,
  ComponentType,
  MessageType,
} from 'discord-api-types/v10'
import type {
  APIMessage,
  APIChannel,
  APIRole,
  APIEmbed,
  APIAttachment,
  APIInteraction,
  APIMessageReference,
} from 'discord-api-types/v10'
import { createPrismaClient, type PrismaClient } from './db.js'
import { generateSnowflake } from './snowflake.js'
import {
  createServer,
  startServer,
  stopServer,
  type ServerComponents,
  type TypingEventRecord,
  type HttpExtension,
  type AttachmentStore,
  pinMessage,
} from './server.js'
import type { GatewayObserver, GatewayState } from './gateway.js'
import { DiscordVoiceServer, type VoiceStream } from './voice.js'
import {
  userToAPI,
  guildToAPI,
  memberToAPI,
  roleToAPI,
  channelToAPI,
  messageToAPI,
  isoTimestamp,
} from './serializers.js'

const MAX_VITEST_WAIT_TIMEOUT_MS = 10_000

function normalizeWaitTimeout(timeout: number): number {
  if (process.env['KIMAKI_VITEST'] === '1') {
    return Math.min(timeout, MAX_VITEST_WAIT_TIMEOUT_MS)
  }
  return timeout
}

function collectComponentText({
  components,
  lines,
}: {
  components: unknown[]
  lines: string[]
}): void {
  for (const component of components) {
    if (!component || typeof component !== 'object') {
      continue
    }
    if (!('type' in component) || typeof component.type !== 'number') {
      continue
    }
    if (component.type === ComponentType.Separator) {
      lines.push('---')
      continue
    }
    // Components V2 media, in the order the message places it.
    if (component.type === ComponentType.MediaGallery && 'items' in component && Array.isArray(component.items)) {
      for (const item of component.items) lines.push(`[media: ${item?.media?.url ?? ''}]`)
      continue
    }
    if (component.type === ComponentType.File && 'file' in component && component.file && typeof component.file === 'object') {
      lines.push(`[file: ${'url' in component.file ? String(component.file.url) : ''}]`)
      continue
    }
    if (
      'content' in component &&
      typeof component.content === 'string' &&
      component.content
    ) {
      lines.push(component.content)
    }
    if ('components' in component && Array.isArray(component.components)) {
      collectComponentText({ components: component.components, lines })
    }
  }
}

export function getMessageVisibleText(message: {
  content?: string | null
  components?: readonly unknown[] | null
}): string {
  const lines: string[] = []
  if (message.content) {
    lines.push(message.content)
  }
  if (message.components) {
    collectComponentText({ components: [...message.components], lines })
  }
  return lines.join('\n')
}

export type DigitalDiscordChannelOption = {
  id?: string
  name: string
  type: ChannelType
  topic?: string
  parentId?: string
}

export type DigitalDiscordGuildOption = {
  id?: string
  name?: string
  ownerId?: string
  channels?: DigitalDiscordChannelOption[]
}

export interface DigitalDiscordOptions {
  guild?: DigitalDiscordGuildOption
  // Multi-guild support: seed multiple guilds, each with its own channels.
  // If both guild and guilds are provided, guilds takes precedence.
  guilds?: DigitalDiscordGuildOption[]
  channels?: DigitalDiscordChannelOption[]
  users?: Array<{
    id?: string
    username: string
    bot?: boolean
  }>
  botUser?: {
    id?: string
    username?: string
  }
  botToken?: string
  // Database URL. Defaults to in-memory (file::memory:?cache=shared).
  // Pass a file: URL (e.g. "file:./test.db") for persistent storage.
  dbUrl?: string
  // Override the gateway URL returned by GET /gateway/bot.
  // Useful when a proxy sits between the client and this server.
  gatewayUrlOverride?: string
  // Act as kimaki's gateway-proxy: only `clientId:secret` tokens registered
  // with authorizeGatewayClient() connect, READY and events are filtered to
  // their guilds, and REST routes follow rest_proxy.rs (fail closed). A
  // botToken containing ':' is authorized for every seeded guild. Message and
  // thread events for a registered client with no connection are buffered and
  // replayed after its next READY, like the proxy's offline buffer.
  gatewayProxy?: boolean
  // Fixed port and bind address. Default: a free port on 127.0.0.1.
  port?: number
  host?: string
  // Start a voice server: gateway op 4 joins get VOICE_SERVER_UPDATE and
  // @discordjs/voice can connect and send audio, recorded as opus frames
  // (getVoiceStreams). Needs the openssl CLI for the wss:// certificate.
  voice?: boolean
  // Extra HTTP routes outside /api and WebSocket upgrades outside /gateway,
  // served on the same port (a hub's client API).
  extension?: HttpExtension
  // Where files uploaded by bots go. Default: data: URIs inside the message.
  storeAttachment?: AttachmentStore
  // gatewayProxy mode: maps a presented client token to the key it is
  // registered under, so the caller can store only a hash of the secret.
  // authorizeGatewayClient() and revokeGatewayClient() then take the key.
  gatewayClientKey?: (token: string) => string
  // A member's permissions in a channel, sent with interactions (Discord's
  // member.permissions and app_permissions). Default: everything.
  memberPermissions?: (userId: string, channelId: string) => Promise<string>
  // gatewayProxy mode: direct message channels (no guild). The client keys
  // that may see one, or null when the channel is not a direct message.
  // Without it, events of guildless channels go to every client.
  directAudience?: (channelId: string) => ReadonlySet<string> | null
}

const isThreadType = (type: number) => type === 10 || type === 11 || type === 12

export type { VoiceStream, HttpExtension, AttachmentStore, GatewayObserver }

export type DigitalDiscordCommandOption = {
  name: string
  type: number
  value?: string | number | boolean
  options?: DigitalDiscordCommandOption[]
}

export type DigitalDiscordSelectOption = {
  values: string[]
}

export type DigitalDiscordModalField = {
  customId: string
  value: string
}

export type DigitalDiscordMessagePredicate = (message: APIMessage) => boolean
export type DigitalDiscordThreadPredicate = (thread: APIChannel) => boolean
export type DigitalDiscordTypingEvent = TypingEventRecord

type DigitalDiscordInteractionEvent = {
  timestamp: number
  channelId: string
  interactionType: InteractionType
  componentType?: ComponentType
  values?: string[]
}

function compareSnowflakeDesc(a: string, b: string): number {
  try {
    const aSnowflake = BigInt(a)
    const bSnowflake = BigInt(b)
    if (aSnowflake > bSnowflake) {
      return -1
    }
    if (aSnowflake < bSnowflake) {
      return 1
    }
    return 0
  } catch {
    return b.localeCompare(a)
  }
}

export class DigitalDiscord {
  prisma: PrismaClient
  botToken: string
  botUserId: string
  // First guild ID for backward compatibility
  guildId: string
  // All guild IDs when using multi-guild mode
  guildIds: string[]

  private server: ServerComponents | null = null
  private options: DigitalDiscordOptions
  // gatewayProxy mode: client token -> authorized guild IDs.
  private gatewayClients = new Map<string, Set<string>>()
  private gatewayClientUsers = new Map<string, string>()
  private seeded = false
  private voiceServer: DiscordVoiceServer | null = null
  private interactionEvents: DigitalDiscordInteractionEvent[] = []

  constructor(options: DigitalDiscordOptions = {}) {
    this.options = options
    this.prisma = createPrismaClient(options.dbUrl)
    this.botUserId = options.botUser?.id ?? generateSnowflake()
    // Shaped like a real bot token: the first segment is base64(application id),
    // so clients that derive the app ID from the token work against the twin.
    this.botToken = options.botToken ?? `${Buffer.from(this.botUserId).toString('base64')}.twin.fake-bot-token`

    if (options.guilds && options.guilds.length > 0) {
      this.guildIds = options.guilds.map((g) => g.id ?? generateSnowflake())
      this.guildId = this.guildIds[0] ?? generateSnowflake()
    } else {
      this.guildId = options.guild?.id ?? generateSnowflake()
      this.guildIds = [this.guildId]
    }
  }

  get port(): number {
    return this.server?.port ?? 0
  }

  get restUrl(): string {
    return `http://127.0.0.1:${this.port}/api`
  }

  get gatewayUrl(): string {
    return `ws://127.0.0.1:${this.port}/gateway`
  }

  async start(): Promise<void> {
    await this.prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000')
    await this.prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')
    // A bounded page cache (8 MB): reads of a large history must not keep the whole database in memory.
    await this.prisma.$executeRawUnsafe('PRAGMA cache_size = -8000')

    // Apply migrations by pushing schema to in-memory DB
    // For libsql :memory:, we use Prisma's $executeRawUnsafe with the schema SQL
    await this.applySchema()

    if (!this.seeded) {
      // A persistent file DB keeps its guilds across restarts: seed only once.
      if ((await this.prisma.guild.count()) === 0) await this.seed()
      this.seeded = true
    }

    if (this.options.gatewayProxy && this.botToken.includes(':')) {
      this.authorizeGatewayClient({ token: this.options.gatewayClientKey?.(this.botToken) ?? this.botToken, guildIds: this.guildIds })
    }
    if (this.options.voice && !this.voiceServer) {
      const voice = new DiscordVoiceServer()
      // Without voice (no openssl for its certificate, say) the rest still runs.
      try {
        await voice.start()
        this.voiceServer = voice
      } catch (error) {
        console.error('[twin] voice server did not start; bots cannot join voice:', error)
        await voice.stop().catch(() => {})
      }
    }
    this.server = createServer({
      voice: this.voiceServer ?? undefined,
      prisma: this.prisma,
      botUserId: this.botUserId,
      gatewayProxy: Boolean(this.options.gatewayProxy),
      authorize: (token) => {
        if (!this.options.gatewayProxy) return token === this.botToken ? null : false
        return this.gatewayClients.get(this.options.gatewayClientKey ? this.options.gatewayClientKey(token) : token) ?? false
      },
      loadGatewayState: () => this.loadGatewayState(),
      gatewayUrlOverride: this.options.gatewayUrlOverride,
      ...(this.options.gatewayProxy && { offlineClients: () => this.gatewayClients.entries() }),
      extension: this.options.extension,
      storeAttachment: this.options.storeAttachment,
      tokenKey: this.options.gatewayClientKey,
      directAudience: this.options.directAudience,
      clientUser: (token) => this.gatewayClientUsers.get(this.options.gatewayClientKey ? this.options.gatewayClientKey(token) : token) ?? null,
    })

    const port = await startServer(this.server, { port: this.options.port, host: this.options.host })
    this.server.port = port
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.privateReplies.clear()
      await stopServer(this.server)
      this.server = null
    }
    await this.voiceServer?.stop()
    this.voiceServer = null
  }

  // --- Voice (needs the `voice` option) ---

  private requireVoice(): DiscordVoiceServer {
    if (!this.voiceServer) throw new Error('DigitalDiscord was started without the voice option')
    return this.voiceServer
  }

  // Trust the self-signed wss:// certificate of the voice server in this process.
  trustVoiceCertificate(): void {
    this.requireVoice().trustCertificate()
  }

  getVoiceStreams({ channelId, userId }: { channelId?: string; userId?: string } = {}): VoiceStream[] {
    return this.requireVoice().streams.filter((stream) => {
      return (!channelId || stream.channelId === channelId) && (!userId || stream.userId === userId)
    })
  }

  // Resolves with the first finished audio stream that matches: Speaking is
  // off and no opus frame arrived for 200ms (UDP can trail the Speaking message).
  async waitForVoiceStream({
    channelId,
    userId,
    timeout = 10000,
  }: { channelId?: string; userId?: string; timeout?: number } = {}): Promise<VoiceStream> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const stream = this.getVoiceStreams({ channelId, userId }).find((candidate) => {
        return !candidate.speaking && candidate.opusPackets.length > 0 && Date.now() - candidate.lastPacketAt > 200
      })
      if (stream) return stream
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for a voice stream in ${channelId ?? 'any channel'}`)
  }

  // A user in a voice channel speaks: the bot receives Speaking and the opus frames.
  async speakInVoice(input: { guildId: string; channelId: string; userId: string; opusPackets: readonly Buffer[]; intervalMs?: number }): Promise<void> {
    await this.requireVoice().speak(input)
  }

  // A user joins a voice channel (channelId) or leaves voice (null).
  async setUserVoiceChannel({ userId, guildId, channelId, selfMute = false, selfDeaf = false }: { userId: string; guildId: string; channelId: string | null; selfMute?: boolean; selfDeaf?: boolean }): Promise<void> {
    if (!this.server) throw new Error('DigitalDiscord is not started')
    this.server.gateway.setVoiceState({ guildId, channelId, userId, sessionId: `user-${userId}`, selfMute, selfDeaf })
  }

  // Everyone in voice now: people and bots.
  voiceStates() {
    return this.server?.gateway.currentVoiceStates() ?? []
  }

  // The voice server, for a host that forwards live audio (sendFrame, onAudio).
  get voice(): DiscordVoiceServer | null {
    return this.voiceServer
  }

  // gatewayProxy mode: a client token that is its own bot user (in voice, presence and
  // what it posts) instead of the shared bot; null makes it the shared bot again.
  // Takes effect at its next connection.
  setGatewayClientUser({ token, userId }: { token: string; userId: string | null }): void {
    if (userId) this.gatewayClientUsers.set(token, userId)
    else this.gatewayClientUsers.delete(token)
  }

  // gatewayProxy mode: what the website's OAuth callback does (a
  // gateway_clients row). The client can connect from now on.
  authorizeGatewayClient({ token, guildIds }: { token: string; guildIds: readonly string[] }): void {
    const guilds = this.gatewayClients.get(token) ?? new Set<string>()
    for (const guildId of guildIds) guilds.add(guildId)
    this.gatewayClients.set(token, guilds)
  }

  // gatewayProxy mode: sets exactly which guilds a client is in. Live
  // connections get GUILD_CREATE for added guilds and GUILD_DELETE for removed
  // ones, like a bot being added to or kicked from a server.
  async setGatewayClientGuilds({ token, guildIds }: { token: string; guildIds: readonly string[] }): Promise<void> {
    const guilds = this.gatewayClients.get(token) ?? new Set<string>()
    this.gatewayClients.set(token, guilds)
    const wanted = new Set(guildIds)
    const added = [...wanted].filter((id) => !guilds.has(id))
    const removed = [...guilds].filter((id) => !wanted.has(id))
    // Mutated in place: identified connections hold this same set.
    for (const id of removed) guilds.delete(id)
    for (const id of added) guilds.add(id)
    if (!this.server) return
    for (const id of removed) await this.server.gateway.sendGuildMembership(token, id, false)
    for (const id of added) await this.server.gateway.sendGuildMembership(token, id, true)
  }

  // A guild created after start, with the bot and the given users as members
  // and a #general channel, like a new Discord server. Bots see it once
  // setGatewayClientGuilds() adds it.
  async createGuild({ id = generateSnowflake(), name, ownerId, icon = null, userIds = [], general = true }: { id?: string; name: string; ownerId: string; icon?: string | null; userIds?: string[]; general?: boolean }): Promise<string> {
    await this.prisma.guild.create({ data: { id, name, ownerId, icon } })
    await this.prisma.role.create({ data: { id, guildId: id, name: '@everyone', permissions: '1071698660929', position: 0 } })
    for (const userId of new Set([this.botUserId, ownerId, ...userIds])) {
      if (await this.prisma.user.findUnique({ where: { id: userId } })) await this.prisma.guildMember.create({ data: { guildId: id, userId } })
    }
    if (general) await this.prisma.channel.create({ data: { id: generateSnowflake(), guildId: id, type: 0, name: 'general' } })
    if (!this.guildIds.includes(id)) this.guildIds.push(id)
    return id
  }

  // A user creates a channel or category in the Discord UI: CHANNEL_CREATE.
  async simulateChannelCreate({ id = generateSnowflake(), guildId, name, type = 0, topic = null, parentId = null, position }: { id?: string; guildId: string; name: string; type?: number; topic?: string | null; parentId?: string | null; position?: number }): Promise<APIChannel> {
    const siblings = await this.prisma.channel.count({ where: { guildId, parentId } })
    const channel = await this.prisma.channel.create({ data: { id, guildId, type, name, topic, parentId, position: position ?? siblings } })
    const api = channelToAPI(channel)
    this.server?.gateway.broadcast(GatewayDispatchEvents.ChannelCreate, api)
    return api
  }

  // A user edits a channel (name, topic, category, position): CHANNEL_UPDATE or THREAD_UPDATE.
  async simulateChannelUpdate({ channelId, name, topic, parentId, position }: { channelId: string; name?: string; topic?: string | null; parentId?: string | null; position?: number }): Promise<APIChannel> {
    const before = await this.prisma.channel.findUniqueOrThrow({ where: { id: channelId } })
    const channel = await this.prisma.channel.update({
      where: { id: channelId },
      data: { ...(name !== undefined && { name }), ...(topic !== undefined && { topic }), ...(parentId !== undefined && { parentId }), ...(position !== undefined && { position }) },
    })
    const api = channelToAPI(channel)
    this.server?.gateway.broadcast(isThreadType(before.type) ? GatewayDispatchEvents.ThreadUpdate : GatewayDispatchEvents.ChannelUpdate, api)
    return api
  }

  // A user deletes a channel, like Discord: its threads and messages go with
  // it; channels in a deleted category stay, without a category.
  async simulateChannelDelete({ channelId }: { channelId: string }): Promise<void> {
    const channel = await this.prisma.channel.findUniqueOrThrow({ where: { id: channelId } })
    const gateway = this.server?.gateway
    const children = await this.prisma.channel.findMany({ where: { parentId: channelId } })
    for (const child of children) {
      if (isThreadType(child.type)) {
        await this.prisma.channel.delete({ where: { id: child.id } })
        gateway?.broadcast(GatewayDispatchEvents.ThreadDelete, { id: child.id, guild_id: child.guildId, parent_id: child.parentId, type: child.type })
      } else {
        const moved = await this.prisma.channel.update({ where: { id: child.id }, data: { parentId: null } })
        gateway?.broadcast(GatewayDispatchEvents.ChannelUpdate, channelToAPI(moved))
      }
    }
    await this.prisma.channel.delete({ where: { id: channelId } })
    if (isThreadType(channel.type)) gateway?.broadcast(GatewayDispatchEvents.ThreadDelete, { id: channel.id, guild_id: channel.guildId, parent_id: channel.parentId, type: channel.type })
    else gateway?.broadcast(GatewayDispatchEvents.ChannelDelete, channelToAPI(channel))
  }

  // --- Mirroring: entities that live on real Discord, copied in with their own ids.
  // Channel changes reach bots like any other; messages only reach observers
  // (a hub's devices and index), never bots, so a bot that also sees the real
  // Discord does not act on a message twice.

  async mirrorUser({ id, username, globalName = null, avatar = null, bot = false }: { id: string; username: string; globalName?: string | null; avatar?: string | null; bot?: boolean }): Promise<void> {
    await this.prisma.user.upsert({ where: { id }, create: { id, username, globalName, avatar, bot }, update: { username, globalName, avatar } })
  }

  async mirrorMember({ guildId, userId }: { guildId: string; userId: string }): Promise<void> {
    if (await this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId } } })) return
    await this.prisma.guildMember.create({ data: { guildId, userId } })
  }

  async mirrorChannel(channel: { id: string; guildId: string; type: number; name?: string | null; topic?: string | null; parentId?: string | null; position?: number; ownerId?: string | null; archived?: boolean; locked?: boolean; autoArchiveDuration?: number; lastMessageId?: string | null }): Promise<APIChannel> {
    const existing = await this.prisma.channel.findUnique({ where: { id: channel.id } })
    const thread = isThreadType(channel.type)
    const data = {
      guildId: channel.guildId,
      type: channel.type,
      name: channel.name ?? null,
      topic: channel.topic ?? null,
      parentId: channel.parentId ?? null,
      position: channel.position ?? 0,
      ownerId: channel.ownerId ?? null,
      archived: channel.archived ?? false,
      locked: channel.locked ?? false,
      autoArchiveDuration: channel.autoArchiveDuration ?? 1440,
      // On Discord a thread started from a message has that message's id.
      ...(thread && { starterMessageId: channel.id }),
      ...(channel.lastMessageId !== undefined && { lastMessageId: channel.lastMessageId }),
    }
    const row = existing ? await this.prisma.channel.update({ where: { id: channel.id }, data }) : await this.prisma.channel.create({ data: { id: channel.id, ...data } })
    const api = channelToAPI(row)
    const event = thread ? (existing ? GatewayDispatchEvents.ThreadUpdate : GatewayDispatchEvents.ThreadCreate) : existing ? GatewayDispatchEvents.ChannelUpdate : GatewayDispatchEvents.ChannelCreate
    this.server?.gateway.broadcast(event, api)
    return api
  }

  // Many channels in one transaction (an import's thousands of threads): one disk sync, not one each.
  async mirrorChannels(channels: Array<Parameters<DigitalDiscord['mirrorChannel']>[0]>): Promise<APIChannel[]> {
    if (!channels.length) return []
    const existing = new Set((await this.prisma.channel.findMany({ where: { id: { in: channels.map((c) => c.id) } }, select: { id: true } })).map((c) => c.id))
    const rows = await this.prisma.$transaction(
      channels.map((channel) => {
        const thread = isThreadType(channel.type)
        const data = {
          guildId: channel.guildId,
          type: channel.type,
          name: channel.name ?? null,
          topic: channel.topic ?? null,
          parentId: channel.parentId ?? null,
          position: channel.position ?? 0,
          ownerId: channel.ownerId ?? null,
          archived: channel.archived ?? false,
          locked: channel.locked ?? false,
          autoArchiveDuration: channel.autoArchiveDuration ?? 1440,
          ...(thread && { starterMessageId: channel.id }),
          ...(channel.lastMessageId !== undefined && { lastMessageId: channel.lastMessageId }),
        }
        return existing.has(channel.id) ? this.prisma.channel.update({ where: { id: channel.id }, data }) : this.prisma.channel.create({ data: { id: channel.id, ...data } })
      }),
    )
    return rows.map((row) => {
      const api = channelToAPI(row)
      const thread = isThreadType(row.type)
      const event = thread ? (existing.has(row.id) ? GatewayDispatchEvents.ThreadUpdate : GatewayDispatchEvents.ThreadCreate) : existing.has(row.id) ? GatewayDispatchEvents.ChannelUpdate : GatewayDispatchEvents.ChannelCreate
      this.server?.gateway.broadcast(event, api)
      return api
    })
  }

  // Upserts a message under its own id. Returns whether it was new.
  async mirrorMessage(message: { id: string; channelId: string; authorId: string; content: string; timestamp: Date; editedTimestamp?: Date | null; type?: number; flags?: number; embeds?: unknown[]; components?: unknown[]; attachments?: unknown[]; mentions?: unknown[]; mentionEveryone?: boolean; pinned?: boolean; messageReference?: unknown | null; passthrough?: Record<string, unknown> | null }, { quiet = false, extra = {} }: { quiet?: boolean; extra?: Record<string, unknown> } = {}): Promise<boolean> {
    const existing = await this.prisma.message.findUnique({ where: { id: message.id } })
    const data = {
      channelId: message.channelId,
      authorId: message.authorId,
      content: message.content,
      timestamp: message.timestamp,
      editedTimestamp: message.editedTimestamp ?? null,
      type: message.type ?? 0,
      flags: message.flags ?? 0,
      embeds: JSON.stringify(message.embeds ?? []),
      components: JSON.stringify(message.components ?? []),
      attachments: JSON.stringify(message.attachments ?? []),
      mentions: JSON.stringify(message.mentions ?? []),
      mentionEveryone: message.mentionEveryone ?? false,
      pinned: message.pinned ?? false,
      messageReference: message.messageReference ? JSON.stringify(message.messageReference) : null,
      extra: message.passthrough && Object.keys(message.passthrough).length ? JSON.stringify(message.passthrough) : null,
    }
    const row = existing ? await this.prisma.message.update({ where: { id: message.id }, data }) : await this.prisma.message.create({ data: { id: message.id, ...data } })
    if (!existing) {
      const channel = await this.prisma.channel.findUnique({ where: { id: message.channelId } })
      const newer = !channel?.lastMessageId || BigInt(message.id) > BigInt(channel.lastMessageId)
      await this.prisma.channel.update({ where: { id: message.channelId }, data: { messageCount: { increment: 1 }, totalMessageSent: { increment: 1 }, ...(newer && { lastMessageId: message.id }) } })
    }
    if (!quiet) {
      const channel = await this.prisma.channel.findUnique({ where: { id: row.channelId } })
      const author = await this.prisma.user.findUniqueOrThrow({ where: { id: row.authorId } })
      const guildId = channel?.guildId ?? undefined
      this.server?.gateway.notifyObservers(existing ? GatewayDispatchEvents.MessageUpdate : GatewayDispatchEvents.MessageCreate, { ...messageToAPI(row, author, guildId), guild_id: guildId, ...extra })
    }
    return !existing
  }

  async mirrorMessageDelete(messageId: string): Promise<void> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, include: { channel: true } })
    if (!message) return
    await this.prisma.message.delete({ where: { id: messageId } })
    this.server?.gateway.notifyObservers(GatewayDispatchEvents.MessageDelete, { id: messageId, channel_id: message.channelId, guild_id: message.channel.guildId ?? undefined })
  }

  // A person joins Discord (a human account, not a bot).
  async createUser({ id = generateSnowflake(), username, globalName = null }: { id?: string; username: string; globalName?: string | null }): Promise<string> {
    await this.prisma.user.create({ data: { id, username, globalName, bot: false } })
    return id
  }

  // A person joins or leaves a guild: GUILD_MEMBER_ADD / GUILD_MEMBER_REMOVE.
  async addGuildMember({ guildId, userId }: { guildId: string; userId: string }): Promise<void> {
    if (await this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId } } })) return
    const member = await this.prisma.guildMember.create({ data: { guildId, userId }, include: { user: true } })
    this.server?.gateway.broadcast(GatewayDispatchEvents.GuildMemberAdd, { ...memberToAPI(member), guild_id: guildId })
  }

  async removeGuildMember({ guildId, userId }: { guildId: string; userId: string }): Promise<void> {
    const member = await this.prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId } }, include: { user: true } })
    if (!member) return
    await this.prisma.guildMember.delete({ where: { guildId_userId: { guildId, userId } } })
    this.server?.gateway.broadcast(GatewayDispatchEvents.GuildMemberRemove, { guild_id: guildId, user: userToAPI(member.user) })
  }

  // Roles, like Server Settings > Roles: GUILD_ROLE_CREATE / UPDATE / DELETE.
  async createRole({ guildId, name, color = 0, permissions = '0', hoist = false, mentionable = false, position }: { guildId: string; name: string; color?: number; permissions?: string; hoist?: boolean; mentionable?: boolean; position?: number }): Promise<APIRole> {
    const top = await this.prisma.role.aggregate({ where: { guildId }, _max: { position: true } })
    const role = await this.prisma.role.create({ data: { id: generateSnowflake(), guildId, name, color, permissions, hoist, mentionable, position: position ?? (top._max.position ?? 0) + 1 } })
    const api = roleToAPI(role)
    this.server?.gateway.broadcast(GatewayDispatchEvents.GuildRoleCreate, { guild_id: guildId, role: api })
    return api
  }

  async updateRole({ guildId, roleId, ...update }: { guildId: string; roleId: string; name?: string; color?: number; permissions?: string; hoist?: boolean; mentionable?: boolean; position?: number }): Promise<APIRole> {
    const data = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))
    const role = await this.prisma.role.update({ where: { id: roleId, guildId }, data })
    const api = roleToAPI(role)
    this.server?.gateway.broadcast(GatewayDispatchEvents.GuildRoleUpdate, { guild_id: guildId, role: api })
    return api
  }

  // Also takes the role off every member that had it.
  async deleteRole({ guildId, roleId }: { guildId: string; roleId: string }): Promise<void> {
    await this.prisma.role.delete({ where: { id: roleId, guildId } })
    for (const member of await this.prisma.guildMember.findMany({ where: { guildId } })) {
      const roles = JSON.parse(member.roles) as string[]
      if (roles.includes(roleId)) await this.setMemberRoles({ guildId, userId: member.userId, roles: roles.filter((r) => r !== roleId) })
    }
    this.server?.gateway.broadcast(GatewayDispatchEvents.GuildRoleDelete, { guild_id: guildId, role_id: roleId })
  }

  async setMemberRoles({ guildId, userId, roles }: { guildId: string; userId: string; roles: string[] }): Promise<void> {
    const member = await this.prisma.guildMember.update({ where: { guildId_userId: { guildId, userId } }, data: { roles: JSON.stringify([...new Set(roles)]) }, include: { user: true } })
    this.server?.gateway.broadcast(GatewayDispatchEvents.GuildMemberUpdate, { ...memberToAPI(member), guild_id: guildId })
  }

  // A user changes their profile (display name, avatar hash): GUILD_MEMBER_UPDATE in each guild.
  async simulateUserUpdate({ userId, globalName, avatar }: { userId: string; globalName?: string | null; avatar?: string | null }): Promise<void> {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { ...(globalName !== undefined && { globalName }), ...(avatar !== undefined && { avatar }) } })
    const members = await this.prisma.guildMember.findMany({ where: { userId } })
    for (const member of members) this.server?.gateway.broadcast(GatewayDispatchEvents.GuildMemberUpdate, { ...memberToAPI({ ...member, user }), guild_id: member.guildId })
  }

  // Renames a guild or changes its icon: GUILD_UPDATE to its members.
  async updateGuild({ id, name, icon }: { id: string; name?: string; icon?: string | null }): Promise<void> {
    const guild = await this.prisma.guild.update({ where: { id }, data: { ...(name !== undefined && { name }), ...(icon !== undefined && { icon }) }, include: { roles: true } })
    this.server?.gateway.broadcast(GatewayDispatchEvents.GuildUpdate, { ...guildToAPI(guild), guild_id: id })
  }

  // gatewayProxy mode: the proxy forgets the client, like a restart whose
  // database sync failed. REST answers 401 until authorizeGatewayClient() again.
  // Ends a client's live sessions; it identifies again (a new READY).
  reidentifyGatewayClient({ token }: { token: string }): void {
    this.server?.gateway.reidentifyToken(token)
  }

  revokeGatewayClient({ token }: { token: string }): void {
    this.gatewayClients.delete(token)
    this.gatewayClientUsers.delete(token)
    this.server?.gateway.disconnectToken(token)
  }

  // Serves the same REST, gateway and extension routes on another server, for
  // example an HTTPS listener on a private address next to the loopback one.
  attachServer(server: { on(event: 'request', listener: (req: http.IncomingMessage, res: http.ServerResponse) => void): unknown; on(event: 'upgrade', listener: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void): unknown }): void {
    if (!this.server) throw new Error('Server not started')
    const target = this.server.httpServer
    server.on('request', (req, res) => target.emit('request', req, res))
    server.on('upgrade', (req, socket, head) => target.emit('upgrade', req, socket, head))
  }

  // Client tokens that hold an identified gateway session (gateway-proxy mode).
  connectedGatewayTokens(): Set<string> {
    return this.server?.gateway.connectedTokens() ?? new Set()
  }

  // Each connected client token's activity text (a bot's custom status), with when it was set.
  gatewayActivities(): Map<string, { text: string | null; at: number }> {
    return this.server?.gateway.connectedActivities() ?? new Map()
  }

  // Called whenever a gateway client identifies or disconnects (presence).
  observeGatewayConnections(observer: () => void): () => void {
    if (!this.server) throw new Error('Server not started')
    return this.server.gateway.observeConnections(observer)
  }

  // Every dispatch the twin sends to bots, plus observer-only events like the
  // bot's TYPING_START. Returns an unsubscribe function.
  observeDispatches(observer: GatewayObserver): () => void {
    if (!this.server) throw new Error('Server not started')
    return this.server.gateway.observe(observer)
  }

  // A committed hub-local deletion: devices and the search index get the usual event,
  // without putting it on a bot gateway (including an offline bridge's replay queue).
  notifyLocalMessageDeletes(channelId: string, guildId: string | null, ids: readonly string[]): void {
    for (const id of ids) this.server?.gateway.notifyObservers(GatewayDispatchEvents.MessageDelete, { id, channel_id: channelId, guild_id: guildId ?? '' })
  }

  // A user adds (or removes) a unicode emoji reaction in the Discord UI.
  async simulateUserReaction({ channelId, messageId, userId, emoji, remove = false }: { channelId: string; messageId: string; userId: string; emoji: string; remove?: boolean }): Promise<void> {
    if (!this.server) throw new Error('Server not started')
    const channel = await this.prisma.channel.findUniqueOrThrow({ where: { id: channelId } })
    if (remove) {
      await this.prisma.reaction.deleteMany({ where: { messageId, userId, emoji } })
    } else {
      await this.prisma.reaction.upsert({
        where: { messageId_userId_emoji: { messageId, userId, emoji } },
        create: { messageId, userId, emoji },
        update: {},
      })
    }
    this.server.gateway.broadcast(remove ? GatewayDispatchEvents.MessageReactionRemove : GatewayDispatchEvents.MessageReactionAdd, {
      user_id: userId,
      channel_id: channelId,
      message_id: messageId,
      guild_id: channel.guildId ?? undefined,
      emoji: { id: null, name: emoji },
    })
  }

  // A user pins or unpins a message in the Discord UI.
  async simulateUserPin({ channelId, messageId, userId, pinned }: { channelId: string; messageId: string; userId: string; pinned: boolean }): Promise<void> {
    if (!this.server) throw new Error('Server not started')
    await pinMessage({ prisma: this.prisma, gateway: this.server.gateway, channelId, messageId, userId, pinned })
  }

  // A user archives or unarchives a thread in the Discord UI.
  async simulateThreadArchive({ channelId, archived }: { channelId: string; archived: boolean }): Promise<APIChannel> {
    if (!this.server) throw new Error('Server not started')
    const updated = await this.prisma.channel.update({
      where: { id: channelId },
      data: { archived, archiveTimestamp: new Date() },
    })
    const apiChannel = channelToAPI(updated)
    this.server.gateway.broadcast(GatewayDispatchEvents.ThreadUpdate, apiChannel)
    return apiChannel
  }

  // --- Scoped accessors ---

  channel(channelId: string): ChannelScope {
    return new ChannelScope({ discord: this, channelId })
  }

  thread(threadId: string): ChannelScope {
    return new ChannelScope({ discord: this, channelId: threadId })
  }

  // --- State queries ---

  async getFirstNonBotUserId(): Promise<string | null> {
    const firstUser = await this.prisma.user.findFirst({
      where: { bot: false },
      orderBy: { id: 'asc' },
    })
    if (!firstUser) {
      return null
    }
    return firstUser.id
  }

  // Non-thread channels of a guild in Discord's order: position, then ID.
  async getGuildChannels({ guildId = this.guildId }: { guildId?: string } = {}): Promise<APIChannel[]> {
    const channels = await this.prisma.channel.findMany({
      where: {
        guildId,
        type: { notIn: [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread] },
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })
    return channels.map(channelToAPI)
  }

  getTypingEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): DigitalDiscordTypingEvent[] {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const allEvents = this.server.typingEvents
    if (!channelId) {
      return [...allEvents]
    }
    return allEvents.filter((event) => {
      return event.channelId === channelId
    })
  }

  clearTypingEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): void {
    if (!this.server) {
      throw new Error('Server not started')
    }
    if (!channelId) {
      this.server.typingEvents.splice(0, this.server.typingEvents.length)
      return
    }
    const filtered = this.server.typingEvents.filter((event) => {
      return event.channelId !== channelId
    })
    this.server.typingEvents.splice(0, this.server.typingEvents.length, ...filtered)
  }

  getInteractionEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): DigitalDiscordInteractionEvent[] {
    if (!channelId) {
      return [...this.interactionEvents]
    }
    return this.interactionEvents.filter((event) => {
      return event.channelId === channelId
    })
  }

  clearInteractionEvents({
    channelId,
  }: {
    channelId?: string
  } = {}): void {
    if (!channelId) {
      this.interactionEvents.splice(0, this.interactionEvents.length)
      return
    }
    const filtered = this.interactionEvents.filter((event) => {
      return event.channelId !== channelId
    })
    this.interactionEvents.splice(0, this.interactionEvents.length, ...filtered)
  }

  // --- Test utilities ---

  async simulateUserMessage({
    id,
    channelId,
    userId,
    content,
    embeds,
    attachments,
    messageReference,
    type = MessageType.Default,
    flags = 0,
  }: {
    // A forum post's opening message has its thread's id, as on Discord.
    id?: string
    channelId: string
    userId: string
    content: string
    embeds?: APIEmbed[]
    attachments?: APIAttachment[]
    messageReference?: APIMessageReference
    type?: MessageType
    // e.g. MessageFlags.IsVoiceMessage
    flags?: number
  }): Promise<APIMessage> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const messageId = id ?? generateSnowflake()
    await this.prisma.message.create({
      data: {
        id: messageId,
        channelId,
        authorId: userId,
        type,
        flags,
        content,
        embeds: JSON.stringify(embeds ?? []),
        attachments: JSON.stringify(attachments ?? []),
        messageReference: messageReference
          ? JSON.stringify(messageReference)
          : null,
      },
    })
    await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        lastMessageId: messageId,
        messageCount: { increment: 1 },
        totalMessageSent: { increment: 1 },
      },
    })
    const dbMessage = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
    })
    const author = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    })
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })
    const guildId = channel?.guildId ?? undefined
    const member = guildId
      ? await this.prisma.guildMember.findUnique({
          where: { guildId_userId: { guildId, userId } },
          include: { user: true },
        })
      : null
    const apiMessage = messageToAPI(
      dbMessage,
      author,
      guildId,
      member ?? undefined,
    )
    this.server.gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
    return apiMessage
  }

  // A user renames a thread in the Discord UI: THREAD_UPDATE, then a
  // CHANNEL_NAME_CHANGE system message whose content is the new name.
  async simulateThreadRename({
    channelId,
    userId,
    name,
  }: {
    channelId: string
    userId: string
    name: string
  }): Promise<APIMessage> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const updated = await this.prisma.channel.update({
      where: { id: channelId },
      data: { name },
    })
    this.server.gateway.broadcast(GatewayDispatchEvents.ThreadUpdate, channelToAPI(updated))
    return this.simulateUserMessage({
      channelId,
      userId,
      content: name,
      type: MessageType.ChannelNameChange,
    })
  }

  // A direct message channel (type 1, no guild) with these people or bots.
  // CHANNEL_CREATE goes only where the directAudience option allows.
  // extra: fields the caller adds to the event (e.g. a hub's own annotations).
  async createDirectChannel({ id, recipientIds, extra = {} }: { id: string; recipientIds: string[]; extra?: Record<string, unknown> }) {
    if (!this.server) throw new Error('Server not started')
    const channel = (await this.prisma.channel.findUnique({ where: { id } })) ?? (await this.prisma.channel.create({ data: { id, type: 1 } }))
    const users = await this.prisma.user.findMany({ where: { id: { in: recipientIds } } })
    this.server.gateway.broadcast(GatewayDispatchEvents.ChannelCreate, { ...channelToAPI(channel), recipients: users.map((u) => userToAPI(u)), ...extra })
    return channel
  }

  async simulateUserMessageEdit({
    messageId,
    channelId,
    content,
  }: {
    messageId: string
    channelId: string
    content: string
  }): Promise<APIMessage> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
    })
    if (!existing) {
      throw new Error(`Message ${messageId} not found`)
    }
    if (existing.channelId !== channelId) {
      throw new Error(`Message ${messageId} is not in channel ${channelId}`)
    }
    await this.prisma.message.update({
      where: { id: messageId },
      data: { content, editedTimestamp: new Date() },
    })
    const dbMessage = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
    })
    const author = await this.prisma.user.findUniqueOrThrow({
      where: { id: dbMessage.authorId },
    })
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })
    const guildId = channel?.guildId ?? undefined
    const member = guildId
      ? await this.prisma.guildMember.findUnique({
          where: { guildId_userId: { guildId, userId: dbMessage.authorId } },
          include: { user: true },
        })
      : null
    const apiMessage = messageToAPI(
      dbMessage,
      author,
      guildId,
      member ?? undefined,
    )
    this.server.gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
      ...apiMessage,
      guild_id: guildId ?? '',
    })
    return apiMessage
  }

  async simulateUserMessageDelete({
    messageId,
    channelId,
  }: {
    messageId: string
    channelId: string
  }): Promise<void> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
    })
    if (!existing) {
      throw new Error(`Message ${messageId} not found`)
    }
    if (existing.channelId !== channelId) {
      throw new Error(`Message ${messageId} is not in channel ${channelId}`)
    }

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })
    const guildId = channel?.guildId ?? undefined

    await this.prisma.message.delete({ where: { id: messageId } })
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { messageCount: { decrement: 1 } },
    })
    this.server.gateway.broadcast(GatewayDispatchEvents.MessageDelete, {
      id: messageId,
      channel_id: channelId,
      guild_id: guildId ?? '',
    })
  }

  async simulateInteraction({
    type,
    channelId,
    userId,
    data,
    guildId,
    messageId,
  }: {
    type: InteractionType
    channelId: string
    userId: string
    data?: Record<string, unknown>
    guildId?: string
    messageId?: string
  }): Promise<{ id: string; token: string }> {
    if (!this.server) {
      throw new Error('Server not started')
    }
    const interactionId = generateSnowflake()
    // Random and short-lived like Discord's: it is the only credential the
    // interaction's webhook and callback routes accept.
    const interactionToken = `itk.${crypto.randomBytes(32).toString('base64url')}`
    const channelRow = await this.prisma.channel.findUnique({ where: { id: channelId } })
    // Never for a channel with no guild (a DM): it would reach every bot of the default guild.
    if (channelRow && !channelRow.guildId) throw new Error('Interactions need a guild channel')
    const resolvedGuildId = guildId ?? channelRow?.guildId ?? this.guildId

    // Pre-create the InteractionResponse row so the callback endpoint can find it
    await this.prisma.interactionResponse.create({
      data: {
        interactionId,
        interactionToken,
        applicationId: this.botUserId,
        channelId,
        type: 0, // placeholder, updated when callback is received
        messageId: messageId ?? null,
        acknowledged: false,
      },
    })

    // Build the INTERACTION_CREATE gateway payload
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    })
    const member = await this.prisma.guildMember.findUnique({
      where: { guildId_userId: { guildId: resolvedGuildId, userId } },
      include: { user: true },
    })
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    })

    let messageData = messageId ? this.privateReplies?.forUser(userId, channelId, messageId) : undefined
    if (messageId && !messageData) {
      const msg = await this.prisma.message.findUniqueOrThrow({
        where: { id: messageId },
      })
      const msgAuthor = await this.prisma.user.findUniqueOrThrow({
        where: { id: msg.authorId },
      })
      const msgMember = resolvedGuildId
        ? await this.prisma.guildMember.findUnique({
            where: {
              guildId_userId: {
                guildId: resolvedGuildId,
                userId: msg.authorId,
              },
            },
            include: { user: true },
          })
        : null
      messageData = messageToAPI(
        msg,
        msgAuthor,
        resolvedGuildId,
        msgMember ?? undefined,
      )
    }

    const componentType = (() => {
      if (type !== InteractionType.MessageComponent || !data) {
        return undefined
      }
      const raw = data['component_type']
      if (typeof raw !== 'number') {
        return undefined
      }
      return raw as ComponentType
    })()
    const values = (() => {
      if (!data) {
        return undefined
      }
      const raw = data['values']
      if (!Array.isArray(raw)) {
        return undefined
      }
      return raw.filter((item): item is string => {
        return typeof item === 'string'
      })
    })()
    this.interactionEvents.push({
      timestamp: Date.now(),
      channelId,
      interactionType: type,
      componentType,
      values,
    })
    if (this.interactionEvents.length > 5_000) {
      this.interactionEvents.splice(0, this.interactionEvents.length - 5_000)
    }

    // APIInteraction is a discriminated union keyed by `type` -- the concrete
    // variant is only known at runtime, so `as APIInteraction` is justified
    const interactionPayload = {
      id: interactionId,
      application_id: this.botUserId,
      type,
      data: data ?? {},
      guild_id: resolvedGuildId,
      channel_id: channelId,
      channel: channel ? channelToAPI(channel) : undefined,
      message: messageData,
      member: member
        ? {
            user: userToAPI(member.user),
            nick: member.nick ?? undefined,
            roles: JSON.parse(member.roles) as string[],
            joined_at: isoTimestamp(member.joinedAt),
            deaf: member.deaf,
            mute: member.mute,
            flags: 0,
            permissions: this.options.memberPermissions ? await this.options.memberPermissions(userId, channelId) : (member.permissions ?? '1099511627775'),
          }
        : undefined,
      token: interactionToken,
      version: 1,
      app_permissions: this.options.memberPermissions ? await this.options.memberPermissions(this.botUserId, channelId) : '1099511627775',
      locale: 'en-US',
      guild_locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: {},
      context: 0,
      attachment_size_limit: 26214400,
    } as unknown as APIInteraction

    // Kept for 15 minutes, as long as the token: its responses carry who triggered it.
    const commandName = type === InteractionType.ApplicationCommand && typeof data?.['name'] === 'string' ? data['name'] : undefined
    this.server.interactions.set(interactionId, { id: interactionId, type, user: userToAPI(user), ...(commandName && { name: commandName }), ...(messageId && { interacted_message_id: messageId }) })
    setTimeout(() => this.server?.interactions.delete(interactionId), 15 * 60_000).unref?.()

    this.server.gateway.broadcast(
      GatewayDispatchEvents.InteractionCreate,
      interactionPayload,
    )

    return { id: interactionId, token: interactionToken }
  }

  get privateReplies() { return this.server?.privateReplies }

  async simulateSlashCommand({
    channelId,
    userId,
    name,
    commandId,
    options,
    guildId,
  }: {
    channelId: string
    userId: string
    name: string
    commandId?: string
    options?: DigitalDiscordCommandOption[]
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    // Resolve the registered command ID by name so guild.commands.fetch()
    // works when the bot looks up the command description at runtime.
    // Prefer guild-scoped command over global to avoid returning a global ID
    // that would 404 on the guild commands GET endpoint.
    const resolvedCommandId = await (async () => {
      if (commandId) {
        return commandId
      }
      const resolvedGuildId = guildId ?? this.guildId
      const guildCmd = await this.prisma.applicationCommand.findFirst({
        where: {
          applicationId: this.botUserId,
          name,
          guildId: resolvedGuildId,
        },
      })
      if (guildCmd) {
        return guildCmd.id
      }
      const globalCmd = await this.prisma.applicationCommand.findFirst({
        where: {
          applicationId: this.botUserId,
          name,
          guildId: null,
        },
      })
      return globalCmd?.id ?? generateSnowflake()
    })()

    return this.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId,
      guildId,
      data: {
        id: resolvedCommandId,
        name,
        type: 1,
        ...(options && options.length > 0 ? { options } : {}),
      },
    })
  }

  // Slash commands the bot registered, ordered by name. Guild commands by
  // default; pass guildId: null for global commands.
  async getRegisteredCommands({
    guildId = this.guildId,
  }: { guildId?: string | null } = {}): Promise<
    Array<{ id: string; name: string; description: string; options: unknown[]; default_member_permissions: string | null }>
  > {
    const commands = await this.prisma.applicationCommand.findMany({
      where: { applicationId: this.botUserId, guildId },
      orderBy: { name: 'asc' },
    })
    return commands.map((command) => {
      return {
        id: command.id,
        name: command.name,
        description: command.description,
        options: JSON.parse(command.options) as unknown[],
        default_member_permissions: command.defaultMemberPermissions,
      }
    })
  }

  // Autocomplete for one option of a slash command: `focused` names the
  // option being typed. Resolves with the choices the bot responded with.
  async simulateAutocomplete({
    channelId,
    userId,
    name,
    options,
    focused,
    guildId,
    timeout = 10_000,
  }: {
    channelId: string
    userId: string
    name: string
    options: DigitalDiscordCommandOption[]
    focused: string
    guildId?: string
    timeout?: number
  }): Promise<Array<{ name: string; value: string | number }>> {
    const resolvedGuildId = guildId ?? this.guildId
    const command = await this.prisma.applicationCommand.findFirst({
      where: { applicationId: this.botUserId, name, guildId: resolvedGuildId },
    })
    const { id } = await this.simulateInteraction({
      type: InteractionType.ApplicationCommandAutocomplete,
      channelId,
      userId,
      guildId,
      data: {
        id: command?.id ?? generateSnowflake(),
        name,
        type: 1,
        options: options.map((option) => {
          return option.name === focused ? { ...option, focused: true } : option
        }),
      },
    })
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const response = await this.prisma.interactionResponse.findUnique({
        where: { interactionId: id },
      })
      if (response?.acknowledged) {
        const data = response.data
          ? (JSON.parse(response.data) as { choices?: Array<{ name: string; value: string | number }> })
          : {}
        return data.choices ?? []
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(`Timed out waiting for autocomplete response of /${name}`)
  }

  async simulateButtonClick({
    channelId,
    userId,
    messageId,
    customId,
    guildId,
  }: {
    channelId: string
    userId: string
    messageId: string
    customId: string
    guildId?: string
  }): Promise<{ id: string; token: string }> {
    return this.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId,
      guildId,
      messageId,
      data: {
        custom_id: customId,
        component_type: ComponentType.Button,
      },
    })
  }

  async simulateSelectMenu({
    channelId,
    userId,
    messageId,
    customId,
    values,
    guildId,
    componentType = ComponentType.StringSelect,
  }: {
    channelId: string
    userId: string
    messageId: string
    customId: string
    values: string[]
    guildId?: string
    // User, role, mentionable and channel selects carry `resolved` objects for
    // the picked ids, like Discord.
    componentType?: ComponentType
  }): Promise<{ id: string; token: string }> {
    const resolved = componentType === ComponentType.StringSelect ? undefined : await this.resolveSelectValues(componentType, values, guildId ?? (await this.prisma.channel.findUnique({ where: { id: channelId } }))?.guildId ?? this.guildId)
    return this.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId,
      guildId,
      messageId,
      data: {
        custom_id: customId,
        component_type: componentType,
        values,
        ...(resolved && { resolved }),
      },
    })
  }

  private async resolveSelectValues(componentType: ComponentType, values: string[], guildId: string | null) {
    const wantUsers = componentType === ComponentType.UserSelect || componentType === ComponentType.MentionableSelect
    const wantRoles = componentType === ComponentType.RoleSelect || componentType === ComponentType.MentionableSelect
    const users = wantUsers ? await this.prisma.user.findMany({ where: { id: { in: values } } }) : []
    const members = wantUsers && guildId ? await this.prisma.guildMember.findMany({ where: { guildId, userId: { in: values } }, include: { user: true } }) : []
    const roles = wantRoles && guildId ? await this.prisma.role.findMany({ where: { guildId, id: { in: values } } }) : []
    const channels = componentType === ComponentType.ChannelSelect ? await this.prisma.channel.findMany({ where: { id: { in: values } } }) : []
    return {
      ...(users.length && { users: Object.fromEntries(users.map((u) => [u.id, userToAPI(u)])) }),
      ...(members.length && { members: Object.fromEntries(members.map((m) => { const { user: _, ...rest } = memberToAPI(m); return [m.userId, rest] })) }),
      ...(roles.length && { roles: Object.fromEntries(roles.map((r) => [r.id, roleToAPI(r)])) }),
      ...(channels.length && { channels: Object.fromEntries(channels.map((c) => { const api = channelToAPI(c) as unknown as Record<string, unknown>; return [c.id, { id: api['id'], name: api['name'], type: api['type'], parent_id: api['parent_id'], ...(api['thread_metadata'] ? { thread_metadata: api['thread_metadata'] } : {}), permissions: '0' }] })) }),
    }
  }

  async simulateModalSubmit({
    channelId,
    userId,
    customId,
    fields,
    guildId,
    messageId,
    files = [],
  }: {
    channelId: string
    userId: string
    customId: string
    fields: DigitalDiscordModalField[]
    guildId?: string
    // Set when the modal was opened from a message component: Discord then
    // includes that message, so the bot can update it.
    messageId?: string
    files?: Array<{ customId: string; attachments: APIAttachment[] }>
  }): Promise<{ id: string; token: string }> {
    const components: unknown[] = fields.map((field) => {
      return {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: field.customId,
            value: field.value,
          },
        ],
      }
    })
    components.push(...files.map((field) => ({ type: ComponentType.Label, component: {
      type: ComponentType.FileUpload, custom_id: field.customId, values: field.attachments.map((attachment) => attachment.id),
    } })))

    return this.simulateInteraction({
      type: InteractionType.ModalSubmit,
      channelId,
      userId,
      guildId,
      messageId,
      data: {
        custom_id: customId,
        components,
        resolved: { attachments: Object.fromEntries(files.flatMap((field) => field.attachments.map((attachment) => [attachment.id, attachment]))) },
      },
    })
  }



  // --- Internal ---

  private async applySchema(): Promise<void> {
    // Read the generated schema.sql (created by `pnpm generate:sql` from
    // schema.prisma via prisma db push + sqlite3 .schema). This avoids
    // hand-writing CREATE TABLE statements that can drift from the prisma schema.
    // src/ is always shipped in the package, so ../src/schema.sql works from
    // both src/ (dev with tsx) and dist/ (built with tsc).
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    // A bundler that inlines this file (e.g. the hub's single-file build)
    // copies schema.sql next to its output instead.
    const schemaPath = [path.resolve(__dirname, '../src/schema.sql'), path.resolve(__dirname, 'schema.sql')].find((file) => fs.existsSync(file)) ?? path.resolve(__dirname, '../src/schema.sql')

    const sql = fs.readFileSync(schemaPath, 'utf-8')

    // Same parsing approach as kimaki/src/migrations.ts schemaStatements():
    // 1. Split on semicolons into statements
    // 2. Strip per-line SQL comments within each statement
    // 3. Filter out empty and sqlite_sequence statements
    // 4. Make CREATE INDEX idempotent with IF NOT EXISTS
    const statements = sql
      .split(';')
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter(
        (s) =>
          s.length > 0 &&
          !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s),
      )
      .map((s) =>
        s
          .replace(
            /^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i,
            'CREATE UNIQUE INDEX IF NOT EXISTS',
          )
          .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'),
      )

    for (const statement of statements) {
      await this.prisma.$executeRawUnsafe(statement)
    }
    // Columns added after a database was created (CREATE TABLE IF NOT EXISTS leaves old tables as they are).
    const added: Array<[table: string, column: string, type: string]> = [['Message', 'interactionMetadata', 'TEXT'], ['Message', 'extra', 'TEXT']]
    for (const [table, column, type] of added) {
      const columns = await this.prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`)
      if (!columns.some((c) => c.name === column)) await this.prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`)
    }
  }

  private async seed(): Promise<void> {
    const opts = this.options

    // Create bot user
    await this.prisma.user.create({
      data: {
        id: this.botUserId,
        username: opts.botUser?.username ?? 'TestBot',
        bot: true,
        globalName: opts.botUser?.username ?? 'TestBot',
      },
    })

    // Create additional users first (needed for guild membership)
    const userIds: string[] = []
    for (const userOpts of opts.users ?? []) {
      const userId = userOpts.id ?? generateSnowflake()
      userIds.push(userId)
      await this.prisma.user.create({
        data: {
          id: userId,
          username: userOpts.username,
          bot: userOpts.bot ?? false,
          globalName: userOpts.username,
        },
      })
    }

    // Build the list of guilds to seed
    const guildConfigs: Array<{ id: string; config: DigitalDiscordGuildOption }> = (() => {
      if (opts.guilds && opts.guilds.length > 0) {
        return this.guildIds.map((id, i) => ({ id, config: opts.guilds![i] ?? {} }))
      }
      return [{ id: this.guildId, config: opts.guild ?? {} }]
    })()

    for (const { id: guildId, config: guildConfig } of guildConfigs) {
      const ownerId = guildConfig.ownerId ?? generateSnowflake()
      await this.prisma.guild.create({
        data: {
          id: guildId,
          name: guildConfig.name ?? 'Test Server',
          ownerId,
        },
      })

      // Create @everyone role
      await this.prisma.role.create({
        data: {
          id: guildId,
          guildId,
          name: '@everyone',
          permissions: '1071698660929',
          position: 0,
        },
      })

      // Add bot as guild member
      await this.prisma.guildMember.create({
        data: { guildId, userId: this.botUserId },
      })

      // Add all users as members of each guild
      for (const userId of userIds) {
        await this.prisma.guildMember.create({
          data: { guildId, userId },
        })
      }

      // Create channels for this guild (from per-guild channels or top-level channels)
      const channels = guildConfig.channels ?? (guildId === this.guildId ? (opts.channels ?? []) : [])
      for (const chOpts of channels) {
        await this.prisma.channel.create({
          data: {
            id: chOpts.id ?? generateSnowflake(),
            guildId,
            type: chOpts.type,
            name: chOpts.name,
            topic: chOpts.topic,
            parentId: chOpts.parentId,
          },
        })
      }
    }
  }

  private async loadGatewayState(): Promise<GatewayState> {
    const botUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: this.botUserId },
    })

    const guilds = await this.prisma.guild.findMany({
      include: {
        roles: true,
        members: { include: { user: true } },
        channels: true,
      },
    })

    return {
      botUser: userToAPI(botUser),
      guilds: guilds.map((guild) => ({
        id: guild.id,
        apiGuild: guildToAPI(guild),
        joinedAt: isoTimestamp(guild.createdAt),
        members: guild.members.map(memberToAPI),
        channels: guild.channels.map(channelToAPI),
      })),
    }
  }
}

// Scoped accessor returned by discord.channel(id) and discord.thread(id).
// Binds a channelId so every method operates on that target without repeating it.
export class ChannelScope {
  private readonly discord: DigitalDiscord
  readonly channelId: string

  constructor({
    discord,
    channelId,
  }: {
    discord: DigitalDiscord
    channelId: string
  }) {
    this.discord = discord
    this.channelId = channelId
  }

  user(userId: string): ScopedUserActor {
    return new ScopedUserActor({
      discord: this.discord,
      channelId: this.channelId,
      userId,
    })
  }

  bot(): ScopedUserActor {
    return this.user(this.discord.botUserId)
  }

  /**
   * Returns a markdown-like textual representation of all messages in this
   * channel/thread. Useful for inline snapshots in tests so both agents and
   * humans can see what happened in Discord at a glance.
   *
   * Format:
   *   --- from: user (Username)
   *   message content
   *   --- from: assistant (BotName)
   *   reply content
   *   [typing]
   *
   * @param deterministicFooters - When true (default), replaces non-deterministic
   *   values in footer lines (duration like "2m 30s" and context percentage like
   *   "71%") with stable placeholders ("Ns" and "N%") so inline snapshots don't
   *   break across runs. Footer lines are detected by starting with "*" and
   *   containing "⋅".
   * @param showTyping - When true, interleaves [typing] markers at the
   *   chronological position of typing indicator POST calls. Defaults to false
   *   so existing snapshots are not affected.
   * @param showInteractions - When true, interleaves interaction markers like
   *   [user clicks button] and [user selects dropdown: value] at the
   *   chronological position of interaction events. Defaults to false so
   *   existing snapshots are not affected.
   * @param showReplies - When true, a reply starts with a
   *   `[reply to Username: first words]` line naming the message it replies
   *   to. Defaults to false so existing snapshots are not affected.
   */
  async text({ deterministicFooters = true, showTyping = false, showInteractions = false, showReplies = false }: { deterministicFooters?: boolean; showTyping?: boolean; showInteractions?: boolean; showReplies?: boolean } = {}): Promise<string> {
    const messages = await this.getMessages()

    // Build timeline entries: messages + optional typing events
    type TimelineEntry =
      | { kind: 'message'; ts: number; msg: APIMessage }
      | { kind: 'typing'; ts: number }
      | { kind: 'interaction'; ts: number; event: DigitalDiscordInteractionEvent }

    const timeline: TimelineEntry[] = messages.map((msg) => {
      return {
        kind: 'message' as const,
        ts: new Date(msg.timestamp).getTime(),
        msg,
      }
    })

    if (showTyping) {
      const typingEvents = this.discord.getTypingEvents({ channelId: this.channelId })
      for (const evt of typingEvents) {
        timeline.push({ kind: 'typing' as const, ts: evt.timestamp })
      }
    }

    if (showInteractions) {
      const interactionEvents = this.discord.getInteractionEvents({
        channelId: this.channelId,
      })
      for (const event of interactionEvents) {
        timeline.push({
          kind: 'interaction' as const,
          ts: event.timestamp,
          event,
        })
      }
    }

    if (showTyping || showInteractions) {
      timeline.sort((a, b) => {
        return a.ts - b.ts
      })
    }

    const lines: string[] = []
    // Track last author to skip repeated --- from: headers for consecutive
    // messages from the same user, matching how Discord groups messages.
    let lastAuthorId: string | null = null
    for (const entry of timeline) {
      if (entry.kind === 'typing') {
        lines.push('[bot typing]')
        continue
      }
      if (entry.kind === 'interaction') {
        const label = (() => {
          if (
            entry.event.interactionType === InteractionType.MessageComponent &&
            entry.event.componentType === ComponentType.Button
          ) {
            return '[user clicks button]'
          }
          if (
            entry.event.interactionType === InteractionType.MessageComponent &&
            entry.event.componentType === ComponentType.StringSelect
          ) {
            const selectedValues = (entry.event.values || []).join(', ')
            if (!selectedValues) {
              return '[user selects dropdown]'
            }
            return `[user selects dropdown: ${selectedValues}]`
          }
          if (entry.event.interactionType === InteractionType.ModalSubmit) {
            return '[user submits modal]'
          }
          return '[user interaction]'
        })()
        lines.push(label)
        continue
      }
      const msg = entry.msg
      const role = msg.author.bot ? 'assistant' : 'user'
      if (msg.author.id !== lastAuthorId) {
        lines.push(`--- from: ${role} (${msg.author.username})`)
      }
      lastAuthorId = msg.author.id
      if (msg.type === MessageType.ChannelNameChange) {
        lines.push(`[renamed thread to: ${msg.content}]`)
        continue
      }
      const referenceId = msg.message_reference?.message_id
      if (showReplies && referenceId) {
        const target = messages.find((candidate) => candidate.id === referenceId)
        const preview = target ? getMessageVisibleText(target).replace(/\s+/g, ' ').slice(0, 40) : ''
        lines.push(target ? `[reply to ${target.author.username}: ${preview}]` : '[reply to unknown message]')
      }
      const visibleText = getMessageVisibleText(msg)
      if (visibleText) {
        let content = visibleText
        // Footer lines look like: -# *project ⋅ main ⋅ <1s ⋅ 2% ⋅ model-name*
        // Replace duration and percentage with stable placeholders.
        const footerBody = content.startsWith('-# ')
          ? content.slice(3)
          : content.startsWith('> ')
            ? content.slice(2)
            : content
        if (deterministicFooters && footerBody.startsWith('*') && footerBody.includes('⋅') && !footerBody.startsWith('*using ')) {
          content = content
            .replace(/<1s/g, 'Ns')
            .replace(/\b\d+m\s+\d+s\b/g, 'Ns')
            .replace(/\b\d+s\b/g, 'Ns')
            .replace(/\b\d+m\b/g, 'Ns')
            .replace(/\b\d+%/g, 'N%')
        }
        lines.push(content)
      }
      const embeds = msg.embeds ?? []
      for (const embed of embeds) {
        // Escape quotes/newlines in titles so snapshots stay clean
        const safeTitle = embed.title ? JSON.stringify(embed.title).slice(1, -1) : ''
        const label = safeTitle ? `embed: "${safeTitle}"` : 'embed'
        lines.push(`[${label}]`)
      }
      const attachments = msg.attachments ?? []
      for (const attachment of attachments) {
        lines.push(`[attachment: ${attachment.filename}]`)
      }
    }
    return lines.join('\n')
  }

  async getMessages(): Promise<APIMessage[]> {
    const channel = await this.discord.prisma.channel.findUnique({
      where: { id: this.channelId },
    })
    const messages = await this.discord.prisma.message.findMany({
      where: { channelId: this.channelId },
      orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    })
    const result: APIMessage[] = []
    // For threads created from a message, prepend the starter message
    // (it lives in the parent channel, not in the thread's own messages)
    if (channel?.starterMessageId) {
      const starterMsg = await this.discord.prisma.message.findUnique({
        where: { id: channel.starterMessageId },
      })
      if (starterMsg && !messages.some((m) => { return m.id === starterMsg.id })) {
        const starterAuthor = await this.discord.prisma.user.findUniqueOrThrow({
          where: { id: starterMsg.authorId },
        })
        result.push(messageToAPI(starterMsg, starterAuthor, channel.guildId ?? undefined))
      }
    }
    for (const msg of messages) {
      const author = await this.discord.prisma.user.findUniqueOrThrow({
        where: { id: msg.authorId },
      })
      result.push(
        messageToAPI(msg, author, channel?.guildId ?? undefined),
      )
    }
    return result
  }

  getTypingEvents(): DigitalDiscordTypingEvent[] {
    return this.discord.getTypingEvents({ channelId: this.channelId })
  }

  clearTypingEvents(): void {
    this.discord.clearTypingEvents({ channelId: this.channelId })
  }

  async waitForTypingEvent({
    timeout = 10000,
    afterTimestamp = 0,
  }: {
    timeout?: number
    afterTimestamp?: number
  } = {}): Promise<DigitalDiscordTypingEvent> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const event = this.getTypingEvents().find((entry) => {
        return entry.timestamp > afterTimestamp
      })
      if (event) {
        return event
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for typing event in channel ${this.channelId}`,
    )
  }

  async waitForTypingToStop({
    timeout = 12000,
    idleMs = 8500,
    afterTimestamp,
  }: {
    timeout?: number
    idleMs?: number
    afterTimestamp?: number
  } = {}): Promise<void> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    const baselineTimestamp = afterTimestamp ?? start
    while (Date.now() - start < effectiveTimeout) {
      const latestTypingTimestamp = this.getTypingEvents()
        .filter((entry) => {
          return entry.timestamp >= baselineTimestamp
        })
        .map((entry) => {
          return entry.timestamp
        })
        .sort((a, b) => {
          return b - a
        })[0] ?? baselineTimestamp

      if (Date.now() - latestTypingTimestamp >= idleMs) {
        return
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }

    throw new Error(
      `Timed out waiting for typing to stop in channel ${this.channelId}`,
    )
  }

  async getChannel(): Promise<APIChannel | null> {
    const channel = await this.discord.prisma.channel.findUnique({
      where: { id: this.channelId },
    })
    if (!channel) {
      return null
    }
    return channelToAPI(channel)
  }

  async getThreads(): Promise<APIChannel[]> {
    const threads = await this.discord.prisma.channel.findMany({
      where: {
        parentId: this.channelId,
        type: {
          in: [
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread,
          ],
        },
      },
    })
    return threads.map(channelToAPI)
  }

  // User IDs of thread members, in join order.
  async getMemberIds(): Promise<string[]> {
    const members = await this.discord.prisma.threadMember.findMany({
      where: { channelId: this.channelId },
      orderBy: { joinedAt: 'asc' },
    })
    return members.map((member) => member.userId)
  }

  async waitForMessage({
    timeout = 10000,
    predicate,
  }: {
    timeout?: number
    predicate?: DigitalDiscordMessagePredicate
  } = {}): Promise<APIMessage> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const messages = await this.getMessages()
      const matchedMessage = [...messages]
        .reverse()
        .find((message) => {
          if (!predicate) {
            return true
          }
          return predicate(message)
        })
      if (matchedMessage) {
        return matchedMessage
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for message in channel ${this.channelId}`,
    )
  }

  async waitForBotReply({ timeout = 10000 }: { timeout?: number } = {}): Promise<APIMessage> {
    return this.waitForMessage({
      timeout,
      predicate: (message) => {
        return message.author.id === this.discord.botUserId
      },
    })
  }

  async waitForThread({
    timeout = 10000,
    predicate,
  }: {
    timeout?: number
    predicate?: DigitalDiscordThreadPredicate
  } = {}): Promise<APIChannel> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const threads = await this.getThreads()
      const matchedThreads = predicate
        ? threads.filter((thread) => {
            return predicate(thread)
          })
        : threads
      if (matchedThreads.length > 0) {
        const newestThread = [...matchedThreads].sort((a, b) => {
          return compareSnowflakeDesc(a.id, b.id)
        })[0]
        if (newestThread) {
          return newestThread
        }
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for thread in channel ${this.channelId}`,
    )
  }

  async getInteractionResponse(interactionId: string): Promise<{
    interactionId: string
    interactionToken: string
    applicationId: string
    channelId: string
    type: number
    messageId: string | null
    data: string | null
    acknowledged: boolean
  } | null> {
    return this.discord.prisma.interactionResponse.findUnique({
      where: { interactionId },
    })
  }

  async waitForInteractionAck({
    interactionId,
    timeout = 10000,
  }: {
    interactionId: string
    timeout?: number
  }): Promise<{
    interactionId: string
    interactionToken: string
    type: number
    messageId: string | null
    acknowledged: boolean
  }> {
    const effectiveTimeout = normalizeWaitTimeout(timeout)
    const start = Date.now()
    while (Date.now() - start < effectiveTimeout) {
      const response =
        await this.discord.prisma.interactionResponse.findUnique({
          where: { interactionId },
        })
      if (response?.acknowledged) {
        return response
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    throw new Error(
      `Timed out waiting for interaction response ${interactionId}`,
    )
  }
}

// User actor scoped to a specific channel/thread.
// Returned by discord.channel(id).user(userId) or discord.thread(id).user(userId).
export class ScopedUserActor {
  private readonly discord: DigitalDiscord
  private readonly channelId: string
  private readonly userId: string

  constructor({
    discord,
    channelId,
    userId,
  }: {
    discord: DigitalDiscord
    channelId: string
    userId: string
  }) {
    this.discord = discord
    this.channelId = channelId
    this.userId = userId
  }

  // The user joins this voice channel (VOICE_STATE_UPDATE to the guild).
  async joinVoice(): Promise<void> {
    await this.setVoice(this.channelId)
  }

  async leaveVoice(): Promise<void> {
    await this.setVoice(null)
  }

  // The user speaks in this voice channel (call joinVoice() first, like a real user).
  // `intervalMs` paces the opus frames; 20 is real time.
  async speak({ opusPackets, intervalMs }: { opusPackets: readonly Buffer[]; intervalMs?: number }): Promise<void> {
    const channel = await this.discord.prisma.channel.findUniqueOrThrow({ where: { id: this.channelId } })
    if (!channel.guildId) throw new Error(`Channel ${this.channelId} is not in a guild`)
    await this.discord.speakInVoice({ guildId: channel.guildId, channelId: this.channelId, userId: this.userId, opusPackets, intervalMs })
  }

  private async setVoice(channelId: string | null): Promise<void> {
    const channel = await this.discord.prisma.channel.findUniqueOrThrow({ where: { id: this.channelId } })
    if (!channel.guildId) throw new Error(`Channel ${this.channelId} is not in a guild`)
    await this.discord.setUserVoiceChannel({ userId: this.userId, guildId: channel.guildId, channelId })
  }

  async sendMessage({
    content,
    embeds,
    attachments,
    messageReference,
  }: {
    content: string
    embeds?: APIEmbed[]
    attachments?: APIAttachment[]
    messageReference?: APIMessageReference
  }) {
    return this.discord.simulateUserMessage({
      channelId: this.channelId,
      userId: this.userId,
      content,
      embeds,
      attachments,
      messageReference,
    })
  }

  /**
   * Send a voice message (audio attachment with content_type: audio/ogg).
   * The attachment URL is fake — tests using deterministic transcription
   * bypass the fetch entirely. Content defaults to empty string since
   * real Discord voice messages have no text body.
   */
  async sendVoiceMessage({
    content,
    url = 'https://fake-cdn.discord.test/voice-message.ogg',
    contentType = 'audio/ogg',
    filename = 'voice-message.ogg',
  }: { content?: string; url?: string; contentType?: string; filename?: string } = {}) {
    return this.sendMessage({
      content: content ?? '',
      attachments: [
        {
          id: generateSnowflake(),
          filename,
          content_type: contentType,
          size: 1024,
          url,
          proxy_url: url,
        },
      ],
    })
  }

  async editMessage({
    messageId,
    content,
  }: {
    messageId: string
    content: string
  }) {
    return this.discord.simulateUserMessageEdit({
      messageId,
      channelId: this.channelId,
      content,
    })
  }

  async deleteMessage({ messageId }: { messageId: string }) {
    return this.discord.simulateUserMessageDelete({
      messageId,
      channelId: this.channelId,
    })
  }

  // Rename this thread from the Discord UI (posts a CHANNEL_NAME_CHANGE message).
  async renameThread({ name }: { name: string }) {
    return this.discord.simulateThreadRename({
      channelId: this.channelId,
      userId: this.userId,
      name,
    })
  }

  async runSlashCommand({
    name,
    commandId,
    options,
    guildId,
  }: {
    name: string
    commandId?: string
    options?: DigitalDiscordCommandOption[]
    guildId?: string
  }) {
    return this.discord.simulateSlashCommand({
      channelId: this.channelId,
      userId: this.userId,
      name,
      commandId,
      options,
      guildId,
    })
  }

  async autocomplete({
    name,
    options,
    focused,
    guildId,
  }: {
    name: string
    options: DigitalDiscordCommandOption[]
    focused: string
    guildId?: string
  }) {
    return this.discord.simulateAutocomplete({
      channelId: this.channelId,
      userId: this.userId,
      name,
      options,
      focused,
      guildId,
    })
  }

  async clickButton({
    messageId,
    customId,
    guildId,
  }: {
    messageId: string
    customId: string
    guildId?: string
  }) {
    return this.discord.simulateButtonClick({
      channelId: this.channelId,
      userId: this.userId,
      messageId,
      customId,
      guildId,
    })
  }

  async selectMenu({
    messageId,
    customId,
    values,
    guildId,
  }: {
    messageId: string
    customId: string
    values: string[]
    guildId?: string
  }) {
    return this.discord.simulateSelectMenu({
      channelId: this.channelId,
      userId: this.userId,
      messageId,
      customId,
      values,
      guildId,
    })
  }

  async submitModal({
    customId,
    fields,
    guildId,
    messageId,
    files,
  }: {
    customId: string
    fields: DigitalDiscordModalField[]
    guildId?: string
    messageId?: string
    files?: Array<{ customId: string; attachments: APIAttachment[] }>
  }) {
    return this.discord.simulateModalSubmit({
      channelId: this.channelId,
      userId: this.userId,
      customId,
      fields,
      guildId,
      messageId,
      files,
    })
  }
}

export { DiscordGateway } from './gateway.js'
export { generateSnowflake } from './snowflake.js'
export type { GatewayState } from './gateway.js'
export { resolveRouteScope, withThreads } from './server.js'
export type { RouteScope } from './server.js'
