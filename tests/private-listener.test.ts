// The private HTTPS listener: own CA with name constraints, DNS over HTTPS for
// the hub's names, the enrolment page, network filtering, and passkey pairing
// over the private origin with no Tailscale header.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { tool } from '../src/platform.ts'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { answerDns, assertSpecificAddress, inCidr } from '../src/private-listener.ts'
import { SoftAuthenticator } from './authenticator.ts'
import { startTestHub } from './helpers.ts'

const NAME = 'hub.home.arpa'
let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let ca: Buffer

beforeAll(async () => {
  t = await startTestHub()
  await t.hub.stop()
  const config = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: 0, names: [NAME], allowedCidrs: ['127.0.0.0/8'] } })
  hub = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  await hub.start()
  ca = fs.readFileSync(hub.privateListener!.files.caCert)
}, 60_000)

afterAll(async () => {
  await hub.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
function request(pathname: string, { method = 'GET', headers = {}, body, port = hub.privateListener!.port, servername = NAME }: { method?: string; headers?: Record<string, string>; body?: Buffer | string; port?: number; servername?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: `${servername}:${port}`, ...headers }, ca, servername }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('addresses: never a wildcard; CIDR matching', () => {
  expect(() => assertSpecificAddress('0.0.0.0')).toThrow()
  expect(() => assertSpecificAddress('::')).toThrow()
  expect(() => assertSpecificAddress('hub.home.arpa')).toThrow()
  expect(inCidr('100.101.102.103', '100.64.0.0/10')).toBe(true)
  expect(inCidr('::ffff:100.101.102.103', '100.64.0.0/10')).toBe(true)
  expect(inCidr('192.168.1.5', '100.64.0.0/10')).toBe(false)
  expect(inCidr('fd7a:115c:a1e0::7134:f060', 'fd7a:115c:a1e0::/48')).toBe(true)
  expect(inCidr('fd7a:115c:a1e1::1', 'fd7a:115c:a1e0::/48')).toBe(false)
})

test('the CA is name constrained and the server certificate fits Apple rules', async () => {
  const caText = (await promisify(execFile)(tool('openssl'), ['x509', '-noout', '-text', '-in', hub.privateListener!.files.caCert])).stdout
  expect(caText).toMatch(/Name Constraints: critical/)
  // Exactly the hub name, not the whole zone (which could be a public suffix).
  expect(caText).toMatch(/DNS:hub\.home\.arpa/)
  expect(caText).not.toMatch(/DNS:home\.arpa/)
  expect(caText).toMatch(/IP:127\.0\.0\.1\/255\.255\.255\.255/)
  const leaf = new crypto.X509Certificate(fs.readFileSync(hub.privateListener!.files.cert))
  expect(leaf.subjectAltName).toBe('DNS:hub.home.arpa, IP Address:127.0.0.1')
  const days = (new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / 86_400_000
  expect(days).toBeLessThanOrEqual(398)
  expect(leaf.checkIssued(new crypto.X509Certificate(ca))).toBe(true)
  if (process.platform !== 'win32') {
    expect(fs.statSync(hub.privateListener!.files.caKey).mode & 0o777).toBe(0o600)
    expect(fs.statSync(hub.privateListener!.files.key).mode & 0o777).toBe(0o600)
  }
})

test('a certificate for another name fails: the TLS handshake only validates the hub names', async () => {
  await expect(request('/', { servername: 'example.com' })).rejects.toThrow(/altnames|Hostname/)
})

test('DNS over HTTPS answers only the hub names', async () => {
  const query = (name: string, type = 1) => {
    const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])
    const qname = Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])])
    return Buffer.concat([header, qname, Buffer.from([0, type, 0, 1])])
  }
  const post = await request('/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: query(NAME) })
  expect(post.status).toBe(200)
  expect(post.headers['content-type']).toBe('application/dns-message')
  expect([...post.body.subarray(-4)]).toEqual([127, 0, 0, 1])
  expect(post.body.readUInt16BE(0)).toBe(0x1234)
  const get = await request(`/dns-query?dns=${query(NAME).toString('base64url')}`)
  expect(get.body.readUInt16BE(6)).toBe(1)
  const rcode = (name: string) => answerDns(query(name), new Map([[NAME, '127.0.0.1']]), ['home.arpa']).readUInt16BE(2) & 0xf
  expect({ known: rcode(NAME), unknownInZone: rcode('x.home.arpa'), outside: rcode('example.com') }).toEqual({ known: 0, unknownInZone: 3, outside: 5 })
})

test('the enrolment page serves only the CA profile, the CA and instructions', async () => {
  const port = hub.privateListener!.httpPort!
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`)
  const profile = await get('/vocorum.mobileconfig')
  expect(profile.headers.get('content-type')).toBe('application/x-apple-aspen-config')
  const plist = await profile.text()
  expect(plist).toContain(new crypto.X509Certificate(ca).raw.toString('base64'))
  expect(plist).toContain(`https://127.0.0.1:${hub.privateListener!.port}/dns-query`)
  expect(plist).toContain("<string>hub.home.arpa</string>")
  expect(plist).toContain('com.apple.dnsSettings.managed')
  // Mac: certificate only, since macOS rejects the DNS payload and with it the profile.
  const mac = await (await get('/vocorum-mac.mobileconfig')).text()
  expect(mac).toContain(new crypto.X509Certificate(ca).raw.toString('base64'))
  expect(mac).not.toContain('dnsSettings')
  expect(mac).toContain('com.apple.security.root')
  expect(mac.match(/<key>PayloadIdentifier<\/key><string>([^<]+)<\/string>\n  <key>PayloadType/)?.[1]).not.toBe(plist.match(/<key>PayloadIdentifier<\/key><string>([^<]+)<\/string>\n  <key>PayloadType/)?.[1])
  const page = await (await get('/')).text()
  expect(page).toContain('/vocorum-mac.mobileconfig')
  expect(page).toContain(`127.0.0.1 ${NAME}`)
  expect(page).toContain(`https://${NAME}:${hub.privateListener!.port}`)
  expect((await get('/client/state')).status).toBe(404)
  expect((await get('/api/v10/gateway/bot')).status).toBe(404)
})

test('setup page: a pairing code opens the app on pairing, and each step shows a tick once it works', async () => {
  const port = hub.privateListener!.httpPort!
  const app = `https://${NAME}:${hub.privateListener!.port}`
  const withCode = await fetch(`http://127.0.0.1:${port}/?code=ABCDE12345`)
  const page = await withCode.text()
  expect(page).toContain(`href="${app}/#pair=ABCDE12345"`)
  expect(page).toContain(`<img class="ok" src="${app}/setup/ok.svg"`)
  // The fingerprint to check comes first, before any step.
  const fp = new crypto.X509Certificate(ca).fingerprint256
  expect(page.indexOf(fp)).toBeGreaterThan(0)
  expect(page.indexOf(fp)).toBeLessThan(page.indexOf('<h2>'))
  expect(withCode.headers.get('content-security-policy')).toBe(`default-src 'none'; style-src 'unsafe-inline'; img-src ${app}`)
  // The device it is opened on comes first; the others fold away.
  const iphone = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } })).text()
  expect(iphone.indexOf('/vocorum.mobileconfig')).toBeLessThan(iphone.indexOf('<details>'))
  expect(iphone.indexOf('/vocorum-mac.mobileconfig')).toBeGreaterThan(iphone.indexOf('<details>'))
  const mac = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' } })).text()
  expect(mac.indexOf('/vocorum-mac.mobileconfig')).toBeLessThan(mac.indexOf('<details>'))
  // Anything but a 10-character code is ignored, never echoed.
  const bad = await (await fetch(`http://127.0.0.1:${port}/?code=%22%3E%3Cscript%3E`)).text()
  expect(bad).not.toContain('#pair=')
  expect(bad).not.toContain('<script')
  // The tick itself: on the TLS listener, no session, no cookie.
  const tick = await request('/setup/ok.svg')
  expect(tick.status).toBe(200)
  expect(tick.headers['content-type']).toBe('image/svg+xml')
  expect(tick.headers['set-cookie']).toBeUndefined()
  expect(tick.body.toString()).toContain('<svg')
})

test('connections from outside the allowed networks are dropped', async () => {
  await hub.stop()
  const config = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: null, names: [NAME], allowedCidrs: ['10.0.0.0/8'] } })
  const closed = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  await closed.start()
  try {
    const port = closed.privateListener!.port
    const result = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.on('close', () => resolve('closed'))
      socket.on('data', () => resolve('data'))
      socket.on('error', () => resolve('closed'))
    })
    expect(result).toBe('closed')
  } finally {
    await closed.stop()
    const restored = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: 0, names: [NAME], allowedCidrs: ['127.0.0.0/8'] } })
    hub = new Hub({ paths: t.paths, config: restored, port: 0, webDir: `${t.paths.root}/web` })
    await hub.start()
  }
})

test('pairing and sign-in over the private origin, without any Tailscale header', async () => {
  const origin = `https://${NAME}:${hub.privateListener!.port}`
  let cookie = ''
  const call = async (pathname: string, json?: unknown) => {
    const reply = await request(pathname, {
      method: json === undefined ? 'GET' : 'POST',
      headers: { origin, ...(cookie && { cookie }), ...(json !== undefined && { 'content-type': 'application/json' }) },
      ...(json !== undefined && { body: JSON.stringify(json) }),
    })
    const setCookie = reply.headers['set-cookie']?.[0]
    if (setCookie) cookie = setCookie.split(';')[0]!
    return { status: reply.status, json: reply.body.length ? JSON.parse(reply.body.toString()) : null }
  }
  expect((await call('/client/state')).status).toBe(401)
  const device = new SoftAuthenticator()
  const code = await hub.store.createPairing('iphone')
  const options = await call('/client/auth/register/options', { code })
  expect(options.json.options.rp.id).toBe(NAME)
  const verified = await call('/client/auth/register/verify', { challengeId: options.json.challengeId, response: device.register(options.json.options, origin) })
  expect(verified.status).toBe(200)
  expect((await call('/client/state')).status).toBe(200)

  // The admin route is never reachable from the private listener.
  const admin = await request('/admin/reload', { method: 'POST', headers: { authorization: `Bearer ${fs.readFileSync(t.paths.adminToken, 'utf8').trim()}` } })
  expect(admin.status).toBe(403)
  // Bots reach the twin API over the private listener too.
  expect((await request('/api/v10/gateway/bot')).status).toBe(401)
})

test('stopping does not wait for devices still connected over the private listener', async () => {
  const WebSocket = (await import('ws')).default
  const origin = `https://${NAME}:${hub.privateListener!.port}`
  const device = new SoftAuthenticator()
  let cookie = ''
  const post = async (pathname: string, json: unknown) => {
    const reply = await request(pathname, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify(json) })
    const set = reply.headers['set-cookie']?.[0]
    if (set) cookie = set.split(';')[0]!
    return JSON.parse(reply.body.toString())
  }
  const options = await post('/client/auth/register/options', { code: await hub.store.createPairing('mac') })
  await post('/client/auth/register/verify', { challengeId: options.challengeId, response: device.register(options.options, origin) })
  const ws = new WebSocket(`wss://127.0.0.1:${hub.privateListener!.port}/client/events`, { ca, servername: NAME, headers: { origin, cookie, host: `${NAME}:${hub.privateListener!.port}` } } as ConstructorParameters<typeof WebSocket>[2])
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
  const keepAlive = https.request({ host: '127.0.0.1', port: hub.privateListener!.port, method: 'POST', path: '/client/read', ca, servername: NAME, headers: { host: NAME, 'content-length': 100 } })
  keepAlive.on('error', () => {})
  keepAlive.write('{')
  await new Promise((r) => setTimeout(r, 50))
  const started = Date.now()
  await hub.stop()
  expect(Date.now() - started).toBeLessThan(2000)
  const restored = initHub(t.paths, {})
  hub = new Hub({ paths: t.paths, config: restored, port: 0, webDir: `${t.paths.root}/web` })
  await hub.start()
})

test('bots that come in over the private listener are sent to its TLS gateway', async () => {
  const listenerHost = `${NAME}:${hub.privateListener!.port}`
  const reply = await request('/api/v10/gateway/bot', { headers: { authorization: 'Bot x:y' } })
  expect(reply.status).toBe(401)
  expect(hub.gatewayUrlFor(listenerHost)).toBe(`wss://${listenerHost}/gateway`)
  expect(hub.gatewayUrlFor(`127.0.0.1:${hub.port}`)).toBe(`ws://127.0.0.1:${hub.port}/gateway`)
  expect(hub.gatewayUrlFor('evil.example')).toBeUndefined()
})

// Older Node 22 releases have no tls.setDefaultCACertificates (bots there use NODE_EXTRA_CA_CERTS).
test.skipIf(!('setDefaultCACertificates' in (await import('node:tls')).default))('a remote machine\'s bot works entirely over the private listener (REST, TLS gateway, attachments)', async () => {
  const { default: tls } = await import('node:tls')
  const { Client, GatewayIntentBits } = await import('discord.js')
  const before = tls.getCACertificates('default')
  tls.setDefaultCACertificates([...before, ca.toString()])
  const minted = await hub.store.addBot('remote')
  await hub.reload()
  const base = `https://127.0.0.1:${hub.privateListener!.port}`
  const bot = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${base}/api`, version: '10' } })
  try {
    const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
    await bot.login(`${minted.clientId}:${minted.secret}`)
    await ready
    expect(bot.ws.gateway).toMatch(new RegExp(`^wss://127\\.0\\.0\\.1:${hub.privateListener!.port}/gateway/?$`))
    expect(bot.guilds.cache.size).toBe(1)
  } finally {
    await bot.destroy()
    tls.setDefaultCACertificates(before)
  }
})
