// Combined HTTP (Spiceflow) + WebSocket (ws) server on a single port.
// The Spiceflow app handles REST API routes at /api/v10/*.
// The ws WebSocketServer handles Gateway connections at /gateway.
// All routes are defined inline since each is small.

import crypto from 'node:crypto'
import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Spiceflow } from 'spiceflow'
import {
  ApplicationFlags,
  ApplicationWebhookEventStatus,
  ApplicationCommandType,
  ChannelType,
  GatewayDispatchEvents,
  InteractionResponseType,
  MessageFlags,
  MessageType,
} from 'discord-api-types/v10'
import type {
  APIAttachment,
  APIUser,
  APIApplication,
  APIApplicationCommand,
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
  APIThreadList,
  RESTGetAPIGatewayBotResult,
  RESTPutAPIApplicationCommandsJSONBody,
  RESTPutAPIApplicationCommandsResult,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  RESTPostAPIApplicationCommandsJSONBody,
  RESTPostAPIChannelMessageJSONBody,
  RESTPatchAPIChannelMessageJSONBody,
  RESTPatchAPIChannelJSONBody,
  RESTPatchAPIGuildChannelPositionsJSONBody,
  RESTPostAPIChannelThreadsJSONBody,
  RESTPostAPIChannelMessagesThreadsJSONBody,
  RESTPostAPIGuildChannelJSONBody,
  RESTPatchAPIGuildRoleJSONBody,
  RESTPostAPIGuildRoleJSONBody,
  APIInteractionResponseCallbackData,
  RESTPostAPIInteractionCallbackJSONBody,
} from 'discord-api-types/v10'
import { DiscordGateway } from './gateway.js'
import type { GatewayAuthorize, GatewayOfflineClients, GatewayState, UpgradeFallback } from './gateway.js'
import type { DiscordVoiceServer } from './voice.js'
import type { ApplicationCommand as ApplicationCommandRow, PrismaClient } from './generated/client.js'
import {
  userToAPI,
  messageToAPI,
  type StoredInteraction,
  channelToAPI,
  threadMemberToAPI,
  guildToAPI,
  roleToAPI,
  memberToAPI,
} from './serializers.js'
import { generateSnowflake } from './snowflake.js'
import { PrivateReplies, type PrivateEvent } from './private-replies.js'

function commandFromRow(row: ApplicationCommandRow): APIApplicationCommand {
  return {
    id: row.id,
    application_id: row.applicationId,
    guild_id: row.guildId ?? undefined,
    name: row.name,
    description: row.description,
    type: row.type as ApplicationCommandType,
    options: JSON.parse(row.options),
    default_member_permissions: row.defaultMemberPermissions ?? null,
    dm_permission: row.dmPermission,
    nsfw: row.nsfw,
    version: row.version,
  }
}

async function createGuildCommand(
  prisma: PrismaClient,
  { applicationId, guildId, body }: { applicationId: string; guildId: string; body: RESTPostAPIApplicationCommandsJSONBody },
): Promise<APIApplicationCommand> {
  const row = await prisma.applicationCommand.create({
    data: {
      id: generateSnowflake(),
      applicationId,
      guildId,
      name: body.name,
      description: 'description' in body ? (body.description ?? '') : '',
      type: body.type ?? ApplicationCommandType.ChatInput,
      options: JSON.stringify('options' in body ? (body.options ?? []) : []),
      defaultMemberPermissions: body.default_member_permissions ?? null,
      dmPermission: body.dm_permission ?? true,
      nsfw: body.nsfw ?? false,
      version: generateSnowflake(),
    },
  })
  return commandFromRow(row)
}

async function findGuildCommand(
  prisma: PrismaClient,
  { applicationId, guildId, commandId }: { applicationId: string; guildId: string; commandId: string },
): Promise<ApplicationCommandRow> {
  const row = await prisma.applicationCommand.findFirst({ where: { id: commandId, applicationId, guildId } })
  if (row) return row
  throw new Response(JSON.stringify({ code: 10063, message: 'Unknown application command', errors: {} }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

// discord.js (via undici) URL-encodes @original to %40original.
// Decode so route handlers can check for the canonical form.
function resolveWebhookMessageId(raw: string): string {
  const decoded = decodeURIComponent(raw)
  return decoded
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack
  }
  return undefined
}

// Generous fake rate limit headers so discord.js never self-throttles
const RATE_LIMIT_HEADERS: Record<string, string> = {
  'X-RateLimit-Limit': '50',
  'X-RateLimit-Remaining': '49',
  'X-RateLimit-Reset-After': '60.0',
  'X-RateLimit-Bucket': 'fake-bucket',
}

const THREAD_CHANNEL_TYPES: ChannelType[] = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]

function isThreadChannelType(channelType: number): boolean {
  return THREAD_CHANNEL_TYPES.includes(channelType as ChannelType)
}

type GuildChannelCreateBody = RESTPostAPIGuildChannelJSONBody & {
  topic?: string
  position?: number
  rate_limit_per_user?: number
}

// Stores an uploaded file and returns the URL messages should carry. Default: a data: URI.
// It may also give the image's size, which Discord sends as width and height.
export type AttachmentStore = (file: { id: string; filename: string; contentType: string; data: Buffer }) => Promise<string | { url: string; size?: number; width?: number | null; height?: number | null }>

export type ChannelMessageWrite = {
  clientKey: string; authorId: string; channelId: string; messageId: string; edit: boolean
  uploaded: APIAttachment[]; previous: APIAttachment[]; attachments: APIAttachment[]
}

// Serves HTTP paths outside /api (a hub's own routes) and WebSocket upgrades outside /gateway.
export interface HttpExtension {
  privateReply?: PrivateEvent
  // A local application may consume uploads on authenticated channel posts. The client
  // key is the registered lookup key; no credential or client-supplied author is passed.
  channelMessage?: (input: ChannelMessageWrite, write: () => Promise<APIMessage>) => Promise<APIMessage>
  channelMessageDelete?: (input: Pick<ChannelMessageWrite, 'clientKey' | 'authorId' | 'channelId' | 'messageId'>, remove: () => Promise<Response>) => Promise<Response>
  handle(req: http.IncomingMessage, res: http.ServerResponse): void
  upgrade?: UpgradeFallback
  // Checked before anything else, for every request and upgrade (/api and
  // /gateway included): false answers 421 or drops the socket. For example a
  // Host allowlist against DNS rebinding.
  accept?: (req: http.IncomingMessage) => boolean
  // The gateway URL to give a client that reached us under this Host (in
  // /gateway/bot and READY's resume_gateway_url), when it differs by listener.
  gatewayUrl?: (host: string | undefined) => string | undefined
}

async function readMessageBody(request: Request, storeAttachment?: AttachmentStore): Promise<RESTPostAPIChannelMessageJSONBody & { uploadedAttachments: APIAttachment[] }> {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const body = await request.json() as RESTPostAPIChannelMessageJSONBody
    return { ...body, uploadedAttachments: [] }
  }
  const form = await request.formData()
  const payload = form.get('payload_json')
  const body = typeof payload === 'string' ? JSON.parse(payload) as RESTPostAPIChannelMessageJSONBody : {}
  const uploadedAttachments: APIAttachment[] = []
  for (const [key, file] of form.entries()) {
    if (!/^files\[\d+\]$/.test(key) || typeof file === 'string') continue
    const id = generateSnowflake()
    const data = Buffer.from(await file.arrayBuffer())
    const contentType = file.type || 'application/octet-stream'
    const stored = storeAttachment ? await storeAttachment({ id, filename: file.name, contentType, data }) : `data:${contentType};base64,${data.toString('base64')}`
    const { url: uri, width, height, size } = typeof stored === 'string' ? { url: stored, width: null, height: null, size: file.size } : stored
    uploadedAttachments.push({ id, filename: file.name, size: size ?? file.size, content_type: file.type, url: uri, proxy_url: uri, ...(width != null && height != null && { width, height }) })
  }
  // Like Discord, components get the uploaded URL in place of each attachment://<filename>.
  // Discord also returns `attachments: []` for Components V2 messages; the twin keeps them for text().
  const components = body.components && resolveAttachmentUrls(body.components, uploadedAttachments)
  return { ...body, ...(components && { components }), uploadedAttachments }
}

function resolveAttachmentUrls<T>(value: T, attachments: readonly APIAttachment[]): T {
  if (typeof value === 'string' && value.startsWith('attachment://')) {
    const attachment = attachments.find((candidate) => `attachment://${candidate.filename}` === value)
    return (attachment?.url ?? value) as T
  }
  if (Array.isArray(value)) return value.map((item) => resolveAttachmentUrls(item, attachments)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveAttachmentUrls(item, attachments)])) as T
  return value
}

export interface ServerComponents {
  privateReplies: PrivateReplies
  httpServer: http.Server
  // Who triggered each recent interaction (and the command name), for interaction_metadata on its responses.
  interactions: Map<string, StoredInteraction>
  gateway: DiscordGateway
  app: { handleForNode: Spiceflow['handleForNode'] }
  typingEvents: TypingEventRecord[]
  port: number
}

export type TypingEventRecord = {
  channelId: string
  timestamp: number
}

// REST route scope of gateway-proxy, ported 1:1 from
// gateway-proxy/src/rest_proxy.rs resolve_route_scope(). Keep them in sync.
export type RouteScope =
  | { kind: 'guild'; guildId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'allowed-without-guild' }
  | { kind: 'allowed-without-auth' }
  | { kind: 'denied' }

const SNOWFLAKE = /^\d+$/

export function resolveRouteScope(pathname: string): RouteScope {
  const segments = pathname.split('/').filter((segment) => segment.length > 0)
  const base = segments[0] === 'api' && segments[1] === 'v10' ? 2 : segments[0] === 'v10' ? 1 : -1
  if (base === -1 || segments.length <= base) return { kind: 'denied' }
  const route = segments.slice(base)
  const [first = '', second = '', third = '', fourth = ''] = route
  // Exact routes only: /users/@me/* reaches every guild of the shared bot.
  if (route.length === 2 && first === 'gateway' && second === 'bot') return { kind: 'allowed-without-guild' }
  if (route.length === 2 && first === 'users' && (second === '@me' || second.toLowerCase() === '%40me')) {
    return { kind: 'allowed-without-guild' }
  }
  // Like Discord, interaction and webhook routes carry their own secret (the
  // interaction token) instead of the bot token; every handler checks it.
  if ((first === 'interactions' || first === 'webhooks') && route.length >= 3) {
    return SNOWFLAKE.test(second) && third.length >= 32 ? { kind: 'allowed-without-auth' } : { kind: 'denied' }
  }
  if (first === 'guilds' && route.length >= 2) return SNOWFLAKE.test(second) ? { kind: 'guild', guildId: second } : { kind: 'denied' }
  if (first === 'channels' && route.length >= 2) return SNOWFLAKE.test(second) ? { kind: 'channel', channelId: second } : { kind: 'denied' }
  if (first === 'applications' && third === 'guilds' && route.length >= 4) {
    return SNOWFLAKE.test(fourth) ? { kind: 'guild', guildId: fourth } : { kind: 'denied' }
  }
  return { kind: 'denied' }
}

// Discord puts the thread started from a message on that message (`thread`,
// and the Has Thread flag). Older twin databases have threads with their own
// ids, so the lookup goes by starter message.
export async function withThreads<T extends { id: string; flags?: number }>(prisma: PrismaClient, messages: T[]): Promise<Array<T & { thread?: APIChannel }>> {
  if (messages.length === 0) return messages
  const threads = await prisma.channel.findMany({ where: { starterMessageId: { in: messages.map((m) => m.id) } } })
  if (threads.length === 0) return messages
  const byStarter = new Map(threads.map((t) => [t.starterMessageId!, t]))
  return messages.map((message) => {
    const thread = byStarter.get(message.id)
    return thread ? { ...message, flags: (message.flags ?? 0) | MessageFlags.HasThread, thread: channelToAPI(thread) } : message
  })
}

// Interaction tokens are random and live 15 minutes, as on Discord.
export const INTERACTION_TOKEN_TTL_MS = 15 * 60_000

const unknownInteraction = () => new Response(JSON.stringify({ code: 10062, message: 'Unknown Interaction', errors: {} }), { status: 404, headers: { 'Content-Type': 'application/json' } })
const unknownMessage = () => new Response(JSON.stringify({ code: 10008, message: 'Unknown Message', errors: {} }), { status: 404, headers: { 'Content-Type': 'application/json' } })

function channelFlags(flags: number) {
  if (flags & MessageFlags.Ephemeral) throw new Response('Ephemeral replies must be sent as a private interaction response', { status: 400 })
  return flags
}

function sameSecret(a: string, b: string) {
  const x = crypto.createHash('sha256').update(a).digest()
  const y = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(x, y)
}

// The interaction behind a webhook route: the token must exist, belong to
// this application and still be live.
async function interactionByToken(prisma: PrismaClient, applicationId: string, token: string) {
  const interaction = await prisma.interactionResponse.findUnique({ where: { interactionToken: token } })
  if (!interaction || interaction.applicationId !== applicationId || Date.now() - interaction.createdAt.getTime() > INTERACTION_TOKEN_TTL_MS) throw unknownInteraction()
  return interaction
}

// A webhook route may only touch its interaction's own messages: the original
// response, or follow-ups it posted (same application, same channel, after it).
async function interactionMessage(prisma: PrismaClient, interaction: { interactionId: string; applicationId: string; channelId: string; messageId: string | null }, messageId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } })
  if (!message) throw unknownMessage()
  const original = message.id === interaction.messageId
  const followUp = message.webhookId === interaction.applicationId && message.channelId === interaction.channelId && BigInt(message.id) > BigInt(interaction.interactionId)
  if (!original && !followUp) throw unknownMessage()
  return message
}

// Shared by the bot REST routes and simulated users.
export async function pinMessage({ prisma, gateway, channelId, messageId, userId, pinned }: { prisma: PrismaClient; gateway: DiscordGateway; channelId: string; messageId: string; userId: string; pinned: boolean }): Promise<void> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } })
  if (!channel) throw new Response(JSON.stringify({ code: 10003, message: 'Unknown Channel', errors: {} }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  const message = await prisma.message.findUnique({ where: { id: messageId } })
  if (!message || message.channelId !== channelId) throw new Response(JSON.stringify({ code: 10008, message: 'Unknown Message', errors: {} }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  if (message.pinned === pinned) return
  const updated = await prisma.message.update({ where: { id: messageId }, data: { pinned } })
  const guildId = channel.guildId ?? undefined
  const author = await prisma.user.findUniqueOrThrow({ where: { id: updated.authorId } })
  gateway.broadcast(GatewayDispatchEvents.MessageUpdate, { ...messageToAPI(updated, author, guildId), guild_id: guildId })
  gateway.broadcast(GatewayDispatchEvents.ChannelPinsUpdate, { guild_id: guildId, channel_id: message.channelId, last_pin_timestamp: pinned ? new Date().toISOString() : null })
  if (!pinned) return
  const systemId = generateSnowflake()
  await prisma.message.create({
    data: { id: systemId, channelId: message.channelId, authorId: userId, type: MessageType.ChannelPinnedMessage, content: '', messageReference: JSON.stringify({ message_id: messageId, channel_id: message.channelId, guild_id: guildId }) },
  })
  await prisma.channel.update({ where: { id: message.channelId }, data: { lastMessageId: systemId, messageCount: { increment: 1 }, totalMessageSent: { increment: 1 } } })
  const system = await prisma.message.findUniqueOrThrow({ where: { id: systemId } })
  gateway.broadcastMessageCreate(messageToAPI(system, await prisma.user.findUniqueOrThrow({ where: { id: userId } }), guildId), guildId ?? '')
}

// A thread started from a message (POST /channels/:id/messages/:id/threads), for bots and simulated users.
export async function startThreadFromMessage({ prisma, gateway, channel, messageId, userId, name, type = ChannelType.PublicThread, autoArchiveDuration, rateLimitPerUser }: { prisma: PrismaClient; gateway: DiscordGateway; channel: { id: string; guildId: string | null }; messageId: string; userId: string; name: string; type?: ChannelType; autoArchiveDuration?: number; rateLimitPerUser?: number }): Promise<APIChannel> {
  const message = await prisma.message.findUnique({ where: { id: messageId } })
  if (!message || message.channelId !== channel.id) throw new Response(JSON.stringify({ code: 10008, message: 'Unknown Message', errors: {} }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  // Real Discord returns 400 with code 160004 if a thread already exists for this message,
  // so tests catch two code paths creating threads on the same starter message.
  if (await prisma.channel.findFirst({ where: { starterMessageId: messageId } })) {
    throw new Response(JSON.stringify({ code: 160004, message: 'A thread has already been created for this message', errors: {} }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  // Like Discord: a thread started from a message has the message's id.
  const threadId = messageId
  await prisma.channel.create({
    data: {
      id: threadId,
      guildId: channel.guildId,
      type,
      name,
      parentId: channel.id,
      ownerId: userId,
      autoArchiveDuration: autoArchiveDuration ?? 1440,
      archiveTimestamp: new Date(),
      rateLimitPerUser: rateLimitPerUser ?? 0,
      starterMessageId: messageId,
      memberCount: 1,
    },
  })
  await prisma.threadMember.create({ data: { channelId: threadId, userId } })
  const thread = await prisma.channel.findUniqueOrThrow({ where: { id: threadId } })
  // Include newly_created so discord.js ThreadCreate action emits the event
  // even when the REST response is processed before the gateway WS event
  const withCreated = { ...channelToAPI(thread), newly_created: true }
  gateway.broadcast(GatewayDispatchEvents.ThreadCreate, withCreated)
  // The starter message now carries the thread, as Discord sends it.
  const starterAuthor = await prisma.user.findUniqueOrThrow({ where: { id: message.authorId } })
  const [starter] = await withThreads(prisma, [messageToAPI(message, starterAuthor, channel.guildId ?? undefined)])
  gateway.broadcast(GatewayDispatchEvents.MessageUpdate, { ...starter, guild_id: channel.guildId ?? undefined })
  return withCreated as APIChannel
}

// What a forward (message_reference type 1) carries of the message it forwards.
export function messageSnapshot(source: { type: number; content: string; embeds: string; attachments: string; components: string; timestamp: Date; editedTimestamp: Date | null; flags: number }) {
  return { message: { type: source.type, content: source.content, embeds: JSON.parse(source.embeds), attachments: JSON.parse(source.attachments), components: JSON.parse(source.components), timestamp: source.timestamp.toISOString(), edited_timestamp: source.editedTimestamp?.toISOString() ?? null, flags: source.flags, mentions: [], mention_roles: [] } }
}

export function createServer({
  prisma,
  botUserId,
  authorize,
  gatewayProxy,
  loadGatewayState,
  gatewayUrlOverride,
  offlineClients,
  voice,
  extension,
  storeAttachment,
  tokenKey,
  directAudience,
  clientUser,
}: {
  prisma: PrismaClient
  botUserId: string
  authorize: GatewayAuthorize
  // Enforce gateway-proxy REST rules: client tokens only reach routes of
  // their authorized guilds, fail closed otherwise.
  gatewayProxy: boolean
  loadGatewayState: () => Promise<GatewayState>
  gatewayUrlOverride?: string
  // gatewayProxy mode: registered clients, for the offline event buffer.
  offlineClients?: GatewayOfflineClients
  voice?: DiscordVoiceServer
  extension?: HttpExtension
  storeAttachment?: AttachmentStore
  tokenKey?: (token: string) => string
  directAudience?: (channelId: string) => ReadonlySet<string> | null
  // gatewayProxy mode: a client token that acts as its own bot user (null: the shared bot).
  clientUser?: (token: string) => string | null
}): ServerComponents {
  // The bot user a REST request acts as: the shared bot, or the client's own user.
  const acting = new AsyncLocalStorage<string>()
  const actor = () => acting.getStore() ?? botUserId
  const channelWrite = (request: Request, input: Omit<ChannelMessageWrite, 'clientKey' | 'authorId'>, write: () => Promise<APIMessage>) => {
    const token = request.headers.get('authorization')?.replace(/^Bot\s+/i, '')
    return gatewayProxy && tokenKey && token && extension?.channelMessage
      ? extension.channelMessage({ ...input, clientKey: tokenKey(token), authorId: actor() }, write) : write()
  }
  const state = { port: 0 }
  const typingEvents: TypingEventRecord[] = []

  // Route handlers close over `gateway`. It's assigned after httpServer
  // creation but before any request arrives (server hasn't started listening).
  let gateway!: DiscordGateway

  // A message by id, only if it is in this channel (Discord answers Unknown
  // Message otherwise): a route's channel decides what it may reach.
  const interactions = new Map<string, StoredInteraction>()
  const privateReplies = new PrivateReplies(extension?.privateReply)
  const privateReply = async (interaction: { interactionId: string; channelId: string; applicationId: string }, body: Parameters<PrivateReplies['create']>[4]) => {
    const meta = interactions.get(interaction.interactionId)
    if (!meta) throw unknownInteraction()
    const author = await prisma.user.findUniqueOrThrow({ where: { id: actor() } })
    return privateReplies.create(meta, userToAPI(author), interaction.channelId, interaction.applicationId, body)
  }
  // An edit of an interaction's message. The first edit of a deferred reply ends its
  // "is thinking…" state, which Discord does not mark as an edit.
  const editInteractionMessage = async (messageId: string, body: RESTPatchAPIChannelMessageJSONBody) => {
    const existing = await prisma.message.findUnique({ where: { id: messageId } })
    if (!existing) throw unknownMessage()
    const loading = Boolean(existing.flags & MessageFlags.Loading)
    const dbMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: body.content ?? existing.content,
        ...(loading ? {} : { editedTimestamp: new Date() }),
        ...(body.embeds ? { embeds: JSON.stringify(body.embeds) } : {}),
        ...(body.components ? { components: JSON.stringify(body.components) } : {}),
        ...(body.flags != null || loading ? { flags: channelFlags(body.flags ?? existing.flags) & ~MessageFlags.Loading } : {}),
      },
    })
    const author = await prisma.user.findUniqueOrThrow({ where: { id: dbMessage.authorId } })
    const channel = await prisma.channel.findUnique({ where: { id: dbMessage.channelId } })
    const guildId = channel?.guildId ?? undefined
    const member = guildId ? await prisma.guildMember.findUnique({ where: { guildId_userId: { guildId, userId: dbMessage.authorId } }, include: { user: true } }) : null
    const apiMessage = messageToAPI(dbMessage, author, guildId, member ?? undefined)
    gateway.broadcast(GatewayDispatchEvents.MessageUpdate, { ...apiMessage, guild_id: guildId })
    return apiMessage
  }
  const interactionMeta = (id: string) => {
    const stored = interactions.get(id)
    return stored ? JSON.stringify(stored) : null
  }

  // What Discord adds to a sent message beyond its text: the poll it opens, and
  // for a forward (message_reference type 1) a snapshot of the forwarded message.
  // A forward copies only from the same guild as the channel it is sent to,
  // never from a direct message: a client must not read, by id, a message in a
  // channel it cannot see.
  async function messageExtras(body: RESTPostAPIChannelMessageJSONBody, channelId: string): Promise<string | null> {
    const extra: Record<string, unknown> = {}
    if (body.poll) {
      const hours = body.poll.duration ?? 24
      extra['poll'] = {
        question: body.poll.question,
        answers: body.poll.answers.map((answer, index) => ({ answer_id: index + 1, poll_media: answer.poll_media })),
        expiry: new Date(Date.now() + hours * 3600_000).toISOString(),
        allow_multiselect: body.poll.allow_multiselect ?? false,
        layout_type: body.poll.layout_type ?? 1,
        results: { is_finalized: false, answer_counts: [] },
      }
    }
    const reference = body.message_reference as { type?: number; message_id?: string } | undefined
    if (reference?.type === 1 && reference.message_id) {
      const source = await prisma.message.findUnique({ where: { id: String(reference.message_id) } })
      const [from, to] = source ? await Promise.all([prisma.channel.findUnique({ where: { id: source.channelId } }), prisma.channel.findUnique({ where: { id: channelId } })]) : [null, null]
      if (source && from?.guildId && from.guildId === to?.guildId) extra['message_snapshots'] = [messageSnapshot(source)]
    }
    return Object.keys(extra).length ? JSON.stringify(extra) : null
  }

  async function findMessageIn(channelId: string, messageId: string) {
    const message = await prisma.message.findUnique({ where: { id: messageId } })
    return message && message.channelId === channelId ? message : null
  }

  async function listPins(channelId: string): Promise<APIMessage[]> {
    const channel = await prisma.channel.findUnique({ where: { id: channelId } })
    const rows = await prisma.message.findMany({ where: { channelId, pinned: true }, orderBy: { id: 'desc' } })
    const out: APIMessage[] = []
    for (const row of rows) out.push(messageToAPI(row, await prisma.user.findUniqueOrThrow({ where: { id: row.authorId } }), channel?.guildId ?? undefined))
    return out
  }

  // The bot pins or unpins: CHANNEL_PINS_UPDATE, plus Discord's
  // "pinned a message" system line on pin.
  async function setPinned(channelId: string, messageId: string, pinned: boolean): Promise<Response> {
    await pinMessage({ prisma, gateway, channelId, messageId, userId: actor(), pinned })
    return new Response(null, { status: 204 })
  }

  const app = new Spiceflow({ basePath: '/api/v10' })
    .onError(({ error }) => {
      if (error instanceof Response) {
        return error
      }
      const message = getErrorMessage(error) || 'Internal Server Error'
      const details = getErrorStack(error) ?? message
      return Response.json(
        {
          code: 0,
          message,
          error: 'internal_server_error',
          details,
          error_description: details,
          errors: {
            _errors: [
              {
                code: 'STACK_TRACE',
                message: details,
              },
            ],
          },
        },
        { status: 500 },
      )
    })

    // --- Gateway ---

    .route({
      method: 'GET',
      path: '/gateway/bot',
      handler({ request }): RESTGetAPIGatewayBotResult {
        return {
          url: extension?.gatewayUrl?.(request.headers.get('host') ?? undefined) ?? gatewayUrlOverride ?? `ws://127.0.0.1:${state.port}/gateway`,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 999,
            reset_after: 14400000,
            max_concurrency: 1,
          },
        }
      },
    })

    // --- Users ---

    .route({
      method: 'GET',
      path: '/users/@me',
      async handler(): Promise<APIUser> {
        const user = await prisma.user.findUniqueOrThrow({
          where: { id: actor() },
        })
        return userToAPI(user)
      },
    })
    .route({
      method: 'GET',
      path: '/users/:user_id',
      async handler({ params }): Promise<APIUser> {
        const user = await prisma.user.findUnique({
          where: { id: params.user_id },
        })
        if (!user) {
          throw new Response(
            JSON.stringify({
              code: 10013,
              message: 'Unknown User',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return userToAPI(user)
      },
    })

    // --- Applications ---

    .route({
      method: 'GET',
      path: '/applications/@me',
      handler(): APIApplication {
        return {
          id: botUserId,
          name: 'TestBot',
          icon: null,
          description: '',
          summary: '',
          bot_public: true,
          bot_require_code_grant: false,
          verify_key: 'fake-verify-key',
          team: null,
          flags:
            ApplicationFlags.GatewayPresence |
            ApplicationFlags.GatewayGuildMembers |
            ApplicationFlags.GatewayMessageContent,
          event_webhooks_status: ApplicationWebhookEventStatus.Disabled,
        }
      },
    })
    .route({
      method: 'PUT',
      path: '/applications/:application_id/commands',
      async handler({
        params,
        request,
      }): Promise<RESTPutAPIApplicationCommandsResult> {
        // JSON.parse of unknown request body -- `as` is the only option
        const commands =
          (await request.json()) as RESTPutAPIApplicationCommandsJSONBody

        await prisma.applicationCommand.deleteMany({
          where: {
            applicationId: params.application_id,
            guildId: null,
          },
        })

        const results: APIApplicationCommand[] = []
        for (const cmd of commands) {
          const id = generateSnowflake()
          const version = generateSnowflake()
          const description =
            'description' in cmd ? (cmd.description ?? '') : ''
          const options = 'options' in cmd ? (cmd.options ?? []) : []
          const type = cmd.type ?? ApplicationCommandType.ChatInput
          await prisma.applicationCommand.create({
            data: {
              id,
              applicationId: params.application_id,
              guildId: null,
              name: cmd.name,
              description,
              type,
              options: JSON.stringify(options),
              defaultMemberPermissions: cmd.default_member_permissions ?? null,
              dmPermission: cmd.dm_permission ?? true,
              nsfw: cmd.nsfw ?? false,
              version,
            },
          })
          const command: APIApplicationCommand = {
            id,
            application_id: params.application_id,
            name: cmd.name,
            description,
            type,
            options,
            default_member_permissions: cmd.default_member_permissions ?? null,
            dm_permission: cmd.dm_permission ?? true,
            nsfw: cmd.nsfw ?? false,
            version,
          }
          results.push(command)
        }

        return results
      },
    })
    .route({
      method: 'PUT',
      path: '/applications/:application_id/guilds/:guild_id/commands',
      async handler({
        params,
        request,
      }): Promise<RESTPutAPIApplicationCommandsResult> {
        const commands =
          (await request.json()) as RESTPutAPIApplicationCommandsJSONBody

        await prisma.applicationCommand.deleteMany({
          where: {
            applicationId: params.application_id,
            guildId: params.guild_id,
          },
        })
        const results: APIApplicationCommand[] = []
        for (const cmd of commands) {
          results.push(await createGuildCommand(prisma, { applicationId: params.application_id, guildId: params.guild_id, body: cmd }))
        }
        return results
      },
    })
    .route({
      method: 'GET',
      path: '/applications/:application_id/guilds/:guild_id/commands',
      async handler({ params }): Promise<APIApplicationCommand[]> {
        const rows = await prisma.applicationCommand.findMany({
          where: { applicationId: params.application_id, guildId: params.guild_id },
        })
        return rows.map(commandFromRow)
      },
    })
    .route({
      method: 'POST',
      path: '/applications/:application_id/guilds/:guild_id/commands',
      async handler({ params, request }): Promise<APIApplicationCommand> {
        const body = (await request.json()) as RESTPostAPIApplicationCommandsJSONBody
        return createGuildCommand(prisma, { applicationId: params.application_id, guildId: params.guild_id, body })
      },
    })
    .route({
      method: 'GET',
      path: '/applications/:application_id/guilds/:guild_id/commands/:command_id',
      async handler({ params }): Promise<APIApplicationCommand> {
        const row = await findGuildCommand(prisma, { applicationId: params.application_id, guildId: params.guild_id, commandId: params.command_id })
        return commandFromRow(row)
      },
    })
    .route({
      method: 'PATCH',
      path: '/applications/:application_id/guilds/:guild_id/commands/:command_id',
      async handler({ params, request }): Promise<APIApplicationCommand> {
        const row = await findGuildCommand(prisma, { applicationId: params.application_id, guildId: params.guild_id, commandId: params.command_id })
        const body = (await request.json()) as Partial<RESTPostAPIChatInputApplicationCommandsJSONBody>
        const updated = await prisma.applicationCommand.update({
          where: { id: row.id },
          data: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.options !== undefined && { options: JSON.stringify(body.options) }),
            ...(body.default_member_permissions !== undefined && { defaultMemberPermissions: body.default_member_permissions }),
            ...(body.dm_permission != null && { dmPermission: body.dm_permission }),
            ...(body.nsfw !== undefined && { nsfw: body.nsfw }),
            version: generateSnowflake(),
          },
        })
        return commandFromRow(updated)
      },
    })
    .route({
      method: 'DELETE',
      path: '/applications/:application_id/guilds/:guild_id/commands/:command_id',
      async handler({ params }) {
        const row = await findGuildCommand(prisma, { applicationId: params.application_id, guildId: params.guild_id, commandId: params.command_id })
        await prisma.applicationCommand.delete({ where: { id: row.id } })
        return new Response(null, { status: 204 })
      },
    })

    // --- Messages ---

    .route({
      method: 'POST',
      path: '/channels/:channel_id/messages',
      async handler({ params, request }): Promise<APIMessage> {
        const body = await readMessageBody(request, storeAttachment)
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const messageId = generateSnowflake()
        return channelWrite(request, { channelId: channel.id, messageId, edit: false, uploaded: body.uploadedAttachments, previous: [], attachments: body.uploadedAttachments }, async () => {
        await prisma.message.create({
          data: {
            id: messageId,
            channelId: params.channel_id,
            authorId: actor(),
            content: body.content ?? '',
            tts: body.tts ?? false,
            nonce: body.nonce != null ? String(body.nonce) : null,
            flags: channelFlags(body.flags ?? 0),
            embeds: JSON.stringify(body.embeds ?? []),
            components: JSON.stringify(body.components ?? []),
            attachments: JSON.stringify(body.uploadedAttachments),
            messageReference: body.message_reference
              ? JSON.stringify(body.message_reference)
              : null,
            extra: await messageExtras(body, params.channel_id),
          },
        })
        await prisma.channel.update({
          where: { id: params.channel_id },
          data: {
            lastMessageId: messageId,
            messageCount: { increment: 1 },
            totalMessageSent: { increment: 1 },
          },
        })
        const dbMessage = await prisma.message.findUniqueOrThrow({
          where: { id: messageId },
        })
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: actor() },
        })
        const guildId = channel.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: { guildId_userId: { guildId, userId: actor() } },
              include: { user: true },
            })
          : null
        const apiMessage = messageToAPI(
          dbMessage,
          author,
          guildId,
          member ?? undefined,
        )
        gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
        return apiMessage
        })
      },
    })
    .route({
      method: 'GET',
      path: '/channels/:channel_id/messages/:message_id',
      async handler({ params }): Promise<APIMessage> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        let dbMessage = await findMessageIn(params.channel_id, params.message_id)
        // discord.js fetchStarterMessage() fetches message with id = thread.id
        // from the parent channel. On real Discord, thread ID = starter message
        // ID for message-based threads. The digital twin uses separate IDs, so
        // fall back to the thread's starterMessageId when the message_id is
        // actually a thread that belongs to this channel.
        if (!dbMessage) {
          const thread = await prisma.channel.findUnique({
            where: { id: params.message_id },
          })
          if (thread?.starterMessageId && thread.parentId === params.channel_id) {
            dbMessage = await prisma.message.findUnique({
              where: { id: thread.starterMessageId },
            })
          }
        }
        if (!dbMessage) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: dbMessage.authorId },
        })
        const guildId = channel.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: {
                guildId_userId: { guildId, userId: dbMessage.authorId },
              },
              include: { user: true },
            })
          : null
        return (await withThreads(prisma, [messageToAPI(dbMessage, author, guildId, member ?? undefined)]))[0]!
      },
    })
    .route({
      method: 'PATCH',
      path: '/channels/:channel_id/messages/:message_id',
      async handler({ params, request }): Promise<APIMessage> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const existing = await findMessageIn(params.channel_id, params.message_id)
        if (!existing) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (existing.authorId !== actor()) throw Response.json({ message: 'Cannot edit another author’s message' }, { status: 403 })
        const body = await readMessageBody(request, storeAttachment)
        const previous: APIAttachment[] = JSON.parse(existing.attachments)
        // Only retain attachments already on THIS message, using their stored metadata.
        const change = Array.isArray(body.attachments) || body.uploadedAttachments.length > 0
        const kept = change ? previous.filter(a => body.attachments?.some(ref => String(ref.id) === a.id)) : previous
        const attachments = [...kept, ...body.uploadedAttachments]
        return channelWrite(request, { channelId: channel.id, messageId: existing.id, edit: true, uploaded: body.uploadedAttachments, previous, attachments }, async () => {
        await prisma.message.update({
          where: { id: params.message_id },
          data: {
            content: body.content ?? existing.content,
            editedTimestamp: new Date(),
            ...(change && { attachments: JSON.stringify(attachments) }),
            ...(body.embeds ? { embeds: JSON.stringify(body.embeds) } : {}),
            ...(body.components
              ? { components: JSON.stringify(body.components) }
              : {}),
            ...(body.flags != null ? { flags: channelFlags(body.flags) } : {}),
          },
        })
        const dbMessage = await prisma.message.findUniqueOrThrow({
          where: { id: params.message_id },
        })
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: dbMessage.authorId },
        })
        const guildId = channel.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: {
                guildId_userId: { guildId, userId: dbMessage.authorId },
              },
              include: { user: true },
            })
          : null
        const apiMessage = messageToAPI(
          dbMessage,
          author,
          guildId,
          member ?? undefined,
        )
        gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
          ...apiMessage,
          guild_id: guildId,
        })
        return apiMessage
        })
      },
    })
    .route({
      method: 'DELETE',
      path: '/channels/:channel_id/messages/:message_id',
      async handler({ params, request }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const existing = await findMessageIn(params.channel_id, params.message_id)
        if (!existing) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const remove = async () => {
          await prisma.message.delete({ where: { id: params.message_id } })
          gateway.broadcast(GatewayDispatchEvents.MessageDelete, {
            id: params.message_id,
            channel_id: params.channel_id,
            guild_id: channel.guildId ?? undefined,
          })
          return new Response(null, { status: 204 })
        }
        const token = request.headers.get('authorization')?.replace(/^Bot\s+/i, '')
        return gatewayProxy && tokenKey && token && extension?.channelMessageDelete
          ? extension.channelMessageDelete({ clientKey: tokenKey(token), authorId: actor(), channelId: channel.id, messageId: existing.id }, remove) : remove()
      },
    })
    .route({
      method: 'GET',
      path: '/channels/:channel_id/messages',
      async handler({ params, request }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url, 'http://localhost')
        const before = url.searchParams.get('before')
        const after = url.searchParams.get('after')
        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '50', 10)
        const limit = Math.min(
          Number.isNaN(parsedLimit) ? 50 : parsedLimit,
          100,
        )

        let messages = await prisma.message.findMany({
          where: { channelId: params.channel_id },
        })
        if (before) {
          const beforeBigInt = BigInt(before)
          messages = messages.filter((m) => BigInt(m.id) < beforeBigInt)
        }
        if (after) {
          const afterBigInt = BigInt(after)
          messages = messages.filter((m) => BigInt(m.id) > afterBigInt)
        }
        // Discord returns desc by default, asc when `after` is specified
        messages.sort((a, b) => {
          const cmp = Number(BigInt(a.id) - BigInt(b.id))
          return after ? cmp : -cmp
        })
        messages = messages.slice(0, limit)

        const guildId = channel.guildId ?? undefined
        const result: APIMessage[] = []
        for (const msg of messages) {
          const author = await prisma.user.findUniqueOrThrow({
            where: { id: msg.authorId },
          })
          const member = guildId
            ? await prisma.guildMember.findUnique({
                where: { guildId_userId: { guildId, userId: msg.authorId } },
                include: { user: true },
              })
            : null
          result.push(messageToAPI(msg, author, guildId, member ?? undefined))
        }
        return new Response(JSON.stringify(await withThreads(prisma, result)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
    .route({
      method: 'POST',
      path: '/channels/:channel_id/typing',
      async handler({ params }): Promise<Response> {
        typingEvents.push({
          channelId: params.channel_id,
          timestamp: Date.now(),
        })
        const channel = await prisma.channel.findUnique({ where: { id: params.channel_id } })
        gateway.notifyObservers(GatewayDispatchEvents.TypingStart, {
          channel_id: params.channel_id,
          guild_id: channel?.guildId ?? undefined,
          user_id: actor(),
          timestamp: Math.floor(Date.now() / 1000),
        })
        if (typingEvents.length > 5_000) {
          typingEvents.splice(0, typingEvents.length - 5_000)
        }
        return new Response(null, { status: 204 })
      },
    })

    // --- Pins (both the 2025 /messages/pins routes and the older /pins ones) ---

    .route({
      method: 'GET',
      path: '/channels/:channel_id/messages/pins',
      async handler({ params }): Promise<Response> {
        const pins = await listPins(params.channel_id)
        return Response.json({ items: pins.map((message) => ({ pinned_at: message.edited_timestamp ?? message.timestamp, message })), has_more: false })
      },
    })
    .route({
      method: 'GET',
      path: '/channels/:channel_id/pins',
      async handler({ params }): Promise<APIMessage[]> {
        return listPins(params.channel_id)
      },
    })
    .route({ method: 'PUT', path: '/channels/:channel_id/messages/pins/:message_id', handler: ({ params }) => setPinned(params.channel_id, params.message_id, true) })
    .route({ method: 'DELETE', path: '/channels/:channel_id/messages/pins/:message_id', handler: ({ params }) => setPinned(params.channel_id, params.message_id, false) })
    .route({ method: 'PUT', path: '/channels/:channel_id/pins/:message_id', handler: ({ params }) => setPinned(params.channel_id, params.message_id, true) })
    .route({ method: 'DELETE', path: '/channels/:channel_id/pins/:message_id', handler: ({ params }) => setPinned(params.channel_id, params.message_id, false) })

    // --- Reactions ---

    .route({
      method: 'PUT',
      path: '/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
      async handler({ params }): Promise<Response> {
        const emoji = decodeURIComponent(params.emoji)
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const message = await findMessageIn(params.channel_id, params.message_id)
        if (!message) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        await prisma.reaction.upsert({
          where: {
            messageId_userId_emoji: {
              messageId: params.message_id,
              userId: actor(),
              emoji,
            },
          },
          create: {
            messageId: params.message_id,
            userId: actor(),
            emoji,
          },
          update: {},
        })
        gateway.broadcast(GatewayDispatchEvents.MessageReactionAdd, {
          user_id: actor(),
          channel_id: params.channel_id,
          message_id: params.message_id,
          guild_id: channel.guildId ?? undefined,
          emoji: { id: null, name: emoji },
        })
        return new Response(null, { status: 204 })
      },
    })
    .route({
      method: 'DELETE',
      path: '/channels/:channel_id/messages/:message_id/reactions/:emoji/@me',
      async handler({ params }): Promise<Response> {
        const emoji = decodeURIComponent(params.emoji)
        if (!(await findMessageIn(params.channel_id, params.message_id))) throw unknownMessage()
        await prisma.reaction.deleteMany({
          where: {
            messageId: params.message_id,
            userId: actor(),
            emoji,
          },
        })
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        gateway.broadcast(GatewayDispatchEvents.MessageReactionRemove, {
          user_id: actor(),
          channel_id: params.channel_id,
          message_id: params.message_id,
          guild_id: channel?.guildId ?? undefined,
          emoji: { id: null, name: emoji },
        })
        return new Response(null, { status: 204 })
      },
    })

    // --- Channels ---

    .route({
      method: 'GET',
      path: '/channels/:channel_id',
      async handler({ params }): Promise<APIChannel> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return channelToAPI(channel)
      },
    })
    .route({
      method: 'PATCH',
      path: '/channels/:channel_id',
      async handler({ params, request }): Promise<APIChannel> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body = (await request.json()) as RESTPatchAPIChannelJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const isThread = isThreadChannelType(channel.type)
        await prisma.channel.update({
          where: { id: params.channel_id },
          data: {
            ...(body.name != null ? { name: body.name } : {}),
            ...(body.topic !== undefined ? { topic: body.topic ?? null } : {}),
            ...(body.archived != null
              ? {
                  archived: body.archived,
                  archiveTimestamp: new Date(),
                }
              : {}),
            ...(body.locked != null ? { locked: body.locked } : {}),
            ...(body.auto_archive_duration != null
              ? { autoArchiveDuration: body.auto_archive_duration }
              : {}),
            ...(body.rate_limit_per_user != null
              ? { rateLimitPerUser: body.rate_limit_per_user }
              : {}),
          },
        })
        const updated = await prisma.channel.findUniqueOrThrow({
          where: { id: params.channel_id },
        })
        const apiChannel = channelToAPI(updated)
        const event = isThread
          ? GatewayDispatchEvents.ThreadUpdate
          : GatewayDispatchEvents.ChannelUpdate
        gateway.broadcast(event, apiChannel)
        return apiChannel
      },
    })
    .route({
      method: 'DELETE',
      path: '/channels/:channel_id',
      async handler({ params }): Promise<APIChannel> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const isThread = isThreadChannelType(channel.type)
        const apiChannel = channelToAPI(channel)
        await prisma.channel.delete({ where: { id: params.channel_id } })
        if (isThread) {
          gateway.broadcast(GatewayDispatchEvents.ThreadDelete, {
            id: channel.id,
            guild_id: channel.guildId,
            parent_id: channel.parentId,
            type: channel.type,
          })
        } else {
          gateway.broadcast(GatewayDispatchEvents.ChannelDelete, apiChannel)
        }
        return apiChannel
      },
    })

    // --- Threads ---

    .route({
      method: 'POST',
      path: '/channels/:channel_id/threads',
      async handler({ params, request }): Promise<APIChannel> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body = (await request.json()) as RESTPostAPIChannelThreadsJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const threadId = generateSnowflake()
        const threadType = body.type ?? ChannelType.PublicThread
        await prisma.channel.create({
          data: {
            id: threadId,
            guildId: channel.guildId,
            type: threadType,
            name: body.name,
            parentId: params.channel_id,
            ownerId: actor(),
            autoArchiveDuration: body.auto_archive_duration ?? 1440,
            archiveTimestamp: new Date(),
            rateLimitPerUser: body.rate_limit_per_user ?? 0,
            memberCount: 1,
          },
        })
        // Auto-add creator as thread member
        await prisma.threadMember.create({
          data: { channelId: threadId, userId: actor() },
        })
        const thread = await prisma.channel.findUniqueOrThrow({
          where: { id: threadId },
        })
        const apiChannel = channelToAPI(thread)
        // Include newly_created so discord.js ThreadCreate action emits the event
        // even when the REST response is processed before the gateway WS event
        const withCreated = { ...apiChannel, newly_created: true }
        gateway.broadcast(GatewayDispatchEvents.ThreadCreate, withCreated)
        return withCreated as APIChannel
      },
    })
    .route({
      method: 'POST',
      path: '/channels/:channel_id/messages/:message_id/threads',
      async handler({ params, request }): Promise<APIChannel> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body =
          (await request.json()) as RESTPostAPIChannelMessagesThreadsJSONBody
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return startThreadFromMessage({ prisma, gateway, channel, messageId: params.message_id, userId: actor(), name: body.name, autoArchiveDuration: body.auto_archive_duration, rateLimitPerUser: body.rate_limit_per_user })
      },
    })
    .route({
      method: 'PUT',
      path: '/channels/:channel_id/thread-members/:user_id',
      async handler({ params }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const existing = await prisma.threadMember.findUnique({
          where: {
            channelId_userId: {
              channelId: params.channel_id,
              userId: params.user_id,
            },
          },
        })
        if (!existing) {
          await prisma.threadMember.create({
            data: { channelId: params.channel_id, userId: params.user_id },
          })
          await prisma.channel.update({
            where: { id: params.channel_id },
            data: { memberCount: { increment: 1 } },
          })
          const threadMember = await prisma.threadMember.findUniqueOrThrow({
            where: {
              channelId_userId: {
                channelId: params.channel_id,
                userId: params.user_id,
              },
            },
          })
          gateway.broadcast(GatewayDispatchEvents.ThreadMembersUpdate, {
            id: params.channel_id,
            guild_id: channel.guildId,
            member_count: channel.memberCount + 1,
            added_members: [threadMemberToAPI(threadMember)],
            removed_member_ids: [] as string[],
          })
        }
        return new Response(null, { status: 204 })
      },
    })
    .route({
      method: 'GET',
      path: '/channels/:channel_id/thread-members',
      async handler({ params }): Promise<Response> {
        const channel = await prisma.channel.findUnique({
          where: { id: params.channel_id },
        })
        if (!channel) {
          throw new Response(
            JSON.stringify({
              code: 10003,
              message: 'Unknown Channel',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const members = await prisma.threadMember.findMany({
          where: { channelId: params.channel_id },
        })
        return new Response(JSON.stringify(members.map(threadMemberToAPI)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    // --- Guilds ---

    .route({
      method: 'GET',
      path: '/guilds/:guild_id',
      async handler({ params }): Promise<APIGuild> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
          include: { roles: true },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return guildToAPI(guild)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/channels',
      async handler({ params }): Promise<APIChannel[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const channels = await prisma.channel.findMany({
          where: {
            guildId: params.guild_id,
            type: { notIn: THREAD_CHANNEL_TYPES },
          },
          // Discord breaks position ties by ID.
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        })
        return channels.map(channelToAPI)
      },
    })
    .route({
      // Modify Guild Channel Positions: one CHANNEL_UPDATE per changed channel.
      method: 'PATCH',
      path: '/guilds/:guild_id/channels',
      async handler({ params, request }): Promise<Response> {
        const body = (await request.json()) as RESTPatchAPIGuildChannelPositionsJSONBody
        const updated: APIChannel[] = []
        for (const entry of body) {
          const channel = await prisma.channel.findUnique({ where: { id: entry.id } })
          if (!channel || channel.guildId !== params.guild_id) {
            throw new Response(
              JSON.stringify({ code: 10003, message: 'Unknown Channel', errors: {} }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            )
          }
          const position = entry.position ?? channel.position
          const parentId = entry.parent_id === undefined ? channel.parentId : entry.parent_id
          if (position === channel.position && parentId === channel.parentId) continue
          const saved = await prisma.channel.update({ where: { id: entry.id }, data: { position, parentId } })
          updated.push(channelToAPI(saved))
        }
        for (const channel of updated) gateway.broadcast(GatewayDispatchEvents.ChannelUpdate, channel)
        return new Response(null, { status: 204 })
      },
    })
    .route({
      method: 'POST',
      path: '/guilds/:guild_id/channels',
      async handler({ params, request }): Promise<APIChannel> {
        const body = (await request.json()) as GuildChannelCreateBody
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const channelId = generateSnowflake()
        await prisma.channel.create({
          data: {
            id: channelId,
            guildId: params.guild_id,
            type: body.type ?? ChannelType.GuildText,
            name: body.name,
            topic: body.topic ?? null,
            parentId: body.parent_id != null ? String(body.parent_id) : null,
            position: body.position ?? 0,
            rateLimitPerUser: body.rate_limit_per_user ?? 0,
          },
        })
        const channel = await prisma.channel.findUniqueOrThrow({
          where: { id: channelId },
        })
        const apiChannel = channelToAPI(channel)
        gateway.broadcast(GatewayDispatchEvents.ChannelCreate, apiChannel)
        return apiChannel
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/roles',
      async handler({ params }): Promise<APIRole[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const roles = await prisma.role.findMany({
          where: { guildId: params.guild_id },
          orderBy: { position: 'asc' },
        })
        return roles.map(roleToAPI)
      },
    })
    .route({
      method: 'POST',
      path: '/guilds/:guild_id/roles',
      async handler({ params, request }): Promise<APIRole> {
        const body = (await request.json()) as RESTPostAPIGuildRoleJSONBody
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const roleCount = await prisma.role.count({
          where: { guildId: params.guild_id },
        })
        const roleId = generateSnowflake()
        await prisma.role.create({
          data: {
            id: roleId,
            guildId: params.guild_id,
            name: body.name ?? 'new role',
            color: body.color ?? 0,
            hoist: body.hoist ?? false,
            position: roleCount,
            permissions:
              body.permissions != null ? String(body.permissions) : '0',
            mentionable: body.mentionable ?? false,
          },
        })
        const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } })
        const apiRole = roleToAPI(role)
        gateway.broadcast(GatewayDispatchEvents.GuildRoleCreate, {
          guild_id: params.guild_id,
          role: apiRole,
        })
        return apiRole
      },
    })
    .route({
      method: 'PATCH',
      path: '/guilds/:guild_id/roles/:role_id',
      async handler({ params, request }): Promise<APIRole> {
        const body = (await request.json()) as RESTPatchAPIGuildRoleJSONBody
        const role = await prisma.role.findFirst({
          where: {
            id: params.role_id,
            guildId: params.guild_id,
          },
        })
        if (!role) {
          throw new Response(
            JSON.stringify({
              code: 10011,
              message: 'Unknown Role',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        await prisma.role.update({
          where: { id: params.role_id },
          data: {
            ...(body.name !== undefined ? { name: body.name ?? 'new role' } : {}),
            ...(body.color !== undefined ? { color: body.color ?? 0 } : {}),
            ...(body.hoist !== undefined ? { hoist: body.hoist ?? false } : {}),
            ...(body.permissions !== undefined
              ? { permissions: body.permissions != null ? String(body.permissions) : '0' }
              : {}),
            ...(body.mentionable !== undefined
              ? { mentionable: body.mentionable ?? false }
              : {}),
          },
        })
        const updatedRole = await prisma.role.findUniqueOrThrow({
          where: { id: params.role_id },
        })
        const apiRole = roleToAPI(updatedRole)
        gateway.broadcast(GatewayDispatchEvents.GuildRoleUpdate, {
          guild_id: params.guild_id,
          role: apiRole,
        })
        return apiRole
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/members/search',
      async handler({ params, request }): Promise<APIGuildMember[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url, 'http://localhost')
        const query = url.searchParams.get('query') ?? ''
        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '1', 10)
        const limit = Math.min(
          Number.isNaN(parsedLimit) ? 1 : parsedLimit,
          1000,
        )
        const members = await prisma.guildMember.findMany({
          where: {
            guildId: params.guild_id,
            OR: [
              { user: { username: { contains: query } } },
              { nick: { contains: query } },
            ],
          },
          include: { user: true },
          take: limit,
        })
        return members.map(memberToAPI)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/members',
      async handler({ params, request }): Promise<APIGuildMember[]> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url, 'http://localhost')
        const after = url.searchParams.get('after')
        const parsedLimit = parseInt(url.searchParams.get('limit') ?? '1', 10)
        const limit = Math.min(
          Number.isNaN(parsedLimit) ? 1 : parsedLimit,
          1000,
        )
        const members = await prisma.guildMember.findMany({
          where: {
            guildId: params.guild_id,
            ...(after ? { userId: { gt: after } } : {}),
          },
          include: { user: true },
          orderBy: { userId: 'asc' },
          take: limit,
        })
        return members.map(memberToAPI)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/members/:user_id',
      async handler({ params }): Promise<APIGuildMember> {
        const member = await prisma.guildMember.findUnique({
          where: {
            guildId_userId: {
              guildId: params.guild_id,
              userId: params.user_id,
            },
          },
          include: { user: true },
        })
        if (!member) {
          throw new Response(
            JSON.stringify({
              code: 10007,
              message: 'Unknown Member',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return memberToAPI(member)
      },
    })
    .route({
      method: 'GET',
      path: '/guilds/:guild_id/threads/active',
      async handler({ params }): Promise<APIThreadList> {
        const guild = await prisma.guild.findUnique({
          where: { id: params.guild_id },
        })
        if (!guild) {
          throw new Response(
            JSON.stringify({
              code: 10004,
              message: 'Unknown Guild',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const threads = await prisma.channel.findMany({
          where: {
            guildId: params.guild_id,
            type: { in: THREAD_CHANNEL_TYPES },
            archived: false,
          },
          orderBy: { createdAt: 'desc' },
        })
        const threadIds = threads.map((thread) => {
          return thread.id
        })
        const threadMembers =
          threadIds.length === 0
            ? []
            : await prisma.threadMember.findMany({
                where: { channelId: { in: threadIds } },
              })
        return {
          threads: threads.map(channelToAPI),
          members: threadMembers.map(threadMemberToAPI),
        }
      },
    })

    // Archived threads of one channel, newest first, all on one page.
    .route({
      method: 'GET',
      path: '/channels/:channel_id/threads/archived/:kind',
      async handler({ params }) {
        if (params.kind !== 'public' && params.kind !== 'private') throw new Response(JSON.stringify({ code: 0, message: '404: Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
        const threads = await prisma.channel.findMany({
          where: { parentId: params.channel_id, archived: true, type: params.kind === 'private' ? 12 : { in: [10, 11] } },
          orderBy: { createdAt: 'desc' },
        })
        const members = threads.length ? await prisma.threadMember.findMany({ where: { channelId: { in: threads.map((t) => t.id) } } }) : []
        return { threads: threads.map(channelToAPI), members: members.map(threadMemberToAPI), has_more: false }
      },
    })

    // --- Interactions ---

    .route({
      method: 'POST',
      path: '/interactions/:interaction_id/:interaction_token/callback',
      async handler({ params, request }): Promise<Response> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body =
          (await request.json()) as RESTPostAPIInteractionCallbackJSONBody

        const existing = await prisma.interactionResponse.findUnique({
          where: { interactionId: params.interaction_id },
        })
        if (!existing || !sameSecret(existing.interactionToken, params.interaction_token) || Date.now() - existing.createdAt.getTime() > INTERACTION_TOKEN_TTL_MS) {
          throw unknownInteraction()
        }
        if (existing.acknowledged) {
          throw new Response(
            JSON.stringify({
              code: 40060,
              message: 'Interaction has already been acknowledged',
              errors: {},
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const callbackType = body.type
        let messageId: string | null = existing.messageId
        const data = (
          'data' in body ? body.data : null
        ) as APIInteractionResponseCallbackData | null

        // Type 4 (CHANNEL_MESSAGE_WITH_SOURCE) creates a message immediately. Type 5
        // creates Discord's "is thinking…" message (LOADING), which the first edit or
        // follow-up turns into the reply.
        const privateSource = privateReplies.forWebhook(existing, existing.messageId, interactions.get(existing.interactionId)?.user.id)
        const deferred = callbackType === InteractionResponseType.DeferredChannelMessageWithSource
        const privateResponse = (callbackType === InteractionResponseType.ChannelMessageWithSource || deferred) && Boolean((data?.flags ?? 0) & MessageFlags.Ephemeral)
        if (privateResponse) {
          messageId = (await privateReply(existing, deferred ? { flags: MessageFlags.Loading } : data ?? {})).id
        } else if (privateSource && callbackType === InteractionResponseType.UpdateMessage) {
          privateReplies.edit(privateSource, data ?? {})
        } else if (callbackType === InteractionResponseType.ChannelMessageWithSource || deferred) {
          const reply: APIInteractionResponseCallbackData | null = deferred ? { flags: MessageFlags.Loading } : data
          messageId = generateSnowflake()
          await prisma.message.create({
            data: {
              id: messageId,
              channelId: existing.channelId,
              authorId: actor(),
              content: reply?.content ?? '',
              tts: reply?.tts ?? false,
              flags: reply?.flags ?? 0,
              embeds: JSON.stringify(reply?.embeds ?? []),
              components: JSON.stringify(reply?.components ?? []),
              webhookId: existing.applicationId,
              applicationId: existing.applicationId,
              interactionMetadata: interactionMeta(existing.interactionId),
              type: MessageType.Default,
            },
          })
          await prisma.channel.update({
            where: { id: existing.channelId },
            data: {
              lastMessageId: messageId,
              messageCount: { increment: 1 },
              totalMessageSent: { increment: 1 },
            },
          })
          const dbMessage = await prisma.message.findUniqueOrThrow({
            where: { id: messageId },
          })
          const author = await prisma.user.findUniqueOrThrow({
            where: { id: actor() },
          })
          const channel = await prisma.channel.findUnique({
            where: { id: existing.channelId },
          })
          const guildId = channel?.guildId ?? undefined
          const member = guildId
            ? await prisma.guildMember.findUnique({
                where: { guildId_userId: { guildId, userId: actor() } },
                include: { user: true },
              })
            : null
          const apiMessage = messageToAPI(
            dbMessage,
            author,
            guildId,
            member ?? undefined,
          )
          gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
        } else if (callbackType === InteractionResponseType.UpdateMessage) {
          messageId = existing.messageId
          if (!messageId) {
            throw new Response(
              JSON.stringify({
                code: 40060,
                message: 'Interaction is not attached to a message',
                errors: {},
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            )
          }
          const origMessage = await prisma.message.findUnique({
            where: { id: messageId },
          })
          if (!origMessage) {
            throw new Response(
              JSON.stringify({
                code: 10008,
                message: 'Unknown Message',
                errors: {},
              }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            )
          }
          await prisma.message.update({
            where: { id: messageId },
            data: {
              content: data?.content ?? origMessage.content,
              editedTimestamp: new Date(),
              ...(data?.embeds ? { embeds: JSON.stringify(data.embeds) } : {}),
              ...(data?.components
                ? { components: JSON.stringify(data.components) }
                : {}),
              ...(data?.flags != null ? { flags: channelFlags(data.flags) } : {}),
            },
          })
          const dbMessage = await prisma.message.findUniqueOrThrow({
            where: { id: messageId },
          })
          const author = await prisma.user.findUniqueOrThrow({
            where: { id: dbMessage.authorId },
          })
          const channel = await prisma.channel.findUnique({
            where: { id: dbMessage.channelId },
          })
          const guildId = channel?.guildId ?? undefined
          const member = guildId
            ? await prisma.guildMember.findUnique({
                where: {
                  guildId_userId: { guildId, userId: dbMessage.authorId },
                },
                include: { user: true },
              })
            : null
          const apiMessage = messageToAPI(
            dbMessage,
            author,
            guildId,
            member ?? undefined,
          )
          gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
            ...apiMessage,
            guild_id: guildId,
          })
        }

        // Mark interaction as acknowledged and store the response
        await prisma.interactionResponse.update({
          where: { interactionId: params.interaction_id },
          data: {
            acknowledged: true,
            type: callbackType,
            messageId,
              data: privateResponse || (privateSource && callbackType === InteractionResponseType.UpdateMessage) ? null : data ? JSON.stringify(data) : null,
          },
        })

        return new Response(null, { status: 204 })
      },
    })

    // --- Webhook endpoints for interaction follow-ups and edits ---
    // discord.js (via undici) URL-encodes @original to %40original, so we
    // use :message_id params and resolve @original inside each handler.

    .route({
      method: 'POST',
      path: '/webhooks/:webhook_id/:webhook_token',
      async handler({ params, request }): Promise<APIMessage> {
        // JSON.parse of unknown request body -- `as` is the only option
        const body = (await request.json()) as RESTPostAPIChannelMessageJSONBody

        // Look up the interaction to find which channel to post in
        const interaction = await interactionByToken(prisma, params.webhook_id, params.webhook_token)

        // The first follow-up after a deferral replaces the "is thinking…" message.
        const thinking = interaction.type === InteractionResponseType.DeferredChannelMessageWithSource && interaction.messageId
        const privateOriginal = thinking ? privateReplies.forWebhook(interaction, thinking, interactions.get(interaction.interactionId)?.user.id) : undefined
        if (privateOriginal && (privateOriginal.flags ?? 0) & MessageFlags.Loading) return privateReplies.edit(privateOriginal, body)
        if (thinking && !privateOriginal && ((await prisma.message.findUnique({ where: { id: thinking } }))?.flags ?? 0) & MessageFlags.Loading) return editInteractionMessage(thinking, { ...body, flags: (body.flags ?? 0) & ~MessageFlags.Ephemeral })
        if ((body.flags ?? 0) & MessageFlags.Ephemeral) return privateReply(interaction, body)
        const messageId = generateSnowflake()
        await prisma.message.create({
          data: {
            id: messageId,
            channelId: interaction.channelId,
            authorId: actor(),
            content: body.content ?? '',
            tts: body.tts ?? false,
            flags: body.flags ?? 0,
            embeds: JSON.stringify(body.embeds ?? []),
            components: JSON.stringify(body.components ?? []),
            webhookId: interaction.applicationId,
            applicationId: interaction.applicationId,
            interactionMetadata: interactionMeta(interaction.interactionId),
            type: MessageType.Default,
          },
        })
        await prisma.channel.update({
          where: { id: interaction.channelId },
          data: {
            lastMessageId: messageId,
            messageCount: { increment: 1 },
            totalMessageSent: { increment: 1 },
          },
        })
        const dbMessage = await prisma.message.findUniqueOrThrow({
          where: { id: messageId },
        })
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: actor() },
        })
        const channel = await prisma.channel.findUnique({
          where: { id: interaction.channelId },
        })
        const guildId = channel?.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: { guildId_userId: { guildId, userId: actor() } },
              include: { user: true },
            })
          : null
        const apiMessage = messageToAPI(
          dbMessage,
          author,
          guildId,
          member ?? undefined,
        )
        gateway.broadcastMessageCreate(apiMessage, guildId ?? '')
        return apiMessage
      },
    })
    .route({
      method: 'GET',
      path: '/webhooks/:webhook_id/:webhook_token/messages/:message_id',
      async handler({ params }): Promise<APIMessage> {
        const interaction = await interactionByToken(prisma, params.webhook_id, params.webhook_token)
        const resolvedId = resolveWebhookMessageId(params.message_id)
        const privateMessage = privateReplies.forWebhook(interaction, resolvedId === '@original' ? interaction.messageId : resolvedId, interactions.get(interaction.interactionId)?.user.id)
        if (privateMessage) return privateMessage
        const messageId = await (async () => {
          if (resolvedId === '@original') {
            if (!interaction || !interaction.messageId) {
              throw new Response(
                JSON.stringify({
                  code: 10008,
                  message: 'Unknown Message',
                  errors: {},
                }),
                {
                  status: 404,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }
            return interaction.messageId
          }
          return (await interactionMessage(prisma, interaction, resolvedId)).id
        })()

        const dbMessage = await prisma.message.findUnique({
          where: { id: messageId },
        })
        if (!dbMessage) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const author = await prisma.user.findUniqueOrThrow({
          where: { id: dbMessage.authorId },
        })
        const channel = await prisma.channel.findUnique({
          where: { id: dbMessage.channelId },
        })
        const guildId = channel?.guildId ?? undefined
        const member = guildId
          ? await prisma.guildMember.findUnique({
              where: {
                guildId_userId: { guildId, userId: dbMessage.authorId },
              },
              include: { user: true },
            })
          : null
        return (await withThreads(prisma, [messageToAPI(dbMessage, author, guildId, member ?? undefined)]))[0]!
      },
    })
    .route({
      method: 'PATCH',
      path: '/webhooks/:webhook_id/:webhook_token/messages/:message_id',
      async handler({ params, request }): Promise<APIMessage> {
        const body =
          (await request.json()) as RESTPatchAPIChannelMessageJSONBody
        const interaction = await interactionByToken(prisma, params.webhook_id, params.webhook_token)
        const resolvedId = resolveWebhookMessageId(params.message_id)

        const privateMessage = privateReplies.forWebhook(interaction, resolvedId === '@original' ? interaction.messageId : resolvedId, interactions.get(interaction.interactionId)?.user.id)
        if (privateMessage) return privateReplies.edit(privateMessage, body)
        if (resolvedId === '@original' && !interaction.messageId) throw unknownMessage()
        return editInteractionMessage(resolvedId === '@original' ? interaction.messageId! : (await interactionMessage(prisma, interaction, resolvedId)).id, body)
      },
    })
    .route({
      method: 'DELETE',
      path: '/webhooks/:webhook_id/:webhook_token/messages/:message_id',
      async handler({ params }): Promise<Response> {
        const interaction = await interactionByToken(prisma, params.webhook_id, params.webhook_token)
        const resolvedId = resolveWebhookMessageId(params.message_id)
        const privateMessage = privateReplies.forWebhook(interaction, resolvedId === '@original' ? interaction.messageId : resolvedId, interactions.get(interaction.interactionId)?.user.id)
        if (privateMessage) { privateReplies.remove(privateMessage.id); return new Response(null, { status: 204 }) }
        const messageId = await (async () => {
          if (resolvedId === '@original') {
            if (!interaction || !interaction.messageId) {
              throw new Response(
                JSON.stringify({
                  code: 10008,
                  message: 'Unknown Message',
                  errors: {},
                }),
                {
                  status: 404,
                  headers: { 'Content-Type': 'application/json' },
                },
              )
            }
            return interaction.messageId
          }
          return (await interactionMessage(prisma, interaction, resolvedId)).id
        })()

        const dbMessage = await prisma.message.findUnique({
          where: { id: messageId },
        })
        if (!dbMessage) {
          throw new Response(
            JSON.stringify({
              code: 10008,
              message: 'Unknown Message',
              errors: {},
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const channel = await prisma.channel.findUnique({
          where: { id: dbMessage.channelId },
        })
        await prisma.message.delete({ where: { id: messageId } })
        gateway.broadcast(GatewayDispatchEvents.MessageDelete, {
          id: messageId,
          channel_id: dbMessage.channelId,
          guild_id: channel?.guildId ?? undefined,
        })
        return new Response(null, { status: 204 })
      },
    })

  // Same status codes as rest_proxy.rs: 401 bad token, 403 outside the
  // authorized guilds, 404 + 10003 for an unknown channel.
  // Like Discord: /channels/A/messages/M (and pins, reactions, threads from
  // a message) only reach M when M is in channel A. Otherwise a client
  // authorised for A could reach any message by id. A thread id in place of
  // its starter message (older twin databases) is left to the handler.
  async function messageOutsideChannel(req: http.IncomingMessage): Promise<boolean> {
    const segments = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean)
    const at = segments.indexOf('channels')
    if (at < 0) return false
    const channelId = segments[at + 1]
    const rest = segments.slice(at + 2)
    const raw = rest[0] === 'messages' && rest[1] === 'pins' ? rest[2] : rest[0] === 'messages' || rest[0] === 'pins' ? rest[1] : undefined
    if (!channelId || raw === undefined) return false
    // Judged on the id the router will see (decoded); anything else is refused.
    let messageId: string
    try {
      messageId = decodeURIComponent(raw)
    } catch {
      return true
    }
    // No route needs an encoded id: an encoded one is an attempt to slip past this check.
    if (raw !== messageId) return true
    if (!SNOWFLAKE.test(messageId)) return false
    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true } })
    return Boolean(message && message.channelId !== channelId)
  }

  async function proxyRejection(req: http.IncomingMessage): Promise<Response | null> {
    if (!gatewayProxy) return null
    const scope = resolveRouteScope(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (scope.kind === 'allowed-without-auth') return null
    const token = (req.headers.authorization ?? '').replace(/^Bot\s+/i, '')
    const guilds = authorize(token)
    if (guilds === false) return Response.json({ error: 'Invalid client credentials' }, { status: 401 })
    if (await messageOutsideChannel(req)) return Response.json({ message: 'Unknown Message', code: 10008 }, { status: 404 })
    if (guilds === null) return null
    // Read-only, like rest_proxy.rs is_client_authorized_for_route.
    if (scope.kind === 'allowed-without-guild') {
      return req.method === 'GET' ? null : Response.json({ error: 'REST route is outside the authorized guild scope' }, { status: 403 })
    }
    if (scope.kind === 'denied') return Response.json({ error: 'REST route is outside the authorized guild scope' }, { status: 403 })
    if (scope.kind === 'guild') {
      return guilds.has(scope.guildId) ? null : Response.json({ error: 'REST route is outside the authorized guild scope' }, { status: 403 })
    }
    const channel = await prisma.channel.findUnique({ where: { id: scope.channelId } })
    if (!channel) return Response.json({ message: 'Unknown Channel', code: 10003 }, { status: 404 })
    if (channel.guildId && guilds.has(channel.guildId)) return null
    // A direct message channel: only the clients it is with.
    if (!channel.guildId && directAudience?.(channel.id)?.has(tokenKey ? tokenKey(token) : token)) return null
    return Response.json({ error: 'REST route is outside the authorized guild scope' }, { status: 403 })
  }

  const httpServer = http.createServer((req, res) => {
    // Nothing a client sends may throw out of here: a request that cannot be
    // parsed gets 400, a failure inside gets 500, and the socket never hangs.
    const fail = (status: number) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' })
      res.end()
    }
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return fail(400)
    }
    try {
      if (extension?.accept && !extension.accept(req)) {
        res.writeHead(421, { 'content-type': 'text/plain' }).end('Misdirected request')
        return
      }
      if (extension && !pathname.startsWith('/api/')) {
        extension.handle(req, res)
        return
      }
    } catch {
      return fail(500)
    }
    proxyRejection(req)
      .then(async (rejection) => {
        if (!rejection) {
          const own = gatewayProxy ? clientUser?.((req.headers.authorization ?? '').replace(/^Bot\s+/i, '')) : null
          return own ? acting.run(own, () => handleRequest(req, res)) : handleRequest(req, res)
        }
        res.writeHead(rejection.status, { 'content-type': 'application/json' })
        res.end(await rejection.text())
      })
      .catch(() => fail(500))
  })

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const origWriteHead = res.writeHead.bind(res)
    // Node's writeHead has complex overloads. Intercept to inject rate
    // limit headers on every response.
    res.writeHead = function writeHeadWithRateLimits(
      statusCode: number,
      ...rest: Parameters<typeof res.writeHead> extends [number, ...infer R]
        ? R
        : never[]
    ) {
      for (const [key, value] of Object.entries(RATE_LIMIT_HEADERS)) {
        res.setHeader(key, value)
      }
      res.setHeader('X-RateLimit-Reset', String(Date.now() / 1000 + 60))
      return origWriteHead(statusCode, ...rest)
    } as typeof res.writeHead
    return app.handleForNode(req, res)
  }

  gateway = new DiscordGateway({
    httpServer,
    port: 0,
    loadState: loadGatewayState,
    authorize,
    offlineClients,
    botUserId,
    voice,
    upgradeFallback: extension?.upgrade,
    acceptUpgrade: extension?.accept,
    gatewayUrlFor: extension?.gatewayUrl,
    resumeUrl: gatewayUrlOverride,
    tokenKey,
    directAudience,
    clientUser,
  })

  return {
    interactions,
    privateReplies,
    httpServer,
    gateway,
    app,
    typingEvents,
    get port() {
      return state.port
    },
    set port(v) {
      state.port = v
    },
  }
}

// Loopback by default: whoever reaches this port can drive the bots.
export function startServer(components: ServerComponents, { port = 0, host = '127.0.0.1' }: { port?: number; host?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    components.httpServer.once('error', reject)
    components.httpServer.listen(port, host, () => {
      const address = components.httpServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }
      const port = address.port
      components.port = port
      // @ts-expect-error -- updating private field after listen
      components.gateway.port = port
      resolve(port)
    })
  })
}

export function stopServer(components: ServerComponents): Promise<void> {
  return new Promise((resolve) => {
    components.gateway.close()
    components.httpServer.close(() => {
      resolve()
    })
    // Keep-alive and in-flight requests (long polls, streams) would hold
    // close() open until they end on their own.
    components.httpServer.closeAllConnections()
  })
}
