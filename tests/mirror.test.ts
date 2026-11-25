// Mirroring Discord into the hub: a machine copies its Discord guild, channels,
// threads and messages in with their Discord ids. Devices see them; bots on
// the hub never get mirrored messages (no prompt runs twice); a message typed
// in the hub reaches the machine and its Discord echo links back.

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { Client, GatewayIntentBits, type Message } from 'discord.js'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'

const OWNER_DISCORD = '900000000000000001'
const GUILD = '910000000000000001'
const CHANNEL = '920000000000000001'
const THREAD = '930000000000000001'
let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let token = ''
let otherToken = ''
let phone: TestDevice
const downloads: string[] = []
const botMessages: Message[] = []
const events: Array<{ t: string; d: any }> = []

beforeAll(async () => {
  t = await startTestHub()
  await t.hub.stop()
  t.config = initHub(t.paths, { ownerDiscordIds: [OWNER_DISCORD] })
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir: `${t.paths.root}/web` })
  await t.hub.start()
  const minted = await t.hub.store.addBot('desktop')
  token = `${minted.clientId}:${minted.secret}`
  const other = await t.hub.store.addBot('homelab')
  otherToken = `${other.clientId}:${other.secret}`
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  bot.on('messageCreate', (m) => botMessages.push(m))
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(token)
  await ready
  phone = await pairedDevice(t.hub)
  // No network in tests: the CDN download is a stub that records what it was asked for.
  t.hub.mirror.download = async (url) => (downloads.push(url ?? ''), url?.includes('gone') ? null : Buffer.from('89504e470d0a1a0a', 'hex'))
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: phone.origin, cookie: phone.cookie!, 'tailscale-user-login': LOGIN } })
  ws.on('message', (data) => events.push(JSON.parse(String(data))))
  await new Promise((resolve) => ws.once('open', resolve))
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

const put = (path: string, body: unknown, auth = token) =>
  fetch(`${t.hub.localUrl}/hub/mirror${path}`, { method: 'PUT', headers: { authorization: `Bot ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('a machine mirrors its Discord server, channels and threads with their own ids', async () => {
  expect((await put(`/guilds/${GUILD}`, { name: 'Side Projects' })).status).toBe(200)
  await waitFor(() => bot.guilds.cache.get(GUILD))
  expect((await put(`/channels/${CHANNEL}`, { guild_id: GUILD, type: 0, name: 'project', topic: 'a project' })).status).toBe(200)
  expect((await put(`/channels/${THREAD}`, { guild_id: GUILD, type: 11, name: 'Fix the footer', parent_id: CHANNEL, owner_id: OWNER_DISCORD })).status).toBe(200)
  const state = await phone.json('/client/state')
  expect(state.guilds.map((g: { id: string; name: string }) => [g.id, g.name])).toContainEqual([GUILD, 'Side Projects'])
  expect(state.threads.find((c: { id: string }) => c.id === THREAD)).toMatchObject({ name: 'Fix the footer', parent_id: CHANNEL, owner_id: t.config.ownerUserId })
  await waitFor(() => bot.channels.cache.get(THREAD))
  // Another machine has not joined this guild.
  expect((await put(`/channels/940000000000000001`, { guild_id: GUILD, type: 0, name: 'x' }, otherToken)).status).toBe(403)
  expect((await put(`/channels/940000000000000001`, { guild_id: GUILD, type: 0, name: 'x' }, 'nope:nope')).status).toBe(401)
})

test('messages: the owner\'s Discord account is the hub owner, bots are themselves, and hub bots never see them', async () => {
  const mine = await put('/messages/950000000000000001', { channel_id: THREAD, author: { id: OWNER_DISCORD, username: 'owner' }, content: `<@${OWNER_DISCORD}> note to self`, timestamp: '2026-11-24T10:00:00.000Z' })
  expect(await mine.json()).toEqual({ id: '950000000000000001', created: true })
  await put('/messages/950000000000000002', { channel_id: THREAD, author: { id: '960000000000000001', username: 'Desktop PC', bot: true, avatar: 'abc' }, content: 'on it', timestamp: '2026-11-24T10:00:01.000Z' })
  const { messages } = await phone.json(`/client/channels/${THREAD}/messages`)
  const byId = Object.fromEntries(messages.map((m: { id: string }) => [m.id, m]))
  expect(byId['950000000000000001']).toMatchObject({ author: { id: t.config.ownerUserId }, content: `<@${t.config.ownerUserId}> note to self`, origin: 'discord' })
  expect(byId['950000000000000002']).toMatchObject({ author: { id: '960000000000000001', username: 'Desktop PC', bot: true, avatar: 'abc' }, origin: 'discord' })
  expect(await waitFor(() => events.find((e) => e.t === 'MESSAGE_CREATE' && e.d.id === '950000000000000002'))).toMatchObject({ d: { origin: 'discord' } })
  // Edits are another PUT.
  await put('/messages/950000000000000002', { channel_id: THREAD, author: { id: '960000000000000001', username: 'Desktop PC', bot: true }, content: 'done', timestamp: '2026-11-24T10:00:01.000Z', edited_timestamp: '2026-11-24T10:01:00.000Z' })
  expect(await waitFor(() => events.find((e) => e.t === 'MESSAGE_UPDATE' && e.d.id === '950000000000000002'))).toMatchObject({ d: { content: 'done' } })
  await t.hub.search.flush()
  expect((await phone.json('/client/search?q=done')).results[0].message.id).toBe('950000000000000002')
  await new Promise((r) => setTimeout(r, 200))
  expect(botMessages.filter((m) => m.channelId === THREAD)).toEqual([])
  expect(await (await fetch(`${t.hub.localUrl}/hub/mirror/channels/${THREAD}/latest`, { headers: { authorization: `Bot ${token}` } })).json()).toEqual({ message_id: '950000000000000002' })
})

test('attachments sent with the message are stored on the hub', async () => {
  const form = new FormData()
  form.append('payload_json', JSON.stringify({ channel_id: THREAD, author: { id: OWNER_DISCORD, username: 'owner' }, content: 'diagram', attachments: [{ id: '970000000000000001', filename: 'flow.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/x/flow.png' }] }))
  form.append('files[0]', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'flow.png')
  const res = await fetch(`${t.hub.localUrl}/hub/mirror/messages/950000000000000003`, { method: 'PUT', headers: { authorization: `Bot ${token}` }, body: form })
  expect(res.status).toBe(200)
  const { messages } = await phone.json(`/client/channels/${THREAD}/messages`)
  const url = messages.find((m: { id: string }) => m.id === '950000000000000003').attachments[0].url
  expect(url).toMatch(/^\/attachments\/970000000000000001\/flow\.png\?ex=/)
  expect((await phone.fetch(url)).status).toBe(200)
})

test('a message typed in the hub reaches the machine; its Discord echo links back instead of showing twice', async () => {
  const typed = await phone.json(`/client/channels/${THREAD}/messages`, { method: 'POST', json: { content: 'please also update the docs' } })
  const received = await waitFor(() => botMessages.find((m) => m.id === typed.id))
  expect(received.channelId).toBe(THREAD)
  // The machine posted "» owner (Vocorum): …" on Discord and mirrors it with echo_of.
  expect(await (await put('/messages/950000000000000004', { channel_id: THREAD, author: { id: '960000000000000001', username: 'Desktop PC', bot: true }, content: '» owner (Vocorum): please also update the docs', echo_of: typed.id })).json()).toEqual({ linked: typed.id })
  const { messages } = await phone.json(`/client/channels/${THREAD}/messages`)
  expect(messages.some((m: { id: string }) => m.id === '950000000000000004')).toBe(false)
  expect(messages.find((m: { id: string }) => m.id === typed.id)).toMatchObject({ discord_echo: '950000000000000004' })
})

test('a mirrored thread is a normal thread for the hub bot: it posts there and devices see it', async () => {
  const thread = await waitFor(() => bot.channels.cache.get(THREAD))
  const sent = await (thread as import('discord.js').ThreadChannel).send('rendered natively by the hub bot')
  expect(await waitFor(() => events.find((e) => e.t === 'MESSAGE_CREATE' && e.d.id === sent.id))).toMatchObject({ d: { channel_id: THREAD } })
  const { messages } = await phone.json(`/client/channels/${THREAD}/messages`)
  expect(messages.find((m: { id: string }) => m.id === sent.id).origin).toBeUndefined()
})

test('deletes follow Discord', async () => {
  await fetch(`${t.hub.localUrl}/hub/mirror/messages/950000000000000001`, { method: 'DELETE', headers: { authorization: `Bot ${token}` } })
  expect(await waitFor(() => events.find((e) => e.t === 'MESSAGE_DELETE' && e.d.id === '950000000000000001'))).toBeTruthy()
  await fetch(`${t.hub.localUrl}/hub/mirror/channels/${THREAD}`, { method: 'DELETE', headers: { authorization: `Bot ${token}` } })
  expect((await phone.fetch(`/client/channels/${THREAD}/messages`)).status).toBe(404)
})

test('import: attachments are copied to the hub, and imported history is read for the owner', async () => {
  const CH = '920000000000000009'
  await put(`/channels/${CH}`, { guild_id: GUILD, type: 0, name: 'history' })
  const admin = (path: string, body: string | Buffer, type = 'application/json') =>
    fetch(`${t.hub.localUrl}/admin/mirror/${path}`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(t.paths.adminToken, 'utf8').trim()}`, 'content-type': type }, body })
  const old = { id: '980000000000000001', channel_id: CH, author: { id: '960000000000000001', username: 'Desktop PC', bot: true }, content: `<@${OWNER_DISCORD}> look at this`, timestamp: '2026-11-01T10:00:00.000Z', attachments: [{ id: '990000000000000001', filename: 'shot.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/shot.png?ex=0' }] }
  expect((await admin('messages', JSON.stringify([old]))).status).toBe(200)
  expect((await phone.json('/client/state')).mentions[CH]).toBe(1)
  const copied = (await (await admin(`attachments/${old.id}/990000000000000001`, Buffer.from('89504e470d0a1a0a', 'hex'), 'application/octet-stream')).json()) as { url: string }
  expect(copied.url).toMatch(/\/attachments\/990000000000000001\/shot\.png\?ex=/)
  const { messages } = await phone.json(`/client/channels/${CH}/messages`)
  const url = messages[0].attachments[0].url
  expect(url.startsWith('/attachments/')).toBe(true)
  expect((await phone.fetch(url)).status).toBe(200)
  // Finishing the import marks it read: no badge, and the inbox agrees with the badge.
  expect((await admin('finish', JSON.stringify({ guild_id: GUILD, threads: [] }))).status).toBe(200)
  expect((await phone.json('/client/state')).mentions[CH]).toBeUndefined()
  const inbox = await phone.json('/client/inbox')
  expect(inbox.mentions.filter((m: { read: boolean }) => !m.read)).toEqual([])
})

test('a machine names its Discord bot; imported users and guilds get their Discord pictures', async () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  expect((await put('/machine-bot', { discord_user_id: '960000000000000001', name: 'Desktop PC' })).status).toBe(200)
  expect((await phone.json('/client/state')).machine_bots).toEqual({ desktop: { discord_user_id: '960000000000000001', name: 'Desktop PC' } })
  const admin = (path: string, body: Buffer) => fetch(`${t.hub.localUrl}/admin/mirror/${path}`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(t.paths.adminToken, 'utf8').trim()}`, 'content-type': 'application/octet-stream' }, body })
  expect((await admin('avatars/960000000000000001', PNG)).status).toBe(200)
  expect((await phone.fetch('/client/avatars/960000000000000001')).headers.get('content-type')).toBe('image/png')
  expect((await admin(`guilds/${GUILD}/icon`, PNG)).status).toBe(200)
  expect((await phone.json('/client/state')).guilds.find((g: { id: string }) => g.id === GUILD).icon).toMatch(/^[0-9a-f]{32}$/)
})

test('the owner\'s Discord id is rewritten everywhere, embeds and components included, and listed as an alias', async () => {
  const CH = '920000000000000009'
  await put('/messages/980000000000000002', { channel_id: CH, author: { id: '960000000000000001', username: 'Desktop PC', bot: true }, content: 'status', embeds: [{ description: `for <@${OWNER_DISCORD}>` }], components: [{ type: 17, components: [{ type: 10, content: `ping <@!${OWNER_DISCORD}>` }] }] })
  const message = (await phone.json(`/client/channels/${CH}/messages`)).messages.find((m: { id: string }) => m.id === '980000000000000002')
  expect(JSON.stringify([message.embeds, message.components])).not.toContain(OWNER_DISCORD)
  expect(message.embeds[0].description).toBe(`for <@${t.config.ownerUserId}>`)
  expect((await phone.json('/client/state')).user_aliases).toEqual({ [OWNER_DISCORD]: t.config.ownerUserId })
})

test('live: a file sent only as a Discord link is downloaded to the hub once; a lost one is marked missing and stays so', async () => {
  const CH = '920000000000000010'
  await put(`/channels/${CH}`, { guild_id: GUILD, type: 0, name: 'files' })
  const shot = { id: '990000000000000010', filename: 'report.png', content_type: 'image/png', width: 640, height: 480, url: 'https://cdn.discordapp.com/attachments/1/2/report.png?ex=1' }
  const lost = { id: '990000000000000011', filename: 'old.csv', content_type: 'text/csv', url: 'https://cdn.discordapp.com/attachments/1/2/gone.csv?ex=1' }
  const message = { channel_id: CH, author: { id: '960000000000000001', username: 'Desktop PC', bot: true }, content: 'results', attachments: [shot, lost] }
  downloads.length = 0
  expect((await put('/messages/980000000000000010', message)).status).toBe(200)
  const load = async () => (await phone.json(`/client/channels/${CH}/messages`)).messages.find((m: { id: string }) => m.id === '980000000000000010').attachments
  let [copy, kept] = await load()
  expect(copy).toMatchObject({ filename: 'report.png', width: 640, height: 480 })
  expect(copy.url).toMatch(/^\/attachments\/990000000000000010\/report\.png\?ex=/)
  expect((await phone.fetch(copy.url)).status).toBe(200)
  // Only Discord's CDN is ever fetched.
  expect(downloads.every((u) => u.startsWith('https://cdn.discordapp.com/'))).toBe(true)
  // An edit keeps the hub copy without downloading again.
  downloads.length = 0
  expect((await put('/messages/980000000000000010', { ...message, content: 'results v2', edited_timestamp: '2026-11-24T20:00:00.000Z' })).status).toBe(200)
  expect(downloads).toEqual([lost.url])
  ;[copy, kept] = await load()
  expect(copy.url.startsWith('/attachments/')).toBe(true)
  expect(kept.url).toBe(lost.url)
  const admin = (path: string) => fetch(`${t.hub.localUrl}/admin/mirror/${path}`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(t.paths.adminToken, 'utf8').trim()}`, 'content-type': 'application/json' }, body: '{}' })
  expect((await admin(`attachments/980000000000000010/${lost.id}/missing`)).status).toBe(200)
  expect((await put('/messages/980000000000000010', { ...message, content: 'results v3', edited_timestamp: '2026-11-24T20:01:00.000Z' })).status).toBe(200)
  ;[copy, kept] = await load()
  expect(kept).toMatchObject({ filename: 'old.csv', missing: true, url: '' })
})

test('a link that is not Discord\'s CDN is never fetched', async () => {
  const { Mirror } = await import('../src/mirror.ts')
  const fresh = new Mirror({} as never)
  for (const url of ['http://cdn.discordapp.com/a', 'https://evil.example/cdn.discordapp.com/a', 'https://cdn.discordapp.com.evil.example/a', 'file:///etc/passwd', undefined]) expect(await fresh.download(url)).toBeNull()
})

test('a session belongs to the machine whose agent posts in it; a project-group category is not a machine', async () => {
  const admin = (p: string, body: unknown) => fetch(`${t.hub.localUrl}/admin/mirror/${p}`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(t.paths.adminToken, 'utf8').trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await admin('machine-bots/desktop', { discord_user_id: '960000000000000001', name: 'Desktop PC' })).status).toBe(200)
  await put('/channels/920000000000000030', { guild_id: GUILD, type: 4, name: 'Kimaki Group Work' })
  await put('/channels/920000000000000031', { guild_id: GUILD, type: 0, name: 'shared-project', parent_id: '920000000000000030' })
  await put('/channels/930000000000000031', { guild_id: GUILD, type: 11, name: 'Look into the data', parent_id: '920000000000000031' })
  await put('/messages/940000000000000031', { channel_id: '930000000000000031', author: { id: '960000000000000001', username: 'Desktop PC', bot: true }, content: 'Which source should I use?', timestamp: '2026-11-24T10:00:00.000Z' })
  const overview = await waitFor(async () => {
    const o = await phone.json('/client/overview')
    return o.sessions.some((s: { id: string; machine: string | null }) => s.id === '930000000000000031' && s.machine) ? o : null
  })
  expect(overview.sessions.find((s: { id: string }) => s.id === '930000000000000031').machine).toBe('desktop')
  expect(overview.machines.map((m: { name: string }) => m.name)).not.toContain('Group Work')
})

test('a machine reports its Kimaki routines; the hub shows them read-only and replaces the list each time', async () => {
  const routine = (id: string, extra: Record<string, unknown> = {}) => ({ id, prompt: 'Weekly report', schedule: '0 9 * * 1 (UTC)', channel_id: '920000000000000031', thread_id: null, agent: 'build', model: 'provider/model', next_run: '2026-11-30T09:00:00.000Z', status: 'active', ...extra })
  expect((await fetch(`${t.hub.localUrl}/hub/mirror/routines`, { method: 'PUT', headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ routines: 'no' }) })).status).toBe(400)
  const send = (routines: unknown[]) => fetch(`${t.hub.localUrl}/hub/mirror/routines`, { method: 'PUT', headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ routines }) })
  expect(await (await send([routine('7'), routine('8', { channel_id: null, thread_id: '930000000000000031' }), routine('9', { channel_id: '999999999999999999' }), routine('10', { thread_id: '939999999999999999' })])).json()).toEqual({ machine: 'desktop', routines: 4 })
  let listed = (await phone.json('/client/routines')).machines.find((m: { machine: string }) => m.machine === 'desktop')
  // A routine in a channel nobody here can see is not shown.
  // A thread the hub never mirrored falls back to the routine's channel.
  expect(listed.routines.map((r: { id: string }) => r.id)).toEqual(['7', '8', '10'])
  expect(listed.routines[0]).toMatchObject({ prompt: 'Weekly report', schedule: '0 9 * * 1 (UTC)', next_run: '2026-11-30T09:00:00.000Z' })
  await send([routine('8', { channel_id: null, thread_id: '930000000000000031' })])
  listed = (await phone.json('/client/routines')).machines.find((m: { machine: string }) => m.machine === 'desktop')
  expect(listed.routines.map((r: { id: string }) => r.id)).toEqual(['8'])
})

test('history added later is marked read for just its channels', async () => {
  const admin = (p: string, body: unknown) => fetch(`${t.hub.localUrl}/admin/mirror/${p}`, { method: 'POST', headers: { authorization: `Bearer ${readFileSync(t.paths.adminToken, 'utf8').trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await put('/channels/920000000000000040', { guild_id: GUILD, type: 0, name: 'live-channel' })
  await put('/messages/940000000000000040', { channel_id: '920000000000000040', author: { id: '960000000000000002', username: 'Someone' }, content: `<@${OWNER_DISCORD}> still unread`, timestamp: '2026-11-24T10:00:00.000Z' })
  expect((await admin('channels', [{ id: '930000000000000041', guild_id: GUILD, type: 11, name: 'old thread', parent_id: '920000000000000040', thread_metadata: { archived: true } }])).status).toBe(200)
  expect((await admin('messages', [{ id: '940000000000000041', channel_id: '930000000000000041', author: { id: '960000000000000002', username: 'Someone' }, content: `<@${OWNER_DISCORD}> old news`, timestamp: '2026-08-01T10:00:00.000Z' }])).status).toBe(200)
  expect((await admin('finish', { threads: ['930000000000000041'], channels: ['930000000000000041'] })).status).toBe(200)
  const state = await phone.json('/client/state')
  expect(state.mentions['930000000000000041']).toBeUndefined()
  expect(state.mentions['920000000000000040']).toBe(1)
})
