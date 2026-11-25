// The mentions inbox by scope: one chat, one server, or everything the person may read.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { P } from '../src/access.ts'
import { startDemoBot } from './demo-bot.ts'
import { pairedDevice, startTestHub, TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let demo: Awaited<ReturnType<typeof startDemoBot>>
let owner: TestDevice
let member: TestDevice
let memberId: string
const ids = (reply: { mentions: Array<{ message: { id: string } }> }) => reply.mentions.map((m) => m.message.id)

beforeAll(async () => {
  t = await startTestHub({ extensions: [] })
  owner = await pairedDevice(t.hub)
  demo = await startDemoBot(t.hub)
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'reader' } })
  memberId = invite.user.id
  const login = 'scope-reader@example.test'
  await t.hub.store.setProfile(memberId, { tailscaleLogin: login })
  await t.hub.refreshLogins()
  member = new TestDevice(t.hub, { 'tailscale-user-login': login })
  await member.pair(invite.code)
})

afterAll(async () => {
  await demo?.stop()
  await t?.cleanup()
})

test('the inbox of one chat holds only its mentions; a server and the full inbox hold both; lost history hides them', async () => {
  const inThread = await demo.thread.send(`<@${t.config.ownerUserId}> <@${memberId}> Review the cover.`)
  const elsewhere = await demo.website.send(`<@${t.config.ownerUserId}> <@${memberId}> Check the website.`)
  await t.hub.search.flush()
  const scoped = `/client/inbox?channel_id=${demo.thread.id}`
  expect(ids(await owner.json(scoped))).toEqual([inThread.id])
  expect(ids(await member.json(scoped))).toEqual([inThread.id])
  expect(ids(await owner.json(`/client/inbox?guild_id=${t.config.guildId}`))).toEqual(expect.arrayContaining([inThread.id, elsewhere.id]))
  expect(ids(await owner.json('/client/inbox'))).toEqual(expect.arrayContaining([inThread.id, elsewhere.id]))

  expect((await owner.fetch('/client/inbox?channel_id=bad')).status).toBe(400)
  expect((await owner.fetch(`/client/inbox?channel_id=${demo.thread.id}&guild_id=${t.config.guildId}`)).status).toBe(400)
  expect((await owner.fetch('/client/inbox?channel_id=1')).status).toBe(404)
  expect((await owner.fetch('/client/inbox?guild_id=1')).status).toBe(404)

  await owner.json(`/client/channels/${demo.kimaki.id}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.READ_MESSAGE_HISTORY) } })
  expect((await member.fetch(scoped)).status).toBe(403)
  const all = ids(await member.json('/client/inbox'))
  expect(all).not.toContain(inThread.id)
  expect(all).toContain(elsewhere.id)
})
