// Several people on one hub: invites, roles, channel overwrites and privacy,
// and above all containment: a person never receives a channel, message,
// search hit, mention or event from a channel they cannot view.

import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { P, applyOverwrites } from '../src/access.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

const ALEX_LOGIN = 'alex@example.com'
let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let owner: TestDevice
let alex: TestDevice
let alexId = ''
let general: TextChannel
let secret: { id: string }
const ownerEvents: Array<{ t: string; d: any }> = []
const alexEvents: Array<{ t: string; d: any }> = []

function listen(device: TestDevice, login: string, into: Array<{ t: string; d: any }>) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login } })
  ws.on('message', (data) => into.push(JSON.parse(String(data))))
  return new Promise<WebSocket>((resolve) => ws.once('open', () => resolve(ws)))
}

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('desktop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  owner = await pairedDevice(t.hub, 'owner-laptop')
  const state = await owner.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

test('overwrites resolve like Discord', () => {
  const base = P.VIEW_CHANNEL | P.SEND_MESSAGES
  const ctx = { guildId: 'g', roles: ['crew'], userId: 'u' }
  expect(applyOverwrites(base, [{ id: 'g', type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) }], ctx) & P.VIEW_CHANNEL).toBe(0n)
  expect(applyOverwrites(base, [{ id: 'g', type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) }, { id: 'crew', type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' }], ctx) & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL)
  expect(applyOverwrites(base, [{ id: 'crew', type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' }, { id: 'u', type: 1, allow: '0', deny: String(P.VIEW_CHANNEL) }], ctx) & P.VIEW_CHANNEL).toBe(0n)
})

test('an invite makes a new person who pairs their own device', async () => {
  expect((await owner.fetch(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'Not Valid!' } })).status).toBe(400)
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'alex', global_name: 'Alex' } })
  expect(invite.code).toMatch(/^[A-Z0-9]{10}$/)
  expect(invite.user).toMatchObject({ username: 'alex', global_name: 'Alex' })
  alexId = invite.user.id
  expect((await owner.fetch(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'alex' } })).status).toBe(409)
  // Their own Tailscale login: the owner's would be refused for their device.
  await t.hub.store.setProfile(alexId, { tailscaleLogin: ALEX_LOGIN })
  await t.hub.reload()
  alex = new TestDevice(t.hub, { 'tailscale-user-login': ALEX_LOGIN })
  await alex.pair(invite.code)
  const state = await alex.json('/client/state')
  expect(state.me.id).toBe(alexId)
  expect(state.hub_owner).toBe(false)
  expect(state.channels.map((c: { name: string }) => c.name)).toContain('general')
  // The same device through the owner's Tailscale identity is refused.
  const borrowed = new TestDevice(t.hub, { 'tailscale-user-login': LOGIN })
  borrowed.cookie = alex.cookie
  expect((await borrowed.fetch('/client/state')).status).toBe(403)
})

test('a channel hidden from @everyone does not exist for them: state, messages, search, inbox, events', async () => {
  await listen(owner, LOGIN, ownerEvents)
  await listen(alex, ALEX_LOGIN, alexEvents)
  // Private from the start, like Discord's "Private channel" switch.
  secret = await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'owners-only', permission_overwrites: [{ id: t.config.guildId, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) }] } })
  const hiddenLater = await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'soon-hidden' } })
  await owner.json(`/client/channels/${hiddenLater.id}/permissions/${t.config.guildId}`, { method: 'PUT', json: { type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) } })
  await waitFor(() => alexEvents.find((e) => e.t === 'ACCESS_CHANGED'))
  expect((await alex.json('/client/state')).channels.some((c: { id: string }) => c.id === hiddenLater.id)).toBe(false)

  const hidden = await owner.json(`/client/channels/${secret.id}/messages`, { method: 'POST', json: { content: `alpha in the vault <@${alexId}>` } })
  const thread = await (bot.channels.cache.get(secret.id) as TextChannel).threads.create({ name: 'vault thread' })
  await thread.send('alpha inside the vault thread')
  const open = await general.send('alpha out in the open')
  await t.hub.search.flush()
  await waitFor(() => ownerEvents.some((e) => e.t === 'MESSAGE_CREATE' && e.d.id === open.id))
  await t.hub.events.flush()

  const state = await alex.json('/client/state')
  expect(state.channels.map((c: { id: string }) => c.id)).not.toContain(secret.id)
  expect(state.threads.map((c: { id: string }) => c.id)).not.toContain(thread.id)
  expect((await alex.fetch(`/client/channels/${secret.id}/messages`)).status).toBe(404)
  expect((await alex.fetch(`/client/channels/${thread.id}/messages`)).status).toBe(404)
  expect((await alex.fetch(`/client/channels/${secret.id}/messages`, { method: 'POST', json: { content: 'let me in' } })).status).toBe(404)
  expect((await alex.fetch(`/client/channels/${secret.id}/pins`)).status).toBe(404)
  expect((await alex.json('/client/search?q=alpha')).results.map((r: { message: { id: string } }) => r.message.id)).toEqual([open.id])
  expect((await owner.json('/client/search?q=alpha')).total).toBe(3)
  // Mentioned in a channel they cannot see: no inbox entry, no badge.
  expect((await alex.json('/client/inbox')).mentions).toEqual([])
  expect(state.mentions[secret.id]).toBeUndefined()

  const seen = (events: typeof alexEvents, id: string) => events.some((e) => JSON.stringify(e.d).includes(id))
  expect(seen(ownerEvents, hidden.id)).toBe(true)
  expect(seen(alexEvents, hidden.id)).toBe(false)
  expect(seen(alexEvents, secret.id)).toBe(false)
  expect(seen(alexEvents, thread.id)).toBe(false)
  expect(seen(alexEvents, open.id)).toBe(true)
})

test('a role opens the channel; removing it closes it again', async () => {
  const crew = await owner.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Crew', color: 0xf59e0b } })
  await owner.json(`/client/channels/${secret.id}/permissions/${crew.id}`, { method: 'PUT', json: { type: 0, allow: String(P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY), deny: '0' } })
  alexEvents.length = 0
  await owner.json(`/client/guilds/${t.config.guildId}/members/${alexId}/roles`, { method: 'PUT', json: { roles: [crew.id] } })
  await waitFor(() => alexEvents.find((e) => e.t === 'ACCESS_CHANGED'))
  const state = await alex.json('/client/state')
  expect(state.channels.map((c: { id: string }) => c.id)).toContain(secret.id)
  expect(state.members[t.config.guildId].find((m: { user_id: string }) => m.user_id === alexId).roles).toEqual([crew.id])
  expect((await alex.json(`/client/channels/${secret.id}/messages`)).messages.length).toBeGreaterThan(0)
  // They can read but @everyone's send permission still applies; the channel permission string says so.
  expect(BigInt(state.channels.find((c: { id: string }) => c.id === secret.id).permissions) & P.VIEW_CHANNEL).toBe(P.VIEW_CHANNEL)

  const live = await general.send('still here')
  const inVault = await (bot.channels.cache.get(secret.id) as TextChannel).send('now you can see this')
  await waitFor(() => alexEvents.some((e) => e.t === 'MESSAGE_CREATE' && e.d.id === inVault.id))
  expect(alexEvents.some((e) => e.d?.id === live.id)).toBe(true)

  await owner.json(`/client/guilds/${t.config.guildId}/members/${alexId}/roles`, { method: 'PUT', json: { roles: [] } })
  await waitFor(async () => !(await alex.json('/client/state')).channels.some((c: { id: string }) => c.id === secret.id))
})

test('without the permissions, managing is refused', async () => {
  const no = async (path: string, init: RequestInit & { json?: unknown }) => (await alex.fetch(path, init)).status
  expect(await no(`/client/guilds/${t.config.guildId}`, { method: 'PATCH', json: { name: 'mine' } })).toBe(403)
  expect(await no(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'x' } })).toBe(403)
  expect(await no(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'x' } })).toBe(403)
  expect(await no(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'friend' } })).toBe(403)
  expect(await no(`/client/channels/${general.id}/permissions/${alexId}`, { method: 'PUT', json: { type: 1, allow: String(P.MANAGE_MESSAGES), deny: '0' } })).toBe(403)
  expect(await no('/client/services', { method: 'GET' })).toBe(403)
  expect(await no(`/client/channels/${general.id}`, { method: 'DELETE' })).toBe(403)
  const ownerMessage = await owner.json(`/client/channels/${general.id}/messages`, { method: 'POST', json: { content: 'owner text' } })
  expect(await no(`/client/channels/${general.id}/messages/${ownerMessage.id}`, { method: 'DELETE' })).toBe(403)
  expect(await no(`/client/channels/${general.id}/pins/${ownerMessage.id}`, { method: 'PUT' })).toBe(403)

  // Their own message, as themselves.
  const mine = await alex.json(`/client/channels/${general.id}/messages`, { method: 'POST', json: { content: 'hi from alex' } })
  expect(mine.author.id).toBe(alexId)
  expect((await alex.fetch(`/client/channels/${general.id}/messages/${mine.id}`, { method: 'DELETE' })).status).toBe(204)

  // Devices: only their own.
  const devices = await alex.json('/client/devices')
  expect(devices.devices).toHaveLength(1)
  const ownerDevices = await owner.json('/client/devices')
  expect(await no(`/client/devices/${ownerDevices.devices[0].id}`, { method: 'DELETE' })).toBe(404)
  expect((await alex.json('/client/devices/pair', { method: 'POST', json: { name: 'alex phone' } })).code).toMatch(/^[A-Z0-9]{10}$/)
})

test('files in a hidden channel are not served to them, even with a session', async () => {
  const form = new FormData()
  form.append('file', new Blob([Buffer.from('vault file')], { type: 'text/plain' }), 'vault.txt')
  const upload = await owner.json('/client/uploads', { method: 'POST', body: form })
  await owner.json(`/client/channels/${secret.id}/messages`, { method: 'POST', json: { content: 'file', attachmentIds: [upload.id] } })
  const unsigned = upload.url.split('?')[0]
  expect((await owner.fetch(unsigned)).status).toBe(200)
  expect((await alex.fetch(unsigned)).status).toBe(404)
  // Their own upload is theirs.
  const own = new FormData()
  own.append('file', new Blob([Buffer.from('mine')], { type: 'text/plain' }), 'mine.txt')
  const mine = await alex.json('/client/uploads', { method: 'POST', body: own })
  expect((await alex.fetch(mine.url.split('?')[0])).status).toBe(200)
  // Someone else's upload cannot be attached to a message.
  expect((await alex.fetch(`/client/channels/${general.id}/messages`, { method: 'POST', json: { content: 'x', attachmentIds: [upload.id] } })).status).toBe(400)
})

test('Manage Roles below your highest role, and never more than you have', async () => {
  const mods = await owner.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Mods', permissions: String(P.MANAGE_ROLES | P.VIEW_CHANNEL) } })
  const admins = await owner.json(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Admins', permissions: String(P.ADMINISTRATOR) } })
  await owner.json(`/client/guilds/${t.config.guildId}/members/${alexId}/roles`, { method: 'PUT', json: { roles: [mods.id] } })
  await waitFor(async () => (await alex.fetch(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Helpers' } })).status === 200)
  expect((await alex.fetch(`/client/guilds/${t.config.guildId}/roles`, { method: 'POST', json: { name: 'Sneaky', permissions: String(P.ADMINISTRATOR) } })).status).toBe(403)
  expect((await alex.fetch(`/client/guilds/${t.config.guildId}/roles/${admins.id}`, { method: 'PATCH', json: { name: 'mine' } })).status).toBe(403)
  expect((await alex.fetch(`/client/guilds/${t.config.guildId}/members/${alexId}/roles`, { method: 'PUT', json: { roles: [mods.id, admins.id] } })).status).toBe(403)
  await owner.json(`/client/guilds/${t.config.guildId}/members/${alexId}/roles`, { method: 'PUT', json: { roles: [] } })
})

test('another guild they are not in is invisible', async () => {
  const other = await t.hub.store.addGuild('Owner Only')
  await t.hub.reload()
  const state = await alex.json('/client/state')
  expect(state.guilds.map((g: { id: string }) => g.id)).toEqual([t.config.guildId])
  const otherChannel = (await t.hub.twin.prisma.channel.findFirstOrThrow({ where: { guildId: other.id } })).id
  expect((await alex.fetch(`/client/channels/${otherChannel}/messages`)).status).toBe(404)
  expect((await alex.fetch(`/client/guilds/${other.id}/channels`, { method: 'POST', json: { name: 'x' } })).status).toBe(404)
  alexEvents.length = 0
  const msg = await owner.json(`/client/channels/${otherChannel}/messages`, { method: 'POST', json: { content: 'not for alex' } })
  await waitFor(() => ownerEvents.some((e) => e.d?.id === msg.id))
  await t.hub.events.flush()
  expect(alexEvents.some((e) => JSON.stringify(e.d).includes(msg.id))).toBe(false)
})

test('privacy: others see their status and place only if they allow it, and never a channel they cannot view', async () => {
  const alexSocket = await listen(alex, ALEX_LOGIN, [])
  alexSocket.send(JSON.stringify({ op: 'focus', d: { channel_id: general.id, visible: true } }))
  const ownerView = async () => (await owner.json('/client/state')).presence[alexId]
  await waitFor(async () => (await ownerView())?.devices?.some((d: { channel_id: string }) => d.channel_id === general.id))

  await alex.json('/client/me', { method: 'PATCH', json: { show_activity: false } })
  expect(await ownerView()).toEqual({ user_id: alexId, status: 'online' })
  await alex.json('/client/me', { method: 'PATCH', json: { show_presence: false } })
  expect(await ownerView()).toEqual({ user_id: alexId, status: 'offline' })
  expect((await alex.json('/client/me')).privacy).toEqual({ show_presence: false, show_activity: false })
  // They still see themselves.
  expect((await alex.json('/client/state')).presence[alexId].status).toBe('online')
  await alex.json('/client/me', { method: 'PATCH', json: { show_presence: true, show_activity: true } })

  // The owner looking at a channel alex cannot view: alex sees the owner online, but not where.
  const ownerSocket = await listen(owner, LOGIN, [])
  ownerSocket.send(JSON.stringify({ op: 'focus', d: { channel_id: secret.id, visible: true } }))
  await waitFor(async () => (await owner.json('/client/state')).presence[t.config.ownerUserId].devices.some((d: { channel_id: string }) => d.channel_id === secret.id))
  const seen = (await alex.json('/client/state')).presence[t.config.ownerUserId]
  expect(seen.status).toBe('online')
  expect(seen.devices.every((d: { channel_id: string | null }) => d.channel_id !== secret.id)).toBe(true)
  alexSocket.close()
  ownerSocket.close()
})

test('removing a member ends their access', async () => {
  await owner.json(`/client/guilds/${t.config.guildId}/members/${alexId}`, { method: 'DELETE' })
  const state = await alex.json('/client/state')
  expect(state.guilds).toEqual([])
  expect(state.channels).toEqual([])
  expect((await alex.fetch(`/client/channels/${general.id}/messages`)).status).toBe(404)
  expect((await owner.fetch(`/client/guilds/${t.config.guildId}/members/${t.config.ownerUserId}`, { method: 'DELETE' })).status).toBe(403)
})

test('in a server with no machine, the agents\' bot is not a member and its machines stay hidden', async () => {
  const friends = await t.hub.store.addGuild('Friends')
  await t.hub.reload()
  await t.hub.twin.addGuildMember({ guildId: friends.id, userId: alexId })
  t.hub.access.invalidate()
  const ownerState = await owner.json('/client/state')
  expect(ownerState.members[friends.id].map((m: { user_id: string }) => m.user_id)).not.toContain(t.config.botUserId)
  expect(ownerState.members[t.config.guildId].map((m: { user_id: string }) => m.user_id)).toContain(t.config.botUserId)
  // A person who sees no machine's channels does not see the bot's machines or presence.
  const invite = await owner.json(`/client/guilds/${friends.id}/invites`, { method: 'POST', json: { username: 'robin' } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: 'robin@example.com' })
  await t.hub.reload()
  const robin = new TestDevice(t.hub, { 'tailscale-user-login': 'robin@example.com' })
  await robin.pair(invite.code)
  const state = await robin.json('/client/state')
  expect(state.machines).toEqual([])
  expect(state.presence[t.config.botUserId]).toBeUndefined()
})
