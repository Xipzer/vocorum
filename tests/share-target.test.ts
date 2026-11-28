// A share sheet POST that reaches the hub (its service worker not running) keeps nothing
// and sends the app to a note asking to share again.

import fs from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { pairedDevice, startTestHub, type TestDevice } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let phone: TestDevice

beforeAll(async () => {
  t = await startTestHub({ extensions: [] })
  phone = await pairedDevice(t.hub)
})

afterAll(async () => {
  await t?.cleanup()
})

test('a share POST is answered with a redirect to the app, and nothing is uploaded or posted', async () => {
  const general = (await phone.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  const before = (await phone.json(`/client/channels/${general}/messages`)).messages.length
  const messages = await t.hub.twin.prisma.message.count()
  const files = () => (fs.existsSync(t.paths.attachments) ? fs.readdirSync(t.paths.attachments, { recursive: true }).length : 0)
  const stored = files()
  const form = new FormData()
  form.set('title', 'A page')
  form.set('text', 'look at this')
  form.append('files', new Blob([new Uint8Array(256 * 1024)], { type: 'image/png' }), 'photo.png')
  const response = await phone.fetch('/share', { method: 'POST', body: form, redirect: 'manual' })
  expect(response.status).toBe(303)
  expect(response.headers.get('location')).toBe('/#/share-again')
  expect((await phone.json(`/client/channels/${general}/messages`)).messages.length).toBe(before)
  expect(await t.hub.twin.prisma.message.count()).toBe(messages)
  expect(files()).toBe(stored)
  // Other methods on the path are still the app's.
  expect((await phone.fetch('/share', { method: 'PUT', body: 'x', redirect: 'manual' })).status).not.toBe(303)
})
