// A fresh loopback-only hub for each case. The transcription boundary supplies WORDS;
// the same WORDS in a typed prompt must stay typed. Never contact a transcription service.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { MessageFlags } from 'discord-api-types/v10'
import { Hub } from '../src/hub.ts'
import type { DiscordMessage } from '../src/mirror.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

const words = 'Please read the voice note.'
const id = (n: number) => String(810000000000071000n + BigInt(n))
const clip = readFileSync(new URL('../vendor/discord-digital-twin/tests/fixtures/voice-hello.ogg', import.meta.url))
const seconds = 3.350188
const flag = MessageFlags.IsVoiceMessage
type Item = { id: string; content: string; flags?: number; origin?: string; voice_note?: { duration_secs?: number; attachment_id?: string }; attachments: Array<{ id: string; url: string; content_type: string; duration_secs?: number; waveform?: string }> }
type Frame = { t: string; d: Item }
let t: Awaited<ReturnType<typeof startTestHub>>, phone: TestDevice, channel: string, key: string
const sockets: WebSocket[] = []
const noDownload = vi.fn(async (_url?: string): Promise<Buffer | null> => { throw new Error('The voice mirror attempted a download') })

beforeEach(async () => {
  t = await startTestHub({ extensions: [] })
  const bot = await t.hub.store.addBot('desktop')
  key = `${bot.clientId}:${bot.secret}`
  await t.hub.reload()
  phone = await pairedDevice(t.hub)
  channel = (await phone.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  noDownload.mockClear()
  t.hub.mirror.download = noDownload
})
afterEach(async () => {
  // Let the peers observe the close while presence and its database still exist.
  await Promise.all(sockets.splice(0).map((ws) => new Promise<void>((done) => {
    if (ws.readyState === WebSocket.CLOSED) return done()
    ws.once('close', () => done())
    ws.close()
  })))
  await waitFor(() => !t.hub.events.connections().length && !t.hub.twin.connectedGatewayTokens().size)
  await t.cleanup()
  expect(noDownload).not.toHaveBeenCalled()
})

const prompt = (n: number): DiscordMessage => ({ id: id(n), channel_id: channel, author: { id: id(1), username: 'alex' }, content: words, timestamp: '2026-02-01T12:00:00Z' })
const recording = (n: number) => ({ id: id(n), filename: 'note.ogg', content_type: 'audio/ogg', duration_secs: seconds, waveform: 'AQID' })
const spoken = (n: number, file: number): DiscordMessage => ({ ...prompt(n), flags: flag, voice_note: { attachment_id: id(file), duration_secs: seconds }, attachments: [recording(file)] })

async function put(m: DiscordMessage, data?: Buffer) {
  const form = new FormData()
  if (data) {
    form.append('payload_json', JSON.stringify(m))
    form.append('files[0]', new Blob([new Uint8Array(data)], { type: 'audio/ogg' }), 'note.ogg')
  }
  const res = await fetch(`${t.hub.localUrl}/hub/mirror/messages/${m.id}`, { method: 'PUT', headers: { authorization: `Bot ${key}`, ...(!data && { 'content-type': 'application/json' }) }, body: data ? form : JSON.stringify(m) })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ id: string; created: boolean }>
}
async function admin(route: string, body: unknown) {
  const binary = Buffer.isBuffer(body)
  const res = await fetch(`${t.hub.localUrl}/admin/mirror/${route}`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(t.paths.adminToken, 'utf8').trim()}`, 'content-type': binary ? 'application/octet-stream' : 'application/json' }, body: binary ? new Uint8Array(body) : JSON.stringify(body) })
  expect(res.status).toBe(200)
  return res.json()
}
const history = async () => (await phone.json<{ messages: Item[] }>(`/client/channels/${channel}/messages`)).messages
const find = async (n: number) => (await history()).find((m) => m.id === id(n))!

async function listen(bot: boolean) {
  const ws = bot ? new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway?v=10&encoding=json`) : new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: phone.origin, cookie: phone.cookie!, 'tailscale-user-login': LOGIN } })
  sockets.push(ws)
  const frames: Frame[] = []
  ws.on('message', (raw) => {
    const packet = JSON.parse(raw.toString())
    if (bot && packet.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: key, intents: 33281, properties: { os: 'linux', browser: 'fixture', device: 'fixture' } } }))
    if (packet.t) frames.push(packet)
  })
  await waitFor(() => frames.some((p) => p.t === (bot ? 'GUILD_CREATE' : 'HELLO')))
  return frames
}

test('identical words stay distinct on the client socket and in history; replay never reaches the agent', async () => {
  const [device, agent] = await Promise.all([listen(false), listen(true)])
  const typed = prompt(10), voice = spoken(11, 12)
  expect((await put(typed)).created).toBe(true)
  expect((await put(voice, clip)).created).toBe(true)
  const accepted = await Promise.all([put(voice, clip), put(voice, clip)])
  expect(accepted.every((r) => !r.created)).toBe(true)
  const live = await waitFor(() => device.find((e) => e.t === 'MESSAGE_CREATE' && e.d.id === voice.id))
  const [plain, note] = await Promise.all([find(10), find(11)])
  expect(plain.content).toBe(note.content)
  expect((plain.flags ?? 0) & flag).toBe(0)
  expect(plain.voice_note).toBeUndefined()
  expect(live.d).toMatchObject({ id: voice.id, origin: 'discord', content: words, flags: flag, voice_note: { attachment_id: id(12), duration_secs: seconds } })
  expect(note).toMatchObject({ voice_note: live.d.voice_note, attachments: live.d.attachments })
  expect(note.attachments).toHaveLength(1)
  const a = note.attachments[0]!
  expect(a).toMatchObject({ id: id(12), content_type: 'audio/ogg', duration_secs: seconds, waveform: 'AQID' })
  expect(a).not.toHaveProperty('mirror_voice_source')
  expect(a.url).toMatch(/^\/attachments\//)
  expect(Buffer.from(await (await phone.fetch(a.url)).arrayBuffer()).equals(clip)).toBe(true)
  expect((await history()).filter((m) => m.id === voice.id)).toHaveLength(1)
  // A later, ordinary hub prompt traverses both ordered sockets. No mirror create or update
  // before this barrier reached the agent gateway, including the very first delivery.
  const marker = await phone.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: 'socket barrier' } })
  await waitFor(() => [device, agent].every((frames) => frames.some((p) => p.t === 'MESSAGE_CREATE' && p.d.id === marker.id)))
  expect(agent.filter((p) => [typed.id, voice.id].includes(p.d?.id))).toEqual([])
  expect(device.filter((p) => p.d?.id === voice.id && p.t.startsWith('MESSAGE_')).map((p) => p.t)).toEqual(['MESSAGE_CREATE'])
})

test('a late voice flag upgrades the original row; an unavailable recording is transcript-only', async () => {
  const device = await listen(false)
  const typed = prompt(20), voice = spoken(21, 22)
  // Metadata and words alone do not turn a typed prompt into speech.
  await put({ ...typed, voice_note: { duration_secs: seconds } })
  await put(prompt(21))
  await put({ ...voice, attachments: [{ ...recording(22), url: 'https://example.invalid/not-local.ogg' }] })
  const updated = await waitFor(() => device.find((e) => e.t === 'MESSAGE_UPDATE' && e.d.id === voice.id))
  expect(updated.d).toMatchObject({ content: words, flags: flag, attachments: [], voice_note: { duration_secs: seconds } })
  expect(updated.d.voice_note).not.toHaveProperty('attachment_id')
  expect((await find(20)).voice_note).toBeUndefined()
  expect((await find(21)).attachments).toEqual([])
  await put({ ...prompt(21), flags: 0, attachments: [] })
  expect((await find(21)).voice_note).toEqual({ duration_secs: seconds })
  await put({ ...prompt(23), flags: flag })
  expect(await find(23)).toMatchObject({ content: words, flags: flag, voice_note: {}, attachments: [] })
  // A prior ordinary audio upload on this row is not proof it is the source recording.
  await put({ ...prompt(24), attachments: [recording(25)] }, clip)
  await put({ ...prompt(24), flags: flag, voice_note: { duration_secs: seconds }, attachments: [] })
  expect((await find(24)).voice_note).toEqual({ duration_secs: seconds })
  expect((await find(24)).attachments).toEqual([])
})

test('a cold hub retains the local clip and transcript through older import data and sparse edits', async () => {
  const voice = spoken(30, 31)
  await put(voice, clip)
  await put({ ...prompt(30), content: 'Corrected transcript.', edited_timestamp: '2026-02-02T12:00:00Z' })
  const before = await find(30)
  const cookie = phone.cookie
  await t.hub.stop()
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir: path.join(t.paths.root, 'web'), extensions: [] })
  await t.hub.start()
  t.hub.mirror.download = noDownload
  phone = new TestDevice(t.hub)
  phone.cookie = cookie
  expect(await find(30)).toMatchObject({ content: 'Corrected transcript.', flags: flag, voice_note: before.voice_note, attachments: before.attachments })
  await admin('messages', [{ ...voice, content: '', attachments: [] }, { ...prompt(30), flags: 0 }])
  expect(await history()).toHaveLength(1)
  const restored = await find(30)
  expect(restored.content).toBe('Corrected transcript.')
  expect(restored.voice_note).toEqual({ duration_secs: seconds, attachment_id: id(31) })
  expect(Buffer.from(await (await phone.fetch(restored.attachments[0]!.url)).arrayBuffer()).equals(clip)).toBe(true)
})

test('late archive bytes bind only to their message; missing-source replay keeps a verified copy', async () => {
  const first = spoken(40, 41), later = spoken(42, 41)
  await put(first, clip)
  await admin('messages', [later])
  expect(await find(42)).toMatchObject({ flags: flag, voice_note: { duration_secs: seconds }, attachments: [] })
  expect((await find(42)).voice_note?.attachment_id).toBeUndefined()
  const endpoint = `attachments/${later.id}/${id(41)}`
  await admin(endpoint, clip)
  const now = await find(42)
  expect(now.voice_note?.attachment_id).toBe(now.attachments[0]!.id)
  expect(now.voice_note?.attachment_id).not.toBe(id(41))
  expect(Buffer.from(await (await phone.fetch(now.attachments[0]!.url)).arrayBuffer()).equals(clip)).toBe(true)
  await admin(`${endpoint}/missing`, {})
  await admin('messages', [later])
  expect((await find(42)).attachments).toEqual(now.attachments)
  expect((await find(40)).voice_note?.attachment_id).toBe(id(41))
})
