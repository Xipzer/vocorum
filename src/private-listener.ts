// Remote access without trusting the transport: an HTTPS listener on one
// private address (a WireGuard or tailnet IP, never a wildcard), with a
// certificate from the hub's own CA, DNS-over-HTTPS answers for the hub's
// names, and a plain-HTTP enrolment page that only hands out the CA profile.
// Connections from outside the allowed networks are dropped before TLS.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createSecureContext } from 'node:tls'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { caFiles, certDer, ensureCa, ensureServerCert, fingerprint, hasLegacy, type CaFiles } from './ca.ts'
import type { PrivateListenerConfig } from './config.ts'

const WILDCARD = new Set(['0.0.0.0', '::', '', '*'])

// VOCORUM_DEBUG_PRIVATE=1: one line per connection, request and DNS question,
// for finding out why a device does not get through.
const debug = process.env['VOCORUM_DEBUG_PRIVATE'] ? (line: string) => console.log(`[private] ${line}`) : () => {}

// The path of a request target, or null when it cannot be parsed.
function pathOf(url: string | undefined) {
  try {
    return new URL(url ?? '/', 'https://x').pathname
  } catch {
    return null
  }
}

function describeQuery(query: Buffer) {
  const labels: string[] = []
  let offset = 12
  while (offset < query.length && query[offset]) {
    labels.push(query.subarray(offset + 1, offset + 1 + query[offset]!).toString('ascii'))
    offset += query[offset]! + 1
  }
  return `${labels.join('.')} type ${query.length >= offset + 3 ? query.readUInt16BE(offset + 1) : '?'}`
}

export function assertSpecificAddress(address: string) {
  if (WILDCARD.has(address) || !net.isIP(address)) throw new Error(`The private listener needs one specific IP address (got "${address}")`)
}

// --- CIDR matching (IPv4, IPv6 and IPv4-mapped IPv6)

function toBigInt(ip: string): { v: bigint; bits: number } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) ip = mapped[1]!
  if (net.isIPv4(ip)) return { v: ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n), bits: 32 }
  if (!net.isIPv6(ip)) return null
  const [head = '', tail = ''] = ip.split('::')
  const parse = (part: string) => (part ? part.split(':') : [])
  const h = parse(head)
  const t = parse(tail)
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return { v: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n), bits: 128 }
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base = '', prefixText] = cidr.split('/')
  const a = toBigInt(ip)
  const b = toBigInt(base)
  if (!a || !b || a.bits !== b.bits) return false
  const prefix = prefixText === undefined ? b.bits : Number(prefixText)
  const shift = BigInt(b.bits - prefix)
  return a.v >> shift === b.v >> shift
}

// --- DNS over HTTPS (RFC 8484), A records for the hub's own names only

export function answerDns(query: Buffer, records: Map<string, string>, zones: string[]): Buffer {
  if (query.length < 12) throw new Error('short query')
  let offset = 12
  const labels: string[] = []
  for (;;) {
    const length = query[offset]
    if (length === undefined) throw new Error('bad name')
    offset++
    if (length === 0) break
    labels.push(query.subarray(offset, offset + length).toString('ascii'))
    offset += length
  }
  const qtype = query.readUInt16BE(offset)
  const question = query.subarray(12, offset + 4)
  const name = labels.join('.').toLowerCase()
  const ip = records.get(name)
  const inZone = zones.some((zone) => name === zone || name.endsWith(`.${zone}`))
  // REFUSED outside our zones, NXDOMAIN for unknown names inside them.
  const rcode = ip ? 0 : inZone ? 3 : 5
  const answers = ip && qtype === 1 && net.isIPv4(ip) ? [ip] : ip && qtype === 28 && net.isIPv6(ip) ? [ip] : []
  const header = Buffer.alloc(12)
  header.writeUInt16BE(query.readUInt16BE(0), 0)
  header.writeUInt16BE(0x8400 | (query.readUInt16BE(2) & 0x0100) | rcode, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(answers.length, 6)
  const records_ = answers.map((addr) => {
    const rdata = net.isIPv4(addr) ? Buffer.from(addr.split('.').map(Number)) : Buffer.from(toBigInt(addr)!.v.toString(16).padStart(32, '0'), 'hex')
    const rr = Buffer.alloc(12)
    rr.writeUInt16BE(0xc00c, 0)
    rr.writeUInt16BE(qtype, 2)
    rr.writeUInt16BE(1, 4)
    rr.writeUInt32BE(300, 6)
    rr.writeUInt16BE(rdata.length, 10)
    return Buffer.concat([rr, rdata])
  })
  return Buffer.concat([header, question, ...records_])
}

// --- Apple configuration profile: trust the CA, resolve the hub's zone over DoH

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const uuidFrom = (seed: string) => {
  const h = crypto.createHash('sha256').update(seed).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase()
}

// dns: false gives a certificate-only profile for macOS, where System Settings
// rejects the DNS payload ("The VPN service could not be created") and with it
// the whole profile. Macs map the name in /etc/hosts instead.
export function mobileconfig({ caDer, address, port, zones, dns = true }: { caDer: Buffer; address: string; port: number; zones: string[]; dns?: boolean }) {
  const id = crypto.createHash('sha256').update(caDer).digest('hex').slice(0, 12) + (dns ? '' : '.mac')
  const host = address.includes(':') ? `[${address}]` : address
  const strings = (items: string[]) => `<array>${items.map((item) => `<string>${xml(item)}</string>`).join('')}</array>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>local.vocorum.${id}.ca</string>
      <key>PayloadUUID</key><string>${uuidFrom(`${id}ca`)}</string>
      <key>PayloadDisplayName</key><string>Vocorum CA</string>
      <key>PayloadCertificateFileName</key><string>vocorum-ca.cer</string>
      <key>PayloadContent</key><data>${caDer.toString('base64')}</data>
    </dict>${dns ? `
    <dict>
      <key>PayloadType</key><string>com.apple.dnsSettings.managed</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>local.vocorum.${id}.dns</string>
      <key>PayloadUUID</key><string>${uuidFrom(`${id}dns`)}</string>
      <key>PayloadDisplayName</key><string>Vocorum names</string>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key><string>HTTPS</string>
        <key>ServerURL</key><string>https://${host}:${port}/dns-query</string>
        <key>ServerAddresses</key>${strings([address])}
        <key>SupplementalMatchDomains</key>${strings(zones)}
      </dict>
    </dict>` : ''}
  </array>
  <key>PayloadDisplayName</key><string>Vocorum${dns ? '' : ' (Mac)'}</string>
  <key>PayloadDescription</key><string>Trusts this Vocorum hub's own certificate authority (limited to its own names)${dns ? ' and resolves its names over encrypted DNS' : ''}.</string>
  <key>PayloadIdentifier</key><string>local.vocorum.${id}</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuidFrom(id)}</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>
`
}

// A green tick served by the TLS listener: as an image on the setup page it only
// shows once the hub's name resolves and its certificate is trusted.
const OK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="10" fill="#23a55a"/><path d="M5.5 10.5l3 3 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

type Platform = 'ios' | 'mac' | 'other'
// The device the page is opened on goes first; the others fold away below it.
function platformOf(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios'
  // iPadOS asks for desktop pages as a Mac; only a real Mac lacks touch, which a page
  // without scripts cannot see, so both get the Mac steps, which also work on an iPad.
  if (/Macintosh/.test(userAgent)) return 'mac'
  return 'other'
}

// The app's own look, written out: near-black, one cyan accent, Discord's auth card.
const ENROL_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#060608;color:#e3e3e9;font:400 16px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:480px}
.card{background:#0d0d10;border:1px solid #27272e;border-radius:8px;padding:32px}
h1{margin:0;font-weight:700;font-size:24px;line-height:30px;color:#fff;text-align:center}
.sub{margin:8px 0 24px;color:#a3a3ae;text-align:center}
h2{margin:24px 0 12px;font-weight:600;font-size:12px;line-height:16px;letter-spacing:.02em;text-transform:uppercase;color:#a3a3ae}
ol{list-style:none;margin:0;padding:0;counter-reset:step}
li{counter-increment:step;position:relative;padding:0 0 16px 36px;min-height:40px}
li::before{content:counter(step);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;background:#1a1a20;color:#fff;font-weight:600;font-size:13px;line-height:24px;text-align:center}
b{color:#fff;font-weight:600}
a{color:#00d2ff;text-decoration:none}
.button{display:block;margin:0;padding:0 16px;height:44px;line-height:44px;border-radius:8px;background:#00d2ff;color:#0a0a0d;font-weight:600;text-align:center}
.button.second{background:#1a1a20;color:#fff}
code{font:13px/18px ui-monospace,SFMono-Regular,Menlo,monospace;color:#e3e3e9;background:#121216;border:1px solid #1d1d23;border-radius:4px;padding:1px 4px;word-break:break-all}
.check{display:flex;align-items:center;gap:12px;margin:0 0 8px;padding:12px;border-radius:8px;background:#121216;color:#a3a3ae;font-size:14px;line-height:18px}
.dot{flex:none;width:20px;height:20px;border-radius:50%;background:#27272e;position:relative}
.dot .ok{position:absolute;inset:0}
.code{font:600 20px/24px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;color:#fff;text-align:center;margin:16px 0 0}
details{margin-top:24px;border-top:1px solid #1d1d23;padding-top:16px}
summary{cursor:pointer;color:#a3a3ae;font-size:14px}
.fine{margin:24px 0 0;color:#82828e;font-size:13px;line-height:18px}
.cmd{display:block;margin:8px 0 0;padding:8px;font:13px/18px ui-monospace,SFMono-Regular,Menlo,monospace;color:#e3e3e9;background:#121216;border:1px solid #1d1d23;border-radius:4px;white-space:pre-wrap;word-break:break-all;user-select:all}
li:has(> .button)::before{top:10px}
.fine .cmd{margin:8px 0}
@media (max-width:520px){body{padding:24px 16px}.card{border:0;background:none;padding:0}}
`

export function enrolPage({ appUrl, fingerprint: fp, hostsLine, code, userAgent = '' }: { appUrl: string; fingerprint: string; hostsLine: string; code: string | null; userAgent?: string }) {
  const tick = `<img class="ok" src="${xml(appUrl)}/setup/ok.svg" alt="" width="20" height="20">`
  const check = `<p class="check"><span class="dot">${tick}</span>A green tick here means this device now trusts the hub.</p>`
  const openApp = code ? `${appUrl}/#pair=${code}` : appUrl
  const steps: Record<Platform, { title: string; body: string }> = {
    ios: {
      title: 'iPhone and iPad',
      body: `<ol>
<li><a class="button second" href="/vocorum.mobileconfig">Download the profile</a></li>
<li>Open Settings, tap <b>Profile Downloaded</b>, then <b>Install</b>.</li>
<li>Settings, General, About, <b>Certificate Trust Settings</b>: turn on <b>Vocorum CA</b>.</li>
<li>Settings, General, VPN, DNS and Device Management, <b>DNS</b>: choose <b>Vocorum names</b>.</li>
</ol>${check}`,
    },
    mac: {
      title: 'Mac',
      body: `<ol>
<li><a class="button second" href="/vocorum-mac.mobileconfig">Download the profile</a></li>
<li>Open System Settings, General, <b>Device Management</b>, and install it. If Safari still warns, open Keychain Access, find <b>Vocorum CA</b> and set it to <b>Always Trust</b>.</li>
<li>In Terminal, map the hub's name:<code class="cmd">echo '${xml(hostsLine)}' | sudo tee -a /etc/hosts</code></li>
</ol>${check}`,
    },
    other: {
      title: 'Windows, Linux and Android',
      body: `<ol>
<li>Install <a href="/vocorum-ca.crt">vocorum-ca.crt</a> as a trusted root certificate.</li>
<li>Add this line to the hosts file:<code class="cmd">${xml(hostsLine)}</code></li>
</ol>${check}`,
    },
  }
  const mine = platformOf(userAgent)
  const others = (Object.keys(steps) as Platform[]).filter((p) => p !== mine)
  const section = (p: Platform) => `<h2>${steps[p].title}</h2>${steps[p].body}`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up Vocorum</title><style>${ENROL_CSS}</style></head><body><main><div class="card">
<h1>Set up this device</h1>
<p class="sub">Once per device. Then you sign in with a passkey.</p>
${section(mine)}
<h2>Then</h2>
${code ? `<a class="button" href="${xml(openApp)}">Open Vocorum</a><p class="code">${code}</p><p class="sub">Your pairing code is filled in. Create the passkey when asked.</p>` : `<a class="button" href="${xml(appUrl)}">Open Vocorum</a><p class="sub">Choose <b>Pair this device</b>, enter the code from the hub, and create the passkey.</p>`}
<details><summary>Setting up a different kind of device</summary>${others.map(section).join('')}</details>
<p class="fine">The profile's certificate fingerprint should match the one the hub printed:<code class="cmd">${xml(fp)}</code>This certificate can only vouch for this hub's own names, never for any other site.</p>
</div></main></body></html>`
}

// --- the listener

export class PrivateListener {
  readonly files: CaFiles
  private servers: Array<http.Server | https.Server> = []
  // Every accepted socket, upgraded WebSockets included: close() would wait for them.
  private open = new Set<net.Socket>()
  private sockets = new WeakSet<object>()
  private whoisCache = new Map<string, { login: string | null; at: number }>()

  constructor(
    readonly config: PrivateListenerConfig,
    caDir: string,
    private readonly hooks: { attach(server: EventEmitter): void; tailscaleLogins(): Map<string, string> },
  ) {
    assertSpecificAddress(config.address)
    this.files = caFiles(caDir)
  }

  get appOrigins() {
    return this.config.names.map((name) => `https://${name}:${this.port}`)
  }

  get port() {
    const address = this.servers[0]?.address()
    return address && typeof address === 'object' ? address.port : this.config.port
  }

  get httpPort() {
    const address = this.servers[1]?.address()
    return address && typeof address === 'object' ? address.port : this.config.httpPort
  }

  // The names the hub answers DNS for (and devices send to it): only its own,
  // and never a Tailscale name (*.ts.net), which Tailscale itself resolves.
  get zones() {
    return [...new Set(this.config.names.map((name) => name.toLowerCase()).filter((name) => !name.endsWith('.ts.net')))]
  }

  // Requests that arrived on this listener (not loopback).
  owns(req: http.IncomingMessage) {
    return this.sockets.has(req.socket)
  }

  private allowed(socket: net.Socket) {
    const ip = socket.remoteAddress ?? ''
    return this.config.allowedCidrs.some((cidr) => inCidr(ip, cidr))
  }

  private guard(server: net.Server) {
    server.on('connection', (socket: net.Socket) => {
      debug(`connection from ${socket.remoteAddress} on ${socket.localPort}${this.allowed(socket) ? '' : ' (refused)'}`)
      if (!this.allowed(socket)) return socket.destroy()
      this.open.add(socket)
      socket.once('close', () => this.open.delete(socket))
    })
  }

  async prepare({ reissueBroad = false } = {}) {
    const ips = [this.config.address]
    const ca = await ensureCa(this.files, { names: this.config.names, ips, reissueBroad })
    await ensureServerCert(this.files, { names: this.config.names, ips })
    return ca
  }

  async start() {
    await this.prepare()
    const current = { key: fs.readFileSync(this.files.key), cert: fs.readFileSync(this.files.cert) }
    // After a CA change the old certificate still answers for the names it had and
    // for connections without a name (by address), so devices that trust only the
    // old CA keep working; new names get the new certificate.
    let options: https.ServerOptions = { ...current, minVersion: 'TLSv1.2' }
    if (hasLegacy(this.files)) {
      const legacy = { key: fs.readFileSync(this.files.legacy.key), cert: fs.readFileSync(this.files.legacy.cert) }
      const legacyNames = new Set((new crypto.X509Certificate(legacy.cert).subjectAltName ?? '').split(', ').filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4).toLowerCase()))
      const contexts = { legacy: createSecureContext({ ...legacy, minVersion: 'TLSv1.2' }), current: createSecureContext({ ...current, minVersion: 'TLSv1.2' }) }
      options = { ...legacy, minVersion: 'TLSv1.2', SNICallback: (name, done) => done(null, legacyNames.has(name.toLowerCase()) ? contexts.legacy : contexts.current) }
    }
    const tls = https.createServer(options)
    this.guard(tls)
    tls.on('secureConnection', (socket) => this.sockets.add(socket))
    // DoH here; everything else goes to the hub's normal handlers.
    const relay = new EventEmitter()
    this.hooks.attach(relay)
    tls.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      const pathname = pathOf(req.url)
      if (pathname === null) return void res.writeHead(400).end()
      res.once('finish', () => debug(`${req.socket.remoteAddress} ${req.method} ${pathname} ${res.statusCode}`))
      if (pathname === '/dns-query') void this.doh(req, res)
      else if (pathname === '/setup/ok.svg') res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'cross-origin-resource-policy': 'cross-origin' }).end(OK_SVG)
      else relay.emit('request', req, res)
    })
    tls.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => relay.emit('upgrade', req, socket, head))
    await new Promise<void>((resolve, reject) => tls.once('error', reject).listen(this.config.port, this.config.address, () => resolve()))
    this.servers.push(tls)
    if (this.config.httpPort !== null) {
      const plain = http.createServer((req, res) => this.enrol(req, res))
      this.guard(plain)
      await new Promise<void>((resolve, reject) => plain.once('error', reject).listen(this.config.httpPort ?? 0, this.config.address, () => resolve()))
      this.servers.push(plain)
    }
  }

  async stop() {
    const closed = Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    for (const socket of this.open) socket.destroy()
    this.open.clear()
    await closed
    this.servers = []
  }

  private records() {
    return new Map(this.config.names.map((name) => [name.toLowerCase(), this.config.address]))
  }

  private async doh(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      let query: Buffer
      if (req.method === 'GET') {
        const dns = new URL(req.url ?? '/', 'https://x').searchParams.get('dns') ?? ''
        query = Buffer.from(dns, 'base64url')
      } else if (req.method === 'POST' && req.headers['content-type'] === 'application/dns-message') {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          if (size > 4096) throw new Error('too large')
          chunks.push(chunk as Buffer)
        }
        query = Buffer.concat(chunks)
      } else {
        res.writeHead(405).end()
        return
      }
      const answer = answerDns(query, this.records(), this.zones)
      debug(`dns ${describeQuery(query)} -> rcode ${answer.readUInt16BE(2) & 0xf}, ${answer.readUInt16BE(6)} answers`)
      res.writeHead(200, { 'content-type': 'application/dns-message', 'cache-control': 'max-age=300', 'content-length': answer.length }).end(answer)
    } catch {
      res.writeHead(400).end()
    }
  }

  private enrol(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = pathOf(req.url)
    if (pathname === null) return res.writeHead(400).end()
    const headers = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, headers).end()
    const caDer = certDer(this.files.caCert)
    if (pathname === '/vocorum.mobileconfig' || pathname === '/vocorum-mac.mobileconfig') {
      const mac = pathname === '/vocorum-mac.mobileconfig'
      const body = mobileconfig({ caDer, address: this.config.address, port: this.port, zones: this.zones, dns: !mac })
      return res.writeHead(200, { ...headers, 'content-type': 'application/x-apple-aspen-config', 'content-disposition': `attachment; filename="vocorum${mac ? '-mac' : ''}.mobileconfig"` }).end(body)
    }
    if (pathname === '/vocorum-ca.crt') {
      return res.writeHead(200, { ...headers, 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="vocorum-ca.crt"' }).end(caDer)
    }
    if (pathname === '/') {
      // ?code= from vocorum pair: the final link opens the app with it filled in.
      const code = new URL(req.url ?? '/', 'http://x').searchParams.get('code')
      const appUrl = this.appOrigins[0] ?? ''
      const body = enrolPage({ appUrl, fingerprint: fingerprint(this.files.caCert), hostsLine: `${this.config.address} ${this.config.names.join(' ')}`, code: code && /^[A-Z0-9]{10}$/.test(code) ? code : null, userAgent: req.headers['user-agent'] ?? '' })
      return res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${appUrl}` }).end(body)
    }
    res.writeHead(404, headers).end()
  }

  // Optional extra filter: when Tailscale logins are configured and the peer is
  // on the tailnet, Tailscale must name one of them as the device's owner. It
  // can only deny: a passkey session is always required as well. Returns the
  // peer's login (null when not checked) or false.
  async checkPeer(req: http.IncomingMessage): Promise<string | null | false> {
    const allowed = this.hooks.tailscaleLogins()
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    // Tailnet peers over IPv4 or IPv6 alike.
    if (allowed.size === 0 || !(inCidr(ip, '100.64.0.0/10') || inCidr(ip, 'fd7a:115c:a1e0::/48'))) return null
    const cached = this.whoisCache.get(ip)
    const login =
      cached && Date.now() - cached.at < 60_000
        ? cached.login
        : await promisify(execFile)('tailscale', ['whois', '--json', ip], { timeout: 5000 })
            .then(({ stdout }) => (JSON.parse(stdout) as { UserProfile?: { LoginName?: string } }).UserProfile?.LoginName ?? null)
            .catch(() => null)
    this.whoisCache.set(ip, { login, at: Date.now() })
    return login && allowed.has(login) ? login : false
  }
}

// The link a Vocorum app opens to pair: where the hub is, where to fetch its CA
// over plain HTTP and the CA's SHA-256 to check it against before pinning it,
// and the pairing code. Null without the enrolment port (nowhere to get the CA).
export function appPairLink(listener: PrivateListenerConfig, caCertFile: string, code: string): string | null {
  if (listener.httpPort === null) return null
  const fp = fingerprint(caCertFile).replace(/:/g, '').toLowerCase()
  const query = new URLSearchParams({ h: listener.names[0] ?? listener.address, a: listener.address, p: String(listener.port), hp: String(listener.httpPort), fp, c: code })
  return `vocorum://pair?${query}`
}
