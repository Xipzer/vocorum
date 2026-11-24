// Several guilds (spaces) in one hub, like one Discord account in several
// servers: the CLI registers them, a bot joins some of them and gets
// GUILD_CREATE / GUILD_DELETE live, and the client API covers all of them.

import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let other: Client
let phone: TestDevice
let friends: { id: string; name: string }

beforeAll(async () => {
  t = await startTestHub()
  const login = async (machine: string) => {
    const minted = await t.hub.store.addBot(machine)
    await t.hub.reload()
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
    const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
    await client.login(`${minted.clientId}:${minted.secret}`)
    await ready
    return client
  }
  bot = await login('desktop')
  other = await login('mac')
  phone = await pairedDevice(t.hub)
})

afterAll(async () => {
  await bot.destroy()
  await other.destroy()
  await t.cleanup()
})

test('a new guild reaches the bots that join it, live, and only them', async () => {
  expect(bot.guilds.cache.map((g) => g.id)).toEqual([t.config.guildId])
  const events: Array<{ t: string; d: { id?: string; name?: string } }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: phone.origin, cookie: phone.cookie!, 'tailscale-user-login': 'owner@example.com' } })
  ws.on('message', (data) => events.push(JSON.parse(String(data))))
  await new Promise((resolve) => ws.once('open', resolve))

  friends = await t.hub.store.addGuild('Friends')
  await t.hub.reload()
  expect(await waitFor(() => events.find((e) => e.t === 'GUILD_CREATE'))).toMatchObject({ d: { id: friends.id, name: 'Friends' } })
  // Registered, but no bot is in it yet.
  expect(bot.guilds.cache.has(friends.id)).toBe(false)

  await t.hub.store.setBotGuilds('desktop', [t.config.guildId, friends.id])
  await t.hub.reload()
  const joined = await waitFor(() => bot.guilds.cache.get(friends.id))
  expect(joined.name).toBe('Friends')
  expect(joined.channels.cache.map((c) => c.name)).toEqual(['general'])
  expect(other.guilds.cache.has(friends.id)).toBe(false)

  // Messages in the new guild reach its bot and the owner's devices, not other bots.
  const seenByOther: string[] = []
  other.on('messageCreate', (m) => seenByOther.push(m.id))
  const general = joined.channels.cache.find((c) => c.name === 'general') as TextChannel
  const sent = await general.send('hello from the second server')
  expect(await waitFor(() => events.find((e) => e.t === 'MESSAGE_CREATE' && e.d.id === sent.id))).toBeTruthy()
  await new Promise((r) => setTimeout(r, 100))
  expect(seenByOther).toEqual([])

  // Renames go out as GUILD_UPDATE.
  await t.hub.store.renameGuild(friends.id, 'Friends (Side Projects)')
  await t.hub.reload()
  await waitFor(() => bot.guilds.cache.get(friends.id)?.name === 'Friends (Side Projects)')
  expect(await waitFor(() => events.find((e) => e.t === 'GUILD_UPDATE' && e.d.id === friends.id))).toBeTruthy()
  ws.close()
})

test('the client API covers every guild: state, messages, search, inbox and pins', async () => {
  const state = await phone.json('/client/state')
  expect(state.guilds.map((g: { id: string; name: string; icon: null }) => [g.id, g.name, g.icon])).toEqual([
    [t.config.guildId, t.config.guildName, null],
    [friends.id, 'Friends (Side Projects)', null],
  ])
  const second = state.channels.find((c: { guild_id: string }) => c.guild_id === friends.id)
  expect(second.name).toBe('general')
  expect(Object.keys(state.guildCommands).sort()).toEqual([t.config.guildId, friends.id].sort())

  const posted = await phone.json(`/client/channels/${second.id}/messages`, { method: 'POST', json: { content: `<@${t.config.ownerUserId}> crosscheck from the owner` } })
  expect(posted.guild_id).toBe(friends.id)
  const fromBot = await (bot.channels.cache.get(second.id) as TextChannel).send(`<@${t.config.ownerUserId}> crossguild mention`)
  await t.hub.search.flush()
  const found = await phone.json('/client/search?q=crossguild')
  expect(found.results[0]).toMatchObject({ message: { id: fromBot.id, guild_id: friends.id }, channel: { id: second.id, guild_id: friends.id } })
  expect((await phone.json(`/client/search?q=${encodeURIComponent('in:#general crossguild')}`)).total).toBe(1)
  expect((await phone.json('/client/inbox')).mentions[0]).toMatchObject({ message: { id: fromBot.id }, channel: { guild_id: friends.id }, read: false })
  expect((await phone.json('/client/state')).mentions[second.id]).toBe(1)

  await phone.json(`/client/channels/${second.id}/pins/${fromBot.id}`, { method: 'PUT' })
  expect((await phone.json(`/client/channels/${second.id}/pins`)).messages[0]).toMatchObject({ id: fromBot.id, guild_id: friends.id })
})

test('leaving a guild: GUILD_DELETE, and the bot loses access', async () => {
  await t.hub.store.setBotGuilds('desktop', [t.config.guildId])
  await t.hub.reload()
  await waitFor(() => !bot.guilds.cache.has(friends.id))
  const second = (await phone.json('/client/state')).channels.find((c: { guild_id: string }) => c.guild_id === friends.id)
  const status = await fetch(`${t.hub.localUrl}/api/v10/channels/${second.id}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${bot.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'should be refused' }),
  }).then((r) => r.status)
  expect(status).toBeGreaterThanOrEqual(400)
})

test('guilds survive a restart and channels outside them stay hidden', async () => {
  await t.hub.stop()
  const { Hub } = await import('../src/hub.ts')
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir: `${t.paths.root}/web` })
  await t.hub.start()
  expect(t.hub.guilds.map((g) => g.id)).toEqual([t.config.guildId, friends.id])
  expect(await t.hub.twin.prisma.guild.count()).toBe(2)
  // A guild in the twin that the hub never registered is invisible to devices.
  const stray = await t.hub.twin.createGuild({ name: 'stray', ownerId: t.config.ownerUserId })
  const strayChannel = await t.hub.twin.prisma.channel.findFirstOrThrow({ where: { guildId: stray } })
  const device = await pairedDevice(t.hub, 'laptop')
  expect((await device.fetch(`/client/channels/${strayChannel.id}/messages`)).status).toBe(404)
  expect((await device.json('/client/state')).guilds.map((g: { id: string }) => g.id)).not.toContain(stray)
})
