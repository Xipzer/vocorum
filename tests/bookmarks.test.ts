// Bookmarks (Discord's saved messages): private to each person, live on all their devices,
// gone with the message or with the right to read it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { P } from '../src/access.ts'
import { HubStore } from '../src/store.ts'
import { startDemoBot } from './demo-bot.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let demo: Awaited<ReturnType<typeof startDemoBot>>
let laptop: TestDevice
let phone: TestDevice
let member: TestDevice
let memberId: string
const phoneEvents: Array<{ t: string; d: any }> = []
const memberEvents: Array<{ t: string; d: any }> = []
const ids = async (device: TestDevice) => ((await device.json('/client/bookmarks')).bookmarks as Array<{ message: { id: string } }>).map((b) => b.message.id)

async function listen(device: TestDevice, login: string, events: Array<{ t: string; d: any }>) {
  const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login } })
  ws.on('message', (raw) => void events.push(JSON.parse(String(raw))))
  await new Promise((resolve) => ws.once('open', resolve))
}

beforeAll(async () => {
  t = await startTestHub({ extensions: [] })
  laptop = await pairedDevice(t.hub, 'laptop')
  phone = await pairedDevice(t.hub, 'phone')
  demo = await startDemoBot(t.hub)
  const invite = await laptop.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'reader' } })
  memberId = invite.user.id
  const login = 'bookmark-reader@example.test'
  await t.hub.store.setProfile(memberId, { tailscaleLogin: login })
  await t.hub.refreshLogins()
  member = new TestDevice(t.hub, { 'tailscale-user-login': login })
  await member.pair(invite.code)
  await listen(phone, LOGIN, phoneEvents)
  await listen(member, login, memberEvents)
}, 60_000)

afterAll(async () => {
  await demo?.stop()
  await t?.cleanup()
})

test('a bookmark made on one device appears on another, newest first, and goes from both', async () => {
  const first = await demo.website.send('Ship the landing page on Friday.')
  const second = await demo.website.send('The logo files are in the shared drive.')
  const saved = await laptop.json(`/client/bookmarks/${demo.website.id}/${first.id}`, { method: 'PUT' })
  expect(saved).toMatchObject({ message: { id: first.id, content: 'Ship the landing page on Friday.' }, channel: { id: demo.website.id } })
  expect(typeof saved.saved_at).toBe('string')
  const live = await waitFor(() => phoneEvents.find((e) => e.t === 'SAVED_MESSAGE_CREATE' && e.d.message.id === first.id))
  expect(live.d.channel.id).toBe(demo.website.id)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await phone.json(`/client/bookmarks/${demo.website.id}/${second.id}`, { method: 'PUT' })
  // Twice is once.
  await phone.json(`/client/bookmarks/${demo.website.id}/${second.id}`, { method: 'PUT' })
  expect(await ids(laptop)).toEqual([second.id, first.id])
  expect(await ids(phone)).toEqual([second.id, first.id])

  expect((await laptop.fetch(`/client/bookmarks/${demo.website.id}/${second.id}`, { method: 'DELETE' })).status).toBe(204)
  await waitFor(() => phoneEvents.find((e) => e.t === 'SAVED_MESSAGE_DELETE' && e.d.message_id === second.id))
  expect(await ids(phone)).toEqual([first.id])
})

test('a deleted message drops its bookmark on every device', async () => {
  const doomed = await demo.website.send('Draft numbers, delete me later.')
  await laptop.json(`/client/bookmarks/${demo.website.id}/${doomed.id}`, { method: 'PUT' })
  expect(await ids(phone)).toContain(doomed.id)
  await doomed.delete()
  await waitFor(() => phoneEvents.find((e) => e.t === 'SAVED_MESSAGE_DELETE' && e.d.message_id === doomed.id))
  expect(await ids(phone)).not.toContain(doomed.id)
  expect((await t.hub.store.bookmarks(t.config.ownerUserId)).map((b) => b.messageId)).not.toContain(doomed.id)
})

test('another person cannot read, remove or learn of your bookmarks', async () => {
  const note = await demo.website.send('Owner-only reading list.')
  await laptop.json(`/client/bookmarks/${demo.website.id}/${note.id}`, { method: 'PUT' })
  expect(await ids(member)).toEqual([])
  expect(memberEvents.some((e) => e.t.startsWith('SAVED_MESSAGE'))).toBe(false)
  expect((await member.fetch(`/client/bookmarks/${demo.website.id}/${note.id}`, { method: 'DELETE' })).status).toBe(204)
  expect(await ids(laptop)).toContain(note.id)
  // Their own bookmark of the same message is theirs alone.
  await member.json(`/client/bookmarks/${demo.website.id}/${note.id}`, { method: 'PUT' })
  expect(await ids(member)).toEqual([note.id])
  expect(phoneEvents.filter((e) => e.t === 'SAVED_MESSAGE_CREATE' && e.d.message.id === note.id)).toHaveLength(1)
})

test('losing access to a channel drops its bookmarks; a hidden channel cannot be bookmarked', async () => {
  const kept = await demo.kimaki.send('Kimaki release notes.')
  await member.json(`/client/bookmarks/${demo.kimaki.id}/${kept.id}`, { method: 'PUT' })
  expect(await ids(member)).toContain(kept.id)
  await laptop.json(`/client/channels/${demo.kimaki.id}/permissions/${memberId}`, { method: 'PUT', json: { type: 1, allow: '0', deny: String(P.VIEW_CHANNEL) } })
  expect(await ids(member)).not.toContain(kept.id)
  expect((await t.hub.store.bookmarks(memberId)).map((b) => b.messageId)).not.toContain(kept.id)
  expect((await member.fetch(`/client/bookmarks/${demo.kimaki.id}/${kept.id}`, { method: 'PUT' })).status).toBe(404)
  // The owner's bookmark of a message elsewhere stays.
  await laptop.json(`/client/bookmarks/${demo.kimaki.id}/${kept.id}`, { method: 'PUT' })
  expect(await ids(laptop)).toContain(kept.id)
})

test('a hub database from before bookmarks gains the table and keeps everything else; migrating again changes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-'))
  try {
    const url = `file:${path.join(dir, 'hub.db')}`
    const before = new HubStore(url)
    await before.migrate()
    await before.setFavourite('7', '42', true)
    // As an older build left it: no bookmarks table or its indexes.
    await before.db.execute('DROP TABLE user_bookmarks')
    before.db.close()
    const store = new HubStore(url)
    await store.migrate()
    expect(await store.favourites('7')).toEqual(['42'])
    expect(await store.bookmarks('7')).toEqual([])
    expect(await store.setBookmark('7', '42', '100', true, 1000)).toBe(true)
    await store.migrate()
    expect(await store.bookmarks('7')).toEqual([{ messageId: '100', channelId: '42', savedAt: 1000 }])
    const indexes = (await store.db.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_bookmarks' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => r['name'])
    expect(indexes).toEqual(['user_bookmarks_channel', 'user_bookmarks_message'])
    store.db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
