// Requests: changes an agent asks for and the owner approves.
//
// Agents drive configuration through the CLI. Anything that widens who can see
// or do what (inviting someone, giving a role, opening a channel to someone,
// deleting on Discord) is filed as a request instead of being applied: the
// owner sees it in the app with where it came from, and approves it with a
// fresh passkey check on one of their devices. The approved change then runs
// through the same route and the same permission checks as the settings
// screens, acting as the owner.
//
// Honest limit: an agent that runs as the same OS user as the hub can read the
// hub's admin token and databases, so for it this is a guard against mistakes
// and prompt injection, not a wall. Running the hub as its own OS user makes
// it a wall.

import crypto from 'node:crypto'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { HttpError } from './auth.ts'
import { match, readJson } from './http.ts'
import type { Hub } from './hub.ts'
import type { Viewer } from './client-api.ts'

const TTL_MS = 24 * 3_600_000
const STEP_UP_MS = 5 * 60_000

// Client routes a request may carry. Never auth, devices, services or bots.
const ALLOWED: Array<{ method: string; route: string; kind: string; shell?: (body: Record<string, unknown>) => boolean }> = [
  { method: 'POST', route: '/client/guilds/:id/invites', kind: 'invite a person' },
  { method: 'DELETE', route: '/client/guilds/:id/members/:user', kind: 'remove a person' },
  { method: 'PUT', route: '/client/guilds/:id/members/:user/roles', kind: 'change roles', shell: () => true },
  { method: 'POST', route: '/client/guilds/:id/roles', kind: 'create a role', shell: () => true },
  { method: 'PATCH', route: '/client/guilds/:id/roles/:role', kind: 'change a role', shell: () => true },
  { method: 'PUT', route: '/client/channels/:id/permissions/:target', kind: 'change who can use a channel' },
  { method: 'DELETE', route: '/client/channels/:id/permissions/:target', kind: 'change who can use a channel' },
  { method: 'POST', route: '/client/guilds/:id/channels', kind: 'create a channel' },
  { method: 'PATCH', route: '/client/channels/:id/settings', kind: 'change a channel' },
  { method: 'DELETE', route: '/client/channels/:id', kind: 'delete a channel' },
  { method: 'PATCH', route: '/client/guilds/:id', kind: 'change a server' },
]

export type RequestRow = { id: string; method: string; route: string; body: string; kind: string; summary: string; reason: string; origin: string; created_at: number; expires_at: number; status: 'pending' | 'approved' | 'denied' | 'failed' | 'expired'; decided_at: number | null; result: string | null; undo?: string | null }

export class Requests {
  private ready: Promise<void> | null = null
  private challenges = new Map<string, { requestId: string; deviceId: string; at: number; challenge?: string }>()

  constructor(private readonly hub: Hub) {}

  private get db() {
    return this.hub.store.db
  }

  private migrate() {
    this.ready ??= this.db
      .execute(`CREATE TABLE IF NOT EXISTS change_requests (
        id TEXT PRIMARY KEY, method TEXT NOT NULL, route TEXT NOT NULL, body TEXT NOT NULL,
        kind TEXT NOT NULL, summary TEXT NOT NULL, reason TEXT NOT NULL, origin TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
        decided_at INTEGER, result TEXT, undo TEXT)`)
      .then(() => this.db.execute('ALTER TABLE change_requests ADD COLUMN undo TEXT').catch(() => undefined))
      .then(() => undefined)
    return this.ready
  }

  private async rows(where = '1 = 1', args: Array<string | number> = []): Promise<RequestRow[]> {
    await this.migrate()
    await this.db.execute({ sql: "UPDATE change_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", args: [Date.now()] })
    return (await this.db.execute({ sql: `SELECT * FROM change_requests WHERE ${where} ORDER BY created_at DESC LIMIT 200`, args })).rows as unknown as RequestRow[]
  }

  private owner(): Viewer {
    return { userId: this.hub.options.config.ownerUserId, device: { id: 'request', name: 'request', userId: null, kind: 'web', createdAt: 0, lastSeenAt: null, revokedAt: null } }
  }

  // POST /admin/requests { method, route, body, summary, reason, origin }
  async create(input: Record<string, unknown>, { prefix = '' }: { prefix?: string } = {}) {
    const method = String(input['method'] ?? '').toUpperCase()
    const route = String(input['route'] ?? '')
    // Plain ids only: an encoded route would be judged on one id and applied to another.
    if (!/^[A-Za-z0-9/_-]{1,300}$/.test(route)) throw new HttpError(400, 'route must be a plain path')
    const allowed = ALLOWED.find((a) => a.method === method && match(a.route, route))
    if (!allowed) throw new HttpError(400, `Requests can only carry: ${[...new Set(ALLOWED.map((a) => a.kind))].join(', ')}`)
    const body = input['body'] && typeof input['body'] === 'object' ? (input['body'] as Record<string, unknown>) : {}
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    if (body['username'] !== undefined && body['user_id'] !== undefined) throw new HttpError(400, 'An invite names a new person (username) or an existing one (user_id), not both')
    // The Admin server is the owner's and their admin agent's alone: no request adds anyone or changes it.
    const adminGuild = this.hub.options.config.adminGuildId
    if (adminGuild && (await this.guildOf(route)) === adminGuild) throw new HttpError(400, 'The Admin server is only for you and your admin agent. Nothing can add people to it or change it through a request.')
    const row: RequestRow = {
      id: crypto.randomBytes(6).toString('hex'),
      method,
      route,
      body: JSON.stringify(body),
      kind: allowed.kind,
      // The card says what the change does in the hub's words; a requester's summary could misdescribe it.
      summary: prefix + (await this.describe(method, route, body)),
      reason: text(input['reason'], 1000),
      origin: text(input['origin'], 300) || 'cli',
      created_at: Date.now(),
      expires_at: Date.now() + TTL_MS,
      status: 'pending',
      decided_at: null,
      result: null,
    }
    if (allowed.shell?.(body)) row.summary += ' (roles can give a shell on your machines through agents: check which)'
    await this.migrate()
    await this.db.execute({ sql: 'INSERT INTO change_requests (id, method, route, body, kind, summary, reason, origin, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [row.id, row.method, row.route, row.body, row.kind, row.summary, row.reason, row.origin, row.created_at, row.expires_at, row.status] })
    this.notify('REQUEST_CREATE', this.toClient(row))
    return this.toClient(row)
  }

  private async guildOf(route: string): Promise<string | null> {
    const guild = /^\/client\/guilds\/(\d{1,20})(\/|$)/.exec(route)
    if (guild) return guild[1]!
    const channel = /^\/client\/channels\/(\d{1,20})(\/|$)/.exec(route)
    if (channel) return (await this.hub.twin.prisma.channel.findUnique({ where: { id: channel[1]! }, select: { guildId: true } }))?.guildId ?? null
    return null
  }

  // A plain sentence for the approval card.
  private async describe(method: string, route: string, body: Record<string, unknown>): Promise<string> {
    const prisma = this.hub.twin.prisma
    const guildName = async (id: string) => this.hub.guilds.find((g) => g.id === id)?.name ?? 'the server'
    const userName = async (id: string) => (await prisma.user.findUnique({ where: { id } }))?.username ?? 'someone'
    const channelName = async (id: string) => `#${(await prisma.channel.findUnique({ where: { id } }))?.name ?? 'a channel'}`
    const roleName = async (id: string) => (await prisma.role.findUnique({ where: { id } }))?.name ?? 'a role'
    const target = async (channel: string, id: string) => {
      const c = await prisma.channel.findUnique({ where: { id: channel } })
      if (id === c?.guildId) return 'everyone'
      return (await prisma.role.findUnique({ where: { id } }))?.name ?? (await userName(id))
    }
    const { P } = await import('./access.ts')
    // Permission bits in words, so the card shows exactly what is granted.
    const perms = (value: unknown) => {
      let bits: bigint
      try {
        bits = BigInt(String(value ?? '0'))
      } catch {
        return 'unreadable permissions'
      }
      const names = Object.entries(P as Record<string, bigint>).filter(([, bit]) => bits & bit).map(([name]) => (name === 'ADMINISTRATOR' ? 'ADMINISTRATOR (everything)' : name.toLowerCase()))
      return names.length ? names.join(', ') : 'nothing'
    }
    const roleChange = body['permissions'] !== undefined ? ` with permissions: ${perms(body['permissions'])}` : ''
    let p: Record<string, string> | null
    if ((p = match('/client/guilds/:id/invites', route))) return typeof body['user_id'] === 'string' ? `Add ${await userName(body['user_id'])} (already on the hub) to ${await guildName(p['id']!)}` : `Invite a new person, ${String(body['username'] ?? 'someone')}, to ${await guildName(p['id']!)}`
    if ((p = match('/client/guilds/:id/members/:user/roles', route))) {
      const roles = Array.isArray(body['roles']) ? await Promise.all((body['roles'] as string[]).map(roleName)) : []
      return `Set ${await userName(p['user']!)}'s roles in ${await guildName(p['id']!)} to ${roles.length ? roles.join(', ') : 'none'}`
    }
    if ((p = match('/client/guilds/:id/members/:user', route))) return `Remove ${await userName(p['user']!)} from ${await guildName(p['id']!)}`
    if ((p = match('/client/guilds/:id/roles/:role', route))) return `Change the role ${await roleName(p['role']!)} in ${await guildName(p['id']!)}${body['name'] !== undefined ? `, name ${String(body['name'])}` : ''}${roleChange}`
    if ((p = match('/client/guilds/:id/roles', route))) return `Create the role ${String(body['name'] ?? '')} in ${await guildName(p['id']!)}${roleChange}`
    if ((p = match('/client/channels/:id/permissions/:target', route))) return method === 'DELETE' ? `Reset ${await channelName(p['id']!)} permissions for ${await target(p['id']!, p['target']!)}` : `Change who can use ${await channelName(p['id']!)}: ${await target(p['id']!, p['target']!)} may ${perms(body['allow'])}${BigInt(String(body['deny'] ?? '0') || '0') ? `, may not ${perms(body['deny'])}` : ''}`
    // Everything else the change carries, so nothing is applied that the card does not say.
    const overwrites = async (channel: string | null, guild: string) => {
      const list = Array.isArray(body['permission_overwrites']) ? (body['permission_overwrites'] as Array<Record<string, unknown>>) : []
      const parts = await Promise.all(list.map(async (o) => {
        const who = String(o['id']) === guild ? 'everyone' : channel ? await target(channel, String(o['id'])) : ((await prisma.role.findUnique({ where: { id: String(o['id']) } }))?.name ?? (await userName(String(o['id']))))
        return `${who} may ${perms(o['allow'])}${BigInt(String(o['deny'] ?? '0') || '0') ? `, may not ${perms(o['deny'])}` : ''}`
      }))
      return parts.length ? `; permissions: ${parts.join('; ')}` : ''
    }
    const settings = async (skip: string[] = []) => {
      const shown: string[] = []
      for (const [key, value] of Object.entries(body)) {
        if (key === 'permission_overwrites' || skip.includes(key)) continue
        shown.push(key === 'parent_id' ? `category ${value ? await channelName(String(value)) : 'none'}` : `${key} ${JSON.stringify(value).slice(0, 120)}`)
      }
      return shown.length ? `: ${shown.join(', ')}` : ''
    }
    if ((p = match('/client/guilds/:id/channels', route))) return `Create the channel #${String(body['name'] ?? '')} in ${await guildName(p['id']!)}${await settings(['name'])}${await overwrites(null, p['id']!)}`
    if ((p = match('/client/channels/:id/settings', route))) {
      const channel = await prisma.channel.findUnique({ where: { id: p['id']! }, select: { guildId: true } })
      return `Change ${await channelName(p['id']!)}${await settings()}${await overwrites(p['id']!, channel?.guildId ?? '')}`
    }
    if ((p = match('/client/channels/:id', route))) return `Delete ${await channelName(p['id']!)}`
    if ((p = match('/client/guilds/:id', route))) return `Rename ${await guildName(p['id']!)} to ${String(body['name'] ?? '')}`
    return `${method} ${route}`
  }

  private toClient(r: RequestRow) {
    return { id: r.id, kind: r.kind, summary: r.summary, reason: r.reason, origin: r.origin, method: r.method, route: r.route, body: JSON.parse(r.body) as unknown, status: r.status, created_at: Number(r.created_at), expires_at: Number(r.expires_at), decided_at: r.decided_at === null ? null : Number(r.decided_at), result: r.result ? (JSON.parse(r.result) as unknown) : null, undoable: Boolean(r.undo) }
  }

  private notify(event: string, data: unknown) {
    this.hub.events.send(event, data, { shape: async (userId) => (this.hub.access.isHubOwner(userId) ? data : null) })
  }

  async list(status?: string) {
    return (status ? await this.rows('status = ?', [status]) : await this.rows()).map((r) => this.toClient(r))
  }

  private async pending(id: string) {
    const [row] = await this.rows('id = ?', [id])
    if (!row) throw new HttpError(404, 'Unknown request')
    if (row.status !== 'pending') throw new HttpError(409, `This request is ${row.status}`)
    return row
  }

  // Runs the change as the owner, through the same handlers as the settings screens.
  private async apply(row: RequestRow) {
    const body = Buffer.from(row.body)
    const req = Object.assign(Readable.from([body]), { method: row.method, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }) as unknown as http.IncomingMessage
    const owner = this.owner()
    const before = await this.snapshot(row)
    try {
      let result = await this.hub.members.handle(req, row.route, owner)
      if (result === undefined) result = await this.hub.settings.handle(req, {} as http.ServerResponse, row.route, owner)
      if (result === undefined) throw new HttpError(400, 'Nothing handles that change')
      const undo = before ?? this.reverseFromResult(row, result)
      if (undo) await this.db.execute({ sql: 'UPDATE change_requests SET undo = ? WHERE id = ?', args: [JSON.stringify(undo), row.id] })
      await this.decide(row.id, 'approved', result)
      return result
    } catch (error) {
      await this.decide(row.id, 'failed', { error: (error as Error).message })
      throw error
    }
  }

  // The change that puts things back, taken before applying. null: not reversible this way.
  private async snapshot(row: RequestRow): Promise<{ method: string; route: string; body: unknown } | null> {
    const prisma = this.hub.twin.prisma
    let p: Record<string, string> | null
    if ((p = match('/client/guilds/:id/members/:user/roles', row.route))) {
      const member = await prisma.guildMember.findUnique({ where: { guildId_userId: { guildId: p['id']!, userId: p['user']! } } })
      return member ? { method: 'PUT', route: row.route, body: { roles: JSON.parse(member.roles) as string[] } } : null
    }
    if ((p = match('/client/channels/:id/permissions/:target', row.route))) {
      const existing = (await this.hub.store.overwrites()).get(p['id']!)?.find((o) => o.id === p!['target'])
      return existing ? { method: 'PUT', route: row.route, body: { type: existing.type, allow: existing.allow, deny: existing.deny } } : { method: 'DELETE', route: row.route, body: {} }
    }
    if ((p = match('/client/channels/:id/settings', row.route))) {
      const c = await prisma.channel.findUnique({ where: { id: p['id']! } })
      return c ? { method: 'PATCH', route: row.route, body: { name: c.name, topic: c.topic, parent_id: c.parentId, position: c.position } } : null
    }
    if ((p = match('/client/guilds/:id', row.route)) && row.method === 'PATCH') {
      const g = this.hub.guilds.find((x) => x.id === p!['id'])
      return g ? { method: 'PATCH', route: row.route, body: { name: g.name } } : null
    }
    return null
  }

  // Reversals that need the result: a new channel is deleted, an invited person removed.
  private reverseFromResult(row: RequestRow, result: unknown): { method: string; route: string; body: unknown } | null {
    const r = result as { id?: string; user?: { id?: string } }
    let p: Record<string, string> | null
    if ((p = match('/client/guilds/:id/channels', row.route)) && row.method === 'POST' && r?.id) return { method: 'DELETE', route: `/client/channels/${r.id}`, body: {} }
    if ((p = match('/client/guilds/:id/invites', row.route)) && r?.user?.id) return { method: 'DELETE', route: `/client/guilds/${p['id']}/members/${r.user.id}`, body: {} }
    return null
  }

  // A new request that reverts an approved one; it needs approval like any other.
  async undo(id: string, origin: string) {
    const [row] = await this.rows('id = ?', [id])
    if (!row) throw new HttpError(404, 'Unknown request')
    if (row.status !== 'approved' || !row.undo) throw new HttpError(409, 'That request cannot be undone this way')
    const reverse = JSON.parse(row.undo) as { method: string; route: string; body: Record<string, unknown> }
    return this.create({ ...reverse, reason: `Reverts request ${row.id}: ${row.summary}`, origin }, { prefix: 'Undo: ' })
  }

  private async decide(id: string, status: RequestRow['status'], result: unknown) {
    await this.db.execute({ sql: 'UPDATE change_requests SET status = ?, decided_at = ?, result = ? WHERE id = ?', args: [status, Date.now(), JSON.stringify(result ?? null), id] })
    const [row] = await this.rows('id = ?', [id])
    if (row) this.notify('REQUEST_UPDATE', this.toClient(row))
  }

  // /admin/requests (local CLI): create, list, deny. Approving needs a passkey, so it is not here.
  async handleAdmin(req: http.IncomingMessage, pathname: string) {
    const method = req.method ?? 'GET'
    if (pathname === '/admin/requests' && method === 'POST') return this.create(await readJson(req))
    if (pathname === '/admin/requests' && method === 'GET') return { requests: await this.list() }
    const undo = match('/admin/requests/:id/undo', pathname)
    if (undo && method === 'POST') return this.undo(undo['id']!, String((await readJson(req))['origin'] ?? 'cli'))
    const params = match('/admin/requests/:id/deny', pathname)
    if (params && method === 'POST') {
      await this.pending(params['id']!)
      await this.decide(params['id']!, 'denied', null)
      return { denied: params['id'] }
    }
    throw new HttpError(404, 'Not found')
  }

  // /client/requests: the owner lists, approves (fresh passkey) or denies.
  async handleClient(req: http.IncomingMessage, pathname: string, v: Viewer, origin: string | null): Promise<unknown | undefined> {
    if (!pathname.startsWith('/client/requests')) return undefined
    if (!this.hub.access.isHubOwner(v.userId)) throw new HttpError(403, 'Only the hub owner decides requests')
    const method = req.method ?? 'GET'
    let params: Record<string, string> | null
    if (pathname === '/client/requests' && method === 'GET') return { requests: await this.list() }
    if ((params = match('/client/requests/:id/undo', pathname)) && method === 'POST') return this.undo(params['id']!, `app (${v.device.name})`)
    if ((params = match('/client/requests/:id/deny', pathname)) && method === 'POST') {
      await this.pending(params['id']!)
      await this.decide(params['id']!, 'denied', null)
      return { denied: params['id'] }
    }
    // Step-up: a passkey assertion made for this request, on this device, now.
    if ((params = match('/client/requests/:id/approve/options', pathname)) && method === 'POST') {
      await this.pending(params['id']!)
      // Apps sign with their approval key instead (see HubAuth.verifyAppApproval).
      if (v.device.kind === 'app') {
        const challenge = crypto.randomBytes(32).toString('base64url')
        const challengeId = crypto.randomBytes(16).toString('base64url')
        this.challenges.set(challengeId, { requestId: params['id']!, deviceId: v.device.id, at: Date.now(), challenge })
        return { challengeId, challenge }
      }
      const options = await this.hub.auth.loginOptions(origin!)
      this.challenges.set(options.challengeId, { requestId: params['id']!, deviceId: v.device.id, at: Date.now() })
      return options
    }
    if ((params = match('/client/requests/:id/approve', pathname)) && method === 'POST') {
      const body = await readJson(req)
      const challenge = typeof body['challengeId'] === 'string' ? this.challenges.get(body['challengeId']) : undefined
      if (typeof body['challengeId'] === 'string') this.challenges.delete(body['challengeId'])
      if (!challenge || challenge.requestId !== params['id'] || challenge.deviceId !== v.device.id || Date.now() - challenge.at > STEP_UP_MS) throw new HttpError(400, 'Confirm with your passkey again')
      const row = await this.pending(params['id']!)
      if (v.device.kind === 'app') {
        if (!challenge.challenge) throw new HttpError(400, 'Confirm on this device again')
        await this.hub.auth.verifyAppApproval(v.device.id, challenge.challenge, row.id, body)
        return { result: await this.apply(row) }
      }
      const { device } = await this.hub.auth.login(origin!, body, { stepUp: true })
      if (device.id !== v.device.id) throw new HttpError(403, 'Use the passkey of this device')
      return { result: await this.apply(row) }
    }
    throw new HttpError(404, 'Not found')
  }
}
