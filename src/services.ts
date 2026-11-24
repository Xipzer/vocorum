// Services agents run on the hub's machine: systemd user units and timers that
// live in the user's own unit directory or were started as transient units.
// Polled, with every change kept as a history (started, stopped, failed,
// restarted, new version) and the threads whose commands name the unit.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Hub } from './hub.ts'
import { kimakiDirs, type Links } from './links.ts'

const exec = promisify(execFile)
// VOCORUM_SYSTEMCTL swaps systemctl for a stand-in (tests).
const run = (cmd: string, args: string[], options: { maxBuffer?: number; timeout?: number } = {}) => exec(cmd === 'systemctl' ? (process.env['VOCORUM_SYSTEMCTL'] ?? 'systemctl') : cmd, args, options)
const POLL_MS = 15_000
const UNIT = /^[A-Za-z0-9@._:-]+\.(service|timer)$/
const PROPS = ['Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'Result', 'MainPID', 'NRestarts', 'FragmentPath', 'WorkingDirectory', 'UnitFileState', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp', 'ExecMainStartTimestamp', 'Triggers']

export type ServiceStatus = 'running' | 'waiting' | 'stopped' | 'failed' | 'restarting' | 'starting'
export type ServiceSummary = {
  unit: string
  kind: 'service' | 'timer'
  description: string
  status: ServiceStatus
  sub: string
  pid: number | null
  since: string | null
  restarts: number
  enabled: boolean
  transient: boolean
  version: string | null
  next: string | null
  threads: string[]
  // A service started by a timer names it; the timer names the service it runs.
  timer: string | null
  runs: string | null
}
export type ServiceEvent = { unit: string; at: number; kind: string; detail: string | null }
export type ServiceVerb = 'start' | 'stop' | 'restart'

function parseShow(text: string): Array<Record<string, string>> {
  return text
    .split(/\n\n+/)
    .map((block) => Object.fromEntries(block.split('\n').flatMap((line) => (line.includes('=') ? [[line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]] : []))))
    .filter((u) => u['Id'])
}

function stamp(value: string | undefined): string | null {
  if (!value || value === 'n/a' || value === '0') return null
  const ms = Date.parse(value.replace(/^\w{3} /, '').replace(/ ([A-Z]{2,5})$/, ''))
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

export function statusOf(u: Record<string, string>): ServiceStatus {
  const active = u['ActiveState']
  const sub = u['SubState'] ?? ''
  if (active === 'failed') return 'failed'
  if (sub === 'auto-restart') return 'restarting'
  if (active === 'activating' || active === 'reloading') return 'starting'
  if (active === 'active') return sub === 'running' || sub === 'listening' ? 'running' : 'waiting'
  return 'stopped'
}

// The commit a unit runs from, read from the work tree without running git.
function gitHead(dir: string | undefined): string | null {
  dir = dir?.replace(/^[!-]+/, '')
  if (!dir || !path.isAbsolute(dir)) return null
  try {
    let root = dir
    while (!fs.existsSync(path.join(root, '.git'))) {
      const up = path.dirname(root)
      // Never above the home directory: a unit that runs from ~ has no version.
      if (up === root || root === os.homedir()) return null
      root = up
    }
    let gitDir = path.join(root, '.git')
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(root, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir: /, '').trim())
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head.slice(0, 7)
    const ref = head.slice(5)
    const loose = path.join(gitDir, ref)
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 7)
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`))
    return packed?.slice(0, 7) ?? null
  } catch {
    return null
  }
}

// Unit names (without .service/.timer) a command or text starts, stops or writes.
export function unitNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const m of text.matchAll(/systemctl --user (?:start|restart|enable|stop|disable|reload-or-restart)(?: --now)?((?: [A-Za-z0-9@._:-]+)+)/g)) for (const n of m[1]!.trim().split(' ')) if (!n.startsWith('-')) names.add(n.replace(/\.(service|timer)$/, ''))
  for (const m of text.matchAll(/systemd-run --user[^\n]*?--unit[= ]?['"]?([A-Za-z0-9@._:-]+)/g)) names.add(m[1]!.replace(/\.(service|timer)$/, ''))
  for (const m of text.matchAll(/systemd\/user\/([A-Za-z0-9@._:-]+)\.(?:service|timer)/g)) names.add(m[1]!)
  return names
}

export class Services {
  private units = new Map<string, ServiceSummary & { fileMtime: number | null }>()
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<void> | null = null
  private origins = new Map<string, string[]>()
  private originsAt = 0
  readonly available: Promise<boolean>
  private userDir = path.join(os.homedir(), '.config/systemd/user')

  constructor(
    private readonly hub: Hub,
    private readonly emit: (event: string, data: unknown) => void,
    private readonly links?: Links,
  ) {
    this.available = run('systemctl', ['--user', '--version']).then(
      () => true,
      () => false,
    )
  }

  async start() {
    if (!(await this.available)) return
    // The last state seen before the hub stopped, so changes while it was down are still recorded.
    const saved = await this.hub.store.serviceSnapshots().catch(() => ({}))
    for (const [unit, snap] of Object.entries(saved)) this.units.set(unit, snap as ServiceSummary & { fileMtime: number | null })
    await this.poll(Object.keys(saved).length === 0).catch(() => {})
    this.timer = setInterval(() => void this.poll(false).catch(() => {}), POLL_MS)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  list(): ServiceSummary[] {
    return [...this.units.values()].map(({ fileMtime: _, ...s }) => s).sort((a, b) => a.unit.localeCompare(b.unit))
  }

  // Units that are the user's own (in ~/.config/systemd/user) or transient ones agents started.
  private ours(u: Record<string, string>) {
    const file = u['FragmentPath'] ?? ''
    if (file.startsWith(this.userDir)) return true
    return file.includes('/transient/')
  }

  poll(first = false): Promise<void> {
    this.polling ??= this.doPoll(first).finally(() => (this.polling = null))
    return this.polling
  }

  private async doPoll(first: boolean) {
    const { stdout } = await run('systemctl', ['--user', 'list-units', '--type=service,timer', '--all', '--output=json', '--no-pager'], { maxBuffer: 8 << 20 })
    const names = (JSON.parse(stdout) as Array<{ unit: string; load: string }>).filter((u) => UNIT.test(u.unit) && u.load !== 'not-found').map((u) => u.unit)
    if (!names.length) return
    const show = await run('systemctl', ['--user', 'show', ...names, `-p${PROPS.join(',')}`, '--no-pager'], { maxBuffer: 16 << 20 })
    await this.loadOrigins()
    const timers = new Map<string, number>()
    try {
      const t = await run('systemctl', ['--user', 'list-timers', '--all', '--output=json', '--no-pager'])
      for (const row of JSON.parse(t.stdout) as Array<{ unit: string; next: number | null }>) if (row.next) timers.set(row.unit, Math.round(row.next / 1000))
    } catch {}
    const seen = new Set<string>()
    const changed: ServiceSummary[] = []
    const now = Date.now()
    const parsed = parseShow(show.stdout).filter((u) => this.ours(u))
    const triggeredBy = new Map(parsed.filter((u) => u['Id']!.endsWith('.timer') && u['Triggers']).map((u) => [u['Triggers']!, u['Id']!]))
    for (const u of parsed) {
      const unit = u['Id']!
      const kind = unit.endsWith('.timer') ? 'timer' : 'service'
      const status = statusOf(u)
      const transient = (u['FragmentPath'] ?? '').includes('/transient/')
      const since = stamp(u['ActiveEnterTimestamp']) ?? stamp(u['InactiveEnterTimestamp'])
      // Transient one-shots that finished over an hour ago are clutter.
      if (transient && status === 'stopped' && (!since || now - Date.parse(since) > 3_600_000)) continue
      if (transient && status === 'waiting' && u['SubState'] === 'exited' && since && now - Date.parse(since) > 3_600_000) continue
      seen.add(unit)
      let fileMtime: number | null = null
      try {
        fileMtime = u['FragmentPath'] ? fs.statSync(u['FragmentPath']).mtimeMs : null
      } catch {}
      const next: ServiceSummary & { fileMtime: number | null } = {
        unit,
        kind,
        description: u['Description'] && u['Description'] !== unit ? u['Description'] : '',
        status,
        sub: u['SubState'] ?? '',
        pid: Number(u['MainPID']) || null,
        since,
        restarts: Number(u['NRestarts']) || 0,
        enabled: u['UnitFileState'] === 'enabled',
        transient,
        version: gitHead(u['WorkingDirectory']),
        next: timers.has(unit) ? new Date(timers.get(unit)!).toISOString() : null,
        threads: this.origins.get(unit.replace(/\.(service|timer)$/, '')) ?? [],
        timer: triggeredBy.get(unit) ?? null,
        runs: kind === 'timer' ? (u['Triggers'] || null) : null,
        fileMtime,
      }
      const before = this.units.get(unit)
      this.units.set(unit, next)
      const events = this.diff(before, next, first)
      for (const e of events) await this.hub.store.addServiceEvent(e)
      const { fileMtime: _, ...pub } = next
      const { fileMtime: __, ...prev } = before ?? next
      if (!before || JSON.stringify(prev) !== JSON.stringify(pub)) changed.push(pub)
    }
    const removed = [...this.units.keys()].filter((unit) => !seen.has(unit))
    for (const unit of removed) {
      this.units.delete(unit)
      await this.hub.store.addServiceEvent({ unit, at: now, kind: 'removed', detail: null })
    }
    if (changed.length || removed.length) await this.hub.store.saveServiceSnapshots([...this.units.values()])
    if (!first && (changed.length || removed.length)) this.emit('SERVICES', { services: this.list() })
  }

  private diff(before: (ServiceSummary & { fileMtime: number | null }) | undefined, next: ServiceSummary & { fileMtime: number | null }, first: boolean): ServiceEvent[] {
    const at = next.since ? Date.parse(next.since) : Date.now()
    if (!before) return first ? [] : [{ unit: next.unit, at: Date.now(), kind: 'appeared', detail: next.status }]
    const out: ServiceEvent[] = []
    const verb: Partial<Record<ServiceStatus, string>> = { running: 'started', waiting: 'started', stopped: 'stopped', failed: 'failed', restarting: 'crashed' }
    if (before.status !== next.status && verb[next.status]) out.push({ unit: next.unit, at, kind: verb[next.status]!, detail: next.status === 'failed' ? next.sub : null })
    else if (before.status === next.status && next.status === 'running' && before.since !== next.since) out.push({ unit: next.unit, at, kind: 'restarted', detail: null })
    if (next.restarts > before.restarts && next.status !== 'restarting') out.push({ unit: next.unit, at, kind: 'crashed', detail: `restarted automatically (${next.restarts})` })
    if (before.version && next.version && before.version !== next.version) out.push({ unit: next.unit, at, kind: 'version', detail: `${before.version} → ${next.version}` })
    if (before.fileMtime && next.fileMtime && before.fileMtime !== next.fileMtime) out.push({ unit: next.unit, at: next.fileMtime, kind: 'unit file changed', detail: null })
    return out
  }

  // Threads whose messages run systemctl on a unit or write its unit file, newest first.
  private async loadOrigins() {
    if (Date.now() - this.originsAt < 5 * 60_000) return
    this.originsAt = Date.now()
    await this.links?.whenReady()
    const rows = await this.hub.twin.prisma.message.findMany({
      where: { OR: [{ content: { contains: 'systemctl --user' } }, { content: { contains: 'systemd-run --user' } }, { content: { contains: 'systemd/user/' } }] },
      select: { channelId: true, content: true },
      orderBy: { id: 'desc' },
      take: 20_000,
    })
    const map = new Map<string, string[]>()
    for (const row of rows) {
      for (const name of unitNames(row.content)) {
        const list = map.get(name) ?? []
        if (!list.includes(row.channelId) && list.length < 5) list.push(row.channelId)
        map.set(name, list)
      }
    }
    // Kimaki transcripts carry the full shell commands; Discord often shows only a description.
    for (const dir of kimakiDirs(this.hub.options.paths.root)) {
      const transcripts = path.join(dir, 'transcripts')
      if (!this.links || !fs.existsSync(transcripts)) continue
      const found = await run('grep', ['-r', '-o', '-E', '--include=*.md', 'systemctl --user (start|restart|enable|stop|disable|reload-or-restart)( --now)?( [A-Za-z0-9@._:-]+)+|systemd/user/[A-Za-z0-9@._:-]+\\.(service|timer)|systemd-run --user[^"]{0,160}--unit[= ]?[A-Za-z0-9@._:-]+', transcripts], { maxBuffer: 64 << 20 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }))
      for (const line of found.stdout.split('\n')) {
        const colon = line.indexOf(':')
        if (colon < 0) continue
        const thread = this.links.threadOf(path.basename(line.slice(0, colon), '.md'))
        if (!thread) continue
        for (const name of unitNames(line.slice(colon + 1))) {
          const list = map.get(name) ?? []
          if (!list.includes(thread) && list.length < 5) list.push(thread)
          map.set(name, list)
        }
      }
    }
    this.origins = map
  }

  // A thread just ran a unit command: look the origins up again on the next poll.
  observe(event: string, data: any) {
    if ((event === 'MESSAGE_CREATE' || event === 'MESSAGE_UPDATE') && typeof data?.content === 'string' && /systemctl --user|systemd-run --user|systemd\/user\//.test(data.content)) {
      this.originsAt = 0
      setTimeout(() => void this.poll(false).catch(() => {}), 500).unref()
    }
  }

  async control(unit: string, verb: ServiceVerb) {
    if (!UNIT.test(unit) || !this.units.has(unit)) throw new Error('Unknown service')
    await this.hub.store.addServiceEvent({ unit, at: Date.now(), kind: `${verb} requested`, detail: 'from the hub' })
    await run('systemctl', ['--user', verb, unit], { timeout: 30_000 })
    await this.poll(false)
  }
}
