// Message fields that must survive a reload, not only show live: forwards,
// polls, stickers, interaction metadata, mentions, locked threads, image
// sizes; and the page policy that lets Discord media and players load.

import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { AttachmentBuilder, Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { imageSize } from '../src/attachments.ts'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { pairedDevice, startTestHub, type TestDevice } from './helpers.ts'

const OWNER_DISCORD = '900000000000000002'
const GUILD = '910000000000000002'
let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let token = ''
let phone: TestDevice
let general: TextChannel
// A 3x2 PNG header.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000030000000208060000000000', 'hex')

beforeAll(async () => {
  t = await startTestHub()
  await t.hub.stop()
  t.config = initHub(t.paths, { ownerDiscordIds: [OWNER_DISCORD] })
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir: `${t.paths.root}/web` })
  await t.hub.start()
  const minted = await t.hub.store.addBot('desktop')
  token = `${minted.clientId}:${minted.secret}`
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(token)
  await ready
  phone = await pairedDevice(t.hub)
  const state = await phone.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

const load = async (channelId: string, id: string) => (await phone.json(`/client/channels/${channelId}/messages`)).messages.find((m: { id: string }) => m.id === id)

test('image sizes are read from the file header', () => {
  expect(imageSize(PNG)).toEqual({ width: 3, height: 2 })
  expect(imageSize(Buffer.from('474946383961050007000000', 'hex'))).toEqual({ width: 5, height: 7 })
  // JPEG: SOI, APP0 (length 4), SOF0 with height 9, width 11.
  expect(imageSize(Buffer.from('ffd8ffe00004aaaaffc0001108000900' + '0b03', 'hex'))).toEqual({ width: 11, height: 9 })
  expect(imageSize(Buffer.from('not an image'))).toEqual({ width: null, height: null })
})

test('bot uploads, polls and forwards, and mentions survive a reload', async () => {
  const image = await general.send({ content: `<@${t.config.ownerUserId}> chart`, files: [new AttachmentBuilder(PNG, { name: 'chart.png' })] })
  const loaded = await load(general.id, image.id)
  expect(loaded.attachments[0]).toMatchObject({ width: 3, height: 2 })
  expect(loaded.mentions.map((u: { id: string }) => u.id)).toEqual([t.config.ownerUserId])

  const poll = await general.send({ poll: { question: { text: 'Ship it?' }, answers: [{ text: 'Yes' }, { text: 'No' }], duration: 1, allowMultiselect: false } })
  expect((await load(general.id, poll.id)).poll).toMatchObject({ question: { text: 'Ship it?' }, answers: [{ answer_id: 1 }, { answer_id: 2 }] })

  const forward = await image.forward(general)
  expect((await load(general.id, forward.id)).message_snapshots[0].message.content).toContain('chart')
})

test('mirrored Discord fields are kept: forwards, polls, stickers, who used a command; locked threads stay locked', async () => {
  const put = (path: string, body: unknown) => fetch(`${t.hub.localUrl}/hub/mirror${path}`, { method: 'PUT', headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await put(`/guilds/${GUILD}`, { name: 'Side Projects' })
  await put('/channels/920000000000000020', { guild_id: GUILD, type: 0, name: 'log' })
  await put('/channels/930000000000000020', { guild_id: GUILD, type: 11, name: 'read only', parent_id: '920000000000000020', thread_metadata: { locked: true, archived: true } })
  const thread = (await phone.json('/client/state')).threads.find((c: { id: string }) => c.id === '930000000000000020')
  expect(thread.thread_metadata).toMatchObject({ locked: true, archived: true })
  await put('/messages/940000000000000020', {
    channel_id: '920000000000000020',
    author: { id: '960000000000000002', username: 'Desktop PC', bot: true },
    content: '',
    message_snapshots: [{ message: { content: 'forwarded text' } }],
    sticker_items: [{ id: '1', name: 'wave', format_type: 1 }],
    interaction_metadata: { id: '5', type: 2, user: { id: OWNER_DISCORD, username: 'owner' }, name: 'model' },
  })
  const message = await load('920000000000000020', '940000000000000020')
  expect(message.message_snapshots[0].message.content).toBe('forwarded text')
  expect(message.sticker_items[0].name).toBe('wave')
  expect(message.interaction_metadata.name).toBe('model')
})

test('the app may load Discord media and YouTube or Vimeo players, nothing else from outside', async () => {
  const csp = (await phone.fetch('/')).headers.get('content-security-policy')!
  expect(csp).toContain('img-src \'self\' data: blob: https://cdn.discordapp.com https://media.discordapp.net')
  expect(csp).toContain('frame-src https://www.youtube-nocookie.com https://player.vimeo.com')
  expect(csp).not.toMatch(/img-src[^;]* https:(;| )/)
})

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test.skipIf(!hasFfmpeg)('uploaded videos store their width and height', async () => {
  const video = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=0.2', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'])
  const form = new FormData()
  form.append('file', new Blob([video], { type: 'video/mp4' }), 'clip.mp4')
  const upload = await phone.json('/client/uploads', { method: 'POST', body: form })
  expect(upload).toMatchObject({ width: 320, height: 180 })
  // Not a video: no size, and ffprobe is never asked to guess the format.
  const other = new FormData()
  other.append('file', new Blob([video], { type: 'application/octet-stream' }), 'clip.bin')
  expect(await phone.json('/client/uploads', { method: 'POST', body: other })).toMatchObject({ width: null, height: null })
})
