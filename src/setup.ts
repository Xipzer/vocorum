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
import { initHub, loadConfig, type HubPaths, type PrivateListenerConfig } from './config.ts'
import { doctor, hubLatency, printLine, type Check } from './doctor.ts'

const run = promisify(execFile)

// The service for this hub: "vocorum" for ~/.vocorum, its own name for any
// other state folder, so a second hub (or a trial run) never touches the first.
export function serviceName(paths: HubPaths) {
  if (path.resolve(paths.root) === path.join(os.homedir(), '.vocorum')) return 'vocorum'
  const base = path.basename(paths.root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'hub'
  return `vocorum-${base}`
}

const TAILNET = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']

async function out(cmd: string, args: string[]) {
  try {
    return (await run(cmd, args, { timeout: 8000 })).stdout
  } catch {
    return null
  }
}

export type Network = { kind: 'tailscale' | 'wireguard' | 'loopback' | 'your address'; address: string | null; names: string[]; allow: string[]; login: string | null }

export async function detectNetwork(): Promise<Network> {
  const ip = (await out('tailscale', ['ip', '-4']))?.trim().split('\n')[0]
  if (ip) {
    const status = JSON.parse((await out('tailscale', ['status', '--json'])) ?? '{}') as { Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }>; MagicDNSSuffix?: string; CurrentTailnet?: { MagicDNSEnabled?: boolean } }
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

export type SetupOptions = { port?: number; address?: string; names?: string[]; allow?: string[]; service: boolean; yes: boolean; dryRun: boolean; json: boolean; repo: string }
type Step = { step: string; status: 'done' | 'already' | 'planned' | 'skipped' | 'failed'; detail: string; fix?: string }

function unitFile(paths: HubPaths, repo: string) {
  return `[Unit]
Description=Vocorum hub
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo}
Environment=VOCORUM_DIR=${paths.root}
ExecStart=${process.execPath} ${path.join(repo, 'dist/hub.mjs')} start
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
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${path.join(repo, 'dist/hub.mjs')}</string><string>start</string></array>
<key>EnvironmentVariables</key><dict><key>VOCORUM_DIR</key><string>${paths.root}</string></dict>
<key>WorkingDirectory</key><string>${repo}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${path.join(paths.root, 'hub.log')}</string><key>StandardErrorPath</key><string>${path.join(paths.root, 'hub.log')}</string>
</dict></plist>
`
}

export async function setup(paths: HubPaths, options: SetupOptions): Promise<{ steps: Step[]; checks: Check[]; network: Network; pairing: { code: string; ttlMinutes: number } | null }> {
  const steps: Step[] = []
  const log = (s: Step) => {
    steps.push(s)
    if (options.json) return
    const status = s.status === 'failed' ? 'fail' : s.status === 'skipped' || s.status === 'planned' ? 'skip' : s.fix ? 'warn' : 'ok'
    printLine(status, s.step[0]!.toUpperCase() + s.step.slice(1), s.status === 'already' ? `${s.detail} (already set up)` : s.detail, s.fix)
  }

  // 1. preflight
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`Vocorum needs Node.js 22 or newer (this is ${process.versions.node}).`)
  if (!fs.existsSync(path.join(options.repo, 'dist/hub.mjs')) || !fs.existsSync(path.join(options.repo, 'web/dist/index.html'))) throw new Error(`Not built yet. Run: cd ${options.repo} && pnpm install && pnpm build`)
  if (!(await out('openssl', ['version']))) throw new Error('openssl is missing. Install it first (the hub makes its own certificates with it).')

  // 2. network and names
  const detected = await detectNetwork()
  const network: Network = { ...detected, ...(options.address && { address: options.address, kind: detected.address === options.address ? detected.kind : 'your address', login: detected.address === options.address ? detected.login : null }), ...(options.names && { names: options.names }), ...(options.allow && { allow: options.allow }) }
  if (options.address && !options.allow) network.allow = detected.address === options.address ? detected.allow : [`${options.address}/32`]
  const existing = loadConfig(paths)
  // A running hub keeps its listener unless told otherwise: a new first name means a new
  // certificate authority and new passkeys on every paired device.
  const kept = existing?.privateListener && !options.address && !options.names && !options.allow ? existing.privateListener : null
  const listener: PrivateListenerConfig | null = kept ?? (network.address ? { address: network.address, port: existing?.privateListener?.port ?? 47443, httpPort: existing?.privateListener?.httpPort ?? 47080, names: network.names, allowedCidrs: network.allow } : null)
  const better = kept && network.names[0] && !kept.names.includes(network.names[0]) ? network.names[0] : null
  const publicUrl = listener ? `https://${listener.names[0]}:${listener.port}` : null

  const plan = [
    `state in ${paths.root}${existing ? ' (exists, kept)' : ''}`,
    listener ? `HTTPS for your devices on ${listener.address}:${listener.port} and a setup page on ${listener.address}:${listener.httpPort}, only from ${listener.allowedCidrs.join(', ')} (${network.kind}); never the internet` : 'no private network found: the hub stays on this machine only (pass --address <private ip> to change that)',
    listener ? `app address ${publicUrl}` : '',
    better ? `kept your current names (${kept!.names.join(', ')}). ${better} would need no DNS step on devices, but switching means reinstalling the certificate and new passkeys on every device: vocorum setup --name ${better},${kept!.names.join(',')}` : '',
    network.login ? `extra check: devices must be on the Tailscale account ${network.login}` : '',
    options.service ? `service: ${process.platform === 'darwin' ? `launchd agent dev.${serviceName(paths)}` : `systemd user unit ${serviceName(paths)}.service`}` : 'no service (start it yourself with: vocorum start)',
  ].filter(Boolean)
  if (!options.json) {
    console.log('Vocorum setup will:')
    for (const line of plan) console.log(`  - ${line}`)
  }
  if (options.dryRun) return { steps: plan.map((detail) => ({ step: 'plan', status: 'planned', detail })), checks: [], network, pairing: null }
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
    const port = options.port ?? 47100
    const busy = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)
    if (busy) throw new Error(`Port ${port} is already in use on this machine (another hub?). Run again with --port <free port>.`)
  }
  const config = initHub(paths, {
    ...(options.port !== undefined && { port: options.port }), ...(network.login && !existing?.tailscaleLogin && { tailscaleLogin: network.login }), ...(publicUrl && !existing?.publicUrl && { publicUrl }) })
  log({ step: 'state', status: existing ? 'already' : 'done', detail: `${paths.root} (owner ${config.ownerUsername}, port ${config.port})` })

  // 4. private listener (same as `vocorum private setup`)
  let listenerChanged = false
  if (listener) {
    const same = JSON.stringify(existing?.privateListener ?? null) === JSON.stringify(listener)
    const { PrivateListener } = await import('./private-listener.ts')
    const prepared = new PrivateListener(listener, paths.ca, { attach: () => {}, tailscaleLogins: () => new Map() })
    const ca = await prepared.prepare({ reissueBroad: true })
    if (!same) initHub(paths, { privateListener: listener })
    listenerChanged = !same || ca.reissued
    const { fingerprint } = await import('./ca.ts')
    log({ step: 'private listener', status: same ? 'already' : 'done', detail: `https://${listener.names[0]}:${listener.port}, CA ${fingerprint(prepared.files.caCert).slice(0, 23)}…${ca.reissued ? ' (new CA: reinstall it on every device)' : ''}` })
  } else log({ step: 'private listener', status: 'skipped', detail: 'no private network' })

  // 5. service
  if (options.service) {
    if (process.platform === 'darwin') {
      const file = path.join(os.homedir(), `Library/LaunchAgents/dev.${serviceName(paths)}.plist`)
      const body = launchdPlist(paths, options.repo)
      const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body
      if (!same) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        await out('launchctl', ['bootout', `gui/${process.getuid?.()}`, file])
        await out('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, file])
      } else if (listenerChanged) await out('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/dev.${serviceName(paths)}`])
      log({ step: 'service', status: same ? 'already' : 'done', detail: file })
    } else {
      const file = path.join(os.homedir(), `.config/systemd/user/${serviceName(paths)}.service`)
      const body = unitFile(paths, options.repo)
      const exists = fs.existsSync(file)
      // Never overwrite a unit someone wrote by hand; it may run a different checkout.
      if (!exists) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        await out('systemctl', ['--user', 'daemon-reload'])
        await out('systemctl', ['--user', 'enable', '--now', serviceName(paths)])
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
    log({ step: 'start', status: latency === null ? 'failed' : 'done', detail: latency === null ? 'the hub did not answer within 30 s' : `answering in ${latency} ms`, ...(latency === null && { fix: `journalctl --user -u ${serviceName(paths)} -n 50` }) })
  } else log({ step: 'start', status: 'skipped', detail: `no service; start it with vocorum start${listenerChanged ? ' (restart it if it runs, to apply the listener)' : ''}` })

  // 7. a `vocorum` command on PATH, so people and their agents can just type it
  const onPath = (await out('sh', ['-c', 'command -v vocorum']))?.trim()
  if (onPath) log({ step: 'command', status: 'already', detail: onPath })
  else {
    const dir = path.join(os.homedir(), '.local/bin')
    fs.mkdirSync(dir, { recursive: true })
    const link = path.join(dir, 'vocorum')
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(options.repo, 'bin/vocorum.js'), link)
    const inPath = (process.env['PATH'] ?? '').split(':').includes(dir)
    log({ step: 'command', status: 'done', detail: `${link}${inPath ? '' : ', not on your PATH'}`, ...(!inPath && { fix: `add ${dir} to your PATH` }) })
  }

  // 8. checks, and a first device when there is none
  const checks = await doctor(paths, { repo: options.repo })
  let pairing: { code: string; ttlMinutes: number } | null = null
  const { HubStore } = await import('./store.ts')
  const store = new HubStore(`file:${paths.hubDb}`)
  await store.migrate()
  try {
    if ((await store.listDevices()).filter((d) => !d.revokedAt).length === 0) pairing = { code: await store.createPairing('first device', { ttlMs: 30 * 60_000 }), ttlMinutes: 30 }
  } finally {
    store.close()
  }
  return { steps, checks, network, pairing }
}
