// A picture per machine, like on Discord where each machine's Kimaki bot has
// its own avatar and its own server icon. Each machine's Kimaki can upload
// its own two pictures with its hub bot token (it can only set its own); the
// hub owner can set or clear any of them from the app.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { HttpError } from './auth.ts'
import { match, readBody } from './http.ts'
import type { Hub } from './hub.ts'
import { imageType } from './settings.ts'
import type { Viewer } from './client-api.ts'

export const MACHINE_ICON_KINDS = ['avatar', 'guild_icon'] as const
export type MachineIconKind = (typeof MACHINE_ICON_KINDS)[number]
export type MachineIcons = Record<string, { avatar: string | null; guild_icon: string | null }>
const IMAGE_LIMIT = 4 * 1024 * 1024

const kindOf = (value: string): MachineIconKind => {
  if (!(MACHINE_ICON_KINDS as readonly string[]).includes(value)) throw new HttpError(400, 'kind must be avatar or guild_icon')
  return value as MachineIconKind
}

export class MachineIconStore {
  constructor(private readonly hub: Hub) {}

  private file(machine: string, kind: MachineIconKind) {
    const key = crypto.createHash('sha256').update(machine.toLowerCase()).digest('hex').slice(0, 24)
    return path.join(this.hub.options.paths.media, `machine-${key}-${kind}.png`)
  }

  async list(): Promise<MachineIcons> {
    const out: MachineIcons = {}
    for (const row of (await this.hub.store.db.execute('SELECT machine, kind, hash FROM machine_icons')).rows) {
      const machine = String(row['machine'])
      out[machine] ??= { avatar: null, guild_icon: null }
      out[machine][String(row['kind']) as MachineIconKind] = String(row['hash'])
    }
    return out
  }

  // Machines are matched case-insensitively and keep the bot's spelling.
  private async canonical(machine: string) {
    const bots = (await this.hub.store.listBots()).filter((b) => !b.revokedAt).map((b) => b.machine)
    const names = [...bots, ...(await this.hub.sessions.machines()).map((m) => m.name)]
    return names.find((n) => n.toLowerCase() === machine.toLowerCase()) ?? null
  }

  // anyName: the CLI may set pictures for a machine before it joins the hub.
  async set(machine: string, kind: MachineIconKind, data: Buffer | null, { anyName = false } = {}) {
    const name = (await this.canonical(machine)) ?? (anyName && /^[\p{L}\p{N} ._-]{1,64}$/u.test(machine) ? machine : null)
    if (!name) throw new HttpError(404, 'Unknown machine')
    const file = this.file(name, kind)
    if (data) {
      if (!imageType(data)) throw new HttpError(400, 'Send a PNG, JPEG, GIF or WebP image')
      fs.mkdirSync(this.hub.options.paths.media, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, data, { mode: 0o600 })
      const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)
      await this.hub.store.db.execute({
        sql: 'INSERT INTO machine_icons (machine, kind, hash, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(machine, kind) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at',
        args: [name, kind, hash, Date.now()],
      })
    } else {
      fs.rmSync(file, { force: true })
      await this.hub.store.db.execute({ sql: 'DELETE FROM machine_icons WHERE machine = ? AND kind = ?', args: [name, kind] })
    }
    const icons = (await this.list())[name] ?? { avatar: null, guild_icon: null }
    this.hub.events.send('MACHINE_ICONS_UPDATE', { machine: name, ...icons }, { shape: async (userId) => ((await this.hub.visibleMachines(userId)).has(name.toLowerCase()) ? { machine: name, ...icons } : null) })
    return { machine: name, ...icons }
  }

  // /client/machine-icons/:machine/:kind: GET for people who see the machine; PUT and DELETE for the hub owner.
  async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, v: Viewer): Promise<unknown | undefined> {
    const params = match('/client/machine-icons/:machine/:kind', pathname)
    if (!params) return undefined
    const kind = kindOf(params['kind']!)
    const machine = params['machine']!
    if (req.method === 'GET') {
      if (!(await this.hub.visibleMachines(v.userId)).has(machine.toLowerCase())) throw new HttpError(404, 'No image')
      const name = (await this.canonical(machine)) ?? machine
      this.hub.settings.serveImage(res, this.file(name, kind))
      return null
    }
    if (!this.hub.access.isHubOwner(v.userId)) throw new HttpError(403, 'Only the hub owner sets machine pictures')
    if (req.method === 'PUT') return this.set(machine, kind, await readBody(req, IMAGE_LIMIT))
    if (req.method === 'DELETE') return this.set(machine, kind, null)
    throw new HttpError(405, 'Method not allowed')
  }

  // PUT /admin/machine-icons/:machine/:kind (CLI, admin token).
  async handleAdmin(req: http.IncomingMessage, pathname: string) {
    const params = match('/admin/machine-icons/:machine/:kind', pathname)
    if (!params) return undefined
    const kind = kindOf(params['kind']!)
    if (req.method === 'PUT') return this.set(params['machine']!, kind, await readBody(req, IMAGE_LIMIT), { anyName: true })
    if (req.method === 'DELETE') return this.set(params['machine']!, kind, null, { anyName: true })
    throw new HttpError(405, 'Method not allowed')
  }

  // PUT /hub/machine-icons/:kind with `Authorization: Bot <hub bot token>`: a machine sets its own picture.
  // GET /hub/machine-icons: its current hashes, so it uploads only what changed.
  async handleBot(req: http.IncomingMessage, pathname: string, machine: string) {
    if (pathname === '/hub/machine-icons' && req.method === 'GET') {
      const name = (await this.canonical(machine)) ?? machine
      return { machine: name, ...((await this.list())[name] ?? { avatar: null, guild_icon: null }) }
    }
    const params = match('/hub/machine-icons/:kind', pathname)
    if (!params) throw new HttpError(404, 'Not found')
    const kind = kindOf(params['kind']!)
    if (req.method === 'PUT') return this.set(machine, kind, await readBody(req, IMAGE_LIMIT))
    if (req.method === 'DELETE') return this.set(machine, kind, null)
    throw new HttpError(405, 'Method not allowed')
  }
}
