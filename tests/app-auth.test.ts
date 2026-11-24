// Vocorum apps: a device key in the OS keychain instead of a passkey, bearer
// sessions instead of cookies, and notifications over the app's socket.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { APP_APPROVE_PREFIX, APP_LOGIN_PREFIX } from '../src/auth.ts'
import { readSecret } from '../src/config.ts'
import { appPairLink } from '../src/private-listener.ts'
import { LOGIN, pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let phone: TestDevice
let general: TextChannel

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('desktop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  phone = await pairedDevice(t.hub, 'browser')
  const state = await phone.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

// The app's side: only the network gate's header, never an Origin or a cookie.
type Reply = Omit<Response, 'json'> & { json(): Promise<any> }
const app = (path: string, init: { method?: string; json?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<Reply> =>
  fetch(`${t.hub.localUrl}${path}`, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { 'tailscale-user-login': LOGIN, ...(init.json !== undefined && { 'content-type': 'application/json' }), ...(init.token && { authorization: `Bearer ${init.token}` }), ...init.headers },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })

function deviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { privateKey, raw: (publicKey.export({ format: 'jwk' }).x as string) }
}

async function signIn(keyId: string, privateKey: crypto.KeyObject) {
  const { challengeId, challenge } = await (await app('/client/auth/app/challenge', { json: {} })).json()
  const signature = crypto.sign(null, Buffer.from(`${APP_LOGIN_PREFIX}\n${challenge}\n${keyId}`), privateKey).toString('base64url')
  return app('/client/auth/app/login', { json: { challengeId, keyId, signature } })
}

test('an app pairs with a code and a device key, then signs a challenge for a 12-hour bearer token', async () => {
  const key = deviceKey()
  const code = await t.hub.store.createPairing('desktop app')
  expect((await app('/client/auth/app/register', { json: { code, publicKey: 'short' } })).status).toBe(400)
  expect((await app('/client/auth/app/register', { json: { code: 'WRONGCODE1', publicKey: key.raw } })).status).toBe(403)
  const registered = await app('/client/auth/app/register', { json: { code, publicKey: key.raw } })
  expect(registered.status).toBe(200)
  expect(registered.headers.get('set-cookie')).toBeNull()
  const { device, keyId } = await registered.json()
  expect(device.name).toBe('desktop app')
  // Single use, like passkey pairing.
  expect((await app('/client/auth/app/register', { json: { code, publicKey: deviceKey().raw } })).status).toBe(403)

  // A signature by another key, a reused challenge, an unknown key: refused.
  const other = deviceKey()
  expect((await signIn(keyId, other.privateKey)).status).toBe(403)
  const { challengeId, challenge } = await (await app('/client/auth/app/challenge', { json: {} })).json()
  const signature = crypto.sign(null, Buffer.from(`${APP_LOGIN_PREFIX}\n${challenge}\n${keyId}`), key.privateKey).toString('base64url')
  const login = await app('/client/auth/app/login', { json: { challengeId, keyId, signature } })
  expect(login.status).toBe(200)
  expect(login.headers.get('set-cookie')).toBeNull()
  const session = await login.json()
  expect(session.device).toEqual(device)
  expect(session.expiresAt - Date.now()).toBeGreaterThan(11.9 * 3600_000)
  expect(session.expiresAt - Date.now()).toBeLessThanOrEqual(12 * 3600_000)
  expect((await app('/client/auth/app/login', { json: { challengeId, keyId, signature } })).status).toBe(400)
  expect((await signIn('unknown-key', key.privateKey)).status).toBe(403)

  // The bearer works on reads and writes without an Origin, and never sets a cookie.
  const token = session.token as string
  expect((await (await app('/client/auth/status', { token })).json())).toMatchObject({ signedIn: true, device })
  const state = await app('/client/state', { token })
  expect(state.status).toBe(200)
  expect(state.headers.get('set-cookie')).toBeNull()
  const sent = await app(`/client/channels/${general.id}/messages`, { token, json: { content: 'from the app' } })
  expect(sent.status).toBe(200)
  const form = new FormData()
  form.append('file', new Blob(['app file'], { type: 'text/plain' }), 'app.txt')
  const upload = await (await fetch(`${t.hub.localUrl}/client/uploads`, { method: 'POST', headers: { 'tailscale-user-login': LOGIN, authorization: `Bearer ${token}` }, body: form })).json()
  const file = await app((upload as { url: string }).url.split('?')[0]!, { token })
  expect(await file.text()).toBe('app file')

  // The devices list marks it as an app.
  const listed = (await (await app('/client/devices', { token })).json()).devices.find((d: { id: string }) => d.id === device.id)
  expect(listed).toMatchObject({ kind: 'app', current: true })

  // Logging out ends that session only.
  expect((await app('/client/auth/logout', { token, json: {} })).status).toBe(200)
  expect((await app('/client/state', { token })).status).toBe(401)
  expect((await signIn(keyId, key.privateKey)).status).toBe(200)

  // Revoked: no new session.
  await t.hub.store.revokeDevice(device.id)
  expect((await signIn(keyId, key.privateKey)).status).toBe(403)
})

test('a bearer and a cookie never stand in for each other', async () => {
  const key = deviceKey()
  const { keyId } = await (await app('/client/auth/app/register', { json: { code: await t.hub.store.createPairing('laptop app'), publicKey: key.raw } })).json()
  const { token } = await (await signIn(keyId, key.privateKey)).json()
  const cookieToken = phone.cookie!.split('=')[1]!
  // A browser session token sent as a bearer, and an app token sent as the cookie.
  expect((await app('/client/state', { token: cookieToken })).status).toBe(401)
  expect((await app('/client/state', { headers: { cookie: `__Host-hub_session=${token}` } })).status).toBe(401)
  // With a bearer, cookies are ignored: a bad bearer plus a good cookie is not signed in.
  expect((await app('/client/state', { token: 'x'.repeat(43), headers: { cookie: phone.cookie! } })).status).toBe(401)
  expect((await app('/client/state', { headers: { authorization: 'Bearer', cookie: phone.cookie! } })).status).toBe(401)
  // Cookie requests still need the Origin check.
  expect((await app(`/client/channels/${general.id}/messages`, { headers: { cookie: phone.cookie! }, json: { content: 'no origin' } })).status).toBe(403)
  // Passkey routes do not take a bearer.
  expect((await app('/client/auth/login/options', { token, json: {} })).status).toBe(400)
})

test('apps get notifications on their socket: NOTIFY when nothing is in front, marked as push while connected', async () => {
  const key = deviceKey()
  const { device, keyId } = await (await app('/client/auth/app/register', { json: { code: await t.hub.store.createPairing('tray app'), publicKey: key.raw } })).json()
  const { token } = await (await signIn(keyId, key.privateKey)).json()
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { authorization: `Bearer ${token}`, 'tailscale-user-login': LOGIN } })
  const events: Array<{ t: string; d: Record<string, unknown> }> = []
  ws.on('message', (raw) => events.push(JSON.parse(String(raw))))
  await new Promise((resolve) => ws.once('open', resolve))
  const listed = async () => (await (await app('/client/devices', { token })).json()).devices.find((d: { id: string }) => d.id === device.id)
  expect(await listed()).toMatchObject({ kind: 'app', online: true, push: true })

  // Minimised: the mention arrives as NOTIFY, with the push payload.
  ws.send(JSON.stringify({ op: 'focus', d: { channel_id: null, visible: false } }))
  await waitFor(() => t.hub.presence.visibleDevices(t.config.ownerUserId).size === 0)
  const mention = await general.send(`<@${t.config.ownerUserId}> the build finished`)
  const notify = await waitFor(() => events.find((e) => e.t === 'NOTIFY'))
  expect(notify.d).toMatchObject({ kind: 'mention', body: '@you the build finished', tag: general.id, channel_id: general.id, message_id: mention.id, url: `/?channel=${general.id}&message=${mention.id}` })
  expect(typeof notify.d['title']).toBe('string')

  // In front: held back, like Web Push.
  events.length = 0
  ws.send(JSON.stringify({ op: 'focus', d: { channel_id: null, visible: true } }))
  await waitFor(() => t.hub.presence.visibleDevices(t.config.ownerUserId).size === 1)
  await new Promise((r) => setTimeout(r, 3100))
  await general.send(`<@${t.config.ownerUserId}> you are looking already`)
  await new Promise((r) => setTimeout(r, 300))
  await t.hub.notifications.flush()
  expect(events.filter((e) => e.t === 'NOTIFY')).toEqual([])

  // The test notification reaches the app too.
  expect(await (await app('/client/push/test', { token, json: {} })).json()).toMatchObject({ sent: 1 })
  expect(await waitFor(() => events.find((e) => e.t === 'NOTIFY'))).toBeTruthy()

  ws.close()
  await waitFor(async () => (await listed()).online === false)
  expect((await listed()).push).toBe(false)
}, 30_000)

test('the app pairing link carries the hub address, the CA fingerprint and the code', () => {
  const ca = `${t.paths.root}/test-ca.crt`
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${ca}.key`, '-out', ca, '-days', '1', '-subj', '/CN=Test CA'], { stdio: 'ignore' })
  const fp = new crypto.X509Certificate(fs.readFileSync(ca)).fingerprint256.replace(/:/g, '').toLowerCase()
  const listener = { address: '100.64.0.5', port: 47443, httpPort: 47080, names: ['hub.home.arpa'], allowedCidrs: ['100.64.0.0/10'] }
  expect(appPairLink(listener, ca, 'ABCDE12345')).toBe(`vocorum://pair?h=hub.home.arpa&a=100.64.0.5&p=47443&hp=47080&fp=${fp}&c=ABCDE12345`)
  expect(appPairLink({ ...listener, httpPort: null }, ca, 'ABCDE12345')).toBeNull()
})

test('an app approves a request only with its approval key, signed for that request', async () => {
  const adminToken = readSecret(t.paths.adminToken)
  const request = async (username: string) => (await (await fetch(`${t.hub.localUrl}/admin/requests`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { username }, reason: 'test', origin: 'test' }) })).json()) as { id: string }
  const approvalKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = approvalKeys.publicKey.export({ format: 'jwk' })
  const approvalKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url')
  const key = deviceKey()
  expect((await app('/client/auth/app/register', { json: { code: await t.hub.store.createPairing('phone app'), publicKey: key.raw, approvalKey: 'bad' } })).status).toBe(400)
  const { keyId } = await (await app('/client/auth/app/register', { json: { code: await t.hub.store.createPairing('phone app'), publicKey: key.raw, approvalKey } })).json()
  const { token } = await (await signIn(keyId, key.privateKey)).json()
  const sign = (challenge: string, requestId: string, dsaEncoding: 'der' | 'ieee-p1363' = 'der') =>
    crypto.sign('sha256', Buffer.from(`${APP_APPROVE_PREFIX}\n${challenge}\n${requestId}\n${keyId}`), { key: approvalKeys.privateKey, dsaEncoding }).toString('base64url')
  const options = async (id: string) => (await app(`/client/requests/${id}/approve/options`, { token, json: {} })).json() as Promise<{ challengeId: string; challenge: string }>

  // Signed by the login key, or for another request: refused.
  const first = await request('ana')
  let o = await options(first.id)
  const loginKeySig = crypto.sign(null, Buffer.from(`${APP_APPROVE_PREFIX}\n${o.challenge}\n${first.id}\n${keyId}`), key.privateKey).toString('base64url')
  expect((await app(`/client/requests/${first.id}/approve`, { token, json: { challengeId: o.challengeId, keyId, signature: loginKeySig } })).status).toBe(403)
  o = await options(first.id)
  expect((await app(`/client/requests/${first.id}/approve`, { token, json: { challengeId: o.challengeId, keyId, signature: sign(o.challenge, 'another') } })).status).toBe(403)
  expect(await t.hub.twin.prisma.user.findFirst({ where: { username: 'ana' } })).toBeNull()
  // DER (Apple) and raw r||s (Windows) signatures both work.
  o = await options(first.id)
  expect((await app(`/client/requests/${first.id}/approve`, { token, json: { challengeId: o.challengeId, keyId, signature: sign(o.challenge, first.id) } })).status).toBe(200)
  expect(await t.hub.twin.prisma.user.findFirst({ where: { username: 'ana' } })).not.toBeNull()
  const second = await request('ben')
  o = await options(second.id)
  expect((await app(`/client/requests/${second.id}/approve`, { token, json: { challengeId: o.challengeId, keyId, signature: sign(o.challenge, second.id, 'ieee-p1363') } })).status).toBe(200)

  // Windows Hello: an RSA key, PKCS#1 v1.5. Too small a key is refused at pairing.
  const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
  expect((await app('/client/auth/app/register', { json: { code: await t.hub.store.createPairing('win app'), publicKey: deviceKey().raw, approvalKey: small.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') } })).status).toBe(400)
  const hello = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const win = deviceKey()
  const winPaired = await (await app('/client/auth/app/register', { json: { code: await t.hub.store.createPairing('win app'), publicKey: win.raw, approvalKey: hello.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') } })).json()
  const winToken = (await (await signIn(winPaired.keyId, win.privateKey)).json()).token
  const fourth = await request('dee')
  const w = await (await app(`/client/requests/${fourth.id}/approve/options`, { token: winToken, json: {} })).json()
  const rsaSig = crypto.sign('sha256', Buffer.from(`${APP_APPROVE_PREFIX}\n${w.challenge}\n${fourth.id}\n${winPaired.keyId}`), { key: hello.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64url')
  expect((await app(`/client/requests/${fourth.id}/approve`, { token: winToken, json: { challengeId: w.challengeId, keyId: winPaired.keyId, signature: rsaSig } })).status).toBe(200)
  expect(await t.hub.twin.prisma.user.findFirst({ where: { username: 'dee' } })).not.toBeNull()

  // An app paired without an approval key (Linux) cannot approve.
  const plain = deviceKey()
  const paired = await (await app('/client/auth/app/register', { json: { code: await t.hub.store.createPairing('linux app'), publicKey: plain.raw } })).json()
  const plainToken = (await (await signIn(paired.keyId, plain.privateKey)).json()).token
  const third = await request('cy')
  const p = await (await app(`/client/requests/${third.id}/approve/options`, { token: plainToken, json: {} })).json()
  const res = await app(`/client/requests/${third.id}/approve`, { token: plainToken, json: { challengeId: p.challengeId, keyId: paired.keyId, signature: crypto.sign(null, Buffer.from('x'), plain.privateKey).toString('base64url') } })
  expect(res.status).toBe(403)
  expect((await res.json()).error).toMatch(/passkey/)
})
