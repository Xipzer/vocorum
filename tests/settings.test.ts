// Settings from the app: profile, devices, server and channel settings. Bots
// see the changes through the gateway like they would on Discord.

import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, type Guild } from 'discord.js'
import { channelName, imageType } from '../src/settings.ts'
import { LOGIN, pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let guild: Guild
let phone: TestDevice
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('desktop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  guild = bot.guilds.cache.get(t.config.guildId)!
  phone = await pairedDevice(t.hub, 'iphone')
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

test('helpers: image sniffing and Discord channel names', () => {
  expect(imageType(PNG)).toBe('image/png')
  expect(imageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
  expect(channelName('My New  Channel!', 0)).toBe('my-new-channel')
  expect(channelName('Projects & Ideas', 4)).toBe('Projects & Ideas')
})

test('profile: display name, colour and avatar reach devices and bots', async () => {
  const events: Array<{ t: string; d: any }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: phone.origin, cookie: phone.cookie!, 'tailscale-user-login': LOGIN } })
  ws.on('message', (data) => events.push(JSON.parse(String(data))))
  await new Promise((resolve) => ws.once('open', resolve))

  expect((await phone.fetch('/client/me', { method: 'PATCH', json: { color: 'red' } })).status).toBe(400)
  const me = await phone.json('/client/me', { method: 'PATCH', json: { global_name: 'Sam', color: 0x22d3ee } })
  expect(me.user).toMatchObject({ id: t.config.ownerUserId, global_name: 'Sam', color: 0x22d3ee })
  expect(await waitFor(() => events.find((e) => e.t === 'USER_UPDATE'))).toMatchObject({ d: { global_name: 'Sam', color: 0x22d3ee } })
  await waitFor(() => guild.members.cache.get(t.config.ownerUserId)?.user.globalName === 'Sam')

  expect((await phone.fetch('/client/me/avatar', { method: 'PUT', body: Buffer.from('not an image') })).status).toBe(400)
  const withAvatar = await phone.json('/client/me/avatar', { method: 'PUT', body: PNG, headers: { 'content-type': 'image/png' } })
  expect(withAvatar.user.avatar).toMatch(/^[0-9a-f]{32}$/)
  const image = await phone.fetch(`/client/avatars/${t.config.ownerUserId}`)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true)
  const state = await phone.json('/client/state')
  expect(state.users.find((u: { id: string }) => u.id === t.config.ownerUserId)).toMatchObject({ global_name: 'Sam', color: 0x22d3ee, avatar: withAvatar.user.avatar })
  await phone.json('/client/me/avatar', { method: 'DELETE' })
  expect((await phone.fetch(`/client/avatars/${t.config.ownerUserId}`)).status).toBe(404)
  ws.close()
})

test('devices: list, rename and revoke from the app', async () => {
  const laptop = await pairedDevice(t.hub, 'laptop')
  const list = await phone.json('/client/devices')
  expect(list.devices.map((d: { name: string; current: boolean }) => [d.name, d.current])).toEqual([['iphone', true], ['laptop', false]])
  const renamed = await phone.json(`/client/devices/${list.devices[1].id}`, { method: 'PATCH', json: { name: 'Work laptop' } })
  expect(renamed.devices[1].name).toBe('Work laptop')
  expect(await phone.json(`/client/devices/${list.devices[1].id}`, { method: 'DELETE' })).toEqual({ revoked: list.devices[1].id, signed_out: false })
  expect((await laptop.fetch('/client/state')).status).toBe(401)
  expect((await phone.json('/client/devices')).devices).toHaveLength(1)
  expect((await phone.fetch('/client/devices/999', { method: 'DELETE' })).status).toBe(404)
})

test('server settings: rename and icon', async () => {
  const renamed = await phone.json(`/client/guilds/${t.config.guildId}`, { method: 'PATCH', json: { name: 'Side Projects' } })
  expect(renamed.name).toBe('Side Projects')
  await waitFor(() => guild.name === 'Side Projects')
  const icon = await phone.json(`/client/guilds/${t.config.guildId}/icon`, { method: 'PUT', body: PNG })
  expect(icon.icon).toMatch(/^[0-9a-f]{32}$/)
  expect((await phone.json('/client/state')).guilds[0]).toMatchObject({ name: 'Side Projects', icon: icon.icon })
  expect((await phone.fetch(`/client/guild-icons/${t.config.guildId}`)).headers.get('content-type')).toBe('image/png')
  await waitFor(() => guild.icon === icon.icon)
  expect((await phone.fetch('/client/guilds/123', { method: 'PATCH', json: { name: 'x' } })).status).toBe(404)
})

test('channels: create, edit, move and delete channels and categories', async () => {
  const category = await phone.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Machines', type: 4 } })
  const channel = await phone.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Build Logs', parent_id: category.id, topic: 'CI output' } })
  expect(channel).toMatchObject({ name: 'build-logs', parent_id: category.id, topic: 'CI output', guild_id: t.config.guildId })
  await waitFor(() => guild.channels.cache.get(channel.id))
  expect((await phone.fetch(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'x', parent_id: channel.id } })).status).toBe(400)

  const edited = await phone.json(`/client/channels/${channel.id}/settings`, { method: 'PATCH', json: { name: 'ci', topic: null, parent_id: null, position: 3 } })
  expect(edited).toMatchObject({ name: 'ci', topic: null, parent_id: null, position: 3 })
  await waitFor(() => guild.channels.cache.get(channel.id)?.name === 'ci')

  const moved = await phone.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'PATCH', json: [{ id: channel.id, parent_id: category.id, position: 0 }] })
  expect(moved.channels[0]).toMatchObject({ parent_id: category.id, position: 0 })

  // Deleting a category keeps its channels, without a category.
  await phone.json(`/client/channels/${category.id}`, { method: 'DELETE' })
  await waitFor(() => !guild.channels.cache.has(category.id))
  const state = await phone.json('/client/state')
  expect(state.channels.find((c: { id: string }) => c.id === channel.id).parent_id).toBeNull()
  await phone.json(`/client/channels/${channel.id}`, { method: 'DELETE' })
  await waitFor(() => !guild.channels.cache.has(channel.id))
})
