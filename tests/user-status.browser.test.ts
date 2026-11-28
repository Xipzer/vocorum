// The status menu in the user panel, as Discord's: pick Do Not Disturb, set a custom status
// that clears after a while, and see both on yourself.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, type TestDevice } from './helpers.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).filter((s) => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))).map((s) => path.join(cache, s, 'chrome-linux64/chrome')).find((p) => fs.existsSync(p)) : undefined)
const check = test.skipIf(!executablePath || !fs.existsSync(path.join(webDir, 'index.html')))
let t: Awaited<ReturnType<typeof startTestHub>>
let browser: Browser
let owner: TestDevice

beforeAll(async () => {
  if (!executablePath || !fs.existsSync(path.join(webDir, 'index.html'))) return
  t = await startTestHub({ extensions: [] })
  await t.hub.stop()
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] })
  await t.hub.start()
  owner = await pairedDevice(t.hub, 'desktop')
  browser = await chromium.launch({ executablePath })
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await t?.cleanup()
})

check('the user panel menu sets Do Not Disturb and a custom status that clears itself', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } })
  const p = await context.newPage()
  p.setDefaultTimeout(6000)
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(owner.origin)
  await p.getByLabel('Pairing code').fill(await t.hub.store.createPairing('status browser', {}))
  await p.getByText('Pair this device', { exact: true }).click()
  await p.locator('.sidebar .channel').first().waitFor({ state: 'attached' })
  const panel = p.locator('.user-panel-me')

  await p.getByRole('button', { name: 'Settings', exact: true }).click()
  await p.getByRole('menuitemradio', { name: /Do Not Disturb/ }).click()
  await panel.getByText('Do Not Disturb', { exact: true }).waitFor()
  await expect.poll(() => panel.locator('.system-light').getAttribute('class')).toContain('dnd')
  await expect.poll(async () => (await owner.json('/client/me')).user_status.status).toBe('dnd')

  await p.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect.poll(() => p.getByRole('menuitemradio', { name: /Do Not Disturb/ }).getAttribute('aria-checked')).toBe('true')
  await p.getByRole('button', { name: 'Set Custom Status' }).click()
  const dialog = p.getByRole('dialog', { name: 'Set a custom status' })
  await dialog.getByRole('textbox').fill('Out for lunch')
  await dialog.getByRole('combobox').selectOption({ label: '30 minutes' })
  const before = Date.now()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await panel.getByText('Out for lunch').waitFor()
  const custom = (await owner.json('/client/me')).user_status.custom_status
  expect(custom.text).toBe('Out for lunch')
  expect(custom.expires_at).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000)
  expect(custom.expires_at).toBeLessThanOrEqual(Date.now() + 30 * 60_000)

  await p.getByRole('button', { name: 'Settings', exact: true }).click()
  await p.getByRole('button', { name: 'Clear Custom Status' }).click()
  await panel.getByText('Do Not Disturb', { exact: true }).waitFor()
  await expect.poll(async () => (await owner.json('/client/me')).user_status.custom_status).toBeNull()
  await context.close()
}, 60_000)
