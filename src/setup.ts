// `vocorum setup`: the whole host side in one command, safe to run again.
// It picks a private address (a tailnet or WireGuard IP, never a wildcard),
// names the hub (the machine's Tailscale name first when there is one, so
// devices need no DNS setup; the certificate still comes from the hub's own
// CA, so nothing reaches public certificate logs), initialises state, turns
// on the private listener, installs and starts the service, checks it with
// doctor and prints the first pairing link.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HUB_NODE_FLAGS, initHub, loadConfig, type HubPaths, type PrivateListenerConfig } from './config.ts'
import { doctor, hubLatency, printLine, type Check } from './doctor.ts'
import { installTask, launchdFile, launchdLabel, NODE_MIN, nodeSupported, restartTask, tool, WINDOWS } from './platform.ts'

const run = promisify(execFile)

// The service for this hub: "vocorum" for ~/.vocorum, its own name for any
// other state folder, so a second hub (or a trial run) never touches the first.
export function serviceName(paths: HubPaths) {
  if (path.resolve(paths.root) === path.join(os.homedir(), '.vocorum')) return 'vocorum'
  const base = path.basename(paths.root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'hub'
  return `vocorum-${base}`
}

// Is there a service manager this user can install into? Containers and WSL often have none.
// Windows: a Task Scheduler task (a real Windows service needs an administrator).
export async function serviceManager(): Promise<'systemd' | 'launchd' | 'task' | null> {
  if (process.platform === 'darwin') return 'launchd'
  if (WINDOWS) return 'task'
  if (process.platform !== 'linux') return null
  return (await out('systemctl', ['--user', 'show-environment'])) === null ? null : 'systemd'
}

// Without a service manager the hub runs as a detached process: hub.pid and hub.log
// in the state folder. It does not come back after a reboot by itself.
export async function startBackground(paths: HubPaths, repo: string): Promise<number> {
  const { spawn } = await import('node:child_process')
  const log = fs.openSync(path.join(paths.root, 'hub.log'), 'a', 0o600)
  const child = spawn(process.execPath, [...HUB_NODE_FLAGS, path.join(repo, 'dist/hub.mjs'), 'start'], { cwd: repo, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, VOCORUM_DIR: paths.root } })
  child.unref()
  fs.closeSync(log)
  fs.writeFileSync(path.join(paths.root, 'hub.pid'), String(child.pid), { mode: 0o600 })
  return child.pid!
}

export function backgroundPid(paths: HubPaths): number | null {
  const file = path.join(paths.root, 'hub.pid')
  if (!fs.existsSync(file)) return null
  const pid = Number(fs.readFileSync(file, 'utf8'))
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

export async function stopBackground(paths: HubPaths) {
  const pid = backgroundPid(paths)
  if (!pid) return
  process.kill(pid, WINDOWS ? undefined : 'SIGTERM')
  for (let i = 0; i < 50 && backgroundPid(paths); i++) await new Promise((r) => setTimeout(r, 200))
}

export function rebootLine(paths: HubPaths, repo: string) {
  if (WINDOWS) return 'vocorum setup (installs a Task Scheduler task that starts it at logon)'
  return `crontab -e, then add: @reboot VOCORUM_DIR=${paths.root} ${process.execPath} ${path.join(repo, 'bin/vocorum.js')} restart`
}

// The first port from `start` (stepping by 100) that nothing listens on at `address`.
async function freePort(address: string, start: number, avoid: number[] = []): Promise<number> {
  const net = await import('node:net')
  for (let port = start; port < start + 2000; port += 100) {
    if (avoid.includes(port)) continue
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, address, () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error(`No free port near ${start} on ${address}`)
}

// Waits until a TCP port accepts connections (the private listener starts after loopback).
async function listening(address: string, port: number, ms: number) {
  const net = await import('node:net')
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: address, port, timeout: 500 }, () => (socket.destroy(), resolve(true)))
      socket.once('error', () => resolve(false))
      socket.once('timeout', () => (socket.destroy(), resolve(false)))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const TAILNET = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']

async function out(cmd: string, args: string[]) {
  try {
    return (await run(cmd, args, { timeout: 8000, windowsHide: true })).stdout
  } catch {
    return null
  }
}

export type Network = { kind: 'tailscale' | 'wireguard' | 'loopback' | 'your address'; address: string | null; names: string[]; allow: string[]; login: string | null }

export async function detectNetwork(): Promise<Network> {
  const ip = (await out(tool('tailscale'), ['ip', '-4']))?.trim().split('\n')[0]
  if (ip) {
    const status = JSON.parse((await out(tool('tailscale'), ['status', '--json'])) ?? '{}') as { Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }>; MagicDNSSuffix?: string; CurrentTailnet?: { MagicDNSEnabled?: boolean } }
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
    const magic = status.CurrentTailnet?.MagicDNSEnabled !== false && dnsName ? [dnsName] : []
    const login = status.Self?.UserID !== undefined ? (status.User?.[String(status.Self.UserID)]?.LoginName ?? null) : null
    return { kind: 'tailscale', address: ip, names: [...magic, 'hub.home.arpa'], allow: TAILNET, login }
  }
  const addresses = JSON.parse((await out('ip', ['-j', 'addr', 'show'])) ?? '[]') as Array<{ ifname: string; addr_info?: Array<{ family: string; local: string; prefixlen: number }> }>
  for (const iface of addresses.filter((i) => /^wg/.test(i.ifname))) {
    const inet = iface.addr_info?.find((a) => a.family === 'inet')
    if (inet) return { kind: 'wireguard', address: inet.local, names: ['hub.home.arpa'], allow: [`${inet.local}/${inet.prefixlen}`], login: null }
  }
  return { kind: 'loopback', address: null, names: [], allow: [], login: null }
}

// open: this computer uses the hub at http://localhost with no code or passkey, and no other
// device can connect unless an address is given as well.
export type SetupOptions = { port?: number; address?: string; names?: string[]; allow?: string[]; open?: boolean; service: boolean; yes: boolean; dryRun: boolean; json: boolean; repo: string }
type Step = { step: string; status: 'done' | 'already' | 'planned' | 'skipped' | 'failed'; detail: string; fix?: string }

// Node flags that keep an idle hub small; they only work on the command line, not in NODE_OPTIONS.
function unitFile(paths: HubPaths, repo: string, flags = HUB_NODE_FLAGS) {
  return `[Unit]
Description=Vocorum hub
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo}
Environment=VOCORUM_DIR=${paths.root}
ExecStart=${[process.execPath, ...flags, path.join(repo, 'dist/hub.mjs'), 'start'].join(' ')}
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`
}

function launchdPlist(paths: HubPaths, repo: string) {
  const label = `dev.${serviceName(paths)}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[process.execPath, ...HUB_NODE_FLAGS, path.join(repo, 'dist/hub.mjs'), 'start'].map((a) => `<string>${a}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>VOCORUM_DIR</key><string>${paths.root}</string></dict>
<key>WorkingDirectory</key><string>${repo}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${path.join(paths.root, 'hub.log')}</string><key>StandardErrorPath</key><string>${path.join(paths.root, 'hub.log')}</string>
</dict></plist>
`
}

export async function setup(paths: HubPaths, options: SetupOptions): Promise<{ steps: Step[]; checks: Check[]; network: Network; pairing: { code: string; ttlMinutes: number } | null; open: string | null }> {
  const steps: Step[] = []
  const log = (s: Step) => {
    steps.push(s)
    if (options.json) return
    const status = s.status === 'failed' ? 'fail' : s.status === 'skipped' || s.status === 'planned' ? 'skip' : s.fix ? 'warn' : 'ok'
    printLine(status, s.step[0]!.toUpperCase() + s.step.slice(1), s.status === 'already' ? `${s.detail} (already set up)` : s.detail, s.fix)
  }

  // 1. preflight
  if (!nodeSupported()) throw new Error(`Vocorum needs Node.js ${NODE_MIN} or newer (this is ${process.versions.node}).`)
  if (!fs.existsSync(path.join(options.repo, 'dist/hub.mjs')) || !fs.existsSync(path.join(options.repo, 'web/dist/index.html'))) throw new Error(`Not built yet. Run: cd ${options.repo} && pnpm install && pnpm build`)
  // Certificates are only for other devices: a hub that is open on this computer alone needs none.
  const localOnly = options.open === true && !options.address && !loadConfig(paths)?.privateListener
  if (!localOnly && !(await out(tool('openssl'), ['version']))) throw new Error(`openssl is missing. Install it first (the hub makes its own certificates with it)${WINDOWS ? ': Git for Windows includes it (https://git-scm.com/download/win)' : process.platform === 'darwin' ? '' : ': sudo apt install openssl'}.`)

  // 2. network and names
  // --open on its own never opens the hub to another device, whatever network this machine is on.
  const detected: Network = localOnly ? { address: null, kind: 'loopback', names: [], allow: [], login: null } : await detectNetwork()
  const network: Network = { ...detected, ...(options.address && { address: options.address, kind: detected.address === options.address ? detected.kind : 'your address', login: detected.address === options.address ? detected.login : null }), ...(options.names && { names: options.names }), ...(options.allow && { allow: options.allow }) }
  if (options.address && !options.allow) network.allow = detected.address === options.address ? detected.allow : [`${options.address}/32`]
  // The Tailscale name points at the Tailscale address only.
  if (options.address && detected.address !== options.address && !options.names) network.names = ['hub.home.arpa']
  const existing = loadConfig(paths)
  const open = options.open === true || existing?.localAccess === 'open'
  // A running hub keeps its listener unless told otherwise: a new first name means a new
  // certificate authority and new passkeys on every paired device.
  const kept = existing?.privateListener && !options.address && !options.names && !options.allow ? existing.privateListener : null
  // Another hub on this machine may hold the usual ports: take the next free ones and say so.
  const notes: string[] = []
  const hubPort = existing ? existing.port : (options.port ?? (await freePort('127.0.0.1', 47100)))
  if (!existing && options.port === undefined && hubPort !== 47100) notes.push(`port 47100 is taken (another hub?), so this hub uses ${hubPort}`)
  // Same address: keep its ports. A new address: the usual ports, unless something holds them there.
  let listenPort = existing?.privateListener?.port ?? 47443
  let httpPort = existing?.privateListener?.httpPort ?? 47080
  if (!kept && network.address && existing?.privateListener?.address !== network.address) {
    listenPort = await freePort(network.address, listenPort)
    httpPort = await freePort(network.address, httpPort, [listenPort])
    if (listenPort !== 47443 || httpPort !== 47080) notes.push(`47443 or 47080 is taken on ${network.address} (another hub?), so devices use ${listenPort} and ${httpPort}`)
  }
  const listener: PrivateListenerConfig | null = kept ?? (network.address ? { address: network.address, port: listenPort, httpPort, names: network.names, allowedCidrs: network.allow } : null)
  const better = kept && network.names[0] && !kept.names.includes(network.names[0]) ? network.names[0] : null
  const publicUrl = listener ? `https://${listener.names[0]}:${listener.port}` : null

  const plan = [
    `state in ${paths.root}${existing ? ' (exists, kept)' : ''}, hub port ${hubPort}`,
    ...notes,
    listener ? `HTTPS for your devices on ${listener.address}:${listener.port} and a setup page on ${listener.address}:${listener.httpPort}, only from ${listener.allowedCidrs.join(', ')} (${['127.0.0.1', '::1'].includes(listener.address) ? 'this computer only' : kept ? 'as before' : network.kind}); never the internet` : localOnly ? '' : 'no private network found: the hub stays on this machine only (pass --address <private ip> to change that)',
    listener ? `app address ${publicUrl}` : '',
    open ? `open on this computer: http://localhost:${hubPort} needs no code or passkey. Anyone and any program on this computer can read and post${listener ? '' : '; nothing off this computer can connect'}` : '',
    better ? `kept your current names (${kept!.names.join(', ')}). ${better} would need no DNS step on devices, but switching means reinstalling the certificate and new passkeys on every device: vocorum setup --name ${better},${kept!.names.join(',')}` : '',
    (existing?.tailscaleLogin ?? network.login) ? `extra check: devices must be on the Tailscale account ${existing?.tailscaleLogin ?? network.login}` : '',
    options.service && (await serviceManager()) ? `service: ${process.platform === 'darwin' ? `launchd agent dev.${serviceName(paths)}` : WINDOWS ? `Task Scheduler task Vocorum\\${serviceName(paths)}, at logon` : `systemd user unit ${serviceName(paths)}.service`}` : `no service${options.service ? ' manager here' : ''}: the hub runs in the background and does not start after a reboot by itself`,
  ].filter(Boolean)
  if (!options.json) {
    console.log('Vocorum setup will:')
    for (const line of plan) console.log(`  - ${line}`)
  }
  if (options.dryRun) return { steps: plan.map((detail) => ({ step: 'plan', status: 'planned', detail })), checks: [], network, pairing: null, open: null }
  // Opening a listener to other devices needs the person's yes, not just an agent's.
  if (listener && !options.yes && !(existing?.privateListener?.address === listener.address)) {
    if (!process.stdin.isTTY) throw new Error('This opens the hub to your own devices on your private network. Ask the person, then run again with --yes.')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('Go ahead? [y/N] ')).trim().toLowerCase()
    rl.close()
    if (answer !== 'y' && answer !== 'yes') throw new Error('Stopped; nothing changed.')
  }

  // 3. state; a new hub must not share a port with one already running
  if (!existing) {
    const port = hubPort
    const busy = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)
    if (busy) throw new Error(`Port ${port} is already in use on this machine (another hub?). Run again with --port <free port>.`)
  }
  const config = initHub(paths, {
    ...(!existing && { port: hubPort }), ...(options.open && { localAccess: 'open' as const }), ...(network.login && !existing?.tailscaleLogin && { tailscaleLogin: network.login }), ...(publicUrl && !existing?.publicUrl && { publicUrl }) })
  log({ step: 'state', status: existing ? 'already' : 'done', detail: `${paths.root} (owner ${config.ownerUsername}, port ${config.port})` })

  // 4. private listener (same as `vocorum private setup`)
  // A running hub reads its settings at start: turning open access on restarts it like a new listener does.
  let listenerChanged = options.open === true && existing !== null && existing.localAccess !== 'open'
  if (listener) {
    const same = JSON.stringify(existing?.privateListener ?? null) === JSON.stringify(listener)
    const { PrivateListener } = await import('./private-listener.ts')
    const prepared = new PrivateListener(listener, paths.ca, { attach: () => {}, tailscaleLogins: () => new Map() })
    const ca = await prepared.prepare({ reissueBroad: true })
    if (!same) initHub(paths, { privateListener: listener })
    listenerChanged ||= !same || ca.reissued
    const { fingerprint } = await import('./ca.ts')
    log({ step: 'private listener', status: same ? 'already' : 'done', detail: `https://${listener.names[0]}:${listener.port}, CA ${fingerprint(prepared.files.caCert).slice(0, 23)}…${ca.reissued ? ' (new CA: reinstall it on every device)' : ''}` })
  } else log({ step: 'private listener', status: 'skipped', detail: localOnly ? 'not asked for: this computer only' : 'no private network' })
  if (open) log({ step: 'open access', status: existing?.localAccess === 'open' ? 'already' : 'done', detail: `http://localhost:${config.port} on this computer, no code or passkey` })

  // 5. service, or a background process where there is no service manager
  const manager = options.service ? await serviceManager() : null
  if (options.service && !manager) log({ step: 'service', status: 'skipped', detail: 'no service manager here (no systemd user session); the hub runs in the background instead and does not start after a reboot by itself', fix: rebootLine(paths, options.repo) })
  if (options.service && manager) {
    if (WINDOWS) {
      const { changed, file } = await installTask(paths, options.repo, serviceName(paths))
      if (changed || listenerChanged || (await hubLatency(config, paths)) === null) await restartTask(serviceName(paths), config.port)
      log({ step: 'service', status: changed ? 'done' : 'already', detail: `Task Scheduler task Vocorum\\${serviceName(paths)} (${file}), starts at logon` })
    } else if (process.platform === 'darwin') {
      const file = launchdFile(serviceName(paths))
      const body = launchdPlist(paths, options.repo)
      const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body
      if (!same) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        await out('launchctl', ['bootout', `gui/${process.getuid?.()}`, file])
        await out('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, file])
      } else if (listenerChanged) await out('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${launchdLabel(serviceName(paths))}`])
      log({ step: 'service', status: same ? 'already' : 'done', detail: file })
    } else {
      const file = path.join(os.homedir(), `.config/systemd/user/${serviceName(paths)}.service`)
      const body = unitFile(paths, options.repo)
      // Never overwrite a unit someone wrote by hand; it may run a different checkout. One this
      // setup wrote before the memory flags is updated.
      const ours = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === unitFile(paths, options.repo, [])
      const exists = fs.existsSync(file) && !ours
      if (!exists) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        await out('systemctl', ['--user', 'daemon-reload'])
        await out('systemctl', ['--user', 'enable', '--now', serviceName(paths)])
        if (ours) await out('systemctl', ['--user', 'restart', serviceName(paths)])
      } else if (listenerChanged || (await hubLatency(config, paths)) === null) await out('systemctl', ['--user', 'restart', serviceName(paths)])
      const linger = (await out('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger']))?.includes('yes')
      log({ step: 'service', status: exists ? 'already' : 'done', detail: `${file}${exists && fs.readFileSync(file, 'utf8') !== body ? ' (kept your own unit)' : ''}${linger ? '' : ', stops when you log out'}`, ...(!linger && { fix: 'loginctl enable-linger $USER' }) })
    }
    // 6. wait for it
    let latency: number | null | 'other' = null
    for (let i = 0; i < 30 && latency === null; i++) {
      latency = await hubLatency(config, paths)
      if (latency === 'other') throw new Error(`Port ${config.port} is held by something else. Give this hub its own port: vocorum init --port <free port>`)
      if (latency === null) await new Promise((r) => setTimeout(r, 1000))
    }
    log({ step: 'start', status: latency === null ? 'failed' : 'done', detail: latency === null ? 'the hub did not answer within 30 s' : `answering in ${latency} ms`, ...(latency === null && { fix: manager === 'systemd' ? `journalctl --user -u ${serviceName(paths)} -n 50` : `the end of ${path.join(paths.root, 'hub.log')}` }) })
  } else {
    let latency = await hubLatency(config, paths)
    if (latency === 'other') throw new Error(`Port ${config.port} is held by something else. Give this hub its own port: vocorum init --port <free port>`)
    const running = typeof latency === 'number'
    // Whether the running hub is one this setup started: asked before stopping it, which forgets its pid.
    const ours = backgroundPid(paths) !== null
    if (running && listenerChanged) await stopBackground(paths)
    if (!running || listenerChanged) {
      if (running && !ours && listenerChanged) log({ step: 'start', status: 'skipped', detail: 'a hub I did not start is running; restart it to apply the listener' })
      else {
        await startBackground(paths, options.repo)
        latency = null
        for (let i = 0; i < 30 && latency === null; i++) {
          await new Promise((r) => setTimeout(r, 500))
          latency = await hubLatency(config, paths)
        }
        log({ step: 'start', status: typeof latency === 'number' ? 'done' : 'failed', detail: typeof latency === 'number' ? `in the background, answering in ${latency} ms (log: ${path.join(paths.root, 'hub.log')})` : 'the hub did not answer within 15 s', ...(typeof latency !== 'number' && { fix: `tail -50 ${path.join(paths.root, 'hub.log')}` }) })
      }
    } else log({ step: 'start', status: 'already', detail: `answering in ${latency} ms` })
  }

  // 7. a `vocorum` command on PATH, so people and their agents can just type it
  // Only for the usual hub folder: a bare `vocorum` always means ~/.vocorum.
  const usual = path.resolve(paths.root) === path.join(os.homedir(), '.vocorum')
  const onPath = !usual ? `VOCORUM_DIR=${paths.root} ${process.execPath} ${path.join(options.repo, 'bin', 'vocorum.js')}` : WINDOWS ? (await out('where.exe', ['vocorum']))?.trim().split('\n')[0]?.trim() : (await out('sh', ['-c', 'command -v vocorum']))?.trim()
  if (!usual) log({ step: 'command', status: 'skipped', detail: `this hub is not in ~/.vocorum, so run it as: ${onPath}` })
  else if (onPath) log({ step: 'command', status: 'already', detail: onPath })
  else if (WINDOWS) {
    // WindowsApps is on every user's PATH; a .cmd there needs no administrator.
    const dir = path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps')
    const shim = path.join(dir, 'vocorum.cmd')
    if (fs.existsSync(dir)) {
      fs.writeFileSync(shim, `@"${process.execPath}" "${path.join(options.repo, 'bin', 'vocorum.js')}" %*\r\n`)
      log({ step: 'command', status: 'done', detail: shim })
    } else log({ step: 'command', status: 'skipped', detail: `run it as: node ${path.join(options.repo, 'bin', 'vocorum.js')}` })
  } else {
    const dir = path.join(os.homedir(), '.local/bin')
    fs.mkdirSync(dir, { recursive: true })
    const link = path.join(dir, 'vocorum')
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(options.repo, 'bin/vocorum.js'), link)
    const inPath = (process.env['PATH'] ?? '').split(':').includes(dir)
    log({ step: 'command', status: 'done', detail: `${link}${inPath ? '' : ', not on your PATH'}`, ...(!inPath && { fix: `add ${dir} to your PATH` }) })
  }

  // 8. checks, and a first device when there is none
  // The private listener comes up a moment after loopback answers.
  if (listener && typeof (await hubLatency(config, paths)) === 'number') await listening(listener.address, listener.port, 10_000)
  const checks = await doctor(paths, { repo: options.repo })
  let pairing: { code: string; ttlMinutes: number } | null = null
  const { HubStore } = await import('./store.ts')
  const store = new HubStore(`file:${paths.hubDb}`)
  await store.migrate()
  try {
    // A first code only where a device can use one.
    if (listener && (await store.listDevices()).filter((d) => !d.revokedAt && d.name !== 'This computer').length === 0) pairing = { code: await store.createPairing('first device', { ttlMs: 30 * 60_000 }), ttlMinutes: 30 }
  } finally {
    store.close()
  }
  return { steps, checks, network, pairing, open: open ? `http://localhost:${config.port}` : null }
}
