// An ordinary Discord community into the hub: roles, members with their roles,
// channel permissions, a private thread, a forum, pins, reactions and custom
// emoji come across; what has no place on the hub (voice, forum tags, moderation
// permissions) is reported. A later import never undoes the owner's changes.

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { P } from '../src/access.ts'
import { DiscordRest } from '../src/discord/rest.ts'
import { pairedDevice, startTestHub } from './helpers.ts'

const G = '1500000000000000000'
const [OWNER, ALICE, BOB, CAROL, BOT] = ['1500000000000000901', '1500000000000000902', '1500000000000000903', '1500000000000000904', '1500000000000000905']
const [MODS, ADMINS] = ['1500000000000000201', '1500000000000000202']
const [CATEGORY, GENERAL, STAFF, FORUM, VOICE, PRIVATE, POST] = ['1500000000000000301', '1500000000000000302', '1500000000000000303', '1500000000000000304', '1500000000000000305', '1500000000000000306', '1500000000000000307']
const EMOJI = '1500000000000000777'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex')

const user = (id: string, username: string, bot = false) => ({ id, username, global_name: username[0]!.toUpperCase() + username.slice(1), avatar: null, bot })
const message = (id: string, channel: string, author: string, content: string, extra: Record<string, unknown> = {}) => ({ id, channel_id: channel, author: user(author, author === OWNER ? 'owner' : author === ALICE ? 'alice' : 'bob'), content, timestamp: new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString(), type: 0, attachments: [], embeds: [], ...extra })
const everyone = String(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY)

const routes: Record<string, unknown> = {
  '/users/@me': user('1500000000000000999', 'importer', true),
  '/applications/@me': { flags: 1 << 18 },
  [`/guilds/${G}`]: { id: G, name: 'Gardening Club', icon: null, owner_id: OWNER },
  [`/guilds/${G}/channels`]: [
    { id: CATEGORY, type: 4, name: 'Text', position: 0 },
    { id: GENERAL, type: 0, name: 'general', parent_id: CATEGORY, position: 0, rate_limit_per_user: 10 },
    { id: STAFF, type: 0, name: 'staff', parent_id: CATEGORY, position: 1, permission_overwrites: [{ id: G, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) }, { id: MODS, type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' }] },
    { id: FORUM, type: 15, name: 'questions', position: 2, available_tags: [{ id: '1', name: 'help' }, { id: '2', name: 'solved' }] },
    { id: VOICE, type: 2, name: 'Lounge', parent_id: CATEGORY, position: 3, permission_overwrites: [{ id: G, type: 0, allow: '0', deny: String(P.CONNECT) }, { id: MODS, type: 0, allow: String(P.CONNECT | P.SPEAK), deny: '0' }] },
    { id: '1500000000000000308', type: 13, name: 'Town hall', position: 4 },
  ],
  [`/guilds/${G}/threads/active`]: { threads: [{ id: PRIVATE, type: 12, name: 'plans', parent_id: GENERAL, guild_id: G }, { id: POST, type: 11, name: 'Why are my tomatoes yellow?', parent_id: FORUM, guild_id: G, applied_tags: ['1'] }] },
  [`/guilds/${G}/roles`]: [
    { id: G, name: '@everyone', permissions: everyone, position: 0, color: 0 },
    { id: MODS, name: 'Mods', permissions: String(P.MANAGE_MESSAGES | (1n << 1n)), position: 1, color: 0x2ecc71, hoist: true },
    { id: ADMINS, name: 'Admins', permissions: String(P.ADMINISTRATOR), position: 2, color: 0xe74c3c },
  ],
  [`/guilds/${G}/members`]: [
    { user: user(OWNER, 'owner'), roles: [], joined_at: '2024-01-01T00:00:00Z' },
    { user: user(ALICE, 'alice'), roles: [MODS], nick: 'Al', joined_at: '2024-02-01T00:00:00Z' },
    { user: user(BOB, 'bob'), roles: [], joined_at: '2024-03-01T00:00:00Z' },
    { user: user(CAROL, 'carol'), roles: [ADMINS], joined_at: '2024-04-01T00:00:00Z' },
    { user: user(BOT, 'helper', true), roles: [], joined_at: '2024-05-01T00:00:00Z' },
  ],
  [`/channels/${GENERAL}/messages`]: [
    message('1500000000000001001', GENERAL, OWNER, 'Welcome to the club', { pinned: true }),
    message('1500000000000001002', GENERAL, ALICE, 'Spring planting starts Saturday', { reactions: [{ emoji: { id: null, name: '👍' }, count: 2 }, { emoji: { id: EMOJI, name: 'sprout' }, count: 1 }] }),
  ],
  [`/channels/${STAFF}/messages`]: [message('1500000000000001101', STAFF, ALICE, 'Mods only: the shed key is under the pot')],
  [`/channels/${PRIVATE}/messages`]: [message('1500000000000001201', PRIVATE, ALICE, 'Surprise party for Bob')],
  [`/channels/${POST}/messages`]: [message(POST, POST, BOB, 'They get full sun')],
  [`/channels/${FORUM}/messages`]: [],
  [`/channels/1500000000000001002/reactions/${encodeURIComponent('👍')}`]: [user(ALICE, 'alice'), user(BOB, 'bob')],
  [`/channels/1500000000000001002/reactions/${encodeURIComponent(`sprout:${EMOJI}`)}`]: [user(CAROL, 'carol')],
  [`/channels/${PRIVATE}/thread-members`]: [{ user_id: ALICE }, { user_id: OWNER }],
  [`/guilds/${G}/emojis`]: [{ id: EMOJI, name: 'sprout', animated: false }],
  [`/guilds/${G}/stickers`]: [],
  [`/guilds/${G}/scheduled-events`]: [{ id: '1' }],
}

let fake: http.Server
let t: Awaited<ReturnType<typeof startTestHub>>
let importDiscord: typeof import('../src/discord/import.ts').importDiscord
let rest: DiscordRest

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === `/emojis/${EMOJI}.png`) return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
    let route = url.pathname.replace(/^\/api\/v10/, '')
    // Reactions: /channels/<c>/messages/<m>/reactions/<emoji> keyed by message.
    route = route.replace(/^\/channels\/\d+\/messages\/(\d+)\/reactions\//, '/channels/$1/reactions/')
    const data = routes[route] ?? routes[decodeURIComponent(route)]
    if (data === undefined) return res.writeHead(route.includes('/threads/archived/') ? 200 : 404, { 'content-type': 'application/json' }).end(route.includes('/threads/archived/') ? '{"threads":[]}' : '{"message":"Unknown"}')
    // Pages: everything fits one page, so ?after= past the end is empty.
    const after = url.searchParams.get('after')
    const list = Array.isArray(data) && after && after !== '0' ? [] : data
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list))
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api/v10`
  process.env['VOCORUM_DISCORD_API'] = base
  ;({ importDiscord } = await import('../src/discord/import.ts'))
  rest = new DiscordRest('test', base)
  t = await startTestHub()
  t.config.ownerDiscordIds = [OWNER]
})

afterAll(async () => {
  delete process.env['VOCORUM_DISCORD_API']
  await t?.cleanup()
  fake?.close()
})

const config = () => ({ ...t.config, port: t.hub.port })
const sees = async (userId: string, channel: string) => (await t.hub.access.view(userId)).channels.has(channel)

test('a community comes across with its roles, members, permissions, private thread, forum, pins, reactions and emoji', async () => {
  const report = await importDiscord(rest, config(), t.paths, { guilds: [G], log: () => {} })
  const c = report.guilds[G]!.community!
  expect(c).toMatchObject({ roles: 3, members: 5, overwrites: 2, private_threads: 1, private_thread_members: 2, reactions: 3, emoji: 1, forum_tags: 2 })
  expect(c.admins.sort()).toEqual(['Carol (@carol)', 'you'])
  const missing = c.not_imported.join('\n')
  for (const text of ['1 stage channels', 'text chat inside 1 voice channels', '2 forum tags', 'Kick and ban members', 'slow mode on 1 channels', '1 scheduled events', 'bans, invites']) expect(missing).toContain(text)

  const prisma = t.hub.twin.prisma
  expect((await prisma.role.findUnique({ where: { id: MODS } }))).toMatchObject({ name: 'Mods', guildId: G, hoist: true, color: 0x2ecc71 })
  expect((await prisma.role.findUnique({ where: { id: G } }))?.permissions).toBe(everyone)
  expect(await prisma.guildMember.findUnique({ where: { guildId_userId: { guildId: G, userId: ALICE } } })).toMatchObject({ nick: 'Al', roles: JSON.stringify([MODS]) })
  // The owner's Discord account is the hub owner, never a second person.
  expect(await prisma.user.findUnique({ where: { id: OWNER } })).toBeNull()
  expect((await prisma.message.findUnique({ where: { id: '1500000000000001001' } }))?.authorId).toBe(t.config.ownerUserId)

  // Permissions as on Discord: #staff only for Mods, the private thread only for its members.
  expect(await sees(ALICE, STAFF)).toBe(true)
  expect(await sees(BOB, STAFF)).toBe(false)
  expect(await sees(CAROL, STAFF)).toBe(true)
  expect(await sees(ALICE, PRIVATE)).toBe(true)
  expect(await sees(BOB, PRIVATE)).toBe(false)
  expect(await sees(BOB, POST)).toBe(true)
  // The voice channel comes across with its permissions: everyone sees it, only Mods connect.
  expect(await prisma.channel.findUnique({ where: { id: VOICE } })).toMatchObject({ type: 2, name: 'Lounge', parentId: CATEGORY })
  expect(await sees(BOB, VOICE)).toBe(true)
  expect(await t.hub.access.can(BOB, VOICE, P.CONNECT)).toBe(false)
  expect(await t.hub.access.can(ALICE, VOICE, P.CONNECT | P.SPEAK)).toBe(true)

  expect((await prisma.message.findUnique({ where: { id: '1500000000000001001' } }))?.pinned).toBe(true)
  expect((await prisma.channel.findUnique({ where: { id: POST } }))).toMatchObject({ type: 11, parentId: FORUM })
  const reactions = await prisma.reaction.findMany({ where: { messageId: '1500000000000001002' } })
  expect(reactions.map((r) => `${r.emoji} ${r.userId}`).sort()).toEqual([`<:sprout:${EMOJI}> ${CAROL}`, `👍 ${ALICE}`, `👍 ${BOB}`].sort())

  const owner = await pairedDevice(t.hub)
  const res = await owner.fetch(`/client/emojis/${EMOJI}`)
  expect(res.status).toBe(200)
  expect(crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')).toBe(crypto.createHash('sha256').update(PNG).digest('hex'))
  expect(await owner.json(`/client/guilds/${G}/emojis`)).toEqual([{ id: EMOJI, name: 'sprout', animated: false }])
})

test('an imported member pairs with a welcome code and lands in the server with their Discord roles', async () => {
  const { TestDevice } = await import('./helpers.ts')
  // Her network identity (learned at first pairing over the private listener; set here directly).
  await t.hub.store.setProfile(ALICE, { tailscaleLogin: 'alice@example.org' })
  await t.hub.refreshLogins()
  const alice = new TestDevice(t.hub, { 'tailscale-user-login': 'alice@example.org' })
  await alice.pair(await t.hub.store.createPairing("alice's device", { userId: ALICE }))
  const state = await alice.json('/client/state')
  const ids = [...state.channels, ...(state.threads ?? [])].map((c: { id: string }) => c.id)
  expect(ids).toContain(STAFF)
  expect(ids).toContain(PRIVATE)
  expect(state.guilds.map((g: { id: string }) => g.id)).toContain(G)
})

test('a later import adds what is new but never undoes what the owner changed on the hub', async () => {
  const prisma = t.hub.twin.prisma
  await prisma.guildMember.update({ where: { guildId_userId: { guildId: G, userId: ALICE } }, data: { roles: '[]' } })
  await prisma.role.update({ where: { id: MODS }, data: { name: 'Gardeners' } })
  await t.hub.store.setOverwrite(STAFF, { id: G, remove: true })
  t.hub.access.invalidate()
  const report = await importDiscord(rest, config(), t.paths, { guilds: [G], log: () => {} })
  expect(report.guilds[G]!.community!.kept).toEqual({ roles: 3, members: 4, overwrites: 2 })
  expect((await prisma.guildMember.findUnique({ where: { guildId_userId: { guildId: G, userId: ALICE } } }))?.roles).toBe('[]')
  expect((await prisma.role.findUnique({ where: { id: MODS } }))?.name).toBe('Gardeners')
  expect(await sees(BOB, STAFF)).toBe(true)
  expect(await prisma.reaction.count({ where: { messageId: '1500000000000001002' } })).toBe(3)
})

test('someone added to a private thread later sees it at once', async () => {
  expect(await sees(BOB, PRIVATE)).toBe(false)
  await t.hub.twin.prisma.threadMember.create({ data: { channelId: PRIVATE, userId: BOB } })
  // What the twin broadcasts when a bot adds a member (PUT /channels/:id/thread-members/:user).
  ;(t.hub.twin as any).server.gateway.broadcast('THREAD_MEMBERS_UPDATE', { id: PRIVATE, guild_id: G, member_count: 3, added_members: [{ id: PRIVATE, user_id: BOB }] })
  await t.hub.events.flush()
  expect(await sees(BOB, PRIVATE)).toBe(true)
})

test('a forum post: a thread whose opening message has its id, only for people who may send there', async () => {
  const owner = await pairedDevice(t.hub, 'owner-forum')
  const made = await owner.json(`/client/channels/${FORUM}/threads`, { method: 'POST', json: { name: 'Best compost?', content: 'Leaves or coffee grounds?' } })
  expect(made.thread).toMatchObject({ type: 11, parent_id: FORUM, name: 'Best compost?' })
  expect(made.message).toMatchObject({ id: made.thread.id, channel_id: made.thread.id, content: 'Leaves or coffee grounds?' })
  expect((await owner.fetch(`/client/channels/${GENERAL}/threads`, { method: 'POST', json: { name: 'x', content: 'y' } })).status).toBe(404)
  expect((await owner.fetch(`/client/channels/${FORUM}/threads`, { method: 'POST', json: { name: '', content: 'y' } })).status).toBe(400)
  // Bob may view the forum but not send there: no post.
  await t.hub.store.setOverwrite(FORUM, { id: G, type: 0, allow: '0', deny: String(P.SEND_MESSAGES) })
  t.hub.access.invalidate()
  await t.hub.store.setProfile(BOB, { tailscaleLogin: 'bob@example.org' })
  await t.hub.refreshLogins()
  const { TestDevice } = await import('./helpers.ts')
  const bob = new TestDevice(t.hub, { 'tailscale-user-login': 'bob@example.org' })
  await bob.pair(await t.hub.store.createPairing("bob's device", { userId: BOB }))
  expect((await bob.fetch(`/client/channels/${FORUM}/threads`, { method: 'POST', json: { name: 'Mine', content: 'hello' } })).status).toBe(403)
})

test('people not joined yet are marked pending, and only the owner can welcome them, from a device', async () => {
  const owner = await pairedDevice(t.hub, 'owner-welcome')
  const state = await owner.json('/client/state')
  const pending = (id: string) => state.users.find((u: { id: string }) => u.id === id)?.pending ?? false
  expect(pending(CAROL)).toBe(true)
  expect(pending(ALICE)).toBe(false)
  expect(pending(t.config.ownerUserId)).toBe(false)
  const first = await owner.json(`/client/users/${CAROL}/welcome`, { method: 'POST', json: {} })
  expect(first).toMatchObject({ code: expect.stringMatching(/^[A-Z0-9]{10}$/) })
  const second = await owner.json(`/client/users/${CAROL}/welcome`, { method: 'POST', json: {} })
  // A new code replaces the old one.
  expect(await t.hub.store.pairingState(first.code)).toBe('expired')
  expect(await t.hub.store.pairingState(second.code)).toBe('ready')
  expect((await owner.fetch(`/client/users/${ALICE}/welcome`, { method: 'POST', json: {} })).status).toBe(409)
  const { TestDevice } = await import('./helpers.ts')
  const alice = new TestDevice(t.hub, { 'tailscale-user-login': 'alice@example.org' })
  await alice.pair(await t.hub.store.createPairing("alice's second", { userId: ALICE }))
  expect((await alice.fetch(`/client/users/${CAROL}/welcome`, { method: 'POST', json: {} })).status).toBe(403)
})
