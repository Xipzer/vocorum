// Built-in extensions: started with the hub, stopped first, answering their
// own client routes behind the same gate as every client route, and never
// able to take the hub down by failing.

import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import type { HubExtensionFactory } from '../src/extensions.ts'
import { HttpError } from '../src/auth.ts'
import { LOGIN, TestDevice, startTestHub, waitFor } from './helpers.ts'

const calls: string[] = []
const notes: HubExtensionFactory = (hub) => ({
  id: 'notes',
  start: () => void calls.push('start'),
  stop: () => void calls.push('stop'),
  async handleClient(req, pathname, viewer) {
    if (!hub.access.isHubOwner(viewer.userId)) throw new HttpError(404, 'Not found')
    if (pathname === '/client/x/notes/me' && req.method === 'GET') return { userId: viewer.userId }
    if (pathname === '/client/x/notes/ping' && req.method === 'POST') {
      hub.events.send('NOTES_PING', { n: 1 }, { hubOwner: true })
      return null
    }
    return undefined
  },
})
const broken: HubExtensionFactory = () => ({ id: 'broken', start: () => Promise.reject(new Error('no backend')), handleClient: async () => ({ reached: true }) })
const unmakeable: HubExtensionFactory = () => {
  throw new Error('bad options')
}

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let friend: TestDevice

beforeAll(async () => {
  t = await startTestHub({ extensions: [unmakeable, broken, notes] })
  owner = new TestDevice(t.hub)
  await owner.pair(await t.hub.store.createPairing('owner desk'))
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'mallory' } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: 'mallory@example.com' })
  await t.hub.refreshLogins()
  friend = new TestDevice(t.hub, { 'tailscale-user-login': 'mallory@example.com' })
  await friend.pair(invite.code)
}, 30_000)

afterAll(async () => {
  await t?.cleanup()
  expect(calls).toEqual(['start', 'stop'])
})

test('an extension that cannot be made or started is skipped; the hub runs', async () => {
  expect(t.hub.extensions.map((e) => e.id)).toEqual(['notes'])
  expect((await owner.fetch('/client/x/broken/anything')).status).toBe(404)
  expect((await owner.fetch('/client/state')).status).toBe(200)
})

test('the owner reaches its routes; an unknown id or path is a 404', async () => {
  expect(calls).toEqual(['start'])
  expect(await owner.json('/client/x/notes/me')).toEqual({ userId: t.config.ownerUserId })
  expect((await owner.fetch('/client/x/notes/other')).status).toBe(404)
  expect((await owner.fetch('/client/x/other/me')).status).toBe(404)
})

test('its routes sit behind the client gate, and it checks who is asking', async () => {
  expect((await new TestDevice(t.hub).fetch('/client/x/notes/me')).status).toBe(401)
  expect((await owner.fetch('/client/x/notes/ping', { method: 'POST', json: {}, headers: { origin: 'https://evil.example' } })).status).toBe(403)
  // A device session through another person's Tailscale identity.
  expect((await new TestDevice(t.hub, { 'tailscale-user-login': 'mallory@example.com' }).fetch('/client/x/notes/me', { headers: { cookie: owner.cookie! } })).status).toBe(403)
  expect((await friend.fetch('/client/x/notes/me')).status).toBe(404)
})

test('events it sends reach the people it names', async () => {
  const socket = (device: TestDevice, login: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': login } })
    const got: string[] = []
    ws.on('message', (raw) => got.push(JSON.parse(String(raw)).t))
    return { ws, got, open: new Promise((r) => ws.once('open', r)) }
  }
  const mine = socket(owner, LOGIN)
  const theirs = socket(friend, 'mallory@example.com')
  await Promise.all([mine.open, theirs.open])
  expect((await owner.fetch('/client/x/notes/ping', { method: 'POST', json: {} })).status).toBe(204)
  await waitFor(() => mine.got.includes('NOTES_PING'))
  await new Promise((r) => setTimeout(r, 200))
  expect(theirs.got).not.toContain('NOTES_PING')
  mine.ws.close()
  theirs.ws.close()
})
