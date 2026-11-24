// The built PWA in headless Chromium: pair with a (virtual) passkey, read a
// Kimaki-shaped thread, chat, answer a modal, run a slash command with
// autocomplete, then the phone layout. Screenshots go to $HUB_SCREENSHOTS.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
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
let context: BrowserContext
let page: Page

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  // Same state, but serving the real PWA build.
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  browser = await chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', deviceScaleFactor: 1 })
  page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
}, 60_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!ready)('pair, chat, modal, slash command, phone layout, passkey sign-in', async () => {
  const origin = `http://localhost:${hub.port}`
  await page.goto(origin)
  await page.getByText('Sign in with passkey').waitFor()
  await page.screenshot({ path: path.join(shots, '1-login.png') })

  const code = await hub.store.createPairing('chromium')
  await page.getByLabel('Pairing code').fill(code)
  await page.getByText('Pair this device').click()
  // A session is waiting for the owner, so the app opens on the Overview.
  await page.getByRole('heading', { name: /Needs you/ }).waitFor()
  await page.screenshot({ path: path.join(shots, '2a-overview.png') })

  await page.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).click()
  await page.getByText('Found it').waitFor()
  await expect.poll(() => page.getByText('Reconnecting…').count()).toBe(0)
  await page.screenshot({ path: path.join(shots, '2-thread.png') })

  // Chat: the bot types, then answers.
  const box = page.getByPlaceholder('Message Fix footer on short turns')
  await box.fill('Also check the **archive** path')
  await box.press('Enter')
  await page.getByText('Got it: Also check the').waitFor()

  // A button that opens a modal.
  await page.getByRole('button', { name: 'Other…' }).click()
  await page.getByRole('heading', { name: 'Your answer' }).waitFor()
  await page.locator('.modal textarea').fill('Use rebase, keep history linear')
  await page.screenshot({ path: path.join(shots, '3-modal.png') })
  await page.getByRole('button', { name: 'Submit' }).click()
  await page.getByText('You answered: Use rebase, keep history linear').waitFor()

  // A select.
  await page.getByText('Pick a strategy').click()
  await page.getByRole('button', { name: /Squash/ }).click()
  await page.getByText('answered: squash').waitFor()

  // Slash command with autocomplete.
  await box.fill('/mo')
  await page.locator('.slash-item').first().waitFor()
  await page.screenshot({ path: path.join(shots, '4-slash-menu.png') })
  await box.press('Enter')
  // Discord's inline command line: the option is a field after the command chip.
  const option = page.locator('.slash-arg input').first()
  await option.click()
  await option.fill('son')
  await page.locator('.palette .slash-item', { hasText: 'claude-sonnet-5' }).click()
  await page.screenshot({ path: path.join(shots, '4b-slash-inline.png') })
  await page.getByRole('button', { name: 'Run command' }).click()
  await page.getByText('Model set to').waitFor()
  await page.screenshot({ path: path.join(shots, '5-after-commands.png') })

  // Phone layout in the same session.
  const phone = await context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(`${origin}/#/c/${demo.thread.id}`)
  await phone.getByText('Found it').waitFor()
  await phone.screenshot({ path: path.join(shots, '6-phone-thread.png') })
  await phone.getByRole('button', { name: 'Channels' }).click()
  await phone.locator('.sidebar.open').waitFor()
  await phone.waitForTimeout(300)
  await phone.screenshot({ path: path.join(shots, '7-phone-drawer.png') })
  await phone.close()

  // Sign out, then sign back in with the passkey.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByText('Sign in with passkey').click()
  await page.getByText('Fix footer on short turns').first().waitFor()
  expect((await hub.store.listDevices()).map((d) => d.name)).toEqual(['chromium'])
}, 120_000)
