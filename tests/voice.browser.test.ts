// Voice notes in the built PWA, with Chromium's fake microphone: click to
// record on desktop (Enter sends, Esc cancels) and hold to record on a touch
// phone. The demo bot answers voice notes. Screenshots go to $HUB_SCREENSHOTS.
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
const shots = process.env['HUB_SCREENSHOTS'] ?? path.join(os.tmpdir(), 'hub-screenshots')

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
let origin: string

async function pair(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await page.goto(origin)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing(`chromium-${Math.random()}`))
  await page.getByText('Pair this device').click()
  await page.locator('.channel').first().waitFor()
  return cdp
}

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  browser = await chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  origin = `http://localhost:${hub.port}`
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

const voiceNotes = (page: Page) => page.locator('.message .voice-message')

test.skipIf(!ready)('desktop: click the mic, see the timer and level, Enter sends; Esc cancels', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  await pair(page)
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const before = await voiceNotes(page).count()
  await page.getByRole('button', { name: 'Record a voice message' }).click()
  await page.locator('.recording-label').waitFor()
  await page.waitForTimeout(1500)
  await expect(page.locator('.recording-label .num').textContent()).resolves.toMatch(/^0:0[1-2]$/)
  await page.screenshot({ path: path.join(shots, 'voice-desktop-recording.png') })
  await page.keyboard.press('Enter')
  await expect.poll(() => voiceNotes(page).count(), { timeout: 10_000 }).toBe(before + 1)
  await page.locator('.message', { hasText: 'Got it: your voice message' }).last().waitFor()

  // Cancel: nothing is sent.
  await page.getByRole('button', { name: 'Record a voice message' }).click()
  await page.locator('.recording-label').waitFor()
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.locator('.recording-label').waitFor({ state: 'detached' })
  await page.waitForTimeout(800)
  await expect(voiceNotes(page).count()).resolves.toBe(before + 1)
  await context.close()
})

test.skipIf(!ready)('phone: hold the mic to record, release to send', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  const cdp = await pair(page)
  page.setDefaultTimeout(8000)
  // A fresh load on the thread: on phones the session list covers it otherwise.
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.reload()
  await page.locator('.message').last().waitFor()
  await page.waitForTimeout(600)
  const before = await voiceNotes(page).count()
  const box = (await page.getByRole('button', { name: 'Record a voice message' }).boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
  await page.locator('.recording-label').waitFor()
  await page.waitForTimeout(1500)
  // The mic stays on screen under the finger while recording.
  const held = (await page.getByRole('button', { name: 'Record a voice message' }).boundingBox())!
  expect(held.x + held.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: path.join(shots, 'voice-phone-recording.png') })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect.poll(() => voiceNotes(page).count(), { timeout: 10_000 }).toBe(before + 1)
  await context.close()
})
