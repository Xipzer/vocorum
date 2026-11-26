// The built PWA in headless Chromium: activity elsewhere in the workspace must not make the
// open chat read its message text again, and a renamed thread must still update its mentions.
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
  browser = await chromium.launch({ executablePath })
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  page = await context.newPage()
  // Count every emoji scan of message text (each one is a block reading its text again) and
  // every redraw of a bot's message row (each one looks its text over for request links).
  await page.addInitScript(() => {
    const scans = { count: 0, rows: 0 }
    Object.assign(window, { emojiScans: scans })
    const matchAll = RegExp.prototype[Symbol.matchAll]
    Object.defineProperty(RegExp.prototype, Symbol.matchAll, {
      configurable: true,
      value(this: RegExp, text: string) {
        if (/RGI_Emoji|Emoji_Presentation/.test(this.source)) scans.count++
        else if (this.source.includes('requests')) scans.rows++
        return matchAll.call(this, text)
      },
    })
  })
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

const scans = () => page.evaluate(() => (window as unknown as { emojiScans: { count: number } }).emojiScans.count)
const rowDraws = () => page.evaluate(() => (window as unknown as { emojiScans: { rows: number } }).emojiScans.rows)

test.skipIf(!ready)('a message or presence change elsewhere does not make the open chat read its text again; a rename still updates mentions', async () => {
  const named = await demo.kimaki.threads.create({ name: 'Before the rename' })
  // Prose as agents write it: dashes, arrows, quotes and emoji, so no plain-text shortcut applies.
  for (let i = 0; i < 20; i++) await demo.kimaki.send(`Line ${i} — the gate passed → “done” ✅ and **bold** text in \`src/app.ts\`.`)
  await demo.kimaki.send(`Read <#${named.id}> next — it’s the follow-up.`)
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await page.locator('.messages .message', { hasText: 'Line 19' }).waitFor()
  const chip = page.locator('.messages .channel-chip', { hasText: 'Before the rename' })
  await chip.waitFor()
  await page.waitForTimeout(600)
  const opened = await scans()
  expect(opened).toBeGreaterThan(20)

  // Three messages in another channel and one presence change: the sidebar marks the channel
  // unread, the open chat's text is untouched.
  for (let i = 0; i < 3; i++) await demo.website.send(`Elsewhere ${i} — unrelated ✅`)
  await page.locator('.sidebar .channel.unread', { hasText: 'website' }).waitFor()
  demo.bot.user!.setPresence({ activities: [{ name: 'Working in 2 threads', type: 4, state: 'Working in 2 threads' }], status: 'online' })
  await page.waitForTimeout(600)
  expect((await scans()) - opened).toBe(0)

  // A name the text resolves did change: the mention follows it.
  await named.setName('After the rename')
  await page.locator('.messages .channel-chip', { hasText: 'After the rename' }).waitFor()
  await expect.poll(() => chip.count()).toBe(0)
}, 60_000)

test.skipIf(!ready)('an agent typing in the open chat shows who is working without redrawing the messages', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await page.locator('.messages .message', { hasText: 'Line 19' }).waitFor()
  // Park the pointer outside the list: when the typing line takes space, rows move under a still
  // pointer and the hovered row (with its toolbar) changes, which is a correct redraw of two rows.
  await page.mouse.move(2, 2)
  await page.waitForTimeout(600)
  const before = await rowDraws()
  expect(before).toBeGreaterThan(20)
  // Typing arrives every few seconds while an agent works; the indicator outlives each by 10 s.
  for (let i = 0; i < 3; i++) {
    await demo.kimaki.sendTyping()
    await page.waitForTimeout(700)
  }
  await page.locator('.footer-line', { hasText: 'is working' }).waitFor()
  await page.locator('.chat-header .chat-sub', { hasText: 'is working' }).waitFor()
  await page.waitForTimeout(1500)
  expect((await rowDraws()) - before).toBe(0)
  // It goes away by itself once the last typing notice has expired.
  await page.locator('.footer-line', { hasText: 'is working' }).waitFor({ state: 'detached', timeout: 15_000 })
  expect((await rowDraws()) - before).toBe(0)
}, 60_000)

test.skipIf(!ready)('a new message redraws only its own row; one elsewhere redraws none', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await page.locator('.messages .message', { hasText: 'Line 19' }).waitFor()
  await page.waitForTimeout(600)
  let before = await rowDraws()
  for (let i = 0; i < 3; i++) await demo.website.send(`Somewhere else ${i} — ✅`)
  await page.locator('.sidebar .channel.unread', { hasText: 'website' }).waitFor()
  await page.waitForTimeout(600)
  expect((await rowDraws()) - before).toBe(0)
  before = await rowDraws()
  await demo.kimaki.send('A new line here — ✅')
  await page.locator('.messages .message', { hasText: 'A new line here' }).waitFor()
  await page.waitForTimeout(600)
  // A few rows at the end (the new one, its neighbour as they group), never the whole chat:
  // before rows were memoised this was every row in the chat for every message anywhere.
  expect((await rowDraws()) - before).toBeLessThanOrEqual(3)
}, 60_000)

test.skipIf(!ready)('a message in the open thread, read as it lands, never shows its row as unread', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.locator('.messages .message').last().waitFor()
  await page.waitForTimeout(600)
  // Record every class the open thread's row takes, from the first DOM change on.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('.sidebar .channel')].find((r) => r.textContent?.includes('Fix footer on short turns'))!
    const seen: string[] = []
    Object.assign(window, { rowClasses: seen })
    new MutationObserver(() => seen.push(row.className)).observe(row, { attributes: true, attributeFilter: ['class'] })
  })
  for (let i = 0; i < 3; i++) {
    await demo.thread.send(`Read as it lands ${i}`)
    await page.locator('.messages .message', { hasText: `Read as it lands ${i}` }).waitFor()
  }
  await page.waitForTimeout(600)
  const classes = await page.evaluate(() => (window as unknown as { rowClasses: string[] }).rowClasses)
  expect(classes.filter((c) => /\bunread\b/.test(c))).toEqual([])
}, 60_000)
