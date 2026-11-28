// Replies ping their author unless the reply bar's "@ OFF" (allowed_mentions.replied_user) says not to, as on Discord.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { pairedDevice, startTestHub, TestDevice, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let member: TestDevice
let general: string
const pushes: Array<{ userId: string; kind: string; message_id: string | null }> = []

beforeAll(async () => {
  t = await startTestHub({ extensions: [] })
  owner = await pairedDevice(t.hub)
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'replier' } })
  const login = 'replier@example.test'
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: login })
  await t.hub.refreshLogins()
  member = new TestDevice(t.hub, { 'tailscale-user-login': login })
  await member.pair(invite.code)
  general = (await owner.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  const deliver = t.hub.notifications.deliver.bind(t.hub.notifications)
  t.hub.notifications.deliver = async (userId, where, n) => {
    pushes.push({ userId, kind: n.kind, message_id: n.message_id })
    return deliver(userId, where, n)
  }
})

afterAll(async () => {
  await t?.cleanup()
})

const send = (device: TestDevice, body: object) => device.json(`/client/channels/${general}/messages`, { method: 'POST', json: body })
const counts = async () => ((await owner.json('/client/state')).mentions[general] ?? 0) as number
const inbox = async () => ((await owner.json('/client/inbox')).mentions as Array<{ message: { id: string } }>).map((m) => m.message.id)
const pushFor = (id: string) => waitFor(() => pushes.find((p) => p.message_id === id && p.userId === t.config.ownerUserId))

test('a reply with @ ON mentions its author: listed, badged, in the inbox and pushed as a mention', async () => {
  const original = await send(owner, { content: 'Which colour for the cover?' })
  const reply = await send(member, { content: 'Blue.', message_reference: { message_id: original.id }, allowed_mentions: { replied_user: true } })
  expect(reply.message_reference.message_id).toBe(original.id)
  expect(reply.mentions.map((u: { id: string }) => u.id)).toEqual([t.config.ownerUserId])
  expect((await pushFor(reply.id)).kind).toBe('mention')
  await t.hub.search.flush()
  expect(await counts()).toBe(1)
  expect(await inbox()).toContain(reply.id)
  const page = await owner.json(`/client/channels/${general}/messages`)
  expect(page.messages.find((m: { id: string }) => m.id === reply.id).mentions.map((u: { id: string }) => u.id)).toEqual([t.config.ownerUserId])
})

test('a reply with @ OFF does not mention its author; a reply to yourself never does', async () => {
  const before = await counts()
  const original = await send(owner, { content: 'And the font?' })
  const quiet = await send(member, { content: 'Serif.', message_reference: { message_id: original.id }, allowed_mentions: { replied_user: false } })
  expect(quiet.message_reference.message_id).toBe(original.id)
  expect(quiet.mentions).toEqual([])
  expect((await pushFor(quiet.id)).kind).toBe('message')
  const own = await send(member, { content: 'Or sans.', message_reference: { message_id: quiet.id }, allowed_mentions: { replied_user: true } })
  expect(own.mentions).toEqual([])
  await t.hub.search.flush()
  expect(await counts()).toBe(before)
  expect(await inbox()).not.toContain(quiet.id)
})

test('without allowed_mentions a reply pings, as Discord defaults', async () => {
  const original = await send(owner, { content: 'Ship it today?' })
  const reply = await send(member, { content: 'Yes.', message_reference: { message_id: original.id } })
  expect(reply.mentions.map((u: { id: string }) => u.id)).toEqual([t.config.ownerUserId])
  expect((await pushFor(reply.id)).kind).toBe('mention')
})
