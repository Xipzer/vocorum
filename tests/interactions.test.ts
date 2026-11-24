// A bot's answers to an interaction say who triggered it, like Discord's
// "Owner used /model" line: interaction_metadata (and the older interaction
// field) on the reply, the deferred reply and follow-ups.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let phone: TestDevice
let general: TextChannel

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('desktop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  phone = await pairedDevice(t.hub)
  const state = await phone.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
  await bot.application!.commands.create({ name: 'model', description: 'pick a model' }, t.config.guildId)
  await bot.application!.commands.create({ name: 'slow', description: 'deferred' }, t.config.guildId)
  bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return
    if (interaction.commandName === 'model') await interaction.reply('Current model: opus')
    else {
      await interaction.deferReply()
      await interaction.editReply('done after a while')
      await interaction.followUp('and one more thing')
    }
  })
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

test('a command reply says who used which command', async () => {
  await phone.json('/client/commands', { method: 'POST', json: { channelId: general.id, name: 'model' } })
  const reply = await waitFor(async () => (await phone.json(`/client/channels/${general.id}/messages`)).messages.find((m: { content: string }) => m.content === 'Current model: opus'))
  expect(reply.interaction_metadata).toMatchObject({ type: 2, name: 'model', user: { id: t.config.ownerUserId } })
  expect(reply.interaction).toMatchObject({ name: 'model', user: { id: t.config.ownerUserId } })
  // Bots see it too.
  const fetched = await general.messages.fetch(reply.id)
  expect(fetched.interactionMetadata?.user.id).toBe(t.config.ownerUserId)
})

test('deferred replies and follow-ups carry it as well', async () => {
  await phone.json('/client/commands', { method: 'POST', json: { channelId: general.id, name: 'slow' } })
  const messages = await waitFor(async () => {
    const list = (await phone.json(`/client/channels/${general.id}/messages`)).messages
    return list.some((m: { content: string }) => m.content === 'and one more thing') ? list : null
  })
  for (const content of ['done after a while', 'and one more thing']) {
    expect(messages.find((m: { content: string }) => m.content === content).interaction_metadata).toMatchObject({ name: 'slow', user: { id: t.config.ownerUserId } })
  }
})
