// Direct messages: between two people who share a server, or a person and one
// machine's agent. Only the two sides see them; a machine's bot only receives
// DMs opened with its own machine.

import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

const SAM_LOGIN = 'sam@example.com'
const ROBIN_LOGIN = 'robin@example.com'
let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let sam: TestDevice
let robin: TestDevice
let samId = ''
let robinId = ''
const bots: Record<string, { client: Client; seen: Message[] }> = {}
const events: Record<string, Array<{ t: string; d: any }>> = { owner: [], sam: [], robin: [] }

async function startBot(machine: string) {
  const minted = await t.hub.store.addBot(machine)
  await t.hub.reload()
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const seen: Message[] = []
  client.on('messageCreate', (m) => void seen.push(m))
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(`${minted.clientId}:${minted.secret}`)
  await ready
  bots[machine] = { client, seen }
}

function listen(device: TestDevice, login: string, into: Array<{ t: string; d: any }>) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login } })
  ws.on('message', (data) => into.push(JSON.parse(String(data))))
  return new Promise<WebSocket>((resolve) => ws.once('open', () => resolve(ws)))
}

async function person(username: string, login: string) {
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: login })
  await t.hub.reload()
  const device = new TestDevice(t.hub, { 'tailscale-user-login': login })
  await device.pair(invite.code)
  return { device, id: invite.user.id as string }
}

beforeAll(async () => {
  t = await startTestHub()
  owner = await pairedDevice(t.hub, 'owner-laptop')
  ;({ device: sam, id: samId } = await person('sam', SAM_LOGIN))
  ;({ device: robin, id: robinId } = await person('robin', ROBIN_LOGIN))
  await startBot('desk-pc')
  await startBot('laptop')
  await listen(owner, LOGIN, events.owner!)
  await listen(sam, SAM_LOGIN, events.sam!)
  await listen(robin, ROBIN_LOGIN, events.robin!)
}, 60_000)

afterAll(async () => {
  for (const { client } of Object.values(bots)) await client.destroy()
  await t.cleanup()
})

test('two people DM each other; nobody else sees it, not even the hub owner or a bot', async () => {
  expect((await sam.fetch('/client/dms', { method: 'POST', json: { recipient_id: samId } })).status).toBe(404)
  const dm = await sam.json('/client/dms', { method: 'POST', json: { user_id: robinId } })
  expect(dm).toMatchObject({ type: 1, recipients: [{ id: robinId }] })
  // Opening again gives the same channel, from either side.
  expect((await robin.json('/client/dms', { method: 'POST', json: { recipient_id: samId } })).id).toBe(dm.id)
  expect((await robin.json('/client/state')).private_channels.map((c: { id: string }) => c.id)).toEqual([dm.id])

  const sent = await sam.json(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'lunch at one?' } })
  expect((await robin.json(`/client/channels/${dm.id}/messages`)).messages.map((m: { id: string }) => m.id)).toContain(sent.id)
  await waitFor(() => events.robin!.find((e) => e.t === 'MESSAGE_CREATE' && e.d.id === sent.id))

  // The owner: no channel, no messages, no event, no search hit.
  expect((await owner.json('/client/state')).private_channels).toEqual([])
  expect((await owner.fetch(`/client/channels/${dm.id}/messages`)).status).toBe(404)
  expect((await owner.fetch(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'hi' } })).status).toBe(404)
  await new Promise((r) => setTimeout(r, 200))
  expect(events.owner!.some((e) => e.d?.channel_id === dm.id || e.d?.id === dm.id)).toBe(false)
  expect((await owner.json('/client/search?q=lunch')).total).toBe(0)
  await waitFor(async () => (await sam.json('/client/search?q=lunch')).results.some((r: { message: { id: string } }) => r.message.id === sent.id))
  // No bot receives it.
  expect(Object.values(bots).some(({ seen }) => seen.some((m) => m.id === sent.id))).toBe(false)
})

test('a DM with a machine says agents work in its project channels; no bot ever gets it', async () => {
  expect((await owner.fetch('/client/dms', { method: 'POST', json: { machine: 'nowhere' } })).status).toBe(404)
  const dm = await owner.json('/client/dms', { method: 'POST', json: { machine: 'desk-pc' } })
  expect(dm).toMatchObject({ type: 1, machine: 'desk-pc', note: 'Agents on desk-pc work in its project channels.', recipients: [{ id: t.config.botUserId }] })
  // The CHANNEL_CREATE event carries the same machine and note.
  expect((await waitFor(() => events.owner!.find((e) => e.t === 'CHANNEL_CREATE' && e.d.id === dm.id))).d).toMatchObject({ type: 1, machine: 'desk-pc', note: 'Agents on desk-pc work in its project channels.' })
  const sent = await owner.fetch(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'status please' } })
  expect(sent.status).toBe(409)
  expect(((await sent.json()) as { error: string }).error).toBe('Agents on desk-pc work in its project channels.')
  // Neither machine's bot may read or post there.
  await expect(bots['desk-pc']!.client.rest.post(`/channels/${dm.id}/messages`, { body: { content: 'hello' } })).rejects.toThrow()
  await expect(bots['laptop']!.client.rest.get(`/channels/${dm.id}/messages`)).rejects.toThrow()
  expect((await sam.fetch(`/client/channels/${dm.id}/messages`)).status).toBe(404)
})

test('a direct message notifies the other person like a mention', async () => {
  const pushed: Array<{ userId?: string; title: string; kind: string }> = []
  const original = t.hub.notifications.pushAll.bind(t.hub.notifications)
  t.hub.notifications.pushAll = async (payload, only) => {
    pushed.push({ userId: only.userId, title: payload.title, kind: payload.kind })
    return original(payload, only)
  }
  // Nobody has a window in front, so the notification goes out.
  for (const list of Object.values(events)) list.length = 0
  const dm = await robin.json('/client/dms', { method: 'POST', json: { recipient_id: samId } })
  await new Promise((r) => setTimeout(r, 3100))
  const sockets = t.hub.events.connections()
  for (const c of sockets) c.visible = false
  await robin.json(`/client/channels/${dm.id}/messages`, { method: 'POST', json: { content: 'running late' } })
  await new Promise((r) => setTimeout(r, 300))
  await t.hub.notifications.flush()
  expect(pushed.filter((p) => p.userId === samId)).toEqual([{ userId: samId, title: 'robin', kind: 'mention' }])
  expect(pushed.some((p) => p.userId === t.config.ownerUserId)).toBe(false)
  t.hub.notifications.pushAll = original
})
