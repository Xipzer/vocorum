// A bot's answers to an interaction say who triggered it, like Discord's
// "Owner used /model" line: interaction_metadata (and the older interaction
// field) on the reply, the deferred reply and follow-ups.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { Client, GatewayIntentBits, MessageFlags, type TextChannel } from 'discord.js'
import { pairedDevice, startTestHub, waitFor, TestDevice } from './helpers.ts'

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
  await bot.application!.commands.create({ name: 'receipt', description: 'private result' }, t.config.guildId)
  bot.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId === 'confirm-receipt') return void (await interaction.update({ content: 'Selection saved', components: [] }))
    if (interaction.isUserSelectMenu()) return void (await interaction.reply(`picked user ${interaction.users.first()?.username}`))
    if (interaction.isChannelSelectMenu()) return void (await interaction.reply(`picked channel ${interaction.channels.first()?.id}`))
    if (!interaction.isChatInputCommand()) return
    if (interaction.commandName === 'receipt') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      await interaction.editReply({ content: 'Account summary', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Confirm', custom_id: 'confirm-receipt' }] }] })
      await interaction.followUp({ flags: MessageFlags.Ephemeral, content: 'Receipt details' })
    } else if (interaction.commandName === 'model') await interaction.reply('Current model: opus')
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

test('user and channel menus reach the bot as their own types, with resolved objects', async () => {
  const sent = await general.send({
    content: 'who and where?',
    components: [
      { type: 1, components: [{ type: 5, custom_id: 'who' }] },
      { type: 1, components: [{ type: 8, custom_id: 'where' }] },
    ],
  })
  await phone.json('/client/interactions', { method: 'POST', json: { type: 'select', channelId: general.id, messageId: sent.id, customId: 'who', values: [t.config.ownerUserId] } })
  const owner = (await phone.json('/client/state')).users.find((u: { id: string }) => u.id === t.config.ownerUserId)
  await waitFor(async () => (await phone.json(`/client/channels/${general.id}/messages`)).messages.find((m: { content: string }) => m.content === `picked user ${owner.username}`))
  await phone.json('/client/interactions', { method: 'POST', json: { type: 'select', channelId: general.id, messageId: sent.id, customId: 'where', values: [general.id, '999999999999999999'] } })
  await waitFor(async () => (await phone.json(`/client/channels/${general.id}/messages`)).messages.find((m: { content: string }) => m.content === `picked channel ${general.id}`))
})

test('private command replies, deferred edits and follow-ups belong only to the caller', async () => {
  const { hub, config } = t
  const id = await hub.twin.createUser({ username: 'reader' })
  await hub.twin.addGuildMember({ userId: id, guildId: config.guildId })
  await hub.store.setProfile(id, { tailscaleLogin: 'reader@example.org' })
  await hub.refreshLogins()
  const reader = new TestDevice(hub, { 'tailscale-user-login': 'reader@example.org' })
  await reader.pair(await hub.store.createPairing('reader', { userId: id }))
  const history = `/client/channels/${general.id}/messages`
  const last = () => hub.twin.prisma.channel.findUniqueOrThrow({ where: { id: general.id }, select: { lastMessageId: true, messageCount: true } })
  const before = await last()
  await phone.json('/client/commands', { method: 'POST', json: { channelId: general.id, name: 'receipt' } })
  const mine = await waitFor(async () => {
    const { privateReplies } = await phone.json<{ privateReplies: Array<{ id: string; flags: number; content: string }> }>(history)
    return privateReplies.length === 2 ? privateReplies : null
  })
  const original = mine.find((m) => m.content === 'Account summary')!
  expect(original).toMatchObject({ flags: 64, interaction_metadata: { name: 'receipt', user: { id: config.ownerUserId } } })
  expect((await reader.json(history)).privateReplies).toEqual([])
  const shared = await general.messages.fetch({ limit: 20 })
  for (const m of mine) expect(shared.has(m.id)).toBe(false)
  await phone.json('/client/interactions', { method: 'POST', json: { type: 'button', channelId: general.id, messageId: original.id, customId: 'confirm-receipt' } })
  const updated = await phone.json(history)
  expect(updated.privateReplies.find((m: { id: string }) => m.id === original.id)).toMatchObject({ content: 'Selection saved', flags: 64 })
  expect(await last()).toEqual(before)
  await phone.json(`/client/channels/${general.id}/private-replies/${original.id}`, { method: 'DELETE' })
  expect((await phone.json(history)).privateReplies).toHaveLength(1)
})
