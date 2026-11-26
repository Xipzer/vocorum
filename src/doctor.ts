// `vocorum doctor`: checks every layer a device or bot goes through, and for
// anything wrong prints the one command that fixes it. Read only. Safe to run
// any time, including by an agent (--json).

import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@libsql/client'
import { openSqlite } from './sqlite.ts'
import { loadConfig, readSecret, type HubConfig, type HubPaths } from './config.ts'
import { launchdLabel, launchdState, listeningSockets, NODE_MIN, nodeSupported, taskName, taskState, tool, WINDOWS } from './platform.ts'

const run = promisify(execFile)

export type Check = { id: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string; fix?: string }

const KIMAKI_ROLE = /^kimaki$/i
const ADMINISTRATOR = 1n << 3n
const MANAGE_GUILD = 1n << 5n

async function quiet(cmd: string, args: string[]) {
  try {
    return (await run(cmd, args, { timeout: 5000 })).stdout
  } catch {
    return null
  }
}

// Milliseconds for the hub to answer an admin request with our token; null when
// nothing answers; 'other' when something else (another hub) holds the port.
export async function hubLatency(config: HubConfig, paths: HubPaths): Promise<number | null | 'other'> {
  const started = performance.now()
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/admin/none`, { headers: { authorization: `Bearer ${readSecret(paths.adminToken)}` }, signal: AbortSignal.timeout(5000) })
    await res.arrayBuffer()
    return res.status === 404 ? Math.round(performance.now() - started) : 'other'
  } catch {
    return null
  }
}

// The hosts file first, then DNS with a short timeout. getaddrinfo cannot be
// cancelled and would keep the process alive for seconds on a name nobody answers.
async function resolveName(name: string): Promise<string | null> {
  try {
    for (const line of fs.readFileSync('/etc/hosts', 'utf8').split('\n')) {
      const [ip, ...names] = line.replace(/#.*/, '').trim().split(/\s+/)
      if (ip && names.includes(name)) return ip
    }
  } catch {}
  const resolver = new dns.Resolver({ timeout: 1000, tries: 1 })
  const timer = setTimeout(() => resolver.cancel(), 1500)
  try {
    return (await resolver.resolve4(name))[0] ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// TLS to the private listener with only our CA trusted, as a device would see it.
function tlsCheck(address: string, port: number, name: string, ca: Buffer): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.request({ host: address, port, servername: name, ca, path: '/', method: 'HEAD', headers: { host: `${name}:${port}` }, timeout: 5000 }, (res) => {
      res.resume()
      resolve(null)
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', (error) => resolve(error.message))
    req.end()
  })
}

// Which of the levels in docs/security-levels.md this hub is on, and the step to the next.
export function securityLevel(config: HubConfig): string {
  const listener = config.privateListener
  const open = config.localAccess === 'open'
  const tailnet = listener ? /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(listener.address) || /^fd7a:115c:a1e0:/i.test(listener.address) : false
  if (!listener && open) return 'level 1 of 4, open on this computer: no other device can connect (next: vocorum setup adds your devices)'
  if (!listener) return 'level 3 of 4, this computer only, and every browser pairs (next: vocorum setup adds your devices)'
  if (open) return 'level 2 of 4, your paired devices, and this computer with no sign-in (next: vocorum config set localAccess off)'
  if (config.tailscaleLogin && tailnet) return 'level 4 of 4, paired devices that are also on your Tailscale account (or a friend\'s)'
  return `level 3 of 4, every browser pairs${tailnet ? ' (next: vocorum config set tailscaleLogin <your Tailscale login>)' : ''}`
}

export async function doctor(paths: HubPaths, { repo = path.resolve(import.meta.dirname, '..') }: { repo?: string } = {}): Promise<Check[]> {
  const checks: Check[] = []
  const add = (id: string, status: Check['status'], detail: string, fix?: string) => checks.push({ id, status, detail, ...(fix && { fix }) })

  add('node', nodeSupported() ? 'ok' : 'fail', `Node ${process.versions.node}`, nodeSupported() ? undefined : `Install Node.js ${NODE_MIN} or newer (the current LTS is fine)`)
  add('openssl', (await quiet(tool('openssl'), ['version'])) ? 'ok' : 'warn', 'openssl makes the hub\'s own certificates', 'Install openssl (needed for the private listener)')
  add('ffmpeg', (await quiet('ffmpeg', ['-version'])) ? 'ok' : 'warn', 'ffmpeg converts voice notes', 'Optional: install ffmpeg so voice notes from phones play everywhere')
  const built = fs.existsSync(path.join(repo, 'dist/hub.mjs')) && fs.existsSync(path.join(repo, 'web/dist/index.html'))
  const { staleBuild } = await import('./updates.ts')
  const stale = built && (await staleBuild(repo))
  add('build', !built ? 'fail' : stale ? 'warn' : 'ok', !built ? 'dist/hub.mjs or web/dist is missing' : stale ? 'built before the newest commit, so the hub runs older code' : 'hub and app are built', !built || stale ? `vocorum setup (builds it), or: cd ${repo} && pnpm install && pnpm build, then vocorum restart` : undefined)

  const config = loadConfig(paths)
  if (!config) {
    add('config', 'fail', `No hub at ${paths.root}`, 'vocorum setup')
    return checks
  }
  add('config', 'ok', `${paths.root}, port ${config.port}`)
  const loose: string[] = []
  // Windows has no file modes; a folder in the user's profile is theirs alone by default.
  if (WINDOWS) add('permissions', 'skip', 'Windows: protected by your user profile, not file modes')
  else if ((fs.statSync(paths.root).mode & 0o077) !== 0) loose.push(paths.root)
  // The databases inherit the folder's protection; the secrets are 0600 on their own as well.
  if (!WINDOWS) for (const file of [paths.config, paths.adminToken, paths.signingKey]) if (fs.existsSync(file) && (fs.statSync(file).mode & 0o077) !== 0) loose.push(file)
  if (!WINDOWS) add('permissions', loose.length ? 'fail' : 'ok', loose.length ? `readable by other users: ${loose.join(', ')}` : 'state folder 0700, secrets 0600', loose.length ? `chmod 700 ${paths.root} && chmod 600 ${loose.filter((f) => f !== paths.root).join(' ')}` : undefined)

  const { serviceName, serviceManager, backgroundPid, rebootLine } = await import('./setup.ts')
  const unit = serviceName(paths)
  const manager = await serviceManager()
  const background = backgroundPid(paths)
  // On a hub that is open on this computer alone, plain `vocorum setup` would offer to add devices as well.
  const again = config.localAccess === 'open' && !config.privateListener ? 'vocorum setup --open' : 'vocorum setup'
  if (background) add('service', 'warn', `no service: the hub runs in the background (pid ${background}) and does not start after a reboot by itself`, manager ? `${again} (installs a service)` : rebootLine(paths, repo))
  else if (process.platform === 'linux' && !manager) add('service', 'warn', 'no service manager here (no systemd user session)', 'vocorum setup starts the hub in the background')
  else if (process.platform === 'linux') {
    // is-active exits non-zero when the unit is not active, so read its output either way.
    const state = await run('systemctl', ['--user', 'is-active', unit], { timeout: 5000 }).then((r) => r.stdout.trim(), (e: { stdout?: string }) => (e.stdout ?? '').trim() || 'not installed')
    add('service', state === 'active' ? 'ok' : 'warn', `${unit}.service is ${state}`, state === 'active' ? undefined : `${again} (installs and starts it), or systemctl --user start ${unit}`)
  } else if (process.platform === 'darwin') {
    const state = await launchdState(unit)
    add('service', state === 'running' ? 'ok' : 'warn', state ? `launchd agent ${launchdLabel(unit)} is ${state}` : `no launchd agent ${launchdLabel(unit)}`, state === 'running' ? undefined : `${again} (installs and starts it), or vocorum restart`)
  } else if (WINDOWS) {
    const state = await taskState(unit)
    add('service', state === 'Running' ? 'ok' : 'warn', state ? `Task Scheduler task ${taskName(unit)} is ${state.toLowerCase()}` : `no Task Scheduler task ${taskName(unit)}`, state === 'Running' ? undefined : `${again} (installs and starts it), or vocorum restart`)
  }
  const latency = await hubLatency(config, paths)
  if (latency === null) add('hub', 'fail', 'the hub does not answer on loopback', manager === 'systemd' ? `vocorum restart; then journalctl --user -u ${unit} -n 50` : `vocorum restart; then ${WINDOWS ? 'read the end of' : 'tail -50'} ${path.join(paths.root, 'hub.log')}`)
  else if (latency === 'other') add('hub', 'fail', `port ${config.port} is held by something else (another hub?)`, `vocorum config get port; give this hub its own port with: vocorum init --port <free port>`)
  else add('hub', latency > 300 ? 'warn' : 'ok', `answers in ${latency} ms`, latency > 300 ? 'Something is keeping it busy (often an import). vocorum discord status' : undefined)
  if (typeof latency === 'number') {
    const stats = await fetch(`http://127.0.0.1:${config.port}/admin/stats`, { headers: { authorization: `Bearer ${readSecret(paths.adminToken)}` }, signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? (r.json() as Promise<{ rss: number; heapUsed: number; uptimeS: number }>) : null), () => null)
    if (stats) {
      const mb = Math.round(stats.rss / 1048576)
      add('memory', mb > 250 ? 'warn' : 'ok', `${mb} MB in use (heap ${Math.round(stats.heapUsed / 1048576)} MB), up ${Math.round(stats.uptimeS / 3600)} h`, mb > 250 ? 'vocorum restart; if it climbs back, check that the service runs node with the memory flags (vocorum setup updates a unit it wrote)' : undefined)
    }
  }

  add('security-level', 'ok', securityLevel(config))
  if (config.localAccess === 'open') add('local-access', 'ok', `open: http://localhost:${config.port} on this computer needs no code or passkey. Do not forward this port to other machines (ask for pairing here too: vocorum config set localAccess off)`)
  const listener = config.privateListener
  // Open on this computer alone is a choice, not a fault.
  if (!listener && config.localAccess === 'open') add('private-listener', 'ok', 'off: no other device can connect (add your phone or another computer: vocorum setup)')
  else if (!listener) add('private-listener', 'warn', 'off: only this machine can reach the hub', 'vocorum setup (or: vocorum private setup --address <private ip>)')
  else {
    const caFile = path.join(paths.ca, 'ca.crt')
    const certFile = path.join(paths.ca, 'server.crt')
    const locals = await listeningSockets()
    if (locals !== null) {
      const lines = locals.filter((local) => [listener.port, listener.httpPort].some((p) => p && local.endsWith(`:${p}`)))
      const wild = lines.filter((local) => /^(0\.0\.0\.0|\*|\[::\]):/.test(local))
      const ours = lines.filter((local) => local.replace(/^\[|\]?:\d+$/g, '') === listener.address)
      const ports = [listener.port, listener.httpPort].filter((p): p is number => p !== null)
      const missing = ports.filter((p) => !ours.some((local) => local.endsWith(`:${p}`)))
      const status = wild.length || missing.length ? 'fail' : 'ok'
      const detail = wild.length ? 'a hub port listens on every address' : missing.length ? `port ${missing.join(' and ')} is not listening on ${listener.address}${lines.length > ours.length ? ` (held on ${lines.filter((l) => !ours.includes(l)).join(', ')}: another hub?)` : ''}` : `ports ${ports.join(' and ')} only on ${listener.address}`
      add('listen-address', status, detail, status === 'ok' ? undefined : `vocorum restart; if another hub holds the ports, give this one others: vocorum private setup --address <ip> --port <n> --http-port <n>`)
    }
    if (fs.existsSync(certFile) && fs.existsSync(caFile)) {
      const cert = new crypto.X509Certificate(fs.readFileSync(certFile))
      const days = Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000)
      const sans = cert.subjectAltName ?? ''
      const missing = listener.names.filter((n) => !sans.includes(`DNS:${n}`))
      add('certificate', days < 14 || missing.length ? 'fail' : 'ok', `valid ${days} more days${missing.length ? `, missing names ${missing.join(', ')}` : ''}`, days < 14 || missing.length ? `vocorum restart (renews on start)` : undefined)
      add('ca-fingerprint', 'ok', new crypto.X509Certificate(fs.readFileSync(caFile)).fingerprint256)
      const ca = fs.readFileSync(caFile)
      const error = await tlsCheck(listener.address, listener.port, listener.names[0]!, ca)
      add('https', error ? 'fail' : 'ok', error ? `HTTPS to ${listener.names[0]} failed: ${error}` : `https://${listener.names[0]}:${listener.port} answers with our certificate`, error ? `vocorum private status; vocorum restart` : undefined)
    } else add('certificate', 'fail', 'no server certificate yet', `vocorum restart`)
    for (const name of listener.names) {
      const found = await resolveName(name)
      const tailnetName = name.endsWith('.ts.net')
      if (found === listener.address) add(`name ${name}`, 'ok', `resolves to ${found} here${tailnetName ? ' (Tailscale names it, so devices need no DNS setup)' : ''}`)
      else if (name === listener.names[0]) add(`name ${name}`, tailnetName ? 'fail' : 'warn', found ? `resolves to ${found}, not ${listener.address}` : 'does not resolve on this machine', tailnetName ? 'tailscale status (is MagicDNS on?)' : `Devices need the profile or a hosts line: ${listener.address} ${name}`)
    }
    if (config.publicUrl && !listener.names.some((n) => config.publicUrl!.includes(n)) && !config.publicUrl.includes(listener.address)) add('public-url', 'warn', `publicUrl ${config.publicUrl} is not on the listener`, `vocorum config set publicUrl https://${listener.names[0]}:${listener.port}`)
  }

  if (fs.existsSync(paths.hubDb)) {
    const hubDb = openSqlite(paths.hubDb)
    const twin = fs.existsSync(paths.twinDb) ? openSqlite(paths.twinDb) : null
    try {
      const bots = (await hubDb.execute('SELECT machine FROM bots WHERE revoked_at IS NULL').catch(() => ({ rows: [] }))).rows.map((r) => String(r['machine']))
      add('bots', bots.length ? 'ok' : 'warn', bots.length ? `active: ${bots.join(', ')}` : 'no bots yet', bots.length ? undefined : 'vocorum kimaki setup <machine> (a Kimaki on this machine), or vocorum bots add <machine> --out <file> for another bot')
      // The browsers of an open computer share one device row; it is not a paired device.
      const devices = Number((await hubDb.execute(`SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL${config.localAccess === 'open' ? " AND name != 'This computer'" : ''}`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.['n'] ?? 0)
      if (!listener && config.localAccess === 'open') add('devices', 'ok', 'this computer needs no pairing')
      else add('devices', devices ? 'ok' : 'warn', `${devices} paired`, devices ? undefined : 'vocorum pair phone')
      if (twin) {
        // Who can drive agents (and so gets a shell on the machines): Kimaki role, Administrator, Manage Server.
        const roles = new Map((await twin.execute('SELECT id, name, permissions FROM Role')).rows.map((r) => [String(r['id']), { name: String(r['name']), perms: BigInt(String(r['permissions'] ?? '0')) }]))
        const members = (await twin.execute({ sql: 'SELECT m.userId, m.roles, u.username FROM GuildMember m JOIN User u ON u.id = m.userId WHERE u.bot = 0 AND m.userId != ?', args: [config.ownerUserId] })).rows
        const shell = new Set<string>()
        for (const m of members) {
          for (const id of JSON.parse(String(m['roles'] ?? '[]')) as string[]) {
            const role = roles.get(id)
            if (role && (KIMAKI_ROLE.test(role.name) || role.perms & ADMINISTRATOR || role.perms & MANAGE_GUILD)) shell.add(String(m['username']))
          }
        }
        add('agent-access', shell.size ? 'warn' : 'ok', shell.size ? `besides you, these people can drive agents (a shell on your machines): ${[...shell].join(', ')}` : 'only you can drive agents', shell.size ? 'Remove the Kimaki role, Administrator or Manage Server from anyone who should not have a shell' : undefined)
      }
    } finally {
      hubDb.close()
      twin?.close()
    }
  }

  const kimakiData = path.join(paths.root, 'kimaki-data', 'kimaki.db')
  if (fs.existsSync(kimakiData)) {
    const db = createClient({ url: `file:${kimakiData}` })
    try {
      const dirs = (await db.execute('SELECT DISTINCT directory FROM channel_directories').catch(() => ({ rows: [] }))).rows.map((r) => String(r['directory']))
      const gone = dirs.filter((d) => !fs.existsSync(d))
      add('kimaki-projects', gone.length ? 'warn' : 'ok', gone.length ? `project folders that no longer exist: ${gone.join(', ')}` : `${dirs.length} project folders exist`, gone.length ? 'Move the folder back, or kimaki project add <new path> with the hub Kimaki\'s --data-dir' : undefined)
    } finally {
      db.close()
    }
  }

  const importReport = path.join(paths.root, 'import', 'report.json')
  if (fs.existsSync(importReport)) {
    const raw = JSON.parse(fs.readFileSync(importReport, 'utf8')) as { finished?: string | null; guilds?: Record<string, { gaps?: Record<string, unknown>; files_failed?: number }> }
    // Older imports wrote one entry per server at the top level, with no finish time.
    const guilds = Object.values(raw.guilds ?? (raw as Record<string, { gaps?: Record<string, unknown>; files_failed?: number }>)).filter((g) => g && typeof g === 'object')
    const finished = raw.guilds ? Boolean(raw.finished) : true
    const gaps = guilds.reduce((n, g) => n + Object.keys(g.gaps ?? {}).length, 0)
    // Files are counted in the hub, not the report: a later run may have copied them, and a
    // file Discord already deleted is gone for good, so it is no reason to warn.
    let failed = guilds.reduce((n, g) => n + (g.files_failed ?? 0), 0)
    let gone = 0
    if (fs.existsSync(paths.twinDb)) {
      const twin = openSqlite(paths.twinDb)
      try {
        const row = (await twin.execute(`SELECT sum(coalesce(json_extract(j.value, '$.missing'), 0) = 1) AS gone, sum(coalesce(json_extract(j.value, '$.missing'), 0) = 0 AND (json_extract(j.value, '$.url') LIKE 'https://cdn.discordapp.com/%' OR json_extract(j.value, '$.url') LIKE 'https://media.discordapp.net/%')) AS left FROM Message m, json_each(m.attachments) j WHERE m.attachments != '[]'`)).rows[0]
        gone = Number(row?.['gone'] ?? 0)
        failed = Number(row?.['left'] ?? 0)
      } catch {
      } finally {
        twin.close()
      }
    }
    const goneNote = gone ? `; ${plural(gone, 'file')} Discord had already deleted` : ''
    add('discord-import', !finished || gaps || failed ? 'warn' : 'ok', !finished ? 'running or stopped early' : gaps || failed ? [gaps && plural(gaps, 'channel') + ' with missing messages', failed && plural(failed, 'file') + ' not copied yet'].filter(Boolean).join(', ') + goneNote : `complete (${guilds.length} servers)${goneNote}`, gaps || failed || !finished ? 'vocorum discord import <guild id> (resumes where it stopped)' : undefined)
  }

  const funnel = await quiet(tool('tailscale'), ['funnel', 'status'])
  if (funnel !== null && /https?:\/\//.test(funnel) && !/No serve config/i.test(funnel)) add('tailscale-funnel', 'warn', 'Tailscale Serve or Funnel is publishing something from this machine', 'tailscale funnel status; tailscale serve reset (only if nothing else needs it)')
  if (config.adminGuildId) {
    const { adminStatus } = await import('./admin.ts')
    checks.push(...(await adminStatus(config, paths)))
  }
  return checks
}

const TITLES: Record<string, string> = { node: 'Node.js', openssl: 'OpenSSL', ffmpeg: 'ffmpeg', https: 'HTTPS', 'ca-fingerprint': 'CA fingerprint', 'listen-address': 'Listening on', 'agent-access': 'Agent access', 'kimaki-projects': 'Kimaki projects', 'discord-import': 'Discord import', 'tailscale-funnel': 'Tailscale Funnel', 'admin-members': 'Admin server', 'admin-bots': 'Other bots', 'admin-bot': 'Admin bot', 'admin-limits': 'Admin limits', 'admin-agent': 'Admin agent', memory: 'Memory' }
// "listen-address" reads "Listening on"; "name <host>" keeps the host as it is.
const title = (id: string) => {
  const [head = '', ...rest] = id.split(' ')
  return [TITLES[head] ?? head.charAt(0).toUpperCase() + head.slice(1).replace(/-/g, ' '), ...rest].join(' ')
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// One line per check: a mark, the name in a column, what was found; the fix underneath.
// Colour only on a terminal that wants it (NO_COLOR turns it off).
// One line per check or step: a mark, the name in a column, then the fix underneath.
// setup prints its steps the same way.
export function printLine(status: Check['status'], name: string, detail: string, fix: string | undefined, width = 16) {
  const colour = process.stdout.isTTY && !process.env['NO_COLOR']
  const paint = (code: number, text: string) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text)
  const mark = { ok: paint(32, '✓'), warn: paint(33, '!'), fail: paint(31, '✗'), skip: paint(90, '-') }
  console.log(`${mark[status]} ${name.padEnd(width)}  ${status === 'skip' ? paint(90, detail) : detail}`)
  if (fix && status !== 'ok') console.log(`  ${' '.repeat(width)}  ${paint(90, 'Fix:')} ${fix}`)
}

export function printChecks(checks: Check[]) {
  // A long name (a host) does not push every other line out.
  const width = Math.min(16, Math.max(...checks.map((c) => title(c.id).length)))
  for (const c of checks) printLine(c.status, title(c.id), c.detail, c.fix, width)
  const failed = checks.filter((c) => c.status === 'fail').length
  const warned = checks.filter((c) => c.status === 'warn').length
  const parts = [failed && plural(failed, 'problem') + ' to fix', warned && plural(warned, 'warning')].filter(Boolean)
  console.log(`\n${parts.length ? `${parts.join(', ')}.` : 'All good.'}`)
}
