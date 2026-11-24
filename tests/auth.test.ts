import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { hubPaths } from '../src/config.ts'
import { Hub, assertLoopback } from '../src/hub.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub } from './helpers.ts'
import { sha256 } from '../src/store.ts'

let t: Awaited<ReturnType<typeof startTestHub>>

beforeAll(async () => {
  t = await startTestHub()
})
afterAll(async () => {
  await t.cleanup()
})

test('non-loopback bind is impossible', () => {
  expect(() => assertLoopback('0.0.0.0')).toThrow(/only binds loopback/)
  expect(() => assertLoopback('100.64.0.1')).toThrow(/only binds loopback/)
  expect(() => new Hub({ paths: t.paths, config: t.config, host: '0.0.0.0' })).toThrow(/only binds loopback/)
  expect(() => assertLoopback('127.0.0.1')).not.toThrow()
  void hubPaths
})

test('human routes need the Tailscale login header, then a device session', async () => {
  const status = async (headers: Record<string, string>, pathname = '/client/state') => (await fetch(`${t.hub.localUrl}${pathname}`, { headers })).status
  expect({
    noHeader: await status({}),
    wrongLogin: await status({ 'tailscale-user-login': 'mallory@example.com' }),
    shellNoHeader: await status({}, '/'),
    shellWithHeader: await status({ 'tailscale-user-login': LOGIN }, '/'),
    noSession: await status({ 'tailscale-user-login': LOGIN }),
    authStatus: await status({ 'tailscale-user-login': LOGIN }, '/client/auth/status'),
  }).toMatchInlineSnapshot(`
    {
      "authStatus": 200,
      "noHeader": 403,
      "noSession": 401,
      "shellNoHeader": 403,
      "shellWithHeader": 200,
      "wrongLogin": 403,
    }
  `)
})

test('a hub with no configured login rejects every human request', async () => {
  const other = await startTestHub({ tailscaleLogin: null })
  try {
    const response = await fetch(`${other.hub.localUrl}/client/auth/status`, { headers: { 'tailscale-user-login': LOGIN } })
    expect(response.status).toBe(403)
  } finally {
    await other.cleanup()
  }
})

test('enroll with a pairing code, log in with the passkey, revoke the device', async () => {
  const phone = new TestDevice(t.hub)
  const code = await t.hub.store.createPairing('phone')

  // Bad codes are rejected; the pairing code works once.
  await expect(phone.pair('WRONGCODE1')).rejects.toThrow(/403/)
  const enrolled = await phone.pair(code)
  expect(enrolled.device.name).toBe('phone')
  expect(phone.cookie).toMatch(/^__Host-hub_session=/)
  const state = await phone.json('/client/state')
  expect(state.guild.name).toBe('Home')

  const thief = new TestDevice(t.hub)
  await expect(thief.pair(code)).rejects.toThrow(/403/)

  // A fresh browser session on the same device signs in with the passkey.
  phone.cookie = null
  await phone.login()
  expect((await phone.fetch('/client/state')).status).toBe(200)

  // An unknown passkey cannot log in.
  await expect(thief.login()).rejects.toThrow(/403/)

  // Revoking kills sessions and the passkey.
  await t.hub.store.revokeDevice('phone')
  await t.hub.reload()
  expect((await phone.fetch('/client/state')).status).toBe(401)
  phone.cookie = null
  await expect(phone.login()).rejects.toThrow(/403/)
})

test('CSRF: mutations and the event socket need the hub origin', async () => {
  const device = await pairedDevice(t.hub, 'laptop')
  const channelId = (await device.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general').id
  const forged = await device.fetch(`/client/channels/${channelId}/messages`, { method: 'POST', json: { content: 'hi' }, headers: { origin: 'https://evil.example' } })
  expect(forged.status).toBe(403)
  const noOrigin = await fetch(`${t.hub.localUrl}/client/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'tailscale-user-login': LOGIN, cookie: device.cookie!, 'content-type': 'application/json' },
    body: '{"content":"hi"}',
  })
  expect(noOrigin.status).toBe(403)

  const open = (headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.hub.port}/client/events`, { headers })
      ws.on('message', (data) => {
        resolve(`open: ${JSON.parse(String(data)).t}`)
        ws.close()
      })
      ws.on('unexpected-response', (_req, res) => resolve(`rejected ${res.statusCode}`))
      ws.on('error', () => resolve('error'))
    })
  expect({
    ok: await open({ 'tailscale-user-login': LOGIN, origin: device.origin, cookie: device.cookie! }),
    badOrigin: await open({ 'tailscale-user-login': LOGIN, origin: 'https://evil.example', cookie: device.cookie! }),
    noSession: await open({ 'tailscale-user-login': LOGIN, origin: device.origin }),
    noHeader: await open({ origin: device.origin, cookie: device.cookie! }),
  }).toMatchInlineSnapshot(`
    {
      "badOrigin": "rejected 403",
      "noHeader": "rejected 403",
      "noSession": "rejected 401",
      "ok": "open: HELLO",
    }
  `)
})

test('admin reload only answers the local CLI token, never proxied requests', async () => {
  const fs = await import('node:fs')
  const token = fs.readFileSync(t.paths.adminToken, 'utf8').trim()
  const post = (headers: Record<string, string>) => fetch(`${t.hub.localUrl}/admin/reload`, { method: 'POST', headers }).then((r) => r.status)
  expect({
    noToken: await post({}),
    proxied: await post({ authorization: `Bearer ${token}`, 'tailscale-user-login': LOGIN }),
    local: await post({ authorization: `Bearer ${token}` }),
  }).toEqual({ noToken: 403, proxied: 403, local: 200 })
})

test('bot secrets are stored only as hashes, and old clear-text rows are migrated', async () => {
  const minted = await t.hub.store.addBot('hash-check')
  const stored = (await t.hub.store.db.execute({ sql: 'SELECT secret, secret_hash FROM bots WHERE machine = ?', args: ['hash-check'] })).rows[0]!
  expect(stored['secret']).toBe('')
  expect(stored['secret_hash']).toMatch(/^[0-9a-f]{64}$/)
  expect(stored['secret_hash']).not.toBe(minted.secret)

  // A row written by an older hub, with the secret in clear.
  await t.hub.store.db.execute({ sql: "INSERT INTO bots (machine, client_id, secret, secret_hash, created_at) VALUES ('legacy', 'legacy-id', 'legacy-secret', '', 0)", args: [] })
  await t.hub.store.migrate()
  const legacy = (await t.hub.store.db.execute("SELECT secret, secret_hash FROM bots WHERE machine = 'legacy'")).rows[0]!
  expect(legacy['secret']).toBe('')
  expect(legacy['secret_hash']).toBe(sha256('legacy-secret'))

  // The minted token still authenticates against the twin API.
  await t.hub.reload()
  const status = (token: string) => fetch(`${t.hub.localUrl}/api/v10/guilds/${t.config.guildId}`, { headers: { authorization: `Bot ${token}` } }).then((r) => r.status)
  expect(await status(`${minted.clientId}:${minted.secret}`)).toBe(200)
  expect(await status(`${minted.clientId}:${stored['secret_hash']}`)).toBe(401)
  expect(await status('legacy-id:legacy-secret')).toBe(200)
})

test('stopping the hub does not wait for open connections', async () => {
  const { startTestHub: start, pairedDevice: pair } = await import('./helpers.ts')
  const local = await start()
  const device = await pair(local.hub)
  const ws = new WebSocket(`ws://127.0.0.1:${local.hub.port}/client/events`, { headers: { origin: device.origin, cookie: device.cookie!, 'tailscale-user-login': LOGIN } })
  await new Promise((resolve) => ws.once('open', resolve))
  // A keep-alive connection with a request still being sent.
  const net = await import('node:net')
  const socket = net.connect(local.hub.port, '127.0.0.1')
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write('POST /client/read HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{')
  await new Promise((r) => setTimeout(r, 50))
  const started = Date.now()
  await local.cleanup()
  expect(Date.now() - started).toBeLessThan(2000)
  socket.destroy()
})

test('bots can be added to a hub created before secrets were hashed', async () => {
  const { HubStore } = await import('../src/store.ts')
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocorum-old-'))
  const store = new HubStore(`file:${dir}/hub.db`)
  // The bots table as the first hubs made it.
  await store.db.execute('CREATE TABLE bots (machine TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, secret TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)')
  await store.migrate()
  const bot = await store.addBot('homelab')
  expect(bot.secret).toMatch(/^[0-9a-f]{64}$/)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
