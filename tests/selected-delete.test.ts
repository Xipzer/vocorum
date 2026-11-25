// All fixtures, users, credentials and sockets belong to a fresh loopback hub.
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { P } from '../src/access.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

type Packet = { t?: string; d?: { id?: string; channel_id?: string; guild_id?: string } }
let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice, member: TestDevice, memberId: string
const memberLogin = 'sam@example.test'
const sockets: WebSocket[] = []
const ownerEvents: Packet[] = [], memberEvents: Packet[] = [], botEvents: Packet[] = []
const deleted = (packets: Packet[], channel: string) => packets.filter((p) => p.t === 'MESSAGE_DELETE' && p.d?.channel_id === channel).map((p) => p.d!.id)

async function listen(device: TestDevice, login: string, sink: Packet[]) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login } })
  sockets.push(ws)
  ws.on('message', (raw) => sink.push(JSON.parse(raw.toString())))
  await waitFor(() => sink.find((p) => p.t === 'HELLO'))
}

async function chat(name: string): Promise<string> {
  const c = await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name } })
  return c.id
}
const messages = (channel: string) => `/client/channels/${channel}/messages`
const post = async (by: TestDevice, channel: string, content: string): Promise<string> => (await by.json(messages(channel), { method: 'POST', json: { content } })).id
const remove = (by: TestDevice, channel: string, ids: string[]) => by.fetch(`${messages(channel)}/bulk-delete`, { method: 'POST', json: { message_ids: ids } })
const history = async (by: TestDevice, channel: string): Promise<string[]> => (await by.json(messages(channel))).messages.map((m: { id: string }) => m.id)

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
  await Promise.all([listen(owner, LOGIN, ownerEvents), listen(member, memberLogin, memberEvents)])

  // A listener at the real bot gateway of THIS hub, to catch accidental bridge fan-out.
  const gateway = new WebSocket(`ws://127.0.0.1:${t.hub.port}/gateway?v=10&encoding=json`)
  sockets.push(gateway)
  gateway.on('message', (raw) => {
    const p = JSON.parse(raw.toString())
    if (p.op === 10) gateway.send(JSON.stringify({ op: 2, d: { token: `${localBot.clientId}:${localBot.secret}`, intents: 513, properties: { os: 'linux', browser: 'test', device: 'test' } } }))
    if (p.op === 0) botEvents.push(p)
  })
  await waitFor(() => botEvents.find((p) => p.t === 'GUILD_CREATE'))
})

afterAll(async () => {
  for (const ws of sockets) ws.terminate()
  await t?.cleanup()
})

test('a member deletes only their selected messages; both devices and search agree, with no bot delete', async () => {
  const channel = await chat('local-selection')
  const first = await post(member, channel, 'violetproof first')
  const neighbour = await post(owner, channel, 'violetproof neighbour')
  const last = await post(member, channel, 'violetproof last')
  await t.hub.search.flush()
  expect((await member.json('/client/search?q=violetproof')).total).toBe(3)
  await waitFor(() => botEvents.find((p) => p.t === 'MESSAGE_CREATE' && p.d?.id === last))
  const ids = [last, first]
  const res = await remove(member, channel, ids)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ deleted_ids: ids })
  expect(await history(owner, channel)).toEqual([neighbour])
  expect(await t.hub.twin.prisma.channel.findUnique({ where: { id: channel } })).toMatchObject({ messageCount: 1, totalMessageSent: 3, lastMessageId: neighbour })
  await waitFor(() => deleted(ownerEvents, channel).length === 2 && deleted(memberEvents, channel).length === 2)
  expect(deleted(ownerEvents, channel)).toEqual(ids)
  expect(deleted(memberEvents, channel)).toEqual(ids)
  await t.hub.search.flush()
  const found = await owner.json('/client/search?q=violetproof')
  expect(found.total).toBe(1)
  expect(found.results.map((r: { message: { id: string } }) => r.message.id)).toEqual([neighbour])
  // A later ordinary message bounds the negative assertion on the same ordered bot socket.
  const marker = await post(owner, channel, 'still connected')
  await waitFor(() => botEvents.find((p) => p.t === 'MESSAGE_CREATE' && p.d?.id === marker))
  expect(deleted(botEvents, channel)).toEqual([])
})

test('one denied, cross-chat or missing item leaves every surviving message alone', async () => {
  const channel = await chat('check-every-item'), other = await chat('other-chat')
  const own = await post(member, channel, 'member fixture'), theirs = await post(owner, channel, 'owner fixture')
  const foreign = await post(member, other, 'another chat')
  const gone = await post(member, channel, 'removed earlier')
  expect((await remove(member, channel, [gone])).status).toBe(200)
  expect((await member.fetch(`${messages(channel)}/${theirs}`, { method: 'DELETE' })).status).toBe(403)
  expect((await remove(member, channel, [own, theirs])).status).toBe(403)
  const stale = await remove(member, channel, [own, gone]), wrong = await remove(owner, channel, [own, foreign])
  expect([stale.status, wrong.status]).toEqual([409, 409])
  expect(await stale.json()).toEqual(await wrong.json())
  expect(await history(owner, channel)).toEqual([own, theirs])
  expect(await history(owner, other)).toEqual([foreign])
  // A member granted Manage Messages can delete the same selection.
  await owner.json(`/client/channels/${channel}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: String(P.MANAGE_MESSAGES), deny: '0' } })
  expect((await remove(member, channel, [theirs, own])).status).toBe(200)
  await waitFor(() => deleted(ownerEvents, channel).includes(own))
  expect(deleted(ownerEvents, channel)).toEqual([gone, theirs, own])
  expect(deleted(ownerEvents, other)).toEqual([])
})

test('thread replies cannot select the parent starter; hidden chats and DMs keep their normal rights', async () => {
  const parent = await chat('parent')
  const starter = await post(owner, parent, 'starter in the parent')
  const thread = await t.hub.twin.simulateChannelCreate({ guildId: t.config.guildId, name: 'fixture thread', type: 11, parentId: parent })
  await t.hub.twin.prisma.channel.update({ where: { id: thread.id }, data: { starterMessageId: starter } })
  const reply = await post(owner, thread.id, 'in the thread')
  expect(await history(owner, thread.id)).toEqual([starter, reply])
  expect((await remove(owner, thread.id, [reply, starter])).status).toBe(409)
  expect(await history(owner, parent)).toEqual([starter])
  expect(await history(owner, thread.id)).toEqual([starter, reply])
  await owner.json(`/client/channels/${parent}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.VIEW_CHANNEL) } })
  expect((await remove(member, thread.id, [reply])).status).toBe(404)
  const dm = (await owner.json('/client/dms', { method: 'POST', json: { user_id: memberId } })).id
  const one = await post(owner, dm, 'owner DM'), two = await post(member, dm, 'member DM')
  expect((await remove(owner, dm, [one, two])).status).toBe(403)
  expect(await history(member, dm)).toEqual([one, two])
  expect((await remove(member, dm, [two])).status).toBe(200)
  expect(await history(owner, dm)).toEqual([one])
})

test('requires an explicit distinct list, accepts exactly 100, and never truncates a larger selection', async () => {
  const channel = await chat('bounded')
  const ids = Array.from({ length: 101 }, (_, i) => String(810000000000031000n + BigInt(i)))
  await t.hub.twin.prisma.message.createMany({ data: ids.map((id) => ({ id, channelId: channel, authorId: t.config.ownerUserId, content: 'boundary fixture' })) })
  for (const body of [null, [], {}, { before: ids[0] }, { message_ids: [] }, { message_ids: ids[0] }, { message_ids: [123] }, { message_ids: [''] }, { message_ids: [ids[0], ids[0]] }, { message_ids: [ids[0]], all: true }, { message_ids: ids }]) {
    expect((await owner.fetch(`${messages(channel)}/bulk-delete`, { method: 'POST', json: body })).status).toBe(400)
  }
  expect(await t.hub.twin.prisma.message.count({ where: { channelId: channel } })).toBe(101)
  const selected = ids.slice(1)
  const res = await remove(owner, channel, selected)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ deleted_ids: selected })
  expect(await history(owner, channel)).toEqual(ids.slice(0, 1))
})

test('overlapping selections have one winner and one stale response', async () => {
  const channel = await chat('overlap')
  const a = await post(member, channel, 'first'), b = await post(member, channel, 'shared selection'), c = await post(member, channel, 'last')
  const batches = [[a, b], [b, c]]
  const results = await Promise.all(batches.map((ids) => remove(member, channel, ids)))
  expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  const winner = batches[results.findIndex((r) => r.status === 200)]!
  expect(await history(owner, channel)).toEqual([a, b, c].filter((id) => !winner.includes(id)))
  await waitFor(() => deleted(ownerEvents, channel).length === 2)
  expect(deleted(ownerEvents, channel)).toEqual(winner)
})

test('if storage skips a selected row the transaction rolls back and emits nothing', async () => {
  const channel = await chat('rollback')
  const a = await post(owner, channel, 'ordinary fixture'), b = await post(owner, channel, 'held fixture')
  const prisma = t.hub.twin.prisma
  await prisma.$executeRawUnsafe("CREATE TEMP TRIGGER fixture_hold BEFORE DELETE ON Message WHEN OLD.content = 'held fixture' BEGIN SELECT RAISE(IGNORE); END")
  try {
    expect((await remove(owner, channel, [a, b])).status).toBe(409)
    expect(await history(owner, channel)).toEqual([a, b])
    expect(await prisma.channel.findUnique({ where: { id: channel } })).toMatchObject({ messageCount: 2, lastMessageId: b })
  } finally { await prisma.$executeRawUnsafe('DROP TRIGGER fixture_hold') }
  const marker = await post(owner, channel, 'after rollback')
  await waitFor(() => ownerEvents.some((p) => p.t === 'MESSAGE_CREATE' && p.d?.id === marker))
  expect(deleted(ownerEvents, channel)).toEqual([])
})
