// The PWA over the private listener in real browser engines: hub.home.arpa
// mapped to loopback, the hub's own CA trusted by key pin (Chromium) or
// certificate errors ignored (WebKit, which has no pin flag). Checks secure
// context, service worker, manifest and that WebAuthn accepts the home.arpa
// RP ID. Needs `pnpm build:web` and Playwright browsers.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
// WebKit drivers are tied to one browser build: pinned to the cached Playwright WebKit.
import { webkit } from 'playwright-webkit'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { startTestHub } from './helpers.ts'

const NAME = 'hub.home.arpa'
const webDir = path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
function newest(prefix: string, bin: string) {
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith(prefix)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop())) : []
  return dirs.map((d) => path.join(cache, d, bin)).find((p) => fs.existsSync(p))
}
const chromiumPath = process.env['PLAYWRIGHT_CHROMIUM'] ?? newest('chromium-', 'chrome-linux64/chrome')
const webkitPath = process.env['PLAYWRIGHT_WEBKIT'] ?? (fs.existsSync(path.join(cache, 'webkit-2248/pw_run.sh')) ? path.join(cache, 'webkit-2248/pw_run.sh') : undefined)
const ready = fs.existsSync(path.join(webDir, 'index.html'))

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let origin: string

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  const config = initHub(t.paths, { privateListener: { address: '127.0.0.1', port: 0, httpPort: null, names: [NAME], allowedCidrs: ['127.0.0.0/8'] } })
  hub = new Hub({ paths: t.paths, config, port: 0, webDir })
  await hub.start()
  origin = `https://${NAME}:${hub.privateListener!.port}`
}, 60_000)

afterAll(async () => {
  if (!ready) return
  await hub.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!ready || !chromiumPath)('Chromium: pair with a passkey on hub.home.arpa, service worker registers', async () => {
  const cert = new crypto.X509Certificate(fs.readFileSync(hub.privateListener!.files.cert))
  const spki = crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  const browser: Browser = await chromium.launch({ executablePath: chromiumPath, args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`] })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
    await page.goto(origin)
    expect(await page.evaluate('window.isSecureContext')).toBe(true)
    await page.getByPlaceholder('Pairing code').fill(await hub.store.createPairing('chromium'))
    await page.getByText('Pair this device').click()
    await page.locator('.composer textarea, textarea').first().waitFor({ timeout: 15_000 })
    const sw = await page.evaluate('navigator.serviceWorker.ready.then((r) => r.active && r.active.scriptURL)')
    expect(sw).toBe(`${origin}/sw.js`)
    expect((await hub.store.listDevices()).map((d) => d.name)).toContain('chromium')
  } finally {
    await browser.close()
  }
}, 60_000)

// WebKit has no host-resolver flag: a tiny CONNECT proxy maps the hub name to loopback.
function connectProxy(target: number): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.on('connect', (req, client: net.Socket, head) => {
      const [host, port] = (req.url ?? '').split(':')
      if (host !== NAME || Number(port) !== target) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      const upstream = net.connect(target, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => client.destroy())
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }))
  })
}

test.skipIf(!ready || !webkitPath)('WebKit (Safari engine): secure context, manifest, and WebAuthn accepts the home.arpa RP ID', async (ctx) => {
  const proxy = await connectProxy(hub.privateListener!.port)
  const browser = await webkit.launch({ executablePath: webkitPath, proxy: { server: `http://127.0.0.1:${proxy.port}` } })
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    const loaded = await page.goto(origin).catch((error: Error) => error)
    // Linux WebKit builds need glib-networking for TLS; without it this cannot run here.
    if (loaded instanceof Error && /TLS support is not available/.test(loaded.message)) return ctx.skip()
    if (loaded instanceof Error) throw loaded
    await page.getByText('Pair this device').waitFor()
    // In-page code as a string: the test project does not type-check against the DOM.
    const result = (await page.evaluate(`(async (rpId) => {
      const out = { secure: window.isSecureContext, webauthn: typeof PublicKeyCredential === 'function', manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href') }
      const create = (id) => navigator.credentials
        .create({ publicKey: { challenge: new Uint8Array(32), rp: { id, name: 'x' }, user: { id: new Uint8Array(8), name: 'x', displayName: 'x' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 1500 } })
        .then(() => 'created', (error) => error.name)
      out.hubRpId = await create(rpId)
      out.foreignRpId = await create('example.com')
      return out
    })(${JSON.stringify(NAME)})`)) as Record<string, unknown>
    expect(result.secure).toBe(true)
    expect(result.webauthn).toBe(true)
    expect(result.manifest).toBe('/manifest.webmanifest')
    // A foreign RP ID is a SecurityError; ours gets past the RP ID check (no
    // authenticator is attached in a headless engine, so it ends differently).
    expect(result.foreignRpId).toBe('SecurityError')
    expect(result.hubRpId).not.toBe('SecurityError')
  } finally {
    await browser.close()
    proxy.close()
  }
}, 60_000)
