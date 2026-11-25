// Attacks on the admin agent, the Admin server, requests and friend pairing
// (security review, 25 Nov): each test is an exploit that once worked and must keep failing.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { hubPaths, initHub, loadConfig, readSecret, saveConfig } from '../src/config.ts'
import { workspacePolicy } from '../src/admin.ts'
import { HubStore } from '../src/store.ts'
import { TestDevice, pairedDevice, startTestHub } from './helpers.ts'

// OpenCode's wildcard: '*' is any text, a trailing ' *' is optional; whole string.
const wildcard = (pattern: string, text: string) => {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  if (re.endsWith(' .*')) re = re.slice(0, -3) + '( .*)?'
  return new RegExp(`^${re}$`, 's').test(text)
}
const decision = (command: string) => {
  // last matching rule wins, as in OpenCode
  const rules = workspacePolicy().permissions.filter((r) => r.action === 'shell' || r.action === '*')
  let effect = 'deny'
  for (const r of rules) if (wildcard(r.resource, command)) effect = r.effect
  return effect
}

let t: Awaited<ReturnType<typeof startTestHub>>
let owner: TestDevice
let admin: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>
let adminGuild = ''
let friends = ''

const encodeDigits = (id: string) => [...id].map((c) => `%3${c}`).join('')

describe('the admin agent', () => {
  const bin = path.resolve(import.meta.dirname, '../bin/vocorum.js')
  let dir = ''
  let state = ''
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, VOCORUM_DIR: state, NO_COLOR: '1' }, encoding: 'utf8' })
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-attacks-admin-'))
    state = path.join(dir, 'state')
    initHub(hubPaths(state), { tailscaleLogin: 'owner@example.com' })
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('"-- --help" is not a way to run a command without asking', async () => {
    for (const cmd of ['vocorum pair evil -- --help', 'vocorum config set tailscaleLogin eve@evil.example -- --help', 'vocorum restart -- --help', 'vocorum welcome sam -- --help']) expect(decision(cmd), cmd).not.toBe('allow')
    for (const cmd of ['vocorum pair evil', 'vocorum welcome sam', 'vocorum config set tailscaleLogin eve@evil.example', 'vocorum config set ownerDiscordIds 1']) expect(decision(cmd), cmd).toBe('deny')
    expect(decision('vocorum help pair')).toBe('allow')
    // And the CLI itself prints help, wherever --help is.
    const paired = run('pair', 'evil', '--', '--help')
    expect(paired.stdout).not.toMatch(/Code [A-Z0-9]{10}/)
    run('config', 'set', 'tailscaleLogin', 'eve@evil.example', '--', '--help')
    expect(loadConfig(hubPaths(state))?.tailscaleLogin).toBe('owner@example.com')
    const store = new HubStore(`file:${hubPaths(state).hubDb}`)
    await store.migrate()
    expect((await store.db.execute('SELECT count(*) AS n FROM pairings')).rows[0]?.['n']).toBe(0)
    store.close()
  })
})

describe('hub', () => {
  beforeAll(async () => {
    t = await startTestHub()
    owner = await pairedDevice(t.hub, 'owner-phone')
    const token = readSecret(t.paths.adminToken)
    admin = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${t.hub.port}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: res.status, json: await res.json().catch(() => null) }
    }
    friends = (await t.hub.store.addGuild('Friends')).id
    adminGuild = (await t.hub.store.addGuild('Admin')).id
    saveConfig(t.paths, { ...t.config, adminGuildId: adminGuild, adminBotReady: true })
    await t.hub.reload()
  })
  afterAll(() => t?.cleanup())

  test('an encoded id cannot slip a change to the Admin server past the request guard', async () => {
    const channel = await owner.json(`/client/guilds/${adminGuild}/channels`, { method: 'POST', json: { name: 'admin' } })
    expect((await admin('POST', '/admin/requests', { method: 'DELETE', route: `/client/channels/${encodeDigits(channel.id)}` })).status).toBe(400)
    expect((await admin('POST', '/admin/requests', { method: 'PATCH', route: `/client/guilds/${encodeDigits(adminGuild)}`, body: { name: 'x' } })).status).toBe(400)
  })

  test('an invite card says exactly who is added', async () => {
    const eve = await admin('POST', '/admin/people', { username: 'eve', guilds: [friends] })
    expect((await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { username: 'newbie', user_id: eve.json.user.id } })).status).toBe(400)
    const add = await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { user_id: eve.json.user.id } })
    expect(add.json.summary).toBe(`Add eve (already on the hub) to ${t.config.guildName}`)
  })

  test('a channel card shows the permissions and category it sets', async () => {
    const eve = (await t.hub.twin.prisma.user.findFirst({ where: { username: 'eve' } }))!
    const created = await admin('POST', '/admin/requests', { method: 'POST', route: `/client/guilds/${t.config.guildId}/channels`, body: { name: 'notes', permission_overwrites: [{ id: eve.id, type: 1, allow: String((1n << 10n) | (1n << 28n)) }] } })
    expect(created.json.summary).toContain('eve may ')
    expect(created.json.summary).toContain('manage_roles')
    const category = await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Hidden', type: 4 } })
    const general = (await owner.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general')
    const moved = await admin('POST', '/admin/requests', { method: 'PATCH', route: `/client/channels/${general.id}/settings`, body: { parent_id: category.id } })
    expect(moved.json.summary).toContain('category #Hidden')
  })

  test('a peer whose Tailscale login cannot be read pairs with nothing', async () => {
    const unknown = new WeakMap<http.IncomingMessage, string>()
    const saved = (t.hub as any).privateListener
    ;(t.hub as unknown as { privateListener: unknown }).privateListener = {
      owns: (req: http.IncomingMessage) => req.headers['x-test-peer'] !== undefined,
      config: { address: '127.0.0.1', names: [], port: 0 },
      port: 0,
      appOrigins: [],
      // As the real checkPeer: whois failed (null) -> false, and no unknownLogin recorded.
      checkPeer: async (req: http.IncomingMessage) => {
        const login = String(req.headers['x-test-peer'])
        if (login === 'whois-failed') return false
        if (t.hub.tailscaleLogins.has(login)) return login
        unknown.set(req, login)
        return false
      },
      unknownLogin: (req: http.IncomingMessage) => unknown.get(req) ?? null,
      stop: async () => {},
    }
    try {
      const ownerCode = await t.hub.store.createPairing('owner tablet')
      // A normal unknown account is refused the owner's code.
      await expect(new TestDevice(t.hub, { 'x-test-peer': 'mallory@evil.example' }).pair(ownerCode)).rejects.toThrow(/403/)
      // Nor one whose login could not be read, nor tagged devices (they share one login).
      for (const peer of ['whois-failed', 'tagged-devices']) await expect(new TestDevice(t.hub, { 'x-test-peer': peer }).pair(ownerCode)).rejects.toThrow(/403/)
      expect(await t.hub.store.findPairing(ownerCode)).not.toBeNull()
    } finally {
      ;(t.hub as any).privateListener = saved
    }
  })
})
