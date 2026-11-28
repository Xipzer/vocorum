// The private listener also answers on this computer's loopback, at the same ports, so a
// Vocorum app on the hub's own computer (or the Windows side of a hub in WSL) needs no
// network. It still needs a paired device, and open access never applies there.

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { startTestHub } from './helpers.ts'

const NAME = 'hub.home.arpa'
// macOS has only 127.0.0.1 on its loopback, so there is no second address to stand in.
const linux = process.platform === 'linux'
let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let ca: Buffer

beforeAll(async () => {
  if (!linux) return
  t = await startTestHub()
  await t.hub.stop()
  // The private address stands in as 127.0.0.2, allowing only itself.
  const config = initHub(t.paths, { localAccess: 'open', privateListener: { address: '127.0.0.2', port: 0, httpPort: 0, names: [NAME], allowedCidrs: ['127.0.0.2/32'] } })
  hub = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  await hub.start()
  ca = fs.readFileSync(hub.privateListener!.files.caCert)
}, 60_000)

afterAll(async () => {
  if (!linux) return
  await hub.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

function get(host: string, pathname: string, { localAddress }: { localAddress?: string } = {}) {
  const port = hub.privateListener!.port
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request({ host, port, path: pathname, ca, servername: NAME, headers: { host: `${NAME}:${port}` }, ...(localAddress && { localAddress }) }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test.skipIf(!linux)('an app on this computer reaches the private listener on loopback, with the same certificate', async () => {
  expect((await get('127.0.0.1', '/setup/ok.svg')).status).toBe(200)
  // The private address itself still answers only its allowed network.
  expect((await get('127.0.0.2', '/setup/ok.svg', { localAddress: '127.0.0.2' })).status).toBe(200)
  await expect(get('127.0.0.2', '/setup/ok.svg', { localAddress: '127.0.0.3' })).rejects.toThrow()
})

test.skipIf(!linux)('loopback on the private listener is not open access: a device must still be paired', async () => {
  const status = JSON.parse((await get('127.0.0.1', '/client/auth/status')).body)
  expect(status).toMatchObject({ signedIn: false })
  expect(status.open).not.toBe(true)
  expect((await get('127.0.0.1', '/client/state')).status).toBe(401)
})

test.skipIf(!linux)('the enrolment page answers on loopback too, for the app to fetch the CA', async () => {
  const port = hub.privateListener!.httpPort!
  const fetchCa = (host: string, localAddress?: string) =>
    new Promise<number>((resolve, reject) => http.get({ host, port, path: '/vocorum-ca.crt', ...(localAddress && { localAddress }) }, (r) => (r.resume(), resolve(r.statusCode ?? 0))).on('error', reject))
  expect([await fetchCa('127.0.0.2', '127.0.0.2'), await fetchCa('127.0.0.1')]).toEqual([200, 200])
})
