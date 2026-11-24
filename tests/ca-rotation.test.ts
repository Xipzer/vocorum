// Adding a name the CA may not sign makes a new CA, while the old certificate
// keeps serving devices that trust only the old CA (old names, and connections
// by address), until it is retired.

import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { startTestHub } from './helpers.ts'

const OLD = 'hub.home.arpa'
const NEW = 'desk.example.ts.net'
let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let oldCa: Buffer

async function startWith(names: string[]) {
  const config = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: 0, names, allowedCidrs: ['127.0.0.0/8'] } })
  hub = new Hub({ paths: t.paths, config, port: 0, webDir: `${t.paths.root}/web` })
  await hub.start()
}

// Resolves to the certificate's issuer check: true if the handshake validated.
function handshake(ca: Buffer, servername?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port: hub.privateListener!.port, path: '/setup/ok.svg', ca, ...(servername ? { servername, headers: { host: servername } } : {}) }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

beforeAll(async () => {
  t = await startTestHub()
  await t.hub.stop()
  await startWith([OLD])
  oldCa = fs.readFileSync(hub.privateListener!.files.caCert)
  await hub.stop()
  await startWith([NEW, OLD])
}, 60_000)

afterAll(async () => {
  await hub.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test('a new name gets a new CA; devices on the old CA keep working by old name and by address', async () => {
  const newCa = fs.readFileSync(hub.privateListener!.files.caCert)
  expect(newCa.equals(oldCa)).toBe(false)
  expect(new crypto.X509Certificate(fs.readFileSync(hub.privateListener!.files.cert)).subjectAltName).toBe(`DNS:${NEW}, DNS:${OLD}, IP Address:127.0.0.1`)
  expect({
    oldCaOldName: await handshake(oldCa, OLD),
    oldCaByAddress: await handshake(oldCa),
    newCaNewName: await handshake(newCa, NEW),
    oldCaNewName: await handshake(oldCa, NEW),
  }).toEqual({ oldCaOldName: true, oldCaByAddress: true, newCaNewName: true, oldCaNewName: false })
  // The enrolment page hands out the new CA; Tailscale names are not in the DNS profile.
  expect(certOf(await (await fetch(`http://127.0.0.1:${hub.privateListener!.httpPort}/vocorum-ca.crt`)).arrayBuffer()).equals(certOf(newCa))).toBe(true)
  expect(hub.privateListener!.zones).toEqual([OLD])
})

test('once retired, every name is served by the new CA', async () => {
  const files = hub.privateListener!.files
  const newCa = fs.readFileSync(files.caCert)
  await hub.stop()
  fs.renameSync(files.legacy.dir, `${files.legacy.dir}.retired`)
  await startWith([NEW, OLD])
  expect(fs.readFileSync(files.caCert).equals(newCa)).toBe(true)
  expect({ newCaOldName: await handshake(newCa, OLD), newCaByAddress: await handshake(newCa), oldCaOldName: await handshake(oldCa, OLD) }).toEqual({ newCaOldName: true, newCaByAddress: true, oldCaOldName: false })
})

function certOf(pemOrDer: ArrayBuffer | Buffer) {
  return Buffer.from(new crypto.X509Certificate(Buffer.from(pemOrDer as ArrayBuffer)).raw)
}
