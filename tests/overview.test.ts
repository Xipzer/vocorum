// The Overview API: session state derived from a real discord.js bot's
// messages, machine health from its gateway session, and read state shared
// by every device.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { pairedDevice, startTestHub, waitFor, type TestDevice } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let demo: Awaited<ReturnType<typeof startDemoBot>>
let phone: TestDevice
let laptop: TestDevice

beforeAll(async () => {
  t = await startTestHub()
  demo = await startDemoBot(t.hub)
  phone = await pairedDevice(t.hub, 'phone')
  laptop = await pairedDevice(t.hub, 'laptop')
}, 30_000)

afterAll(async () => {
  await demo?.stop()
  await t?.cleanup()
})

type Overview = { machines: Array<{ name: string; online: boolean | null; waiting: number }>; sessions: Array<{ id: string; title: string; state: string; machine: string | null; ask?: { choices?: Array<{ label: string }> } }> }

test('a session asking the owner shows as waiting, with its machine online', async () => {
  const overview = await waitFor(async () => {
    const value = await phone.json<Overview>('/client/overview')
    return value.sessions.find((s) => s.id === demo.thread.id)?.state === 'waiting' ? value : null
  })
  const session = overview.sessions.find((s) => s.id === demo.thread.id)!
  expect(session.title).toBe('Fix footer on short turns')
  expect(session.ask?.choices).toBeUndefined() // a select is not mirrored, only all-button asks
  const machine = overview.machines.find((m) => m.name === session.machine)
  expect(machine?.online).toBe(true)
  expect(machine?.waiting).toBe(1)
})

test('the owner answering moves the session to busy', async () => {
  await phone.json(`/client/channels/${demo.thread.id}/messages`, { method: 'POST', json: { content: 'Use rebase' } })
  await waitFor(async () => (await phone.json<Overview>('/client/overview')).sessions.find((s) => s.id === demo.thread.id)?.state !== 'waiting')
})

test('read state is shared by devices and only moves forward', async () => {
  const id = demo.thread.id
  await phone.fetch('/client/read', { method: 'PUT', json: { read: { [id]: '200' } } })
  await laptop.fetch('/client/read', { method: 'PUT', json: { read: { [id]: '100' } } })
  const state = await laptop.json<{ read: Record<string, string> }>('/client/state')
  expect(state.read[id]).toBe('200')
})

test('favourites round trip', async () => {
  await phone.fetch(`/client/favourites/${demo.thread.id}`, { method: 'PUT' })
  expect((await laptop.json<{ favourites: string[] }>('/client/state')).favourites).toEqual([demo.thread.id])
  await phone.fetch(`/client/favourites/${demo.thread.id}`, { method: 'DELETE' })
  expect((await laptop.json<{ favourites: string[] }>('/client/state')).favourites).toEqual([])
})
