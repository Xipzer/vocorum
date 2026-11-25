// The built PWA in headless Chromium: what a long channel costs. Message
// toolbars exist only for the message under the pointer or focus, and history
// read far back is let go once no view shows the channel.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { LOGIN, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')

function findChromium(): string | undefined {
  if (process.env['PLAYWRIGHT_CHROMIUM']) return process.env['PLAYWRIGHT_CHROMIUM']
  const cache = path.join(os.homedir(), '.cache/ms-playwright')
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : []
  for (const dir of dirs) {
    const bin = path.join(cache, dir, 'chrome-linux64/chrome')
    if (fs.existsSync(bin)) return bin
  }
  return undefined
}

const executablePath = findChromium()
const ready = fs.existsSync(path.join(webDir, 'index.html')) && executablePath

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser
let page: Page
let origin: string

const shown = () => page.locator('.messages .message').count()
const scrollToTop = () => page.locator('.messages').evaluate((el) => (el.scrollTop = 0))

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  for (let i = 0; i < 260; i += 20) await Promise.all(Array.from({ length: 20 }, (_, k) => demo.kimaki.send(`history line ${i + k}`)))
  browser = await chromium.launch({ executablePath })
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  origin = `http://localhost:${hub.port}`
  await page.goto(origin)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing('chromium'))
  await page.getByText('Pair this device').click()
  await page.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).waitFor()
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!ready)('a message toolbar exists only under the pointer or focus', async () => {
  // The pointer stays where an earlier test left it, which can be over a message.
  await page.mouse.move(5, 5)
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const last = page.locator('.messages .message', { hasText: 'history line 259' })
  await last.waitFor()
  // Under load the first paint can land under the pointer before it moves: wait
  // until nothing is hovered or focused in the list, then expect no toolbar.
  await page.mouse.move(5, 5)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.messages :hover, .messages :focus').length)).toBe(0)
  await expect.poll(() => page.locator('.message-actions').count()).toBe(0)
  await last.hover()
  await last.locator('.message-actions').getByLabel('Reply').waitFor()
  expect(await page.locator('.message-actions').count()).toBe(1)
  await page.mouse.move(5, 5)
  await expect.poll(() => page.locator('.message-actions').count()).toBe(0)
  // Keyboard: a focused message shows its toolbar too.
  await last.focus()
  await last.locator('.message-actions').waitFor()
})

test.skipIf(!ready)('history read far back is let go when the channel is left', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await page.locator('.messages .message', { hasText: 'history line 259' }).waitFor()
  for (let i = 0; i < 8 && !(await page.locator('.message', { hasText: 'history line 0' }).count()); i++) {
    await scrollToTop()
    await page.waitForTimeout(400)
  }
  expect(await shown()).toBeGreaterThan(200)
  // Same page, so the store stays: only the route changes.
  await page.evaluate(() => (location.hash = '#/overview'))
  await page.waitForTimeout(300)
  await page.evaluate((id) => (location.hash = `#/c/${id}`), demo.kimaki.id)
  await page.locator('.messages .message', { hasText: 'history line 259' }).waitFor()
  const kept = await shown()
  expect(kept).toBeLessThanOrEqual(100)
  expect(kept).toBeGreaterThan(50)
  // Older pages load again on scroll.
  await scrollToTop()
  await expect.poll(shown).toBeGreaterThan(kept)
})
