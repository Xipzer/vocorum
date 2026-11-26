// Voice channels: people join over /client/voice, hear each other and bots,
// and bots in the twin's voice server hear people. Opus frames are relayed as
// they arrive; PCM from browsers without an encoder is encoded by the hub.

import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits } from 'discord.js'
import { EndBehaviorType, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel } from '../vendor/discord-digital-twin/node_modules/@discordjs/voice/dist/index.js'
// @ts-ignore prism-media ships no types
import prism from '../vendor/discord-digital-twin/node_modules/prism-media/src/index.js'
import OpusScript from 'opusscript'
import { P } from '../src/access.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

const FIXTURE = path.resolve(import.meta.dirname, '../vendor/discord-digital-twin/tests/fixtures/voice-hello.ogg')

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let sam: TestDevice
let samId = ''
let robin: TestDevice
let robinId = ''
let room = ''
let packets: Buffer[] = []

type Socket = { ws: WebSocket; text: any[]; audio: Array<{ userId: string; opus: Buffer }>; closed: Promise<number> }

async function join(device: TestDevice, channel: string, login?: string): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/voice?channel=${channel}`, { headers: { origin: device.origin, cookie: device.cookie!, ...(login && { 'tailscale-user-login': login }), ...(!login && { 'tailscale-user-login': LOGIN }) } })
  const s: Socket = { ws, text: [], audio: [], closed: new Promise((r) => ws.once('close', (code) => r(code))) }
  ws.on('message', (data, binary) => {
    if (!binary) return void s.text.push(JSON.parse(String(data)))
    const b = data as Buffer
    s.audio.push({ userId: b.subarray(1, 1 + b[0]!).toString('ascii'), opus: b.subarray(1 + b[0]!) })
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))))
    ws.once('error', reject)
  })
  return s
}

const opusFrame = (opus: Buffer) => Buffer.concat([Buffer.from([0]), opus])

async function person(username: string, login: string) {
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: login })
  await t.hub.reload()
  const device = new TestDevice(t.hub, { 'tailscale-user-login': login })
  await device.pair(invite.code)
  return { device, id: invite.user.id as string }
}

beforeAll(async () => {
  t = await startTestHub()
  owner = await pairedDevice(t.hub, 'owner-laptop')
  ;({ device: sam, id: samId } = await person('sam', 'sam@example.com'))
  ;({ device: robin, id: robinId } = await person('robin', 'robin@example.com'))
  room = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Lounge', type: 2 } })).id
  for await (const packet of fs.createReadStream(FIXTURE).pipe(new prism.opus.OggDemuxer())) packets.push(packet as Buffer)
}, 60_000)

afterAll(() => t?.cleanup())

test('a voice channel keeps its name; people join, hear each other, and see who is speaking', async () => {
  const state = await owner.json('/client/state')
  expect(state.channels.find((c: { id: string }) => c.id === room)).toMatchObject({ type: 2, name: 'Lounge' })
  const a = await join(owner, room)
  const b = await join(sam, room, 'sam@example.com')
  await waitFor(async () => ((await robin.json('/client/state')).voice_states as any[]).length === 2 || undefined)
  const states = (await robin.json('/client/state')).voice_states
  expect(states.map((s: { user_id: string }) => s.user_id).sort()).toEqual([t.config.ownerUserId, samId].sort())
  for (const p of packets.slice(0, 5)) b.ws.send(opusFrame(p))
  await waitFor(() => (a.audio.length === 5 ? true : undefined))
  expect(a.audio.every((f) => f.userId === samId)).toBe(true)
  expect(a.audio.map((f) => f.opus)).toEqual(packets.slice(0, 5))
  // Nobody hears themselves; both see sam speaking, then stop.
  expect(b.audio).toEqual([])
  await waitFor(() => a.text.find((m) => m.op === 'speaking' && m.user_id === samId && m.speaking))
  await waitFor(() => b.text.find((m) => m.op === 'speaking' && m.user_id === samId && !m.speaking))
  a.ws.close()
  b.ws.close()
  await waitFor(async () => ((await robin.json('/client/state')).voice_states as any[]).length === 0 || undefined)
})

test('PCM from a browser without an encoder arrives as Opus', async () => {
  const a = await join(owner, room)
  const b = await join(sam, room, 'sam@example.com')
  const pcm = Buffer.alloc(1920)
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i / 8)), i * 2)
  // The encoder loads on the first PCM frame; keep sending until frames come through.
  for (let i = 0; i < 50 && a.audio.length < 3; i++) {
    b.ws.send(Buffer.concat([Buffer.from([1]), pcm]))
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(a.audio.length).toBeGreaterThan(0)
  const decoder = new OpusScript(48000, 1)
  expect(decoder.decode(a.audio[0]!.opus).length).toBe(1920)
  decoder.delete()
  a.ws.close()
  b.ws.close()
})

test('muted people send nothing, deafened people hear nothing', async () => {
  const a = await join(owner, room)
  const b = await join(sam, room, 'sam@example.com')
  b.ws.send(JSON.stringify({ op: 'state', self_mute: true, self_deaf: false }))
  a.ws.send(JSON.stringify({ op: 'state', self_mute: false, self_deaf: true }))
  await waitFor(async () => ((await robin.json('/client/state')).voice_states as any[]).some((s) => s.user_id === samId && s.self_mute) || undefined)
  b.ws.send(opusFrame(packets[0]!))
  a.ws.send(opusFrame(packets[1]!))
  // Sam (muted) still hears the owner (deafened, not muted); the owner hears nobody.
  await waitFor(() => (b.audio.length === 1 ? true : undefined))
  await new Promise((r) => setTimeout(r, 200))
  expect(a.audio).toEqual([])
  a.ws.close()
  b.ws.close()
})

test('joining again moves the person; the earlier connection closes', async () => {
  const first = await join(owner, room)
  const other = await pairedDevice(t.hub, 'owner-phone')
  const second = await join(other, room)
  expect(await first.closed).toBe(4000)
  second.ws.close()
})

test('only people who may: no session, a foreign page, a hidden channel, no Connect, no Speak', async () => {
  const refused = (headers: Record<string, string>, channel = room) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/voice?channel=${channel}`, { headers })
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.once('open', () => resolve(101))
      ws.once('error', () => resolve(0))
    })
  expect(await refused({ origin: owner.origin, 'tailscale-user-login': LOGIN })).toBe(401)
  expect(await refused({ origin: 'https://evil.example', cookie: owner.cookie!, 'tailscale-user-login': LOGIN })).toBe(403)
  const general = (await owner.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  expect(await refused({ origin: owner.origin, cookie: owner.cookie!, 'tailscale-user-login': LOGIN }, general)).toBe(404)
  // Robin may see the room but not join it; Sam may join but not speak.
  await owner.json(`/client/channels/${room}/permissions/${robinId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.CONNECT) } })
  expect(await refused({ origin: robin.origin, cookie: robin.cookie!, 'tailscale-user-login': 'robin@example.com' })).toBe(403)
  await owner.json(`/client/channels/${room}/permissions/${samId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.SPEAK) } })
  const a = await join(owner, room)
  const b = await join(sam, room, 'sam@example.com')
  b.ws.send(opusFrame(packets[0]!))
  await waitFor(() => b.text.find((m) => m.op === 'error'))
  expect(a.audio).toEqual([])
  a.ws.close()
  b.ws.close()
  await owner.fetch(`/client/channels/${room}/permissions/${samId}`, { method: 'DELETE' })
  await owner.fetch(`/client/channels/${room}/permissions/${robinId}`, { method: 'DELETE' })
})

test("a voice channel's chat takes messages from people who may send them, and only from them", async () => {
  const sent = await sam.json(`/client/channels/${room}/messages`, { method: 'POST', json: { content: 'Is the build green?' } })
  expect(sent).toMatchObject({ channel_id: room, content: 'Is the build green?', author: { id: samId } })
  // It is the room's own history: readable without joining, by anyone who can see the room.
  const page = await robin.json(`/client/channels/${room}/messages?limit=5`)
  expect(page.messages.map((m: { content: string }) => m.content)).toEqual(['Is the build green?'])
  // Without Send Messages the chat is read-only; joining and speaking are separate permissions.
  await owner.json(`/client/channels/${room}/permissions/${samId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.SEND_MESSAGES) } })
  expect((await sam.fetch(`/client/channels/${room}/messages`, { method: 'POST', json: { content: 'Still there?' } })).status).toBe(403)
  const a = await join(sam, room, 'sam@example.com')
  a.ws.close()
  await owner.fetch(`/client/channels/${room}/permissions/${samId}`, { method: 'DELETE' })
  // The other checks hold: nothing empty, nothing in a channel the person cannot see, nothing in a category.
  expect((await sam.fetch(`/client/channels/${room}/messages`, { method: 'POST', json: { content: ' ' } })).status).toBe(400)
  await owner.json(`/client/channels/${room}/permissions/${robinId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.VIEW_CHANNEL) } })
  expect((await robin.fetch(`/client/channels/${room}/messages`, { method: 'POST', json: { content: 'Hello' } })).status).toBe(404)
  await owner.fetch(`/client/channels/${room}/permissions/${robinId}`, { method: 'DELETE' })
  const category = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Rooms', type: 4 } })).id
  expect((await owner.fetch(`/client/channels/${category}/messages`, { method: 'POST', json: { content: 'Hello' } })).status).toBe(400)
})

test('a bot in the voice channel hears people, and people hear the bot', async () => {
  const bot = await t.hub.store.addBot('desk-pc')
  await t.hub.reload()
  // A bot on the hub machine trusts the certificate the hub writes, and only it.
  const certFile = t.hub.options.paths.voiceCert
  expect(fs.statSync(certFile).mode & 0o777).toBe(0o600)
  const cert = fs.readFileSync(certFile, 'utf8')
  expect(cert).toBe(t.hub.twin.voice!.certificate)
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert])
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(`${bot.clientId}:${bot.secret}`)
  await ready
  try {
    const guild = client.guilds.cache.get(t.config.guildId)!
    const connection = joinVoiceChannel({ guildId: t.config.guildId, channelId: room, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, daveEncryption: false })
    await entersState(connection, VoiceConnectionStatus.Ready, 8_000)
    const a = await join(owner, room)
    // The bot is in the room for people too.
    await waitFor(async () => ((await owner.json('/client/state')).voice_states as any[]).some((s) => s.user_id === t.config.botUserId) || undefined)
    // A person speaks: the bot's receiver gets the same frames, from that person.
    const received: Buffer[] = []
    const heard = new Promise<string>((resolve) =>
      connection.receiver.speaking.once('start', (userId) => {
        connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 200 } }).on('data', (p: Buffer) => received.push(p))
        resolve(userId)
      }),
    )
    for (const p of packets.slice(0, 10)) {
      a.ws.send(opusFrame(p))
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(await heard).toBe(t.config.ownerUserId)
    await waitFor(() => (received.length >= 8 ? true : undefined))
    expect(packets.slice(0, 10)).toEqual(expect.arrayContaining(received))
    // The bot speaks: the person gets its frames.
    const player = createAudioPlayer()
    connection.subscribe(player)
    player.play(createAudioResource(fs.createReadStream(FIXTURE), { inputType: StreamType.OggOpus }))
    await waitFor(() => (a.audio.filter((f) => f.userId === t.config.botUserId).length >= 5 ? true : undefined), { timeout: 10_000 })
    connection.destroy()
    a.ws.close()
  } finally {
    await client.destroy()
  }
}, 60_000)
