// A bot's custom status (gateway op 3) reaches people as presence[bot].activity,
// so they can see what a silent bot is doing; cleared, it is null again.

import { afterAll, expect, test } from 'vitest'
import { ActivityType, Client, GatewayIntentBits } from 'discord.js'
import { pairedDevice, startTestHub, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let client: Client | null = null

afterAll(async () => {
  await client?.destroy()
  await t?.cleanup()
})

test('a bot that sets a custom status shows it to people; clearing it clears it', async () => {
  t = await startTestHub()
  const owner = await pairedDevice(t.hub, 'owner-laptop')
  const bot = await t.hub.store.addBot('desk-pc')
  await t.hub.reload()
  client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => client!.once('clientReady', () => resolve()))
  await client.login(`${bot.clientId}:${bot.secret}`)
  await ready
  const activity = async () => (await owner.json('/client/state')).presence[t.config.botUserId]?.activity
  await waitFor(async () => ((await activity()) === null ? true : undefined))
  client.user!.setPresence({ activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Searching the web' }] })
  expect(await waitFor(async () => ((await activity()) === 'Searching the web' ? true : undefined))).toBe(true)
  const state = await owner.json('/client/state')
  expect(state.presence[t.config.botUserId].machines).toEqual([{ machine: 'desk-pc', online: true, activity: 'Searching the web' }])
  client.user!.setPresence({ activities: [] })
  expect(await waitFor(async () => ((await activity()) === null ? true : undefined))).toBe(true)
})

test('a bot that identifies with a presence shows it at once', async () => {
  const bot = await t.hub.store.addBot('laptop')
  await t.hub.reload()
  const owner = await pairedDevice(t.hub, 'owner-phone')
  const second = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${t.hub.localUrl}/api`, version: '10' }, presence: { activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: 'Idle' }] } })
  const ready = new Promise<void>((resolve) => second.once('clientReady', () => resolve()))
  await second.login(`${bot.clientId}:${bot.secret}`)
  await ready
  try {
    const machines = await waitFor(async () => {
      const m = (await owner.json('/client/state')).presence[t.config.botUserId]?.machines as Array<{ machine: string; activity: string | null }>
      return m?.find((x) => x.machine === 'laptop' && x.activity === 'Idle') ? m : undefined
    })
    expect(machines.find((m) => m.machine === 'laptop')!.activity).toBe('Idle')
  } finally {
    await second.destroy()
  }
})
