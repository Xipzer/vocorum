// The status a person chooses, as on Discord: Do Not Disturb holds every push back and
// others (people and bots) see dnd; Invisible shows offline to everyone else while the
// person still sees their own state; a custom status clears itself when it expires.

import crypto from 'node:crypto'
import http from 'node:http'
import type net from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

const ALEX_LOGIN = 'alex@example.com'
let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let owner: TestDevice
let alex: TestDevice
let alexId = ''
let general: TextChannel
let pushServer: http.Server
let pushes = 0
const ownerEvents: Array<{ t: string; d: any }> = []
const alexEvents: Array<{ t: string; d: any }> = []
const botPresences: any[] = []
const sockets: WebSocket[] = []

function listen(device: TestDevice, login: string, into: Array<{ t: string; d: any }>) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login } })
  sockets.push(ws)
  ws.on('message', (data) => into.push(JSON.parse(String(data))))
  return new Promise<WebSocket>((resolve) => ws.once('open', () => resolve(ws)))
}

const setStatus = (body: object) => owner.json('/client/me', { method: 'PATCH', json: body })
const seenBy = async (device: TestDevice) => (await device.json('/client/state')).presence[t.config.ownerUserId]
const settle = async () => {
  await new Promise((r) => setTimeout(r, 300))
  await t.hub.notifications.flush()
}

beforeAll(async () => {
  pushServer = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      pushes++
      res.writeHead(201).end()
    })
  })
  await new Promise<void>((resolve) => pushServer.listen(0, '127.0.0.1', resolve))
  const pushBase = `http://127.0.0.1:${(pushServer.address() as net.AddressInfo).port}`
  t = await startTestHub({ push: { allowEndpoint: (url) => url.origin === pushBase } })
  const minted = await t.hub.store.addBot('desktop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildPresences], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  bot.on('raw', (packet: { t?: string; d?: any }) => packet.t === 'PRESENCE_UPDATE' && packet.d.user.id === t.config.ownerUserId && botPresences.push(packet.d))
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  owner = await pairedDevice(t.hub, 'owner-laptop')
  const state = await owner.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  await owner.json('/client/push', { method: 'PUT', json: { endpoint: `${pushBase}/sub/laptop`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } })

  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'alex', global_name: 'Alex' } })
  alexId = invite.user.id
  await t.hub.store.setProfile(alexId, { tailscaleLogin: ALEX_LOGIN })
  await t.hub.reload()
  alex = new TestDevice(t.hub, { 'tailscale-user-login': ALEX_LOGIN })
  await alex.pair(invite.code)
  await listen(alex, ALEX_LOGIN, alexEvents)
  const mine = await listen(owner, LOGIN, ownerEvents)
  // The owner's window is open but not in front: pushes would go out.
  mine.send(JSON.stringify({ op: 'focus', d: { channel_id: null, visible: false } }))
  await waitFor(async () => (await seenBy(alex))?.status === 'idle')
})

afterAll(async () => {
  for (const ws of sockets) ws.close()
  await bot.destroy()
  await t.cleanup()
  pushServer.close()
})

test('Do Not Disturb: no pushes, and others see dnd', async () => {
  expect((await owner.fetch('/client/me', { method: 'PATCH', json: { status: 'busy' } })).status).toBe(400)
  expect((await setStatus({ status: 'dnd' })).user_status).toEqual({ status: 'dnd', custom_status: null })
  await waitFor(() => alexEvents.find((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === t.config.ownerUserId && e.d.status === 'dnd'))
  expect((await seenBy(alex)).status).toBe('dnd')
  expect((await owner.json('/client/state')).user_status.status).toBe('dnd')
  expect(ownerEvents.find((e) => e.t === 'USER_SETTINGS_UPDATE')?.d).toEqual({ status: 'dnd', custom_status: null })
  const toBot = await waitFor(() => botPresences.find((p) => p.status === 'dnd'))
  expect(toBot).toMatchObject({ guild_id: t.config.guildId, status: 'dnd', client_status: { web: 'dnd' }, activities: [] })

  pushes = 0
  await general.send(`<@${t.config.ownerUserId}> are you free?`)
  await settle()
  expect(pushes).toBe(0)

  await setStatus({ status: 'online' })
  await new Promise((r) => setTimeout(r, 3100))
  await general.send(`<@${t.config.ownerUserId}> now?`)
  await waitFor(() => pushes === 1)
  // Online keeps the idle the devices report.
  await waitFor(async () => (await seenBy(alex)).status === 'idle')
}, 20_000)

test('Invisible: offline to others and bots, the person still sees their own state', async () => {
  await setStatus({ status: 'invisible' })
  await waitFor(async () => (await seenBy(alex)).status === 'offline')
  expect(await seenBy(alex)).toEqual({ user_id: t.config.ownerUserId, status: 'offline' })
  expect((await seenBy(owner)).status).toBe('invisible')
  const toBot = await waitFor(() => botPresences.find((p) => p.status === 'offline'))
  expect(toBot.client_status).toEqual({})
  await setStatus({ status: 'online' })
  await waitFor(async () => (await seenBy(alex)).status === 'idle')
})

test('a custom status shows to others and bots, then clears itself when it expires', async () => {
  expect((await owner.fetch('/client/me', { method: 'PATCH', json: { custom_status: { text: '' } } })).status).toBe(400)
  const expires = Date.now() + 1500
  await setStatus({ custom_status: { text: 'Out for lunch', expires_at: expires } })
  await waitFor(async () => (await seenBy(alex)).custom_status?.text === 'Out for lunch')
  expect((await seenBy(alex)).custom_status).toEqual({ text: 'Out for lunch', expires_at: expires })
  const toBot = await waitFor(() => botPresences.find((p) => p.activities?.[0]?.state === 'Out for lunch'))
  expect(toBot.activities[0]).toMatchObject({ type: 4, name: 'Custom Status', state: 'Out for lunch' })
  const at = alexEvents.length
  await waitFor(() => alexEvents.slice(at).find((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === t.config.ownerUserId && !e.d.custom_status))
  expect((await seenBy(alex)).custom_status).toBeUndefined()
  expect((await owner.json('/client/me')).user_status).toEqual({ status: 'online', custom_status: null })
  await waitFor(() => botPresences.at(-1)?.activities.length === 0)

  // Don't clear: kept until it is changed.
  await setStatus({ custom_status: { text: 'Heads down', expires_at: null } })
  await waitFor(async () => (await seenBy(alex)).custom_status?.text === 'Heads down')
  await setStatus({ custom_status: null })
  await waitFor(async () => !(await seenBy(alex)).custom_status)
})
