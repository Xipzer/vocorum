// Open access on this computer (vocorum setup --open): a browser at
// http://localhost:<port> needs no certificate, code or passkey. It never
// applies to a request that came through a proxy or under another name, and a
// hub that was not set up this way keeps asking every browser to pair.

import http from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { LOGIN, startTestHub } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTestHub>>
let closed: Awaited<ReturnType<typeof startTestHub>>

// A request straight to the hub's port, with exactly these headers.
function call(hub: Hub, route: string, { method = 'GET', headers = {}, json }: { method?: string; headers?: Record<string, string>; json?: unknown } = {}) {
  return new Promise<{ status: number; body: any; cookie: string | null }>((resolve, reject) => {
    const body = json === undefined ? undefined : JSON.stringify(json)
    const req = http.request({ host: '127.0.0.1', port: hub.port, path: route, method, headers: { host: `localhost:${hub.port}`, ...(body && { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }), ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8').on('data', (chunk: string) => (text += chunk)).on('end', () => {
        let parsed: unknown = null
        try {
          parsed = text ? JSON.parse(text) : null
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? null })
      })
    })
    req.on('error', reject).end(body)
  })
}

beforeAll(async () => {
  t = await startTestHub({ tailscaleLogin: null })
  await t.hub.stop()
  t.config = initHub(t.paths, { localAccess: 'open' })
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir: `${t.paths.root}/web` })
  await t.hub.start()
  closed = await startTestHub()
})

afterAll(async () => {
  await t?.cleanup()
  await closed?.cleanup()
})

test('this computer signs in with no code or passkey, and sends a message', async () => {
  const origin = `http://localhost:${t.hub.port}`
  expect((await call(t.hub, '/')).status).toBe(200)
  expect((await call(t.hub, '/client/auth/status')).body).toMatchObject({ signedIn: false, open: true })
  expect((await call(t.hub, '/client/state')).status).toBe(401)
  const signIn = await call(t.hub, '/client/auth/local', { method: 'POST', headers: { origin }, json: {} })
  expect(signIn.status).toBe(200)
  expect(signIn.body.device.name).toBe('This computer')
  const cookie = signIn.cookie!
  expect(cookie.startsWith('hub_local_session=')).toBe(true)
  expect((await call(t.hub, '/client/auth/status', { headers: { cookie } })).body).toMatchObject({ signedIn: true, userId: t.config.ownerUserId })
  const state = await call(t.hub, '/client/state', { headers: { cookie } })
  expect(state.body.hub_owner).toBe(true)
  const general = state.body.channels.find((c: { name: string }) => c.name === 'general')
  const sent = await call(t.hub, `/client/channels/${general.id}/messages`, { method: 'POST', headers: { cookie, origin }, json: { content: 'first message' } })
  expect(sent.status).toBe(200)
  // Another browser on this computer is the same device, not a new one each time.
  const again = await call(t.hub, '/client/auth/local', { method: 'POST', headers: { origin }, json: {} })
  expect(again.body.device.id).toBe(signIn.body.device.id)
  expect((await t.hub.store.listDevices()).length).toBe(1)
})

test('open access never reaches past this computer: a proxy, a tunnel name or another site gets nothing', async () => {
  const origin = `http://localhost:${t.hub.port}`
  // What a reverse proxy or tailscale serve adds.
  const added: Array<Record<string, string>> = [{ 'x-forwarded-for': '100.64.0.9' }, { 'tailscale-user-login': LOGIN }, { forwarded: 'for=100.64.0.9' }, { via: '1.1 proxy' }, { 'x-real-ip': '100.64.0.9' }]
  for (const headers of added) {
    expect((await call(t.hub, '/client/auth/status', { headers })).status).toBe(403)
    expect((await call(t.hub, '/client/auth/local', { method: 'POST', headers: { origin, ...headers }, json: {} })).status).toBe(403)
  }
  // Reached under any other name (a forwarded port, a DNS name pointed at loopback).
  for (const host of [`127.0.0.1:${t.hub.port}`, `my-laptop.lan:${t.hub.port}`, `evil.example:${t.hub.port}`]) {
    expect((await call(t.hub, '/client/auth/status', { headers: { host } })).status).not.toBe(200)
    expect((await call(t.hub, '/client/auth/local', { method: 'POST', headers: { host, origin: `http://${host}` }, json: {} })).status).not.toBe(200)
  }
  // A page on another site cannot sign in for you.
  expect((await call(t.hub, '/client/auth/local', { method: 'POST', headers: { origin: 'https://evil.example' }, json: {} })).status).toBe(403)
  expect((await call(t.hub, '/client/auth/local', { method: 'POST', json: {} })).status).toBe(403)
})

test('a hub that was not set up as open keeps asking every browser to pair', async () => {
  const origin = `http://localhost:${closed.hub.port}`
  expect((await call(closed.hub, '/client/auth/status')).status).toBe(403)
  const viaProxy = await call(closed.hub, '/client/auth/status', { headers: { 'tailscale-user-login': LOGIN } })
  expect(viaProxy.body).toEqual({ signedIn: false, device: null, userId: null })
  expect((await call(closed.hub, '/client/auth/local', { method: 'POST', headers: { origin, 'tailscale-user-login': LOGIN }, json: {} })).status).toBe(403)
  expect((await closed.hub.store.listDevices()).length).toBe(0)
})

test('the local sign-in is worth nothing anywhere but on this computer', async () => {
  const origin = `http://localhost:${t.hub.port}`
  const { cookie } = await call(t.hub, '/client/auth/local', { method: 'POST', headers: { origin }, json: {} })
  expect((await call(t.hub, '/client/state', { headers: { cookie: cookie! } })).status).toBe(200)
  // The same cookie replayed through a proxy, or as if it were a paired device's cookie.
  expect((await call(t.hub, '/client/state', { headers: { cookie: cookie!, 'x-forwarded-for': '100.64.0.9' } })).status).toBe(403)
  const token = cookie!.split('=')[1]!
  expect((await call(closed.hub, '/client/state', { headers: { cookie: `hub_local_session=${token}`, 'tailscale-user-login': LOGIN } })).status).toBe(401)
  // Signing out ends it.
  expect((await call(t.hub, '/client/auth/logout', { method: 'POST', headers: { cookie: cookie!, origin }, json: {} })).status).toBe(200)
  expect((await call(t.hub, '/client/state', { headers: { cookie: cookie! } })).status).toBe(401)
})

test('turning open access off is refused while no device could reach the hub', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const cli = (args: string[]) => promisify(execFile)(process.execPath, ['bin/vocorum.js', ...args], { env: { ...process.env, VOCORUM_DIR: t.paths.root } }).then((r) => r.stdout, (e: { stderr: string }) => `refused: ${e.stderr}`)
  expect(await cli(['config', 'set', 'localAccess', 'off'])).toMatch(/refused: .*no browser could reach this hub/s)
  expect(await cli(['config', 'get', 'localAccess'])).toBe('open\n')
  expect(await cli(['config', 'set', 'localAccess', 'sometimes'])).toMatch(/refused: .*open .* or off/s)
})
