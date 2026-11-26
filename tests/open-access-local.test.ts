// What the app is told about open access: a browser signed in by it learns so (signing out
// would only sign it in again), and the device list marks the row it shares. A paired
// device is told neither.

import http from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { pairedDevice, startTestHub } from './helpers.ts'

let open: Awaited<ReturnType<typeof startTestHub>>
let closed: Awaited<ReturnType<typeof startTestHub>>

function call(hub: Hub, route: string, { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: any; cookie: string | null }>((resolve, reject) => {
    const body = method === 'POST' ? '{}' : undefined
    const req = http.request({ host: '127.0.0.1', port: hub.port, path: route, method, headers: { host: `localhost:${hub.port}`, ...(body && { 'content-type': 'application/json', 'content-length': '2' }), ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8').on('data', (chunk: string) => (text += chunk)).on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? null }))
    })
    req.on('error', reject).end(body)
  })
}

beforeAll(async () => {
  open = await startTestHub({ tailscaleLogin: null })
  await open.hub.stop()
  open.config = initHub(open.paths, { localAccess: 'open' })
  open.hub = new Hub({ paths: open.paths, config: open.config, port: 0, webDir: `${open.paths.root}/web` })
  await open.hub.start()
  closed = await startTestHub()
})

afterAll(async () => {
  await open?.cleanup()
  await closed?.cleanup()
})

test('a browser signed in by open access is told so, and its device row is marked open', async () => {
  const origin = `http://localhost:${open.hub.port}`
  const { cookie, body } = await call(open.hub, '/client/auth/local', { method: 'POST', headers: { origin } })
  expect((await call(open.hub, '/client/auth/status', { headers: { cookie: cookie! } })).body).toMatchObject({ signedIn: true, local: true })
  const { devices } = (await call(open.hub, '/client/devices', { headers: { cookie: cookie! } })).body
  expect(devices).toEqual([expect.objectContaining({ id: body.device.id, current: true, open: true })])
})

test('a paired device is told neither', async () => {
  const phone = await pairedDevice(closed.hub)
  const status = await phone.json('/client/auth/status')
  expect(status.signedIn).toBe(true)
  expect(status).not.toHaveProperty('local')
  const { devices } = await phone.json('/client/devices')
  expect(devices.length).toBe(1)
  expect(devices[0]).not.toHaveProperty('open')
})
