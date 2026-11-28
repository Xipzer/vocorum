// Who reacted: the client's list of a reaction's users, as Discord's GET .../reactions/{emoji}.
import { afterAll, beforeAll, expect, test } from 'vitest'
import { P } from '../src/access.ts'
import { TestDevice, pairedDevice, startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice, member: TestDevice, memberId: string, botToken: string
const memberLogin = 'sam@example.test'

beforeAll(async () => {
  t = await startTestHub({ extensions: [] })
  owner = await pairedDevice(t.hub, 'test-browser')
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'sam' } })
  memberId = invite.user.id
  await t.hub.store.setProfile(memberId, { tailscaleLogin: memberLogin })
  const bot = await t.hub.store.addBot('test-worker')
  botToken = `${bot.clientId}:${bot.secret}`
  await t.hub.reload()
  member = new TestDevice(t.hub, { 'tailscale-user-login': memberLogin })
  await member.pair(invite.code)
})

afterAll(async () => {
  await t?.cleanup()
})

test('two people and a bot react; the list names them in ID order, pages, and is closed to those who cannot see the channel', async () => {
  const channel = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'reacting' } })).id
  const message = (await owner.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: 'react to this' } })).id
  const emoji = encodeURIComponent('👍')
  const path = `/client/channels/${channel}/messages/${message}/reactions/${emoji}`
  await owner.json(path, { method: 'PUT' })
  await member.json(path, { method: 'PUT' })
  const botPut = await fetch(`${t.hub.localUrl}/api/v10/channels/${channel}/messages/${message}/reactions/${emoji}/@me`, { method: 'PUT', headers: { authorization: `Bot ${botToken}` } })
  expect(botPut.status).toBe(204)
  await owner.json(`/client/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('👀')}`, { method: 'PUT' })

  const users: Array<{ id: string; username: string; bot?: boolean }> = await member.json(path)
  expect(users.map((u) => u.id)).toEqual([...users.map((u) => u.id)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)))
  expect(users.map((u) => `${u.username}${u.bot ? ' (bot)' : ''}`).sort()).toEqual(['owner', 'sam', expect.stringMatching(/\(bot\)$/)].sort())
  expect(await owner.json(`/client/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('👀')}`)).toEqual([expect.objectContaining({ username: 'owner' })])

  const first = await owner.json(`${path}?limit=1`)
  expect(first).toEqual([users[0]])
  expect(await owner.json(`${path}?after=${first[0].id}&limit=100`)).toEqual(users.slice(1))
  expect(await owner.json(`/client/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('🔥')}`)).toEqual([])

  await owner.json(`/client/channels/${channel}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.VIEW_CHANNEL) } })
  expect((await member.fetch(path)).status).toBe(404)
  await owner.json(`/client/channels/${channel}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.READ_MESSAGE_HISTORY) } })
  expect((await member.fetch(path)).status).toBe(403)
})
