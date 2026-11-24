// Hooks a hub builds on: dispatch observers, extra HTTP/WS routes on the same
// port, an attachment store for bot uploads, and revocation that disconnects.

import http from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { AttachmentBuilder, ChannelType, Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { DigitalDiscord } from '../src/index.js'

const GUILD = '310000000000000001'
const CHANNEL = '310000000000000011'
const USER = '310000000000000021'
const TOKEN = 'client-1:secret-1'
const stored: string[] = []

let discord: DigitalDiscord
let client: Client

beforeAll(async () => {
  discord = new DigitalDiscord({
    gatewayProxy: true,
    users: [{ id: USER, username: 'owner' }],
    guild: { id: GUILD, channels: [{ id: CHANNEL, name: 'general', type: ChannelType.GuildText }] },
    storeAttachment: async ({ id, filename, data }) => {
      stored.push(`${filename}:${data.toString()}`)
      return `http://files.test/${id}/${filename}`
    },
    extension: {
      handle(req: http.IncomingMessage, res: http.ServerResponse) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(`hub ${req.url}`)
      },
      upgrade(req, socket, head) {
        if (!req.url?.startsWith('/client/events')) return false
        new WebSocketServer({ noServer: true }).handleUpgrade(req, socket, head, (ws) => ws.send('hub socket'))
        return true
      },
    },
  })
  await discord.start()
  discord.authorizeGatewayClient({ token: TOKEN, guildIds: [GUILD] })
  client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: discord.restUrl, version: '10' } })
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(TOKEN)
  await ready
})

afterAll(async () => {
  await client.destroy()
  await discord.stop()
})

test('extension serves non-/api paths and its own WebSocket; /api and /gateway are untouched', async () => {
  expect(await (await fetch(`http://127.0.0.1:${discord.port}/client/state`)).text()).toBe('hub /client/state')
  expect((await fetch(`${discord.restUrl}/v10/gateway/bot`, { headers: { authorization: `Bot ${TOKEN}` } })).status).toBe(200)
  const message = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${discord.port}/client/events`)
    ws.on('message', (data) => {
      resolve(String(data))
      ws.close()
    })
  })
  expect(message).toBe('hub socket')
})

test('observers see dispatches and the bot typing; bot uploads go to the store', async () => {
  const seen: string[] = []
  const stop = discord.observeDispatches((event) => seen.push(event))
  const channel = (await client.channels.fetch(CHANNEL)) as TextChannel
  await channel.sendTyping()
  const sent = await channel.send({ content: 'file', files: [new AttachmentBuilder(Buffer.from('abc'), { name: 'a.txt' })] })
  await discord.simulateUserReaction({ channelId: CHANNEL, messageId: sent.id, userId: USER, emoji: '👍' })
  await discord.simulateThreadArchive({ channelId: (await channel.threads.create({ name: 't' })).id, archived: true })
  stop()
  await channel.send('after stop')
  expect(seen).toEqual(['TYPING_START', 'MESSAGE_CREATE', 'MESSAGE_REACTION_ADD', 'THREAD_CREATE', 'THREAD_UPDATE'])
  expect(stored).toEqual(['a.txt:abc'])
  expect(sent.attachments.first()!.url).toMatch(/^http:\/\/files\.test\/\d+\/a\.txt$/)
})

test('revoking a client token closes its gateway connection', async () => {
  const closed = new Promise<number>((resolve) => {
    const gateway = (discord as unknown as { server: { gateway: { clients: Array<{ token: string | null; ws: WebSocket }> } } }).server.gateway
    gateway.clients.find((entry) => entry.token === TOKEN)!.ws.once('close', (code: number) => resolve(code))
  })
  discord.revokeGatewayClient({ token: TOKEN })
  expect(await closed).toBe(4004)
})
