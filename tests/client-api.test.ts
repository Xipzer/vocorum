// The client API drives a real discord.js bot the way Discord would.

import http from 'node:http'
import zlib from 'node:zlib'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Message,
  type TextChannel,
} from 'discord.js'
import { botTokenKey } from '../src/store.ts'
import { LOGIN, pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let phone: TestDevice
let general: string
const received: Message[] = []

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('laptop')
  await t.hub.reload()
  bot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
    rest: { api: `${t.hub.localUrl}/api`, version: '10' },
  })
  bot.on('messageCreate', (message) => {
    if (!message.author.bot) received.push(message)
  })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  phone = await pairedDevice(t.hub)
  general = (await phone.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

test('state lists the guild, channels, users and the bot', async () => {
  const state = await phone.json('/client/state')
  expect({
    guild: state.guild.name,
    channels: state.channels.map((c: { name: string }) => c.name),
    users: state.users.map((u: { username: string; bot: boolean }) => `${u.username}${u.bot ? ' (bot)' : ''}`).sort(),
    me: state.me.id === t.config.ownerUserId,
  }).toMatchInlineSnapshot(`
    {
      "channels": [
        "general",
      ],
      "guild": "Home",
      "me": true,
      "users": [
        "Kimaki (bot)",
        "owner",
      ],
    }
  `)
})

test('a posted message with an upload reaches the bot; the file is served only when signed or signed in', async () => {
  const form = new FormData()
  form.append('file', new Blob(['hello file'], { type: 'text/plain' }), 'notes.txt')
  const upload = await phone.json('/client/uploads', { method: 'POST', body: form })
  expect(upload.url).toMatch(/^\/attachments\/\d+\/notes\.txt\?ex=[0-9a-f]+&hm=[0-9a-f]{32}$/)

  await phone.json(`/client/channels/${general}/messages`, { method: 'POST', json: { content: 'hello bot', attachmentIds: [upload.id], descriptions: { [upload.id]: ' Meeting notes ' } } })
  const message = await waitFor(() => received.find((m) => m.content === 'hello bot'))
  expect(message.author.id).toBe(t.config.ownerUserId)
  const attachment = message.attachments.first()!
  // Alt text set in the composer: the bot and every device get it as description.
  expect(attachment.description).toBe('Meeting notes')
  const loaded = (await phone.json(`/client/channels/${general}/messages`)).messages.find((m: { id: string }) => m.id === message.id)
  expect(loaded.attachments[0].description).toBe('Meeting notes')
  // Absolute for bots: Kimaki downloads it with a plain fetch.
  expect(attachment.url.startsWith(`${t.hub.localUrl}/attachments/`)).toBe(true)
  expect(await (await fetch(attachment.url)).text()).toBe('hello file')

  const unsigned = attachment.url.split('?')[0]!
  const tampered = attachment.url.replace(/hm=(.)/, (_m, c: string) => `hm=${c === '0' ? '1' : '0'}`)
  expect({
    unsigned: (await fetch(unsigned)).status,
    tampered: (await fetch(tampered)).status,
    session: (await fetch(unsigned, { headers: { cookie: phone.cookie! } })).status,
  }).toEqual({ unsigned: 404, tampered: 404, session: 200 })
})

test('bot uploads land on disk, not in the database as data: URIs', async () => {
  const channel = (await bot.channels.fetch(general)) as TextChannel
  const sent = await channel.send({ content: 'diagram', files: [new AttachmentBuilder(Buffer.from('PNGDATA'), { name: 'flow.png' })] })
  expect(sent.attachments.first()!.url).toMatch(/\/attachments\/\d+\/flow\.png\?ex=[0-9a-f]+&hm=/)
  const { messages } = await phone.json(`/client/channels/${general}/messages`)
  const last = messages.at(-1)
  expect(last.attachments[0].url).toMatch(/^\/attachments\/\d+\/flow\.png\?ex=[0-9a-f]+&hm=/)
  expect(await (await phone.fetch(last.attachments[0].url)).text()).toBe('PNGDATA')
})

test('the event socket streams dispatches for the guild', async () => {
  const events: Array<{ t: string; d: any }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { 'tailscale-user-login': LOGIN, origin: phone.origin, cookie: phone.cookie! } })
  ws.on('message', (data) => events.push(JSON.parse(String(data))))
  await waitFor(() => events.some((e) => e.t === 'HELLO'))
  const channel = (await bot.channels.fetch(general)) as TextChannel
  await channel.sendTyping()
  const sent = await channel.send('streamed')
  await sent.edit('streamed (edited)')
  await sent.react('👍')
  await sent.delete()
  await waitFor(() => events.some((e) => e.t === 'MESSAGE_DELETE'))
  ws.close()
  expect(events.map((e) => e.t).filter((type) => !['PRESENCE_UPDATE', 'SESSION_LINKS', 'SESSION_STATE', 'MACHINES_UPDATE'].includes(type))).toEqual(['HELLO', 'TYPING_START', 'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_REACTION_ADD', 'MESSAGE_DELETE'])
})

test('voice notes carry the voice flag, duration and waveform', async () => {
  const form = new FormData()
  form.append('file', new Blob([Buffer.from('OggS fake')], { type: 'audio/ogg' }), 'voice-message.ogg')
  form.append('voice', '1')
  form.append('durationSecs', '2.5')
  form.append('waveform', Buffer.alloc(32, 7).toString('base64'))
  const upload = await phone.json('/client/uploads', { method: 'POST', body: form })
  await phone.json(`/client/channels/${general}/messages`, { method: 'POST', json: { attachmentIds: [upload.id], voice: true } })
  const message = await waitFor(() => received.find((m) => m.attachments.first()?.name === 'voice-message.ogg'))
  const attachment = message.attachments.first()!
  expect({ flags: message.flags.has('IsVoiceMessage'), duration: attachment.duration, waveform: Boolean(attachment.waveform), type: attachment.contentType }).toEqual({
    flags: true,
    duration: 2.5,
    waveform: true,
    type: 'audio/ogg',
  })
})

test('buttons, selects and modals round-trip through the bot', async () => {
  bot.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId === 'open') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('ask')
          .setTitle('Question')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('answer').setLabel('Answer').setStyle(TextInputStyle.Short))),
      )
    }
    if (interaction.isStringSelectMenu()) await interaction.update({ content: `picked ${interaction.values.join(',')}`, components: [] })
    if (interaction.isModalSubmit()) await interaction.reply({ content: `answer: ${interaction.fields.getTextInputValue('answer')}` })
  })
  const channel = (await bot.channels.fetch(general)) as TextChannel
  const prompt = await channel.send({
    content: 'choose',
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('open').setLabel('Open').setStyle(ButtonStyle.Primary)),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('pick').addOptions({ label: 'A', value: 'a' }, { label: 'B', value: 'b' })),
    ],
  })

  const click = await phone.json('/client/interactions', { method: 'POST', json: { type: 'button', channelId: general, messageId: prompt.id, customId: 'open' } })
  expect({ type: click.type, modal: click.data.custom_id, title: click.data.title }).toEqual({ type: 9, modal: 'ask', title: 'Question' })

  const submit = await phone.json('/client/interactions', { method: 'POST', json: { type: 'modal', channelId: general, messageId: prompt.id, customId: 'ask', fields: [{ customId: 'answer', value: '42' }] } })
  expect({ type: submit.type, content: submit.data.content }).toEqual({ type: 4, content: 'answer: 42' })

  const select = await phone.json('/client/interactions', { method: 'POST', json: { type: 'select', channelId: general, messageId: prompt.id, customId: 'pick', values: ['b'] } })
  expect(select.type).toBe(7)
  const { messages } = await phone.json(`/client/channels/${general}/messages`)
  expect(messages.find((m: { id: string }) => m.id === prompt.id).content).toBe('picked b')
})

test('slash commands and autocomplete', async () => {
  await bot.application!.commands.set(
    [{ name: 'echo', description: 'Echo text', options: [{ name: 'text', description: 'Text', type: 3, required: true, autocomplete: true }] }],
    t.config.guildId,
  )
  bot.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) await interaction.respond([{ name: `${interaction.options.getFocused()}!`, value: 'x' }])
    if (interaction.isChatInputCommand()) await interaction.reply(`echo: ${interaction.options.getString('text')}`)
  })
  const state = await phone.json('/client/state')
  expect(state.commands.map((c: { name: string }) => c.name)).toEqual(['echo'])
  const auto = await phone.json('/client/autocomplete', { method: 'POST', json: { channelId: general, name: 'echo', focused: 'text', options: [{ name: 'text', type: 3, value: 'hi' }] } })
  expect(auto.choices).toEqual([{ name: 'hi!', value: 'x' }])
  const run = await phone.json('/client/commands', { method: 'POST', json: { channelId: general, name: 'echo', options: [{ name: 'text', type: 3, value: 'yo' }] } })
  expect(run.data.content).toBe('echo: yo')
})

test('reactions, thread rename and archive, own message edit and delete', async () => {
  const channel = (await bot.channels.fetch(general)) as TextChannel
  const starter = await phone.json(`/client/channels/${general}/messages`, { method: 'POST', json: { content: 'start a thread' } })
  const thread = await channel.threads.create({ name: 'session', startMessage: starter.id })
  await phone.json(`/client/channels/${general}/messages/${starter.id}/reactions/${encodeURIComponent('🔥')}`, { method: 'PUT' })
  const renamed = await phone.json(`/client/channels/${thread.id}`, { method: 'PATCH', json: { name: 'renamed' } })
  expect(renamed.name).toBe('renamed')
  const archived = await phone.json(`/client/channels/${thread.id}`, { method: 'PATCH', json: { archived: true } })
  expect(archived.thread_metadata.archived).toBe(true)

  // The thread view starts with the starter message, carrying the reaction.
  const { messages } = await phone.json(`/client/channels/${thread.id}/messages`)
  expect(messages[0].id).toBe(starter.id)
  expect(messages[0].reactions_summary).toEqual([{ emoji: '🔥', count: 1, me: true }])

  const edited = await phone.json(`/client/channels/${general}/messages/${starter.id}`, { method: 'PATCH', json: { content: 'edited' } })
  expect(edited.content).toBe('edited')
  const botMessage = await channel.send('not yours')
  // Editing is for the author only; the owner may delete anyone's (Manage Messages), like Discord.
  expect((await phone.fetch(`/client/channels/${general}/messages/${botMessage.id}`, { method: 'PATCH', json: { content: 'mine now' } })).status).toBe(403)
  expect((await phone.fetch(`/client/channels/${general}/messages/${botMessage.id}`, { method: 'DELETE' })).status).toBe(204)
})

test('revoking a bot disconnects it and its REST access', async () => {
  const closed = new Promise<number>((resolve) => {
    const gatewayClients = (t.hub.twin as unknown as { server: { gateway: { clients: Array<{ ws: WebSocket; token: string | null }> } } }).server.gateway.clients
    gatewayClients.find((client) => client.token === botTokenKey(bot.token!))!.ws.once('close', (code: number) => resolve(code))
  })
  await t.hub.store.revokeBot('laptop')
  await t.hub.reload()
  expect(await closed).toBe(4004)
  const status = (await fetch(`${t.hub.localUrl}/api/v10/guilds/${t.config.guildId}`, { headers: { authorization: `Bot ${bot.token}` } })).status
  expect(status).toBe(401)
})

test('large JSON goes out compressed when the client accepts it', async () => {
  const plain = await phone.fetch('/client/state', { headers: { 'accept-encoding': 'identity' } })
  expect(plain.headers.get('content-encoding')).toBeNull()
  const text = await plain.text()
  for (const encoding of ['br', 'gzip']) {
    const raw = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
      const req = http.get(`${t.hub.localUrl}/client/state`, { headers: { 'accept-encoding': encoding, cookie: phone.cookie!, 'tailscale-user-login': LOGIN, origin: phone.origin } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
    })
    expect(raw.encoding).toBe(encoding)
    const decoded = encoding === 'br' ? zlib.brotliDecompressSync(raw.body) : zlib.gunzipSync(raw.body)
    expect(JSON.parse(decoded.toString()).me).toEqual(JSON.parse(text).me)
    expect(raw.body.length).toBeLessThan(text.length)
  }
})
