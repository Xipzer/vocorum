// Presence, notification settings and Web Push. A local push service stands in
// for Apple's or Google's and decrypts what the hub sends with the device's keys.

import crypto from 'node:crypto'
import http from 'node:http'
import type net from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, MessageFlags, type TextChannel } from 'discord.js'
import { effectiveSetting, shouldNotify, type PushPayload } from '../src/notifications.ts'
import { encryptPayload, isPushEndpoint, vapidAuthorization } from '../src/push.ts'
import { LOGIN, pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

// --- a push service and a browser's subscription keys

type Received = { payload: PushPayload; headers: http.IncomingHttpHeaders; path: string }
const received: Received[] = []
let gone = false
let pushServer: http.Server
let pushBase = ''

function subscriptionKeys() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
}
const browser = subscriptionKeys()

// RFC 8291 from the user agent's side.
function decrypt(body: Buffer, keys: { ecdh: crypto.ECDH; p256dh: string; auth: string }) {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idLength)
  const shared = keys.ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(keys.p256dh, 'base64url'), asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(keys.auth, 'base64url'), keyInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const record = body.subarray(21 + idLength)
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(-16))
  const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()])
  expect(plain.at(-1)).toBe(2)
  return plain.subarray(0, -1)
}

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let phone: TestDevice
let general: TextChannel

beforeAll(async () => {
  pushServer = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (gone) return res.writeHead(410).end()
      received.push({ payload: JSON.parse(decrypt(Buffer.concat(chunks), browser).toString()), headers: req.headers, path: req.url ?? '' })
      res.writeHead(201).end()
    })
  })
  await new Promise<void>((resolve) => pushServer.listen(0, '127.0.0.1', resolve))
  pushBase = `http://127.0.0.1:${(pushServer.address() as net.AddressInfo).port}`
  t = await startTestHub({ push: { allowEndpoint: (url) => url.origin === pushBase } })
  const minted = await t.hub.store.addBot('desktop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  phone = await pairedDevice(t.hub, 'iphone')
  const state = await phone.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
  pushServer.close()
})

test('payload encryption matches the RFC 8291 example', () => {
  const out = encryptPayload(
    Buffer.from('When I grow up, I want to be a watermelon'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), serverPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
  )
  expect(out.toString('base64url')).toBe(
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  )
})

test('VAPID: an ES256 token for the push service origin, signed with the hub key', () => {
  const keys = t.hub.notifications.keys
  const header = vapidAuthorization('https://web.push.apple.com/abc', keys, 'mailto:hub@vocorum.invalid')
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!
  expect(k).toBe(keys.publicKey)
  const [h, c, sig] = token!.split('.')
  const claims = JSON.parse(Buffer.from(c!, 'base64url').toString())
  expect(claims).toMatchObject({ aud: 'https://web.push.apple.com', sub: 'mailto:hub@vocorum.invalid' })
  const point = Buffer.from(keys.publicKey, 'base64url')
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' })
  expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true)
})

test('only known push services are accepted as endpoints', () => {
  expect(isPushEndpoint(new URL('https://web.push.apple.com/QGx'))).toBe(true)
  expect(isPushEndpoint(new URL('https://fcm.googleapis.com/fcm/send/x'))).toBe(true)
  expect(isPushEndpoint(new URL('https://wns2-par02p.notify.windows.com/w/?token=x'))).toBe(true)
  expect(isPushEndpoint(new URL('http://web.push.apple.com/x'))).toBe(false)
  expect(isPushEndpoint(new URL('https://web.push.apple.com.evil.example/x'))).toBe(false)
  expect(isPushEndpoint(new URL('https://127.0.0.1/x'))).toBe(false)
})

test('settings resolve thread, channel, category, guild; mentions pass a mute', () => {
  const now = 1000
  expect(effectiveSetting(['t', 'c', 'g'], {}, now)).toEqual({ level: 'mentions', muted: false })
  expect(effectiveSetting(['t', 'c', 'g'], { g: { level: 'all', muted_until: null } }, now).level).toBe('all')
  expect(effectiveSetting(['t', 'c', 'g'], { g: { level: 'all', muted_until: null }, c: { level: 'nothing', muted_until: null } }, now).level).toBe('nothing')
  expect(effectiveSetting(['t', 'c', 'g'], { c: { level: null, muted_until: 2000 } }, now).muted).toBe(true)
  expect(effectiveSetting(['t', 'c', 'g'], { c: { level: null, muted_until: 500 } }, now).muted).toBe(false)
  expect(shouldNotify('message', { level: 'all', muted: true })).toBe(false)
  expect(shouldNotify('mention', { level: 'all', muted: true })).toBe(true)
  expect(shouldNotify('needs_you', { level: 'nothing', muted: false })).toBe(false)
})

test('presence: devices online, idle and offline with the channel they show; bot machines from the gateway', async () => {
  const state = await phone.json('/client/state')
  expect(state.presence[t.config.botUserId]).toMatchObject({ status: 'online', machines: [{ machine: 'desktop', online: true }] })
  expect(state.presence[t.config.ownerUserId].status).toBe('offline')

  const events: Array<{ t: string; d: any }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: phone.origin, cookie: phone.cookie!, 'tailscale-user-login': LOGIN } })
  ws.on('message', (data) => events.push(JSON.parse(String(data))))
  await new Promise((resolve) => ws.once('open', resolve))
  const presence = (status: string, extra: (d: any) => boolean = () => true) => waitFor(() => events.find((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === t.config.ownerUserId && e.d.status === status && extra(e.d)))
  await presence('online')
  ws.send(JSON.stringify({ op: 'focus', d: { channel_id: general.id, visible: true } }))
  const focused = await presence('online', (d) => d.devices[0]?.channel_id === general.id)
  expect(focused.d.devices).toEqual([{ id: expect.any(String), name: 'iphone', channel_id: general.id, visible: true }])
  ws.send(JSON.stringify({ op: 'focus', d: { channel_id: general.id, visible: false } }))
  await presence('idle')
  ws.close()
  await waitFor(async () => (await phone.json('/client/state')).presence[t.config.ownerUserId].status === 'offline')
})

test('settings are stored per scope, validated and broadcast', async () => {
  expect((await phone.fetch(`/client/notifications/${general.id}`, { method: 'PUT', json: { level: 'loud' } })).status).toBe(400)
  expect((await phone.fetch('/client/notifications/123', { method: 'PUT', json: { level: 'all' } })).status).toBe(404)
  await phone.json(`/client/notifications/${t.config.guildId}`, { method: 'PUT', json: { level: 'mentions' } })
  const saved = await phone.json(`/client/notifications/${general.id}`, { method: 'PUT', json: { muted_until: 99 } })
  expect(saved).toEqual({ scope_id: general.id, level: null, muted_until: 99 })
  const state = await phone.json('/client/notifications')
  expect(state.settings).toEqual({ [t.config.guildId]: { level: 'mentions', muted_until: null }, [general.id]: { level: null, muted_until: 99 } })
  expect(state.vapid_public_key).toBe(t.hub.notifications.keys.publicKey)
  await phone.json(`/client/notifications/${general.id}`, { method: 'PUT', json: { muted_until: null } })
  expect((await phone.json('/client/notifications')).settings[general.id]).toBeUndefined()
})

test('Web Push: mentions and needs-you reach the device, encrypted; levels, mutes and an open app hold them back', async () => {
  expect((await phone.fetch('/client/push', { method: 'PUT', json: { endpoint: 'https://evil.example/x', keys: { p256dh: browser.p256dh, auth: browser.auth } } })).status).toBe(400)
  await phone.json('/client/push', { method: 'PUT', json: { endpoint: `${pushBase}/sub/iphone`, keys: { p256dh: browser.p256dh, auth: browser.auth } } })
  expect((await phone.json('/client/notifications')).push_subscribed).toBe(true)

  expect(await phone.json('/client/push/test', { method: 'POST' })).toEqual({ sent: 1, failed: 0 })
  expect(received.pop()!.payload.body).toBe('Notifications work on iphone.')

  const settle = async () => {
    await new Promise((r) => setTimeout(r, 150))
    await t.hub.notifications.flush()
  }
  const expectPush = async (kind: string) => {
    const got = await waitFor(() => received.shift())
    expect(got.payload.kind).toBe(kind)
    return got
  }

  // Default level: mentions only.
  await general.send('a plain progress message')
  const mention = await general.send(`<@${t.config.ownerUserId}> which database should I use?`)
  const got = await expectPush('mention')
  expect(got.payload).toMatchObject({ title: 'Kimaki in #general', body: '@you which database should I use?', channel_id: general.id, message_id: mention.id, url: `/?channel=${general.id}&message=${mention.id}` })
  expect(got.headers['content-encoding']).toBe('aes128gcm')
  expect(got.headers['authorization']).toMatch(/^vapid t=/)
  expect(got.headers['urgency']).toBe('high')
  await settle()
  expect(received).toEqual([])

  // "All messages" on the channel.
  await phone.json(`/client/notifications/${general.id}`, { method: 'PUT', json: { level: 'all' } })
  await new Promise((r) => setTimeout(r, REPEAT_GAP))
  await general.send({ content: 'a silent status line', flags: MessageFlags.SuppressNotifications })
  await general.send('now every message counts')
  expect((await expectPush('message')).payload.body).toBe('now every message counts')
  await settle()
  expect(received).toEqual([])

  // Muted: plain messages stop, mentions still come.
  await phone.json(`/client/notifications/${general.id}`, { method: 'PUT', json: { muted_until: Date.now() + 60_000 } })
  await new Promise((r) => setTimeout(r, REPEAT_GAP))
  await general.send('muted chatter')
  await general.send(`<@${t.config.ownerUserId}> still reaches you`)
  expect((await expectPush('mention')).payload.body).toBe('@you still reaches you')

  // A session that starts waiting on the owner.
  const thread = await general.threads.create({ name: 'Pick a database' })
  await new Promise((r) => setTimeout(r, REPEAT_GAP))
  t.hub.notifications.hubEvent('SESSION_STATE', { id: thread.id, title: 'Pick a database', machine: 'desktop', state: 'waiting', ask: { text: 'Postgres or SQLite?', messageId: '1' } })
  expect((await expectPush('needs_you')).payload).toMatchObject({ title: 'Needs you: Pick a database (desktop)', body: 'Postgres or SQLite?', channel_id: thread.id })
  // Still waiting: no repeat.
  t.hub.notifications.hubEvent('SESSION_STATE', { id: thread.id, title: 'Pick a database', machine: 'desktop', state: 'waiting' })
  await settle()
  expect(received).toEqual([])

  // "Nothing" silences mentions too.
  await phone.json(`/client/notifications/${general.id}`, { method: 'PUT', json: { level: 'nothing', muted_until: null } })
  await general.send(`<@${t.config.ownerUserId}> nobody hears this`)
  await settle()
  expect(received).toEqual([])

  // An app window in front: it shows the mention itself, no push.
  await phone.json(`/client/notifications/${general.id}`, { method: 'PUT', json: { level: null } })
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: phone.origin, cookie: phone.cookie!, 'tailscale-user-login': LOGIN } })
  await new Promise((resolve) => ws.once('open', resolve))
  await waitFor(() => t.hub.presence.visibleDevices(t.config.ownerUserId).size === 1)
  await new Promise((r) => setTimeout(r, REPEAT_GAP))
  await general.send(`<@${t.config.ownerUserId}> you are looking already`)
  await settle()
  expect(received).toEqual([])
  ws.close()
  await waitFor(() => t.hub.presence.visibleDevices(t.config.ownerUserId).size === 0)

  // The browser dropped the subscription: the hub forgets it.
  gone = true
  await new Promise((r) => setTimeout(r, REPEAT_GAP))
  await general.send(`<@${t.config.ownerUserId}> are you there?`)
  await waitFor(async () => !(await phone.json('/client/notifications')).push_subscribed)
  gone = false
}, 30_000)

test('revoking a device removes its push subscription', async () => {
  const laptop = await pairedDevice(t.hub, 'laptop')
  await laptop.json('/client/push', { method: 'PUT', json: { endpoint: `${pushBase}/sub/laptop`, keys: { p256dh: browser.p256dh, auth: browser.auth } } })
  expect((await t.hub.store.pushSubscriptions()).map((s) => s.endpoint)).toContain(`${pushBase}/sub/laptop`)
  await t.hub.store.revokeDevice('laptop')
  expect((await t.hub.store.pushSubscriptions()).map((s) => s.endpoint)).not.toContain(`${pushBase}/sub/laptop`)
})

const REPEAT_GAP = 3100
