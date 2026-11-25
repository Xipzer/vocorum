// A machine bot can be its own bot user: it logs in as that user, joins voice
// and posts as it, and its presence and custom status are its own, apart from
// the shared bot's. Made shared again, it reconnects as the shared bot.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { ActivityType, Client, GatewayIntentBits } from 'discord.js'
import { snowflake } from '../src/config.ts'
import { TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
const clients: Client[] = []

async function login(machine: string) {
  const bot = await t.hub.store.addBot(machine)
  return `${bot.clientId}:${bot.secret}`
}

async function connect(token: string) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  clients.push(client)
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(token)
  await ready
  return client
}

beforeAll(async () => {
  t = await startTestHub()
  owner = await pairedDevice(t.hub, 'owner-laptop')
}, 60_000)

afterAll(async () => {
  for (const c of clients) await c.destroy()
  await t?.cleanup()
})

test('a machine with its own user is that user in login, presence, posts and voice', async () => {
  const sharedToken = await login('desk-pc')
  const helperToken = await login('helper')
  await t.hub.store.setBotUser('helper', 'Helper', snowflake)
  await t.hub.reload()
  const helperId = (await t.hub.store.botUsers()).get('helper')!.userId

  const shared = await connect(sharedToken)
  const helper = await connect(helperToken)
  expect(shared.user!.id).toBe(t.config.botUserId)
  expect(helper.user!.id).toBe(helperId)
  expect(helper.user!.bot).toBe(true)
  expect(helper.user!.globalName).toBe('Helper')

  // Each status stays with its own user.
  shared.user!.setPresence({ activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Working in 2 threads' }] })
  helper.user!.setPresence({ activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Listening' }] })
  const presence = await waitFor(async () => {
    const p = (await owner.json('/client/state')).presence
    return p[helperId]?.activity === 'Listening' && p[t.config.botUserId]?.activity === 'Working in 2 threads' ? p : undefined
  })
  expect(presence[helperId].machines).toEqual([{ machine: 'helper', online: true, activity: 'Listening' }])
  expect(presence[t.config.botUserId].machines).toEqual([{ machine: 'desk-pc', online: true, activity: 'Working in 2 threads' }])

  // People see it as a member; what it posts is by it.
  const state = await owner.json('/client/state')
  expect(state.users.find((u: { id: string }) => u.id === helperId)).toMatchObject({ global_name: 'Helper', bot: true })
  const general = state.channels.find((c: { name: string }) => c.name === 'general').id
  const channel = await helper.channels.fetch(general)
  if (!channel?.isSendable()) throw new Error('general is not sendable')
  const sent = await channel.send('hello from the helper')
  expect(sent.author.id).toBe(helperId)

  // In voice it is itself, not the shared bot.
  const room = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Lounge', type: 2 } })).id
  helper.ws.shards.first()!.send({ op: 4, d: { guild_id: t.config.guildId, channel_id: room, self_mute: false, self_deaf: false } })
  const states = await waitFor(async () => {
    const s = (await owner.json('/client/state')).voice_states as Array<{ user_id: string; channel_id: string }>
    return s.length ? s : undefined
  })
  expect(states).toEqual([expect.objectContaining({ user_id: helperId, channel_id: room })])
})

test('made shared again, it reconnects as the shared bot', async () => {
  const helper = clients[1]!
  const readies: Array<{ id: string }> = []
  helper.on('raw', (packet: { t?: string; d?: { user?: { id: string } } }) => {
    if (packet.t === 'READY' && packet.d?.user) readies.push(packet.d.user)
  })
  await t.hub.store.setBotUser('helper', null, snowflake)
  await t.hub.reload()
  // It identifies again; its new READY is the shared bot.
  const ready = await waitFor(() => readies.find((r) => r.id === t.config.botUserId), { timeout: 20_000 })
  expect(ready).toBeTruthy()
  const presence = await waitFor(async () => {
    const p = (await owner.json('/client/state')).presence
    return p[t.config.botUserId]?.machines?.length === 2 ? p : undefined
  })
  expect(presence[t.config.botUserId].machines.map((m: { machine: string }) => m.machine).sort()).toEqual(['desk-pc', 'helper'])
}, 30_000)
