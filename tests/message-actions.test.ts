// Create Thread from a message and Forward, as a person does them in the app.
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { P } from '../src/access.ts'
import { generateSnowflake } from 'discord-digital-twin/src'
import { TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

type Packet = { t?: string; d?: Record<string, any> }
let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice, member: TestDevice, memberId: string
const memberLogin = 'sam@example.test'
const sockets: WebSocket[] = []
const botEvents: Packet[] = []

const chat = async (name: string): Promise<string> => (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name } })).id
const post = async (by: TestDevice, channel: string, content: string): Promise<string> => (await by.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content } })).id
const deny = (channel: string, bits: bigint) => owner.json(`/client/channels/${channel}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(bits) } })
const startThread = (by: TestDevice, channel: string, message: string, name: string) => by.fetch(`/client/channels/${channel}/messages/${message}/threads`, { method: 'POST', json: { name } })
const forward = (by: TestDevice, to: string, from: string, message: string, extra = {}) => by.fetch(`/client/channels/${to}/messages`, { method: 'POST', json: { message_reference: { type: 1, channel_id: from, message_id: message }, ...extra } })

beforeAll(async () => {
  t = await startTestHub({ extensions: [] })
  owner = await pairedDevice(t.hub, 'test-browser')
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'sam' } })
  memberId = invite.user.id
  await t.hub.store.setProfile(memberId, { tailscaleLogin: memberLogin })
  const localBot = await t.hub.store.addBot('test-worker')
  await t.hub.reload()
  member = new TestDevice(t.hub, { 'tailscale-user-login': memberLogin })
  await member.pair(invite.code)
  const gateway = new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway?v=10&encoding=json`)
  sockets.push(gateway)
  gateway.on('message', (raw) => {
    const p = JSON.parse(raw.toString())
    if (p.op === 10) gateway.send(JSON.stringify({ op: 2, d: { token: `${localBot.clientId}:${localBot.secret}`, intents: 513 | 32768, properties: { os: 'linux', browser: 'test', device: 'test' } } }))
    if (p.op === 0) botEvents.push(p)
  })
  await waitFor(() => botEvents.find((p) => p.t === 'GUILD_CREATE'))
})

afterAll(async () => {
  for (const ws of sockets) ws.terminate()
  await t?.cleanup()
})

test('Create Thread starts a thread from the message, named by the person, as Discord does', async () => {
  const channel = await chat('thread-from-message')
  const message = await post(owner, channel, 'Ship the release notes')
  const created = await startThread(member, channel, message, '  Release notes  ')
  expect(created.status).toBe(200)
  const thread: any = await created.json()
  expect({ id: thread.id === message, type: thread.type, name: thread.name, parent: thread.parent_id === channel, owner: thread.owner_id === memberId }).toEqual({ id: true, type: 11, name: 'Release notes', parent: true, owner: true })
  // Bots see the thread, and the starter message now carries it.
  await waitFor(() => botEvents.find((p) => p.t === 'THREAD_CREATE' && p.d?.id === message))
  const history = (await member.json(`/client/channels/${channel}/messages`)).messages
  expect(history.find((m: { id: string }) => m.id === message).thread?.id).toBe(message)
  // The person can open it and post there.
  expect((await member.json('/client/state')).threads.some((c: { id: string }) => c.id === message)).toBe(true)
  expect((await member.fetch(`/client/channels/${message}/messages`, { method: 'POST', json: { content: 'first reply' } })).status).toBe(200)
  // One thread per message, a name is required, and threads do not nest.
  expect((await startThread(owner, channel, message, 'again')).status).toBe(400)
  expect((await startThread(owner, channel, await post(owner, channel, 'unnamed'), '   ')).status).toBe(400)
  expect((await startThread(owner, message, await post(owner, message, 'in the thread'), 'nested')).status).toBe(400)
})

test('Create Thread needs Create Public Threads and a message in that channel', async () => {
  const channel = await chat('no-threads-here')
  const other = await chat('elsewhere')
  const message = await post(owner, channel, 'keep this flat')
  await deny(channel, P.CREATE_PUBLIC_THREADS)
  expect((await startThread(member, channel, message, 'not allowed')).status).toBe(403)
  expect((await startThread(member, other, message, 'wrong channel')).status).toBe(404)
  expect((await t.hub.twin.prisma.channel.findMany({ where: { starterMessageId: message } })).length).toBe(0)
  await deny(channel, P.VIEW_CHANNEL)
  expect((await startThread(member, channel, message, 'hidden')).status).toBe(404)
  // The owner still can.
  expect((await startThread(owner, channel, message, 'owner thread')).status).toBe(200)
})

test('Forward sends a type 1 reference with a snapshot of the message', async () => {
  const from = await chat('forward-from')
  const to = await chat('forward-to')
  const source = await post(owner, from, 'Worth reading **twice**')
  const sent = await forward(member, to, from, source)
  expect(sent.status).toBe(200)
  const message: any = await sent.json()
  expect({ content: message.content, reference: message.message_reference, snapshot: message.message_snapshots?.[0]?.message?.content, author: message.author.id === memberId })
    .toEqual({ content: '', reference: { type: 1, message_id: source, channel_id: from, guild_id: t.config.guildId }, snapshot: 'Worth reading **twice**', author: true })
  // Stored: the history and bots show the same forward.
  const stored = (await owner.json(`/client/channels/${to}/messages`)).messages.find((m: { id: string }) => m.id === message.id)
  expect(stored.message_snapshots[0].message.content).toBe('Worth reading **twice**')
  const event = await waitFor(() => botEvents.find((p) => p.t === 'MESSAGE_CREATE' && p.d?.id === message.id))
  expect(event!.d!['message_reference'].type).toBe(1)
  expect(event!.d!['message_snapshots'][0].message.content).toBe('Worth reading **twice**')
  // The note is a message of its own; a forward carries nothing else.
  expect((await forward(member, to, from, source, { content: 'see this' })).status).toBe(400)
})

test('Forward needs read access to the source and send access to the target', async () => {
  const hidden = await chat('forward-hidden')
  const unread = await chat('forward-no-history')
  const muted = await chat('forward-muted')
  const open = await chat('forward-open')
  const secret = await post(owner, hidden, 'not for sam')
  const old = await post(owner, unread, 'history only')
  const fine = await post(owner, open, 'anyone may read this')
  await deny(hidden, P.VIEW_CHANNEL)
  await deny(unread, P.READ_MESSAGE_HISTORY)
  await deny(muted, P.SEND_MESSAGES)
  expect((await forward(member, open, hidden, secret)).status).toBe(404)
  expect((await forward(member, open, unread, old)).status).toBe(403)
  expect((await forward(member, muted, open, fine)).status).toBe(403)
  // A message id from another channel is not this channel's message.
  expect((await forward(member, open, open, secret)).status).toBe(404)
  const leaked = await t.hub.twin.prisma.message.findMany({ where: { channelId: { in: [open, muted] }, messageReference: { not: null } } })
  expect(leaked).toEqual([])
})

test('forwarded files load for whoever can read the forward, and nothing else of the source does', async () => {
  const from = await chat('forward-files-from')
  const to = await chat('forward-files-to')
  const upload = async (name: string) => {
    const form = new FormData()
    form.append('file', new Blob([`file ${name}`], { type: 'text/plain' }), name)
    return owner.json<{ id: string; url: string }>('/client/uploads', { method: 'POST', body: form })
  }
  const shared = await upload('shared.txt')
  const other = await upload('other.txt')
  const source = (await owner.json(`/client/channels/${from}/messages`, { method: 'POST', json: { content: 'with a file', attachmentIds: [shared.id] } })).id
  await owner.json(`/client/channels/${from}/messages`, { method: 'POST', json: { content: 'another file', attachmentIds: [other.id] } })
  const forwarded: any = await (await forward(owner, to, from, source)).json()
  expect(forwarded.message_snapshots[0].message.attachments.map((a: { id: string }) => a.id)).toEqual([shared.id])
  const load = async (file: { url: string }) => {
    const response = await member.fetch(file.url.split('?')[0]!)
    return { status: response.status, body: response.ok ? await response.text() : null }
  }
  // Sam reads the target but not the source.
  await deny(from, P.VIEW_CHANNEL)
  expect((await member.fetch(`/client/channels/${from}/messages`)).ok).toBe(false)
  expect(await load(shared)).toEqual({ status: 200, body: 'file shared.txt' })
  expect((await load(other)).status).toBe(404)
  // Neither: the forwarded file is hidden too.
  await deny(to, P.VIEW_CHANNEL)
  expect((await load(shared)).status).toBe(404)
  expect((await load(other)).status).toBe(404)
})

test('a snapshot file counts only when its source holds it: forged claims stay hidden, a deleted source keeps same-server forwards', async () => {
  const other = (await t.hub.store.addGuild('Elsewhere')).id
  await t.hub.reload()
  await owner.json(`/client/guilds/${other}/invites`, { method: 'POST', json: { user_id: memberId } })
  const elsewhere = (await owner.json(`/client/guilds/${other}/channels`, { method: 'POST', json: { name: 'elsewhere-open' } })).id
  const upload = async (name: string) => {
    const form = new FormData()
    form.append('file', new Blob([`file ${name}`], { type: 'text/plain' }), name)
    return owner.json<{ id: string; url: string }>('/client/uploads', { method: 'POST', body: form })
  }
  const load = async (file: { url: string }) => (await member.fetch(file.url.split('?')[0]!)).status
  const postFile = async (channel: string, file: { id: string }) => (await owner.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: 'a file', attachmentIds: [file.id] } })).id
  const remove = (channel: string, id: string) => owner.fetch(`/client/channels/${channel}/messages/${id}`, { method: 'DELETE' })
  // A message stored as the mirror would, with a snapshot naming any file.
  const claim = async (channel: string, reference: { channel: string; message: string }, file: { id: string }) => {
    const id = generateSnowflake()
    await t.hub.twin.mirrorMessage(
      { id, channelId: channel, authorId: t.config.botUserId, content: '', timestamp: new Date(), messageReference: { type: 1, channel_id: reference.channel, message_id: reference.message } },
      { extra: { message_snapshots: [{ message: { type: 0, content: '', attachments: [{ id: file.id, filename: 'x.txt' }], embeds: [], components: [], timestamp: new Date().toISOString(), edited_timestamp: null, flags: 0, mentions: [], mention_roles: [] } }] } },
    )
    await waitFor(async () => (await owner.json(`/client/channels/${channel}/messages`)).messages.some((m: { id: string }) => m.id === id))
    return id
  }

  // A file in a channel Sam cannot read, in the first server.
  const secret = await chat('snapshot-secret')
  const secretFile = await upload('secret.txt')
  const secretMessage = await postFile(secret, secretFile)
  await deny(secret, P.VIEW_CHANNEL)
  const readable = await chat('snapshot-readable')
  // Claimed from another server (the source is real and holds it), from a made-up source, or
  // from a same-server source that does not hold it: hidden from Sam.
  await claim(elsewhere, { channel: secret, message: secretMessage }, secretFile)
  await claim(elsewhere, { channel: elsewhere, message: generateSnowflake() }, secretFile)
  const decoy = await postFile(readable, await upload('decoy.txt'))
  await claim(readable, { channel: readable, message: decoy }, secretFile)
  expect(await load(secretFile)).toBe(404)

  // A real forward within the server outlives its source.
  const from = await chat('snapshot-from')
  const to = await chat('snapshot-to')
  const kept = await upload('kept.txt')
  const source = await postFile(from, kept)
  expect((await forward(owner, to, from, source)).status).toBe(200)
  await deny(from, P.VIEW_CHANNEL)
  expect(await load(kept)).toBe(200)
  expect((await remove(from, source)).ok).toBe(true)
  expect(await load(kept)).toBe(200)

  // A forward to another server loads while its source is there, not after.
  const away = await upload('away.txt')
  const awaySource = await postFile(from, away)
  expect((await forward(owner, elsewhere, from, awaySource)).status).toBe(200)
  expect(await load(away)).toBe(200)
  expect((await remove(from, awaySource)).ok).toBe(true)
  expect(await load(away)).toBe(404)
})
