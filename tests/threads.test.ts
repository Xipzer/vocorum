// Threads started from a message, as on Discord: the thread has the message's
// id, and the starter message carries the thread (REST, MESSAGE_UPDATE, PWA).

import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, MessageFlags, type TextChannel } from 'discord.js'
import { LOGIN, pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

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
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

test('a thread from a message has the message id, and the message carries the thread', async () => {
  const events: Array<{ t: string; d: any }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: phone.origin, cookie: phone.cookie!, 'tailscale-user-login': LOGIN } })
  ws.on('message', (data) => events.push(JSON.parse(String(data))))
  await new Promise((resolve) => ws.once('open', resolve))

  const starter = await phone.json(`/client/channels/${general.id}/messages`, { method: 'POST', json: { content: 'fix the footer' } })
  const message = await general.messages.fetch(starter.id)
  const thread = await message.startThread({ name: 'Footer fix' })
  expect(thread.id).toBe(starter.id)
  await thread.send('on it')

  // discord.js sees the thread on the message (MESSAGE_UPDATE and REST).
  const refetched = await general.messages.fetch({ message: starter.id, force: true })
  expect(refetched.flags.has(MessageFlags.HasThread)).toBe(true)
  expect(refetched.thread?.id).toBe(starter.id)
  expect((await thread.fetchStarterMessage())?.id).toBe(starter.id)

  // The PWA: in the message list and live.
  const update = await waitFor(() => events.find((e) => e.t === 'MESSAGE_UPDATE' && e.d.id === starter.id && e.d.thread))
  expect(update.d.thread).toMatchObject({ id: starter.id, name: 'Footer fix', parent_id: general.id })
  const { messages } = await phone.json(`/client/channels/${general.id}/messages`)
  const listed = messages.find((m: { id: string }) => m.id === starter.id)
  expect(listed.thread).toMatchObject({ id: starter.id, name: 'Footer fix' })
  expect(listed.flags & MessageFlags.HasThread).toBe(MessageFlags.HasThread)
  // The thread view still opens with its starter message.
  expect((await phone.json(`/client/channels/${thread.id}/messages`)).messages[0].id).toBe(starter.id)
  ws.close()
})
