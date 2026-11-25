// A friend joins from their own Tailscale account, which the hub has never seen:
// they may load the app and pair with their invite code, nothing else, and pairing
// ties that account to them. Afterwards their code and their account are theirs
// alone; removing them forgets the account. vocorum access shows what they see.

import { afterAll, beforeAll, expect, test } from 'vitest'
import type http from 'node:http'
import { readSecret, saveConfig } from '../src/config.ts'
import { TestDevice, pairedDevice, startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let admin: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>
let friends = ''

beforeAll(async () => {
  t = await startTestHub()
  await pairedDevice(t.hub, 'owner-laptop')
  const token = readSecret(t.paths.adminToken)
  admin = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${t.hub.port}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  friends = (await t.hub.store.addGuild('Friends')).id
  await t.hub.reload()
  // Every request now arrives as if through the private listener from a tailnet peer,
  // whose Tailscale login the test names in a header (Tailscale's whois in real life).
  const known = () => t.hub.tailscaleLogins
  const unknown = new WeakMap<http.IncomingMessage, string>()
  ;(t.hub as unknown as { privateListener: unknown }).privateListener = {
    // Only human requests from the test's tailnet peers; the admin API stays local.
    owns: (req: http.IncomingMessage) => req.headers['tailscale-user-login'] !== undefined,
    config: { address: '127.0.0.1', names: [], port: 0 },
    port: 0,
    appOrigins: [],
    checkPeer: async (req: http.IncomingMessage) => {
      const login = String(req.headers['tailscale-user-login'] ?? '')
      if (known().has(login)) return login
      unknown.set(req, login)
      return false
    },
    unknownLogin: (req: http.IncomingMessage) => unknown.get(req) ?? null,
    stop: async () => {},
  }
})

afterAll(() => t?.cleanup())

test('a friend pairs from an account the hub has never seen, and that account becomes theirs', async () => {
  const invited = await admin('POST', '/admin/people', { username: 'sam', guilds: [friends] })
  expect(invited.status).toBe(200)
  const sam = new TestDevice(t.hub, { 'tailscale-user-login': 'sam@example.org' })
  // Before pairing: the app loads, but no data.
  expect((await sam.fetch('/client/auth/status')).status).toBe(200)
  expect((await sam.fetch('/client/state')).status).toBe(403)
  await sam.pair(invited.json.code)
  expect((await t.hub.store.profiles())[invited.json.user.id]?.tailscaleLogin).toBe('sam@example.org')
  const state = await sam.json('/client/state')
  expect(state.guilds.map((g: { name: string }) => g.name)).toEqual(['Friends'])

  // Sam's next code cannot be used from someone else's unknown account.
  const again = await t.hub.store.createPairing("sam's tablet", { userId: invited.json.user.id, ttlMs: 60_000 })
  const eve = new TestDevice(t.hub, { 'tailscale-user-login': 'eve@example.org' })
  // Refused before the code is spent, so Sam can still use it.
  await expect(eve.pair(again)).rejects.toThrow(/403/)
  expect((await eve.fetch('/client/state')).status).toBe(403)
  // Nor can the owner's own pairing code.
  const ownerCode = await t.hub.store.createPairing('owner tablet')
  await expect(new TestDevice(t.hub, { 'tailscale-user-login': 'eve@example.org' }).pair(ownerCode)).rejects.toThrow(/403/)
  // From Sam's own account it works.
  await new TestDevice(t.hub, { 'tailscale-user-login': 'sam@example.org' }).pair(again)
})

test('access shows what a friend sees; removing them forgets their account', async () => {
  const view = await admin('GET', '/admin/people/sam/access')
  expect(view.json.servers.map((s: { name: string }) => s.name)).toEqual(['Friends'])
  expect(view.json.servers[0].drives_agents).toBe(false)
  expect(view.json.tailscale_login).toBe('sam@example.org')
  expect((await admin('DELETE', '/admin/people/sam')).status).toBe(200)
  expect((await t.hub.store.profiles())[view.json.id ?? '']?.tailscaleLogin ?? null).toBeNull()
  expect(t.hub.tailscaleLogins.has('sam@example.org')).toBe(false)
  expect((await new TestDevice(t.hub, { 'tailscale-user-login': 'sam@example.org' }).fetch('/client/state')).status).toBe(403)
})

test('nobody is invited into the Admin server, not even by the owner', async () => {
  const adminGuild = (await t.hub.store.addGuild('Admin')).id
  saveConfig(t.paths, { ...t.config, adminGuildId: adminGuild })
  await t.hub.reload()
  expect((await admin('POST', '/admin/people', { username: 'robin', guilds: [adminGuild] })).status).toBe(400)
})
