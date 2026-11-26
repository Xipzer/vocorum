// Message history pages forward with after=, as Discord's API does: the oldest messages
// newer than the given one, oldest first, and hasMore while newer ones remain.

import { afterAll, beforeAll, expect, test } from 'vitest'
import { pairedDevice, startTestHub, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let channel: string
const ids: string[] = []

beforeAll(async () => {
  t = await startTestHub()
  owner = await pairedDevice(t.hub, 'laptop')
  channel = (await owner.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  for (const n of [1, 2, 3, 4, 5]) ids.push((await owner.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: `message ${n}` } })).id)
})

afterAll(async () => {
  await t?.cleanup()
})

const page = (query: string) => owner.json<{ messages: Array<{ id: string; content: string }>; hasMore: boolean; privateReplies?: unknown }>(`/client/channels/${channel}/messages?${query}`)

test('after= returns the next messages in order and says whether newer ones remain', async () => {
  const next = await page(`after=${ids[0]}&limit=2`)
  expect(next.messages.map((m) => m.content)).toEqual(['message 2', 'message 3'])
  expect(next.hasMore).toBe(true)
  const last = await page(`after=${ids[2]}&limit=2`)
  expect(last.messages.map((m) => m.content)).toEqual(['message 4', 'message 5'])
  expect(last.hasMore).toBe(true)
  const end = await page(`after=${ids[4]}&limit=2`)
  expect(end.messages).toEqual([])
  expect(end.hasMore).toBe(false)
  // A forward page is not the latest page: it carries no private replies.
  expect(next).not.toHaveProperty('privateReplies')
})

test('before= wins over after=, and the latest page is unchanged', async () => {
  const back = await page(`before=${ids[3]}&after=${ids[0]}&limit=2`)
  expect(back.messages.map((m) => m.content)).toEqual(['message 2', 'message 3'])
  const latest = await page('limit=2')
  expect(latest.messages.map((m) => m.content)).toEqual(['message 4', 'message 5'])
  expect(latest).toHaveProperty('privateReplies')
})
