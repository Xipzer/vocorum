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
import { loadConfig, readSecret, type HubConfig, type HubPaths } from './config.ts'

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

export async function doctor(paths: HubPaths, { repo = path.resolve(import.meta.dirname, '..') }: { repo?: string } = {}): Promise<Check[]> {
  const checks: Check[] = []
  const add = (id: string, status: Check['status'], detail: string, fix?: string) => checks.push({ id, status, detail, ...(fix && { fix }) })

  const major = Number(process.versions.node.split('.')[0])
  add('node', major >= 22 ? 'ok' : 'fail', `Node ${process.versions.node}`, major >= 22 ? undefined : 'Install Node.js 22 or newer')
  add('openssl', (await quiet('openssl', ['version'])) ? 'ok' : 'warn', 'openssl makes the hub\'s own certificates', 'Install openssl (needed for the private listener)')
  add('ffmpeg', (await quiet('ffmpeg', ['-version'])) ? 'ok' : 'warn', 'ffmpeg converts voice notes', 'Optional: install ffmpeg so voice notes from phones play everywhere')
  const built = fs.existsSync(path.join(repo, 'dist/hub.mjs')) && fs.existsSync(path.join(repo, 'web/dist/index.html'))
  add('build', built ? 'ok' : 'fail', built ? 'hub and app are built' : 'dist/hub.mjs or web/dist is missing', `cd ${repo} && pnpm install && pnpm build`)

  const config = loadConfig(paths)
  if (!config) {
    add('config', 'fail', `No hub at ${paths.root}`, 'vocorum setup')
    return checks
  }
  add('config', 'ok', `${paths.root}, port ${config.port}`)
  const loose: string[] = []
  if ((fs.statSync(paths.root).mode & 0o077) !== 0) loose.push(paths.root)
  // The databases inherit the folder's protection; the secrets are 0600 on their own as well.
  for (const file of [paths.config, paths.adminToken, paths.signingKey]) if (fs.existsSync(file) && (fs.statSync(file).mode & 0o077) !== 0) loose.push(file)
  add('permissions', loose.length ? 'fail' : 'ok', loose.length ? `readable by other users: ${loose.join(', ')}` : 'state folder 0700, secrets 0600', loose.length ? `chmod 700 ${paths.root} && chmod 600 ${loose.filter((f) => f !== paths.root).join(' ')}` : undefined)

  const { serviceName } = await import('./setup.ts')
  const unit = serviceName(paths)
  if (process.platform === 'linux') {
    // is-active exits non-zero when the unit is not active, so read its output either way.
    const state = await run('systemctl', ['--user', 'is-active', unit], { timeout: 5000 }).then((r) => r.stdout.trim(), (e: { stdout?: string }) => (e.stdout ?? '').trim() || 'not installed')
    add('service', state === 'active' ? 'ok' : 'warn', `${unit}.service is ${state}`, state === 'active' ? undefined : `vocorum setup (installs and starts it), or systemctl --user start ${unit}`)
  }
  const latency = await hubLatency(config, paths)
  if (latency === null) add('hub', 'fail', 'the hub does not answer on loopback', `systemctl --user restart ${unit}; then journalctl --user -u ${unit} -n 50`)
  else if (latency === 'other') add('hub', 'fail', `port ${config.port} is held by something else (another hub?)`, `vocorum config get port; give this hub its own port with: vocorum init --port <free port>`)
  else add('hub', latency > 300 ? 'warn' : 'ok', `answers in ${latency} ms`, latency > 300 ? 'Something is keeping it busy (often an import). vocorum discord status' : undefined)

  const listener = config.privateListener
  if (!listener) add('private-listener', 'warn', 'off: only this machine can reach the hub', 'vocorum setup (or: vocorum private setup --address <private ip>)')
  else {
    const caFile = path.join(paths.ca, 'ca.crt')
    const certFile = path.join(paths.ca, 'server.crt')
    const ss = await quiet('ss', ['-ltnH'])
    if (ss !== null) {
      // Columns: state, recv-q, send-q, local address:port, peer.
      const locals = ss.split('\n').map((l) => l.trim().split(/\s+/)[3] ?? '')
      const lines = locals.filter((local) => [listener.port, listener.httpPort].some((p) => p && local.endsWith(`:${p}`)))
      const wild = lines.filter((local) => /^(0\.0\.0\.0|\*|\[::\]):/.test(local))
      const ours = lines.filter((local) => local.replace(/^\[|\]?:\d+$/g, '') === listener.address)
      const ports = [listener.port, listener.httpPort].filter((p): p is number => p !== null)
      const missing = ports.filter((p) => !ours.some((local) => local.endsWith(`:${p}`)))
      const status = wild.length || missing.length ? 'fail' : 'ok'
      const detail = wild.length ? 'a hub port listens on every address' : missing.length ? `port ${missing.join(' and ')} is not listening on ${listener.address}${lines.length > ours.length ? ` (held on ${lines.filter((l) => !ours.includes(l)).join(', ')}: another hub?)` : ''}` : `ports ${ports.join(' and ')} only on ${listener.address}`
      add('listen-address', status, detail, status === 'ok' ? undefined : `systemctl --user restart ${unit}; if another hub holds the ports, give this one others: vocorum private setup --address <ip> --port <n> --http-port <n>`)
    }
    if (fs.existsSync(certFile) && fs.existsSync(caFile)) {
      const cert = new crypto.X509Certificate(fs.readFileSync(certFile))
      const days = Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000)
      const sans = cert.subjectAltName ?? ''
      const missing = listener.names.filter((n) => !sans.includes(`DNS:${n}`))
      add('certificate', days < 14 || missing.length ? 'fail' : 'ok', `valid ${days} more days${missing.length ? `, missing names ${missing.join(', ')}` : ''}`, days < 14 || missing.length ? `systemctl --user restart ${unit} (renews on start)` : undefined)
      add('ca-fingerprint', 'ok', new crypto.X509Certificate(fs.readFileSync(caFile)).fingerprint256)
      const ca = fs.readFileSync(caFile)
      const error = await tlsCheck(listener.address, listener.port, listener.names[0]!, ca)
      add('https', error ? 'fail' : 'ok', error ? `HTTPS to ${listener.names[0]} failed: ${error}` : `https://${listener.names[0]}:${listener.port} answers with our certificate`, error ? `vocorum private status; systemctl --user restart ${unit}` : undefined)
    } else add('certificate', 'fail', 'no server certificate yet', `systemctl --user restart ${unit}`)
    for (const name of listener.names) {
      const found = await resolveName(name)
      const tailnetName = name.endsWith('.ts.net')
      if (found === listener.address) add(`name ${name}`, 'ok', `resolves to ${found} here${tailnetName ? ' (Tailscale names it, so devices need no DNS setup)' : ''}`)
      else if (name === listener.names[0]) add(`name ${name}`, tailnetName ? 'fail' : 'warn', found ? `resolves to ${found}, not ${listener.address}` : 'does not resolve on this machine', tailnetName ? 'tailscale status (is MagicDNS on?)' : `Devices need the profile or a hosts line: ${listener.address} ${name}`)
    }
    if (config.publicUrl && !listener.names.some((n) => config.publicUrl!.includes(n)) && !config.publicUrl.includes(listener.address)) add('public-url', 'warn', `publicUrl ${config.publicUrl} is not on the listener`, `vocorum config set publicUrl https://${listener.names[0]}:${listener.port}`)
  }

  if (fs.existsSync(paths.hubDb)) {
    const hubDb = createClient({ url: `file:${paths.hubDb}` })
    const twin = fs.existsSync(paths.twinDb) ? createClient({ url: `file:${paths.twinDb}` }) : null
    try {
      const bots = (await hubDb.execute('SELECT machine FROM bots WHERE revoked_at IS NULL').catch(() => ({ rows: [] }))).rows.map((r) => String(r['machine']))
      add('bots', bots.length ? 'ok' : 'warn', bots.length ? `active: ${bots.join(', ')}` : 'no bots yet', bots.length ? undefined : 'vocorum kimaki setup <machine> (a Kimaki on this machine), or vocorum bots add <machine> --out <file> for another bot')
      const devices = Number((await hubDb.execute('SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL').catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.['n'] ?? 0)
      add('devices', devices ? 'ok' : 'warn', `${devices} paired`, devices ? undefined : 'vocorum pair phone')
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
    const failed = guilds.reduce((n, g) => n + (g.files_failed ?? 0), 0)
    add('discord-import', !finished || gaps || failed ? 'warn' : 'ok', !finished ? 'running or stopped early' : gaps || failed ? `${gaps} channels with missing messages, ${failed} files not copied` : `complete (${guilds.length} servers)`, gaps || failed || !finished ? 'vocorum discord import <guild id> (resumes where it stopped)' : undefined)
  }

  const funnel = await quiet('tailscale', ['funnel', 'status'])
  if (funnel !== null && /https?:\/\//.test(funnel) && !/No serve config/i.test(funnel)) add('tailscale-funnel', 'warn', 'Tailscale Serve or Funnel is publishing something from this machine', 'tailscale funnel status; tailscale serve reset (only if nothing else needs it)')
  return checks
}

export function printChecks(checks: Check[]) {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' }
  for (const c of checks) {
    console.log(`${mark[c.status]}  ${c.id}: ${c.detail}`)
    if (c.fix && c.status !== 'ok') console.log(`      fix: ${c.fix}`)
  }
  const failed = checks.filter((c) => c.status === 'fail').length
  console.log(failed ? `\n${failed} problem(s) to fix.` : '\nNo problems.')
}
