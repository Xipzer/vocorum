// The hub: one Node process on your machine. A persistent discord-digital-twin in
// gateway-proxy mode that every machine's unmodified Kimaki connects to, plus
// the client API, attachment store and PWA for the owner's devices. Loopback,
// plus an optional HTTPS listener on one private address (private-listener.ts).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { ChannelType } from 'discord-api-types/v10'
import { DigitalDiscord, generateSnowflake } from 'discord-digital-twin/src'
import { AttachmentStore } from './attachments.ts'
import { HttpError, HubAuth } from './auth.ts'
import { ClientApi } from './client-api.ts'
import { ClientEvents, type Audience } from './events.ts'
import { Sessions } from './sessions.ts'
import { loadConfig, readSecret, type HubConfig, type HubPaths } from './config.ts'
import { readJson, sendError, sendJson } from './http.ts'
import { botTokenKey, HubStore, type DeviceRow, type GuildRow } from './store.ts'
import { serveStatic } from './static.ts'
import { PrivateListener } from './private-listener.ts'
import { SearchIndex } from './search.ts'
import { Presence } from './presence.ts'
import { Notifications } from './notifications.ts'
import { Settings } from './settings.ts'
import { Access, P } from './access.ts'
import { Members } from './members.ts'
import { MachineIconStore } from './machine-icons.ts'
import { Community } from './community.ts'
import { Mirror } from './mirror.ts'
import { Requests } from './requests.ts'
import { DirectMessages } from './dms.ts'
import { VoiceRooms } from './voice.ts'
import { Schedules } from './schedules.ts'
import { AppReleases, sendDownload } from './app-releases.ts'
import { Routines } from './routines.ts'
import { extensions, type HubExtension, type HubExtensionFactory } from './extensions.ts'

// Constant time, whatever the lengths.
function sameSecret(a: string, b: string) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest())
}

const DEBUG = Boolean(process.env['VOCORUM_DEBUG'])

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

// What an unknown Tailscale account may call: the sign-in state and pairing.
const FIRST_PAIRING = new Set(['/client/auth/status', '/client/auth/register/options', '/client/auth/register/verify', '/client/auth/app/register'])

export function assertLoopback(host: string) {
  if (!LOOPBACK.has(host)) throw new Error(`The hub only binds loopback (got "${host}"). Expose it with tailscale serve.`)
}

export type HubOptions = {
  paths: HubPaths
  config: HubConfig
  // Defaults to config.port. Tests pass 0.
  port?: number
  host?: string
  // Built PWA (vite build output). Default: hub/web/dist.
  webDir?: string
  // Built-in extensions (src/extensions.ts by default; tests pass their own).
  extensions?: HubExtensionFactory[]
  // Web Push: VAPID contact and which endpoints may be called (tests use a local one).
  push?: { subject?: string; allowEndpoint?: (url: URL) => boolean }
}

export class Hub {
  readonly twin: DigitalDiscord
  readonly store: HubStore
  readonly auth: HubAuth
  readonly attachments: AttachmentStore
  readonly events: ClientEvents
  readonly privateListener: PrivateListener | null
  readonly search: SearchIndex
  readonly sessions: Sessions
  readonly presence: Presence
  readonly notifications: Notifications
  readonly settings: Settings
  readonly access: Access
  readonly members: Members
  readonly requests: Requests
  readonly dms: DirectMessages
  readonly voice: VoiceRooms
  readonly schedules: Schedules
  readonly apps: AppReleases
  readonly routines: Routines
  extensions: HubExtension[]
  readonly machineIcons: MachineIconStore
  readonly mirror: Mirror
  readonly community: Community
  readonly api: ClientApi
  private readonly adminToken: string
  // Registered token key -> machine.
  private activeBotTokens = new Map<string, string>()
  // Bot token -> its own bot user, for machines that have one.
  private botUsers = new Map<string, string>()
  // The hub's guilds (spaces), primary first. Refreshed on start and reload.
  guilds: GuildRow[] = []

  constructor(readonly options: HubOptions) {
    const { paths, config } = options
    const host = options.host ?? '127.0.0.1'
    assertLoopback(host)
    this.store = new HubStore(`file:${paths.hubDb}`)
    this.adminToken = readSecret(paths.adminToken)
    this.attachments = new AttachmentStore(paths.attachments, readSecret(paths.signingKey), this.store, () => this.attachmentBaseUrl)
    this.auth = new HubAuth(this.store, {
      tailscaleLogins: () => this.logins,
      allowedOrigins: () => this.allowedOrigins,
      localOpen: (req) => this.localOpen(req),
      rpName: 'Vocorum',
    })
    const webDir = options.webDir ?? path.resolve(import.meta.dirname, '../web/dist')
    this.twin = new DigitalDiscord({
      dbUrl: `file:${paths.twinDb}`,
      port: options.port ?? config.port,
      host,
      gatewayProxy: true,
      // Voice channels: bots join through the twin's voice server; people through /client/voice.
      voice: true,
      // Bot secrets are stored hashed; the twin looks clients up by this key.
      gatewayClientKey: botTokenKey,
      // What bots see as a member's permissions in interactions: the hub's own answer.
      memberPermissions: async (userId, channelId) => String(await this.access.channel(userId, channelId)),
      // Direct messages reach only the bot of the machine they were opened with.
      directAudience: (channelId) => this.dms.audience(channelId),
      // Never used by a bot: every machine gets its own clientId:secret. A
      // random value keeps the default fake token from being accepted.
      botToken: `${generateSnowflake()}.hub.${readSecret(paths.signingKey).slice(0, 8)}`,
      botUser: { id: config.botUserId, username: config.botUsername },
      guild: { id: config.guildId, name: config.guildName, ownerId: config.ownerUserId },
      channels: [{ name: 'general', type: ChannelType.GuildText }],
      users: [{ id: config.ownerUserId, username: config.ownerUsername }],
      ...(config.publicUrl && { gatewayUrlOverride: `${config.publicUrl.replace(/^http/, 'ws')}/gateway` }),
      storeAttachment: async (file) => {
        const saved = await this.attachments.save({ ...file, uploadedBy: 'bot' })
        return { url: saved.url, width: saved.width, height: saved.height }
      },
      extension: {
        privateReply: (userId, message, removed) => {
          const { id, channel_id } = message
          this.events.send(removed ? 'PRIVATE_REPLY_DELETE' : 'PRIVATE_REPLY', removed ? { id, channel_id } : message, { userId, channelId: channel_id })
        },
        // Only our own names reach anything, so a page that rebinds its DNS name to this address gets nowhere.
        accept: (req) => this.allowedHost(req.headers.host),
        // A bot gets the gateway on the listener it reached us through: loopback stays plain, the private listener is TLS.
        gatewayUrl: (host) => this.gatewayUrlFor(host),
        handle: (req, res) => void this.handle(req, res),
        upgrade: (req, socket, head) => this.upgrade(req, socket, head),
      },
    })
    this.events = new ClientEvents(this)
    this.sessions = new Sessions(this, (event, data) => {
      // Session state belongs to its thread; machine health and services to the hub's owner.
      const state = data as { id: string; removed?: boolean }
      const audience: Audience =
        event === 'SESSION_STATE'
          ? state.removed
            ? {}
            : { channelId: state.id }
          : event === 'SESSION_LINKS'
            ? { shape: async (userId) => { const visible = await this.access.visibleChannels(userId); return Object.fromEntries(Object.entries(data as Record<string, number>).filter(([id]) => visible.has(id))) } }
            : { hubOwner: true }
      this.events.send(event, data, audience)
      this.notifications.hubEvent(event, data)
    })
    this.presence = new Presence(this)
    this.notifications = new Notifications(this, paths.vapid, options.push)
    this.settings = new Settings(this)
    this.access = new Access(this)
    this.members = new Members(this)
    this.requests = new Requests(this)
    this.dms = new DirectMessages(this)
    this.voice = new VoiceRooms(this)
    this.schedules = new Schedules(this)
    this.apps = new AppReleases(paths.apps)
    this.routines = new Routines(this)
    this.machineIcons = new MachineIconStore(this)
    this.mirror = new Mirror(this)
    this.community = new Community(this)
    this.api = new ClientApi(this, webDir)
    this.search = new SearchIndex(this)
    this.extensions = []
    for (const make of options.extensions ?? extensions) {
      try {
        this.extensions.push(make(this))
      } catch (error) {
        console.error('[extension] could not be made; skipped:', error)
      }
    }
    this.privateListener = config.privateListener
      ? new PrivateListener(config.privateListener, paths.ca, {
          attach: (server) => this.twin.attachServer(server),
          tailscaleLogins: () => this.logins,
          installers: async (code, peer) => ((await this.auth.pairingCodeValid(code, peer)) ? this.apps.installers() : null),
          sendInstaller: (req, res, file) => {
            const found = this.apps.installerFile(file)
            if (found) sendDownload(req, res, found, file)
            return Boolean(found)
          },
        })
      : null
  }

  get port() {
    return this.twin.port
  }

  get localUrl() {
    return `http://127.0.0.1:${this.port}`
  }

  get attachmentBaseUrl() {
    return this.options.config.publicUrl ?? this.localUrl
  }

  // Attachment URLs inside messages are absolute (Kimaki fetches them). The
  // PWA gets them relative so they work from any origin the hub is served on.
  relativize(json: string): string {
    let out = json
    for (const base of new Set([this.localUrl, `http://127.0.0.1:${this.options.config.port}`, this.options.config.publicUrl])) {
      if (base) out = out.split(`${base}/attachments/`).join('/attachments/')
    }
    return out
  }

  // Host headers the hub answers: loopback on its port, the public URL, and the private listener's names and address.
  allowedHost(host: string | undefined) {
    if (!host) return false
    const hosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`])
    if (this.options.config.publicUrl) {
      const url = new URL(this.options.config.publicUrl)
      hosts.add(url.host.toLowerCase())
      if (!url.port) hosts.add(`${url.hostname}:${url.protocol === 'https:' ? 443 : 80}`.toLowerCase())
    }
    const listener = this.privateListener
    if (listener) {
      const address = listener.config.address.includes(':') ? `[${listener.config.address}]` : listener.config.address
      for (const name of [...listener.config.names, address]) {
        hosts.add(`${name}:${listener.port}`.toLowerCase())
        // Browsers leave the default port out of Host.
        if (listener.port === 443) hosts.add(name.toLowerCase())
      }
    }
    return hosts.has(host.toLowerCase())
  }

  gatewayUrlFor(host: string | undefined) {
    if (!host || !this.allowedHost(host)) return undefined
    const name = host.toLowerCase()
    if ([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(name)) return `ws://${host}/gateway`
    if (this.options.config.publicUrl && new URL(this.options.config.publicUrl).host === name) return undefined
    return `wss://${host}/gateway`
  }

  get allowedOrigins() {
    const origins = [`http://localhost:${this.port}`]
    if (this.options.config.publicUrl) origins.push(new URL(this.options.config.publicUrl).origin)
    if (this.privateListener) origins.push(...this.privateListener.appOrigins)
    return origins
  }

  get guildIds() {
    return new Set(this.guilds.map((g) => g.id))
  }

  async start() {
    fs.mkdirSync(this.options.paths.attachments, { recursive: true, mode: 0o700 })
    // With VOCORUM_DEBUG=1, how long each start step took (remote machines wait for the last one).
    const timed = async (name: string, step: () => unknown) => {
      const began = performance.now()
      await step()
      if (process.env['VOCORUM_DEBUG'] === '1') console.log(`[start] ${name} ${Math.round(performance.now() - began)} ms, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`)
    }
    await timed('store', async () => {
      await this.store.migrate()
      await this.store.migrateOwnerData(this.options.config.ownerUserId)
    })
    await timed('twin', () => this.twin.start())
    await timed('direct messages', () => this.dms.start())
    await this.routines.start()
    await timed('guilds, bots, logins', async () => {
      await this.syncGuilds()
      await this.syncBots()
      await this.refreshLogins()
    })
    this.events.start()
    this.voice.start()
    await timed('sessions', () => this.sessions.start())
    await timed('search', () => this.search.start())
    await timed('presence', () => this.presence.start())
    this.notifications.start()
    await timed('private listener', () => this.privateListener?.start())
    await timed('schedules', () => this.schedules.start())
    // One that fails to start is left out; the hub runs without it.
    for (const extension of [...this.extensions]) {
      try {
        await timed(`extension ${extension.id}`, () => extension.start?.())
      } catch (error) {
        console.error(`[extension ${extension.id}] did not start; skipped:`, error)
        this.extensions = this.extensions.filter((e) => e !== extension)
      }
    }
    void timed('session states', () => this.sessions.warm())
  }

  async stop() {
    for (const extension of [...this.extensions].reverse()) await extension.stop?.()
    this.schedules.stop()
    await this.privateListener?.stop()
    this.search.stop()
    this.notifications.stop()
    this.presence.stop()
    this.sessions.stop()
    this.voice.stop()
    this.events.stop()
    await this.twin.stop()
    // Closes twin.db: Windows cannot move or delete a file that is still open.
    await this.twin.prisma.$disconnect()
    this.store.close()
  }

  // Applies bots and device revocations written by the CLI to the running hub.
  async reload() {
    // vocorum admin setup names the Admin server in config.json while the hub runs.
    const fresh = loadConfig(this.options.paths)
    this.options.config.adminGuildId = fresh?.adminGuildId ?? null
    this.options.config.adminBotReady = fresh?.adminBotReady ?? false
    const created = await this.syncGuilds()
    this.access.invalidate()
    for (const guild of created) this.events.send('GUILD_CREATE', { id: guild.id, name: guild.name, icon: guild.icon }, { guildId: guild.id })
    await this.syncBots()
    await this.sessions.reloadBots()
    await this.presence.reload()
    await this.refreshLogins()
    this.access.invalidate()
    const devices = await this.store.listDevices()
    for (const device of devices) if (device.revokedAt) this.events.disconnectDevice(device.id)
  }

  // After a guild is renamed or gets an icon from the app.
  async refreshGuilds() {
    await this.syncGuilds()
    this.access.invalidate()
  }

  // The person a device belongs to (devices from before several people: the owner).
  userOf(device: DeviceRow) {
    return device.userId ?? this.options.config.ownerUserId
  }

  // Tailscale logins allowed past the network gate: the owner's and any set for invited people.
  private logins = new Map<string, string>()
  async refreshLogins() {
    const logins = new Map<string, string>()
    if (this.options.config.tailscaleLogin) logins.set(this.options.config.tailscaleLogin, this.options.config.ownerUserId)
    for (const [userId, profile] of Object.entries(await this.store.profiles())) if (profile.tailscaleLogin && userId !== this.options.config.ownerUserId) logins.set(profile.tailscaleLogin, userId)
    this.logins = logins
  }

  get tailscaleLogins() {
    return this.logins
  }

  // Creates guilds registered by the CLI in the twin and applies renames.
  // Returns the guilds that are new to the twin.
  // Servers copied from Discord bring their own channels: no extra #general.
  readonly mirroredGuilds = new Set<string>()

  private async syncGuilds(): Promise<GuildRow[]> {
    const { config } = this.options
    await this.store.ensureGuild(config.guildId, config.guildName)
    this.guilds = await this.store.listGuilds()
    const created: GuildRow[] = []
    for (const guild of this.guilds) {
      const existing = await this.twin.prisma.guild.findUnique({ where: { id: guild.id } })
      if (!existing) {
        await this.twin.createGuild({ id: guild.id, name: guild.name, ownerId: config.ownerUserId, icon: guild.icon, general: !this.mirroredGuilds.delete(guild.id) && guild.id !== this.options.config.adminGuildId })
        created.push(guild)
      } else if (existing.name !== guild.name || existing.icon !== guild.icon) {
        await this.twin.updateGuild({ id: guild.id, name: guild.name, icon: guild.icon })
      }
    }
    return created
  }

  private async syncBots() {
    const bots = await this.store.listBots()
    const memberships = await this.store.botGuilds()
    const ownUsers = await this.store.botUsers()
    const known = this.guildIds
    const active = new Map<string, string>()
    for (const bot of bots) {
      const token = `${bot.clientId}:${bot.secretHash}`
      if (bot.revokedAt) {
        this.twin.revokeGatewayClient({ token })
        continue
      }
      active.set(token, bot.machine)
      // The Admin server holds the admin bot and nothing else, and the admin bot holds nothing else:
      // no other machine's bot (or a session on it) can read or post where the admin agent listens.
      const admin = this.options.config.adminGuildId
      // Until vocorum admin setup has the admin Kimaki logged in once, the admin bot is in no server at all.
      if (bot.machine === 'admin') {
        await this.twin.setGatewayClientGuilds({ token, guildIds: admin && known.has(admin) && this.options.config.adminBotReady ? [admin] : [] })
        continue
      }
      const guildIds = (memberships.get(bot.machine) ?? []).filter((id) => known.has(id) && id !== admin)
      const inGuilds = guildIds.length ? guildIds : [this.options.config.guildId]
      await this.twin.setGatewayClientGuilds({ token, guildIds: inGuilds })
      const own = ownUsers.get(bot.machine)
      if (own) await this.ownBotUser(own, inGuilds)
      // A change of user takes effect on the next connection, so the live one ends.
      if ((this.botUsers.get(token) ?? null) !== (own?.userId ?? null)) this.twin.reidentifyGatewayClient({ token })
      this.twin.setGatewayClientUser({ token, userId: own?.userId ?? null })
      if (own) this.botUsers.set(token, own.userId)
      else this.botUsers.delete(token)
    }
    for (const token of this.activeBotTokens.keys()) if (!active.has(token)) this.twin.revokeGatewayClient({ token })
    this.activeBotTokens = active
  }

  // A machine's own bot user: a bot account with its name, a member of exactly the machine's guilds.
  private async ownBotUser({ userId, name }: { userId: string; name: string }, guildIds: string[]) {
    const username = name.toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 32) || 'bot'
    await this.twin.mirrorUser({ id: userId, username, globalName: name, bot: true })
    for (const guildId of guildIds) await this.twin.addGuildMember({ guildId, userId })
    for (const m of await this.twin.prisma.guildMember.findMany({ where: { userId } })) {
      if (!guildIds.includes(m.guildId)) await this.twin.removeGuildMember({ guildId: m.guildId, userId })
    }
  }

  // Without a signed URL, a signed-in person gets a file only if they uploaded
  // it from one of their devices or it is in a message in a channel they can view.
  private async canSeeAttachment(userId: string, attachmentId: string) {
    if (!/^\d{1,20}$/.test(attachmentId)) return false
    if (this.access.isHubOwner(userId)) return true
    const row = await this.store.getAttachment(attachmentId)
    if (!row) return false
    const uploader = row.uploadedBy.startsWith('device:') ? await this.store.getDevice(row.uploadedBy.slice('device:'.length)) : null
    if (uploader && this.userOf(uploader) === userId) return true
    const messages = await this.twin.prisma.message.findMany({ where: { attachments: { contains: `"${attachmentId}"` } }, select: { channelId: true }, take: 20 })
    for (const message of messages) if (await this.access.can(userId, message.channelId, 0n)) return true
    return false
  }

  // A machine's bot reads files from messages in its own guilds (and files bots uploaded, before they are posted).
  private async botCanSeeAttachment(machine: string, attachmentId: string) {
    if (!/^\d{1,20}$/.test(attachmentId)) return false
    const row = await this.store.getAttachment(attachmentId)
    if (!row) return false
    const guilds = (await this.store.botGuilds()).get(machine)?.filter((id) => this.guildIds.has(id))
    const allowed = new Set(guilds?.length ? guilds : [this.options.config.guildId])
    const messages = await this.twin.prisma.message.findMany({ where: { attachments: { contains: `"${attachmentId}"` } }, select: { channel: { select: { guildId: true } } }, take: 20 })
    if (messages.length === 0) return row.uploadedBy === 'bot'
    return messages.some((m) => m.channel.guildId !== null && allowed.has(m.channel.guildId))
  }

  isBotAuthorization(header: string | undefined) {
    return this.botMachine(header) !== null
  }

  // The machine a bot token belongs to, or null.
  botMachine(header: string | undefined) {
    const token = (header ?? '').replace(/^Bot\s+/i, '')
    return token.length > 0 ? (this.activeBotTokens.get(botTokenKey(token)) ?? null) : null
  }

  // Machine names (lower case) a person sees: all for the hub owner, otherwise
  // those with a category the person can view.
  async visibleMachines(userId: string): Promise<Set<string>> {
    const bots = (await this.store.listBots()).filter((b) => !b.revokedAt).map((b) => b.machine)
    const machines = [...new Set([...bots, ...(await this.sessions.machines()).map((m) => m.name)])]
    if (this.access.isHubOwner(userId)) return new Set(machines.map((m) => m.toLowerCase()))
    const visible = await this.access.visibleChannels(userId)
    const categories = await this.twin.prisma.channel.findMany({ where: { id: { in: [...visible] }, type: 4 }, select: { name: true } })
    return new Set(categories.flatMap((c) => this.sessions.machineOf(c.name ?? '')?.toLowerCase() ?? []))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      // VOCORUM_DEBUG=1: one line per request with its duration.
      if (DEBUG) {
        const started = performance.now()
        res.once('finish', () => console.log(`[http] ${req.method} ${pathname} ${res.statusCode} ${Math.round(performance.now() - started)}ms`))
      }
      if (pathname.startsWith('/admin/')) return await this.handleAdmin(req, res, pathname)
      // Machines' own calls, with their hub bot token.
      if (pathname.startsWith('/hub/')) {
        const machine = this.botMachine(req.headers.authorization)
        if (!machine) throw new HttpError(401, 'Bot token required')
        if (pathname.startsWith('/hub/mirror/')) return sendJson(res, 200, await this.mirror.handleBot(req, pathname, machine))
        return sendJson(res, 200, await this.machineIcons.handleBot(req, pathname, machine))
      }
      if (pathname.startsWith('/attachments/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed')
        const attachmentId = pathname.split('/')[2] ?? ''
        const machine = this.botMachine(req.headers.authorization)
        const device = machine ? null : await this.auth.device(req)
        const authorized = machine ? await this.botCanSeeAttachment(machine, attachmentId) : device !== null && (await this.canSeeAttachment(this.userOf(device), attachmentId))
        return await this.attachments.serve(req, res, { authorized })
      }
      // Everything else is for humans: the private listener or a proxy on loopback.
      await this.checkHuman(req, pathname)
      if (pathname.startsWith('/client/')) return await this.api.handle(req, res, pathname)
      return await serveStatic(req, res, pathname, this.api.webDir)
    } catch (error) {
      sendError(res, error)
    }
  }

  // Open access on this computer (config.localAccess): a browser on localhost needs no code or
  // passkey. Only for a request that came straight to the hub's own port under its loopback
  // name, carrying nothing a proxy or tunnel adds. Anything else keeps every check.
  localOpen(req: http.IncomingMessage) {
    if (this.options.config.localAccess !== 'open' || this.privateListener?.owns(req)) return false
    if ((req.headers.host ?? '').toLowerCase() !== `localhost:${this.port}`) return false
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false
    return !Object.keys(req.headers).some((name) => /^(tailscale-|x-forwarded-|x-real-ip$|forwarded$|via$|cf-|true-client-ip$)/.test(name))
  }

  // First gate on human routes. On loopback the proxy's identity header must
  // name an allowed login; on the private listener the peer must pass the
  // optional Tailscale check. Either way a passkey session is required after
  // this, and checkIdentity() then ties the two together.
  async checkHuman(req: http.IncomingMessage, pathname = '') {
    if (this.privateListener?.owns(req)) {
      const login = await this.privateListener.checkPeer(req)
      // A Tailscale account the hub does not know yet may load the app and pair with an
      // invite code, nothing else: pairing ties that account to the invited person.
      // Not when the account could not be read (whois failed: nothing to tie it to), nor
      // for tagged devices, which all share one login name.
      const unknown = login === false ? this.privateListener.unknownLogin(req) : null
      if (unknown && unknown !== 'tagged-devices' && (FIRST_PAIRING.has(pathname) || !pathname.startsWith('/client/'))) {
        this.firstPairings.set(req, unknown)
        return
      }
      if (login === false) throw new HttpError(403, 'Forbidden: this device is not on an allowed Tailscale account')
      if (login) this.identities.set(req, login)
      return
    }
    if (this.localOpen(req)) return
    this.identities.set(req, this.auth.checkTailscale(req))
  }

  private identities = new WeakMap<http.IncomingMessage, string>()
  private firstPairings = new WeakMap<http.IncomingMessage, string>()

  // After a passkey is made with an invite code from an unknown Tailscale account: that
  // account becomes the invited person's, once. The owner's own code, or a person who
  // already has an account, cannot be used from an unknown one.
  async firstPairingAllowed(req: http.IncomingMessage, userId: string | null) {
    const login = this.firstPairings.get(req)
    if (!login) return true
    const profile = userId ? (await this.store.profiles())[userId] : undefined
    return Boolean(userId && userId !== this.options.config.ownerUserId && !profile?.tailscaleLogin && !this.logins.has(login))
  }

  async bindFirstPairing(req: http.IncomingMessage, device: { id: string; userId: string | null }) {
    const login = this.firstPairings.get(req)
    if (!login) return
    const userId = device.userId
    if (!(await this.firstPairingAllowed(req, userId)) || !userId) {
      await this.store.revokeDevice(device.id)
      throw new HttpError(403, 'Forbidden: this device is not on an allowed Tailscale account')
    }
    await this.store.setProfile(userId, { tailscaleLogin: login })
    await this.refreshLogins()
  }

  // The Tailscale login the network gate verified for this request, if any.
  identityOf(req: http.IncomingMessage) {
    return this.identities.get(req) ?? null
  }

  // A device signed in as one person cannot be used through another person's Tailscale identity.
  checkIdentity(req: http.IncomingMessage, userId: string) {
    const login = this.identities.get(req)
    const owner = login ? this.logins.get(login) : undefined
    if (login && owner !== userId) throw new HttpError(403, 'Forbidden: this Tailscale account belongs to someone else')
  }

  // Local CLI only: a bearer token from a 0600 file, and never via a proxy or the private listener.
  private async handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const proxied = this.privateListener?.owns(req) || Object.keys(req.headers).some((name) => name.startsWith('tailscale-') || name === 'x-forwarded-for')
    if (proxied || !sameSecret(req.headers.authorization ?? '', `Bearer ${this.adminToken}`)) throw new HttpError(403, 'Forbidden')
    if (pathname === '/admin/reload' && req.method === 'POST') {
      await this.reload()
      return sendJson(res, 200, { ok: true })
    }
    // Memory and CPU of this process, for the resource budget (vocorum doctor, tests).
    if (pathname === '/admin/stats' && req.method === 'GET') {
      if (new URL(req.url ?? '/', 'http://x').searchParams.has('gc') && typeof globalThis.gc === 'function') globalThis.gc()
      const memory = process.memoryUsage()
      const usage = process.resourceUsage()
      return sendJson(res, 200, { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers, cpuUserMs: Math.round(usage.userCPUTime / 1000), cpuSystemMs: Math.round(usage.systemCPUTime / 1000), uptimeS: Math.round(process.uptime()), sockets: this.events.connections().length })
    }
    if (pathname.startsWith('/admin/mirror/')) return sendJson(res, 200, await this.mirror.handleAdmin(req, pathname))
    if (pathname.startsWith('/admin/requests')) return sendJson(res, 200, await this.requests.handleAdmin(req, pathname))
    const icon = await this.machineIcons.handleAdmin(req, pathname)
    if (icon !== undefined) return sendJson(res, 200, icon)
    if (pathname === '/admin/people' && req.method === 'GET') return sendJson(res, 200, { people: await this.people() })
    if (pathname === '/admin/people' && req.method === 'POST') return sendJson(res, 200, await this.invitePerson(await readJson(req)))
    const access = /^\/admin\/people\/([^/]+)\/access$/.exec(pathname)
    if (access && req.method === 'GET') return sendJson(res, 200, await this.personAccess(decodeURIComponent(access[1]!)))
    const remove = /^\/admin\/people\/([^/]+)$/.exec(pathname)
    if (remove && req.method === 'DELETE') return sendJson(res, 200, await this.removePerson(decodeURIComponent(remove[1]!)))
    throw new HttpError(404, 'Not found')
  }

  // People on the hub (not bots), with the guilds they are in and their active devices.
  private async people() {
    const users = await this.twin.prisma.user.findMany({ where: { bot: false }, include: { members: true } })
    const devices = (await this.store.listDevices()).filter((d) => !d.revokedAt)
    const profiles = await this.store.profiles()
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      global_name: u.globalName,
      owner: u.id === this.options.config.ownerUserId,
      guilds: u.members.map((m) => this.guilds.find((g) => g.id === m.guildId)?.name ?? m.guildId),
      devices: devices.filter((d) => this.userOf(d) === u.id).map((d) => d.name),
      tailscale_login: u.id === this.options.config.ownerUserId ? this.options.config.tailscaleLogin : (profiles[u.id]?.tailscaleLogin ?? null),
    }))
  }

  // CLI: what one person can see and do, worked out by the same rules the app uses.
  private async personAccess(name: string) {
    const user = await this.twin.prisma.user.findFirst({ where: { username: name.toLowerCase(), bot: false } })
    if (!user) throw new HttpError(404, `No person "${name}"`)
    const view = await this.access.view(user.id)
    const channels = await this.twin.prisma.channel.findMany({ where: { id: { in: [...view.channels.keys()] }, type: { in: [0, 2, 4, 5, 15] } }, select: { id: true, name: true, type: true, guildId: true, parentId: true } })
    const roles = await this.twin.prisma.role.findMany({ where: { guildId: { in: [...view.guilds.keys()] } } })
    const servers = [...view.guilds.entries()].map(([id, g]) => {
      const names = roles.filter((r) => g.roles.includes(r.id)).map((r) => r.name)
      const perms = g.perms
      return {
        id,
        name: this.guilds.find((x) => x.id === id)?.name ?? id,
        owner: g.owner,
        roles: names,
        // Kimaki takes orders from these: a shell on the machines.
        drives_agents: g.owner || (perms & P.ADMINISTRATOR) !== 0n || (perms & P.MANAGE_GUILD) !== 0n || names.some((n) => /^kimaki$/i.test(n)),
        manages_people: (perms & (P.ADMINISTRATOR | P.MANAGE_GUILD | P.MANAGE_ROLES)) !== 0n,
        channels: channels.filter((c) => c.guildId === id && c.type !== 4).map((c) => ({ id: c.id, name: c.name, category: channels.find((x) => x.id === c.parentId)?.name ?? null, send: ((view.channels.get(c.id) ?? 0n) & P.SEND_MESSAGES) !== 0n })),
      }
    })
    const devices = (await this.store.listDevices()).filter((d) => !d.revokedAt && this.userOf(d) === user.id).map((d) => d.name)
    const profile = (await this.store.profiles())[user.id]
    return { username: user.username, owner: user.id === this.options.config.ownerUserId, tailscale_login: profile?.tailscaleLogin ?? null, devices, servers }
  }

  // CLI: a new person in the given guilds, with a 24-hour code for their first device.
  private async invitePerson(body: Record<string, unknown>) {
    const guildIds = Array.isArray(body['guilds']) && body['guilds'].length ? (body['guilds'] as string[]) : [this.options.config.guildId]
    for (const id of guildIds) if (!this.guildIds.has(id)) throw new HttpError(404, `Unknown guild ${id}`)
    if (this.options.config.adminGuildId && guildIds.includes(this.options.config.adminGuildId)) throw new HttpError(400, 'The Admin server is only for you and your admin agent')
    const owner = { userId: this.options.config.ownerUserId, device: { id: 'cli', name: 'cli', userId: null, kind: 'web' as const, createdAt: 0, lastSeenAt: null, revokedAt: null } }
    const invite = (await this.members.invite(owner, guildIds[0]!, { username: body['username'], global_name: body['global_name'] })) as { user: { id: string } }
    for (const id of guildIds.slice(1)) await this.twin.addGuildMember({ guildId: id, userId: invite.user.id })
    if (typeof body['tailscale_login'] === 'string' && body['tailscale_login']) {
      await this.store.setProfile(invite.user.id, { tailscaleLogin: body['tailscale_login'] })
      await this.refreshLogins()
    }
    this.access.invalidate()
    return invite
  }

  // CLI: signs every device of the person out and takes them out of every guild. Their messages stay.
  private async removePerson(name: string) {
    const user = await this.twin.prisma.user.findFirst({ where: { OR: [{ id: name }, { username: name }], bot: false } })
    if (!user) throw new HttpError(404, `No person "${name}"`)
    if (user.id === this.options.config.ownerUserId) throw new HttpError(400, 'The owner cannot be removed')
    for (const device of (await this.store.listDevices()).filter((d) => !d.revokedAt && this.userOf(d) === user.id)) {
      await this.store.revokeDevice(device.id)
      this.events.disconnectDevice(device.id)
    }
    for (const member of await this.twin.prisma.guildMember.findMany({ where: { userId: user.id } })) await this.twin.removeGuildMember({ guildId: member.guildId, userId: user.id })
    await this.store.setProfile(user.id, { tailscaleLogin: null })
    await this.refreshLogins()
    this.access.invalidate()
    return { removed: user.username }
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return false
    }
    if (pathname === '/client/voice') {
      void this.voice.upgrade(req, socket, head)
      return true
    }
    if (pathname !== '/client/events') return false
    void this.events.upgrade(req, socket, head)
    return true
  }
}
