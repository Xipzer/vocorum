// Attacks on direct messages, schedules and routines (security review, 25 Nov):
// each test is an exploit that once worked and must keep failing.
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'
import { nextCron } from '../src/schedules.ts'

const SAM_LOGIN = 'sam@example.com'
const ROBIN_LOGIN = 'robin@example.com'
let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let sam: TestDevice
let robin: TestDevice
let samId = ''
let robinId = ''
let botAuth = ''
let general = ''
let client: Client
const raw: Array<{ t: string; d: any }> = []
const samEvents: Array<{ t: string; d: any }> = []

async function person(username: string, login: string) {
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: login })
  await t.hub.reload()
  const device = new TestDevice(t.hub, { 'tailscale-user-login': login })
  await device.pair(invite.code)
  return { device, id: invite.user.id as string }
}

const api = (path: string, init: { method?: string; json?: unknown } = {}) =>
  fetch(`${t.hub.localUrl}/api/v10${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bot ${botAuth}`, 'content-type': 'application/json' }, body: init.json === undefined ? undefined : JSON.stringify(init.json) })

beforeAll(async () => {
  t = await startTestHub()
  owner = await pairedDevice(t.hub, 'owner-laptop')
  ;({ device: sam, id: samId } = await person('sam', SAM_LOGIN))
  ;({ device: robin, id: robinId } = await person('robin', ROBIN_LOGIN))
  const minted = await t.hub.store.addBot('desk-pc')
  await t.hub.reload()
  botAuth = `${minted.clientId}:${minted.secret}`
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  client.on('raw', (p: { t: string; d: any }) => void raw.push(p))
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(botAuth)
  await ready
  general = (await owner.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: sam.origin, cookie: sam.cookie!, 'tailscale-user-login': SAM_LOGIN } })
  ws.on('message', (data) => void samEvents.push(JSON.parse(String(data))))
  await new Promise((r) => ws.once('open', r))
}, 60_000)

afterAll(async () => {
  await client.destroy()
  await t.cleanup()
})

test('a bot cannot read a DM message (or its file) by forwarding it into its own channel', async () => {
  const dm = await sam.json('/client/dms', { method: 'POST', json: { user_id: robinId } })
  const form = new FormData()
  form.append('file', new Blob(['secret-bytes-in-dm'], { type: 'text/plain' }), 'secret.txt')
  const up = await sam.json('/client/uploads', { method: 'POST', body: form })
  const secret = await sam.json(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'the safe code is 4417', attachmentIds: [up.id] } })
  expect((await api(`/channels/${dm.id}/messages`)).status).toBe(403)
  const res = await api(`/channels/${general}/messages`, { method: 'POST', json: { content: 'fwd', message_reference: { type: 1, message_id: secret.id } } })
  const body = (await res.json()) as any
  expect(JSON.stringify(body)).not.toContain('4417')
  expect(body.message_snapshots).toBeUndefined()
  // A forward within its own server still works.
  const own = (await (await api(`/channels/${general}/messages`, { method: 'POST', json: { content: 'own words' } })).json()) as any
  const fwd = (await (await api(`/channels/${general}/messages`, { method: 'POST', json: { content: '', message_reference: { type: 1, message_id: own.id } } })).json()) as any
  expect(fwd.message_snapshots[0].message.content).toBe('own words')
})

test('a bot cannot overwrite or move a DM message, or a message typed in the hub, through the mirror', async () => {
  const dm = await sam.json('/client/dms', { method: 'POST', json: { user_id: robinId } })
  const victim = await sam.json(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'original dm text' } })
  const put = (id: string, channel: string) => fetch(`${t.hub.localUrl}/hub/mirror/messages/${id}`, { method: 'PUT', headers: { authorization: `Bot ${botAuth}`, 'content-type': 'application/json' }, body: JSON.stringify({ id, channel_id: channel, author: { id: '777000000000000001', username: 'x' }, content: 'hijacked' }) })
  expect((await put(victim.id, general)).status).toBe(409)
  const typed = await owner.json(`/client/channels/${general}/messages`, { method: 'POST', json: { content: 'typed here' } })
  expect((await put(typed.id, general)).status).toBe(409)
  expect(await t.hub.twin.prisma.message.findUnique({ where: { id: victim.id } })).toMatchObject({ channelId: dm.id, content: 'original dm text' })
  expect(await t.hub.twin.prisma.message.findUnique({ where: { id: typed.id } })).toMatchObject({ content: 'typed here' })
})

test('a bot cannot replace a DM file by mirroring a message with that attachment id', async () => {
  const dm = await sam.json('/client/dms', { method: 'POST', json: { user_id: robinId } })
  const form = new FormData()
  form.append('file', new Blob(['real file'], { type: 'text/plain' }), 'notes.txt')
  const up = await sam.json('/client/uploads', { method: 'POST', body: form })
  await sam.json(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'file', attachmentIds: [up.id] } })
  const payload = new FormData()
  payload.append('payload_json', JSON.stringify({ id: '1399999999999999001', channel_id: general, author: { id: '777000000000000001', username: 'x' }, content: 'swap', attachments: [{ id: up.id, filename: 'notes.txt' }] }))
  payload.append(`files[${up.id}]`, new Blob(['attacker bytes']), 'notes.txt')
  const swapped = await fetch(`${t.hub.localUrl}/hub/mirror/messages/1399999999999999001`, { method: 'PUT', headers: { authorization: `Bot ${botAuth}` }, body: payload })
  expect(swapped.status).toBe(200)
  const row = await t.hub.store.getAttachment(up.id)
  const fs = await import('node:fs')
  const path = await import('node:path')
  expect(fs.readFileSync(path.join(t.paths.attachments, up.id, row!.filename), 'utf8')).toBe('real file')
})

test('a slash command or component in a DM never reaches a bot', async () => {
  const dm = await sam.json('/client/dms', { method: 'POST', json: { user_id: robinId } })
  raw.length = 0
  expect((await sam.fetch('/client/commands', { method: 'POST', json: { channelId: dm.id, name: 'queue', options: [{ name: 'prompt', type: 3, value: 'private text typed in dm' }] } })).status).toBe(400)
  expect((await sam.fetch('/client/interactions', { method: 'POST', json: { channelId: dm.id, customId: 'x' } })).status).toBe(400)
  await new Promise((r) => setTimeout(r, 300))
  expect(raw.some((e) => JSON.stringify(e.d ?? {}).includes(dm.id))).toBe(false)
})

test('routine updates do not tell people who cannot see the machine its name', async () => {
  samEvents.length = 0
  const res = await fetch(`${t.hub.localUrl}/hub/mirror/routines`, { method: 'PUT', headers: { authorization: `Bot ${botAuth}`, 'content-type': 'application/json' }, body: JSON.stringify({ routines: [{ id: 'r1', prompt: 'p', schedule: '* * * * *', channel_id: '1' }] }) })
  expect(res.status).toBe(200)
  await t.hub.events.flush()
  await new Promise((r) => setTimeout(r, 300))
  expect(samEvents.some((e) => e.t === 'ROUTINES_UPDATE')).toBe(false)
})

test('an impossible cron is refused at once', async () => {
  const start = performance.now()
  expect(nextCron('0 0 30 2 *', Date.now())).toBeNull()
  expect(performance.now() - start).toBeLessThan(20)
  expect((await sam.fetch('/client/schedules', { method: 'POST', json: { kind: 'message', channel_id: general, content: 'x', cron: '0 0 30 2 *' } })).status).toBe(400)
})

test('removed from every server, a person keeps only the DM history; revoked, their schedules stop', async () => {
  const dm = await sam.json('/client/dms', { method: 'POST', json: { user_id: robinId } })
  await sam.json(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'before removal' } })
  const s = await sam.json('/client/schedules', { method: 'POST', json: { kind: 'message', channel_id: dm.id, content: 'still here, every minute', cron: '* * * * *' } })
  await owner.json(`/client/guilds/${t.config.guildId}/members/${samId}`, { method: 'DELETE' })
  expect((await sam.fetch(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'you cannot get rid of me' } })).status).toBe(403)
  expect((await sam.json(`/client/channels/${dm.id}/messages`)).messages.some((m: { content: string }) => m.content === 'before removal')).toBe(true)
  const devices = await sam.json('/client/devices')
  for (const d of devices.devices ?? devices) await sam.fetch(`/client/devices/${d.id}`, { method: 'DELETE' })
  await t.hub.schedules.runDue(Date.now() + 120_000)
  const msgs = (await robin.json(`/client/channels/${dm.id}/messages`)).messages
  expect(msgs.some((m: { content: string }) => m.content === 'still here, every minute' || m.content === 'you cannot get rid of me')).toBe(false)
  expect((await t.hub.store.db.execute({ sql: 'SELECT status, next_at FROM schedules WHERE id = ?', args: [s.id] })).rows[0]).toMatchObject({ status: 'failed', next_at: null })
})
