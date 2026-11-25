// The built PWA in headless Chromium: Discord's keyboard shortcuts for panels,
// the message list and the message box.
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


beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  for (let i = 0; i < 5; i++) await demo.kimaki.send(`keys line ${i}`)
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

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const open = async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await page.locator('.messages .message', { hasText: 'keys line 4' }).waitFor()
}
const panel = (title: string) => page.locator('.side-panel .panel-head', { hasText: title })

test.skipIf(!ready)('Ctrl+P, Ctrl+U and Ctrl+I open and close their panels', async () => {
  await open()
  await page.locator('.messages').focus()
  await page.keyboard.press(`${mod}+p`)
  await panel('Pinned messages').waitFor()
  await page.keyboard.press(`${mod}+p`)
  await panel('Pinned messages').waitFor({ state: 'detached' })
  await page.keyboard.press(`${mod}+u`)
  await panel('Members').waitFor()
  await page.keyboard.press(`${mod}+u`)
  await panel('Members').waitFor({ state: 'detached' })
  await page.keyboard.press(`${mod}+i`)
  await page.locator('.side-panel').waitFor()
  await page.keyboard.press(`${mod}+i`)
  await page.locator('.side-panel').waitFor({ state: 'detached' })
  // In the message box Ctrl+U stays underline: no panel.
  await page.locator('.composer textarea').focus()
  await page.keyboard.press(`${mod}+u`)
  await page.waitForTimeout(200)
  expect(await panel('Members').count()).toBe(0)
})

test.skipIf(!ready)('arrows pick messages, Esc returns to the message box, R replies', async () => {
  await open()
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '')
  await page.locator('.messages').focus()
  await page.keyboard.press('ArrowUp')
  await expect.poll(focused).toContain('keys line 4')
  await page.locator('.message:focus .message-actions').waitFor()
  await page.keyboard.press('ArrowUp')
  await expect.poll(focused).toContain('keys line 3')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
  await page.locator('.messages').focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('r')
  await page.getByText('Replying to').waitFor()
})

test.skipIf(!ready)('typing anywhere goes to the message box', async () => {
  await open()
  await page.locator('.chat-header').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.type('hello')
  await expect.poll(() => page.locator('.composer textarea').inputValue()).toContain('hello')
})
