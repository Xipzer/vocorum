// Scheduled messages (once or on a UTC cron) and reminders, per person.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { Client, GatewayIntentBits, type Message, type TextChannel } from 'discord.js'
import { nextCron, parseCron } from '../src/schedules.ts'
import { TestDevice, pairedDevice, startTestHub, waitFor } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let bot: Client
let owner: TestDevice
let general: TextChannel
const seen: Message[] = []

beforeAll(async () => {
  t = await startTestHub()
  const minted = await t.hub.store.addBot('desk-pc')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  bot.on('messageCreate', (m) => void seen.push(m))
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  owner = await pairedDevice(t.hub, 'owner-laptop')
  const state = await owner.json('/client/state')
  general = (await bot.channels.fetch(state.channels.find((c: { name: string }) => c.name === 'general').id)) as TextChannel
})

afterAll(async () => {
  await bot.destroy()
  await t.cleanup()
})

test('cron: five UTC fields, steps, ranges and lists', () => {
  const monday = Date.UTC(2026, 10, 23, 8, 30) // Monday 23 Nov 2026, 08:30 UTC
  expect(nextCron('0 9 * * 1', monday)).toBe(Date.UTC(2026, 10, 23, 9, 0))
  expect(nextCron('0 9 * * 1', Date.UTC(2026, 10, 23, 9, 0))).toBe(Date.UTC(2026, 10, 30, 9, 0))
  expect(nextCron('*/15 * * * *', Date.UTC(2026, 10, 23, 8, 31))).toBe(Date.UTC(2026, 10, 23, 8, 45))
  expect(nextCron('0 9,18 * * *', Date.UTC(2026, 10, 23, 10, 0))).toBe(Date.UTC(2026, 10, 23, 18, 0))
  expect(nextCron('30 6 1 * *', monday)).toBe(Date.UTC(2026, 11, 1, 6, 30))
  expect(nextCron('0 0 * * 7', monday)).toBe(Date.UTC(2026, 10, 29, 0, 0))
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', 'a b c d e', '*/0 * * * *']) expect(parseCron(bad)).toBeNull()
})

test('a scheduled message is posted as its author at the time, and the agent receives it', async () => {
  const at = Date.now() + 3_600_000
  expect((await owner.fetch('/client/schedules', { method: 'POST', json: { kind: 'message', channel_id: general.id, content: 'x', at: Date.now() - 3_600_000 } })).status).toBe(400)
  const s = await owner.json('/client/schedules', { method: 'POST', json: { kind: 'message', channel_id: general.id, content: 'run the nightly report', at } })
  expect(s).toMatchObject({ kind: 'message', status: 'pending', next_at: at })
  await t.hub.schedules.runDue(at - 1000)
  expect(seen.some((m) => m.content === 'run the nightly report')).toBe(false)
  await t.hub.schedules.runDue(at)
  const got = await waitFor(() => seen.find((m) => m.content === 'run the nightly report'))
  expect(got.author.id).toBe(t.config.ownerUserId)
  const [after] = (await owner.json('/client/schedules')).schedules.filter((x: { id: string }) => x.id === s.id)
  expect(after).toMatchObject({ status: 'done', next_at: null })
  expect(after.last_result).toMatch(/^posted \d+$/)
})

test('a recurring message keeps its next time after each run; cancelling stops it', async () => {
  const s = await owner.json('/client/schedules', { method: 'POST', json: { kind: 'message', channel_id: general.id, content: 'weekly check', cron: '0 9 * * 1' } })
  const first = s.next_at as number
  expect(new Date(first).getUTCDay()).toBe(1)
  await t.hub.schedules.runDue(first)
  await waitFor(() => seen.find((m) => m.content === 'weekly check'))
  const [again] = (await owner.json('/client/schedules')).schedules.filter((x: { id: string }) => x.id === s.id)
  expect(again).toMatchObject({ status: 'pending', next_at: first + 7 * 86_400_000 })
  expect(await owner.json(`/client/schedules/${s.id}`, { method: 'DELETE' })).toEqual({ cancelled: s.id })
  expect((await owner.json('/client/schedules')).schedules.some((x: { id: string }) => x.id === s.id)).toBe(false)
})

test('a reminder notifies its owner about a message', async () => {
  const target = await general.send('deploy window opens at 14:00')
  const pushed: Array<{ kind: string; title: string; body: string; message_id: string | null }> = []
  const original = t.hub.notifications.pushAll.bind(t.hub.notifications)
  t.hub.notifications.pushAll = async (payload, only) => {
    pushed.push({ kind: payload.kind, title: payload.title, body: payload.body, message_id: payload.message_id })
    return original(payload, only)
  }
  const at = Date.now() + 7_200_000
  expect((await owner.fetch('/client/schedules', { method: 'POST', json: { kind: 'reminder', channel_id: general.id, message_id: '123', at } })).status).toBe(404)
  await owner.json('/client/schedules', { method: 'POST', json: { kind: 'reminder', channel_id: general.id, message_id: target.id, at } })
  await t.hub.schedules.runDue(at)
  expect(pushed).toEqual([{ kind: 'reminder', title: 'Reminder', body: 'deploy window opens at 14:00', message_id: target.id }])
  t.hub.notifications.pushAll = original
})

test('schedules are private to their owner and need access to the channel', async () => {
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'sam' } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: 'sam@example.com' })
  await t.hub.reload()
  const sam = new TestDevice(t.hub, { 'tailscale-user-login': 'sam@example.com' })
  await sam.pair(invite.code)
  const mine = await owner.json('/client/schedules', { method: 'POST', json: { kind: 'reminder', channel_id: general.id, content: 'private note', at: Date.now() + 60_000 } })
  expect((await sam.json('/client/schedules')).schedules).toEqual([])
  expect((await sam.fetch(`/client/schedules/${mine.id}`, { method: 'DELETE' })).status).toBe(404)
  expect((await sam.fetch('/client/schedules', { method: 'POST', json: { kind: 'message', channel_id: '999999999999999999', content: 'x', at: Date.now() + 60_000 } })).status).toBe(404)
})

test('reminders: listed until done, due after they fire, snoozed with a new time', async () => {
  const target = await general.send('rotate the keys this week')
  const at = Date.now() + 5_400_000
  const created = await owner.json('/client/reminders', { method: 'POST', json: { channel_id: general.id, message_id: target.id, at, note: 'keys' } })
  expect(created).toMatchObject({ channel_id: general.id, message_id: target.id, at, note: 'keys', due: false })
  const list = async () => (await owner.json('/client/reminders')).reminders.find((r: { id: string }) => r.id === created.id)
  await t.hub.schedules.runDue(at)
  expect(await list()).toMatchObject({ due: true })
  const later = Date.now() + 9_000_000
  expect(await owner.json(`/client/reminders/${created.id}`, { method: 'PATCH', json: { at: later } })).toMatchObject({ at: later, due: false })
  expect(await list()).toMatchObject({ at: later, due: false })
  expect(await owner.json(`/client/reminders/${created.id}`, { method: 'DELETE' })).toEqual({ deleted: created.id })
  expect(await list()).toBeUndefined()
  expect((await owner.fetch(`/client/reminders/${created.id}`, { method: 'DELETE' })).status).toBe(404)
})

test('schedule rows: a fired reminder is snoozed or dismissed on its one row, with the message excerpt', async () => {
  const target = await general.send('renew the certificate before Friday')
  const at = Date.now() + 3_000_000
  const s = await owner.json('/client/schedules', { method: 'POST', json: { kind: 'reminder', channel_id: general.id, message_id: target.id, at } })
  const row = async () => (await owner.json('/client/schedules')).schedules.find((x: { id: string }) => x.id === s.id)
  expect((await row()).message).toMatchObject({ content: 'renew the certificate before Friday', author: { id: bot.user!.id, username: bot.user!.username } })
  await t.hub.schedules.runDue(at)
  expect(await row()).toMatchObject({ status: 'done' })
  const later = Date.now() + 6_000_000
  expect(await owner.json(`/client/schedules/${s.id}`, { method: 'PATCH', json: { at: later } })).toMatchObject({ id: s.id, status: 'pending', next_at: later })
  await t.hub.schedules.runDue(later)
  expect(await row()).toMatchObject({ status: 'done' })
  expect(await owner.json(`/client/schedules/${s.id}`, { method: 'DELETE' })).toEqual({ cancelled: s.id })
  expect(await row()).toBeUndefined()
  // A recurring schedule is not moved this way.
  const weekly = await owner.json('/client/schedules', { method: 'POST', json: { kind: 'message', channel_id: general.id, content: 'standup', cron: '0 9 * * 1' } })
  expect((await owner.fetch(`/client/schedules/${weekly.id}`, { method: 'PATCH', json: { at: later } })).status).toBe(404)
})
