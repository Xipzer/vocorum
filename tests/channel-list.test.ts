// The channel list's per-person settings on the hub: favourites, hidden muted channels,
// joined and left threads, and moving channels. Each reaches only the person's own devices.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { Client, GatewayIntentBits } from 'discord.js'
import { P } from '../src/access.ts'
import { HubStore } from '../src/store.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let laptop: TestDevice
let phone: TestDevice
let member: TestDevice
let memberId: string
let bot: Client
const botEvents: Array<{ t: string; d: any }> = []
const memberLogin = 'lister@example.test'
const phoneEvents: Array<{ t: string; d: any }> = []
const memberEvents: Array<{ t: string; d: any }> = []
const sockets: WebSocket[] = []
// Store tables added for the channel list; an older hub database has none of them.
const NEW_TABLES = ['user_guild_settings', 'user_left_threads']

async function listen(device: TestDevice, login: string, events: Array<{ t: string; d: any }>) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login } })
  ws.on('message', (raw) => void events.push(JSON.parse(String(raw))))
  sockets.push(ws)
  await new Promise((resolve) => ws.once('open', resolve))
}
const chat = async (name: string): Promise<string> => (await laptop.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name } })).id
const deny = (channel: string, bits: bigint) => laptop.json(`/client/channels/${channel}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(bits) } })

beforeAll(async () => {
  t = await startTestHub({ extensions: [] })
  laptop = await pairedDevice(t.hub, 'laptop')
  phone = await pairedDevice(t.hub, 'phone')
  const invite = await laptop.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'lister' } })
  memberId = invite.user.id
  await t.hub.store.setProfile(memberId, { tailscaleLogin: memberLogin })
  await t.hub.refreshLogins()
  member = new TestDevice(t.hub, { 'tailscale-user-login': memberLogin })
  await member.pair(invite.code)
  await listen(phone, LOGIN, phoneEvents)
  await listen(member, memberLogin, memberEvents)
  const minted = await t.hub.store.addBot('lister-bot')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  bot.on('raw', (packet: { t: string; d: any }) => void botEvents.push(packet))
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
}, 60_000)

afterAll(async () => {
  await bot?.destroy()
  for (const ws of sockets) ws.terminate()
  await t?.cleanup()
})

test('favourites reach the person\'s other devices in the order added, only channels they can see', async () => {
  const first = await chat('fav-first')
  const second = await chat('fav-second')
  await member.json(`/client/favourites/${first}`, { method: 'PUT' })
  await member.json(`/client/favourites/${second}`, { method: 'PUT' })
  await waitFor(() => memberEvents.find((e) => e.t === 'FAVOURITES_UPDATE' && e.d.favourites.length === 2))
  expect(memberEvents.filter((e) => e.t === 'FAVOURITES_UPDATE').at(-1)!.d.favourites).toEqual([first, second])
  // Losing sight of one: the next update leaves it out.
  await deny(first, P.VIEW_CHANNEL)
  await member.json(`/client/favourites/${second}`, { method: 'DELETE' })
  await waitFor(() => memberEvents.filter((e) => e.t === 'FAVOURITES_UPDATE').at(-1)!.d.favourites.length === 0)
  expect(phoneEvents.some((e) => e.t === 'FAVOURITES_UPDATE')).toBe(false)
  expect((await member.fetch(`/client/favourites/${first}`, { method: 'PUT' })).ok).toBe(false)
})

test('a channel move checks every entry before it moves anything', async () => {
  const moving = await chat('reorder-first')
  const position = async () => (await laptop.json('/client/state')).channels.find((c: { id: string }) => c.id === moving).position
  const before = await position()
  const category = (await laptop.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Reorder', type: 4 } })).id
  const starter = (await laptop.json(`/client/channels/${moving}/messages`, { method: 'POST', json: { content: 'a thread starts here' } })).id
  const thread = (await laptop.json(`/client/channels/${moving}/messages/${starter}/threads`, { method: 'POST', json: { name: 'not movable' } })).id
  for (const bad of [{ id: '1', position: 0 }, { id: thread, position: 0 }, { id: moving, parent_id: '1' }]) {
    const response = await laptop.fetch(`/client/guilds/${t.config.guildId}/channels`, { method: 'PATCH', json: [{ id: moving, position: before + 5, parent_id: category }, bad] })
    expect(response.ok).toBe(false)
    expect(await position()).toBe(before)
  }
  // Someone without Manage Channels moves nothing either.
  expect((await member.fetch(`/client/guilds/${t.config.guildId}/channels`, { method: 'PATCH', json: [{ id: moving, position: before + 5 }] })).status).toBe(403)
  expect(await position()).toBe(before)
})

test('hide muted channels is kept per person and server, and reaches only their devices', async () => {
  const settings = (device: TestDevice, guild: string, body: unknown) => device.fetch(`/client/guilds/${guild}/settings`, { method: 'PATCH', json: body })
  expect((await settings(member, t.config.guildId, { hide_muted_channels: 'yes' })).status).toBe(400)
  expect((await settings(member, '1', { hide_muted_channels: true })).status).toBe(404)
  expect(await (await settings(member, t.config.guildId, { hide_muted_channels: true })).json()).toEqual({ guild_id: t.config.guildId, hide_muted_channels: true })
  await waitFor(() => memberEvents.find((e) => e.t === 'USER_GUILD_SETTINGS_UPDATE' && e.d.hide_muted_channels === true))
  expect((await member.json('/client/notifications')).hide_muted).toEqual([t.config.guildId])
  expect((await laptop.json('/client/notifications')).hide_muted).toEqual([])
  expect(phoneEvents.some((e) => e.t === 'USER_GUILD_SETTINGS_UPDATE')).toBe(false)
  await settings(member, t.config.guildId, { hide_muted_channels: false })
  expect((await member.json('/client/notifications')).hide_muted).toEqual([])
})

test('Join and Leave Thread change the twin\'s thread members, tell bots, and keep the left thread per person', async () => {
  const channel = await chat('thread-members')
  const starter = (await laptop.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: 'start here' } })).id
  const thread = (await laptop.json(`/client/channels/${channel}/messages/${starter}/threads`, { method: 'POST', json: { name: 'Members' } })).id
  const members = async () => (await t.hub.twin.prisma.threadMember.findMany({ where: { channelId: thread } })).map((m) => m.userId)
  expect((await member.fetch(`/client/channels/${thread}/thread-members/@me`, { method: 'PUT' })).status).toBe(204)
  expect(await members()).toContain(memberId)
  const added = await waitFor(() => botEvents.find((e) => e.t === 'THREAD_MEMBERS_UPDATE' && e.d.id === thread && e.d.added_members?.some((m: { user_id: string }) => m.user_id === memberId)))
  expect(added.d.guild_id).toBe(t.config.guildId)
  expect((await member.json('/client/state')).thread_members).toContain(thread)
  await waitFor(() => memberEvents.find((e) => e.t === 'THREAD_MEMBER_UPDATE' && e.d.id === thread && e.d.joined === true))

  expect((await member.fetch(`/client/channels/${thread}/thread-members/@me`, { method: 'DELETE' })).status).toBe(204)
  expect(await members()).not.toContain(memberId)
  await waitFor(() => botEvents.find((e) => e.t === 'THREAD_MEMBERS_UPDATE' && e.d.id === thread && e.d.removed_member_ids?.includes(memberId)))
  const state = await member.json('/client/state')
  expect({ left: state.left_threads.includes(thread), member: state.thread_members.includes(thread) }).toEqual({ left: true, member: false })
  // Only this person left it.
  expect((await laptop.json('/client/state')).left_threads).not.toContain(thread)
  expect(phoneEvents.some((e) => e.t === 'THREAD_MEMBER_UPDATE')).toBe(false)
  // Joining again brings it back; a channel is not a thread; a hidden thread is unknown.
  await member.json(`/client/channels/${thread}/thread-members/@me`, { method: 'PUT' })
  expect((await member.json('/client/state')).left_threads).not.toContain(thread)
  expect((await member.fetch(`/client/channels/${channel}/thread-members/@me`, { method: 'PUT' })).status).toBe(400)
  await deny(channel, P.VIEW_CHANNEL)
  expect((await member.fetch(`/client/channels/${thread}/thread-members/@me`, { method: 'DELETE' })).status).toBe(404)
})

test('a hub database from before these settings gains their tables and keeps everything else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-list-'))
  try {
    const url = `file:${path.join(dir, 'hub.db')}`
    const before = new HubStore(url)
    await before.migrate()
    await before.setFavourite('7', '42', true)
    // As an older build left it.
    for (const table of NEW_TABLES) await before.db.execute(`DROP TABLE ${table}`)
    before.db.close()
    const store = new HubStore(url)
    await store.migrate()
    expect(await store.favourites('7')).toEqual(['42'])
    await store.setHideMuted('7', '9', true)
    await store.setLeftThread('7', '11', true)
    await store.migrate()
    expect(await store.hideMutedGuilds('7')).toEqual(['9'])
    expect(await store.leftThreads('7')).toEqual(['11'])
    const tables = (await store.db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r['name']))
    for (const table of NEW_TABLES) expect(tables).toContain(table)
    store.db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
