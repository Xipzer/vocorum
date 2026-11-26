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
const scrollToTop = () => page.getByRole('button', { name: 'Load earlier messages' }).click()

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

test.skipIf(!ready)('click one message, hover another, then leave: just one toolbar and no sticky mouse focus', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const a = page.locator('.message').filter({ has: page.getByText('history line 255', { exact: true }) })
  const b = page.locator('.message').filter({ has: page.getByText('history line 257', { exact: true }) })
  const bars = page.getByRole('toolbar', { name: 'Message actions' })
  await a.getByText('history line 255', { exact: true }).click()
  expect(await a.evaluate((el) => el === document.activeElement)).toBe(true)
  await b.getByText('history line 257', { exact: true }).hover()
  await b.getByRole('toolbar').waitFor()
  expect(await bars.count()).toBe(1)
  await page.mouse.move(5, 5)
  await expect.poll(() => bars.count()).toBe(0)
  // A key on the still-focused message moves to its neighbour and exposes its actions.
  await page.keyboard.press('ArrowDown')
  await bars.waitFor()
  await page.keyboard.press('Tab')
  expect(await bars.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await b.hover()
  await b.getByRole('button', { name: 'More', exact: true }).click()
  await page.mouse.move(5, 5)
  await page.getByRole('menuitem', { name: 'Reply', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel reply' }).click()
})

test.skipIf(!ready)('history stays quiet on open and preserves the reader when older messages arrive', async () => {
  const p = await page.context().newPage()
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let older = 0
  try {
    await p.route('**/client/channels/*/messages?**', async (r) => {
      if (new URL(r.request().url()).searchParams.has('before')) { older++; await gate }
      await r.continue()
    })
    await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
    await p.getByText('history line 259').waitFor()
    const log = p.locator('.chat-history')
    const rows = log.locator('.message[id]')
    const count = await rows.count()
    expect(count).toBe(50)
    await log.evaluate((el) => { el.scrollTop = 74 })
    await p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    expect(older).toBe(0)
    expect(await log.getAttribute('data-scrolling')).toBeNull()
    const box = (await log.boundingBox())!
    await p.mouse.move(box.x + 120, box.y + 140)
    await p.mouse.wheel(0, -10)
    await expect.poll(() => older).toBe(1)
    await p.getByRole('status', { name: 'Loading earlier messages' }).waitFor()
    // The user moves a little more while the request is outstanding. Not the oldest row:
    // its author header goes when the page above joins its group, and its text holds instead.
    const anchor = await log.evaluate((el) => {
      el.scrollTop = 41
      const top = el.getBoundingClientRect().top
      const row = [...el.querySelectorAll('.message[id]')].slice(1).find((n) => n.getBoundingClientRect().top >= top)!
      return { id: row.id, y: row.getBoundingClientRect().top }
    })
    release()
    await expect.poll(() => rows.count()).toBeGreaterThan(count)
    expect(Math.abs((await p.locator(`#${anchor.id}`).boundingBox())!.y - anchor.y)).toBeLessThan(2)
    expect(older).toBe(1)
    await expect.poll(() => log.getAttribute('data-scrolling')).toBeNull()
  } finally { release(); await p.close() }
})

test.skipIf(!ready)('older history is asked for a screen or more before the top, and never while the scroll bar is held', async () => {
  const p = await page.context().newPage()
  let older = 0
  try {
    await p.route('**/client/channels/*/messages?**', async (r) => {
      if (new URL(r.request().url()).searchParams.has('before')) older++
      await r.continue()
    })
    await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
    await p.getByText('history line 259').waitFor()
    const log = p.locator('.chat-history')
    const box = (await log.boundingBox())!
    // Held on the scroll bar and dragged to the very top: the list stays as it is.
    await log.evaluate((el) => { el.scrollTop = el.clientHeight * 1.5 })
    await p.mouse.move(box.x + box.width - 4, box.y + 200)
    await p.mouse.down()
    await log.evaluate((el) => { el.scrollTop = 0 })
    await p.waitForTimeout(300)
    expect(older).toBe(0)
    expect(await log.locator('.message[id]').count()).toBe(50)
    // Let go near the top: now the page comes in.
    await p.mouse.up()
    await expect.poll(() => older).toBe(1)
    await expect.poll(() => log.locator('.message[id]').count()).toBe(100)
    // A wheel turn upward a screen and a half below the top already asks for the next page.
    await log.evaluate((el) => { el.scrollTop = el.clientHeight * 1.5 })
    await p.mouse.move(box.x + 120, box.y + 140)
    await p.mouse.wheel(0, -10)
    await expect.poll(() => older).toBe(2)
  } finally { await p.close() }
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
