// Older history at the top, as in Discord: only the reader moves the view. When the
// older page lands above, what was on screen stays exactly where it was, even when the
// oldest loaded message joins the group above it and loses its author header.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { LOGIN, pairedDevice, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache)
  .filter(s => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .map(s => path.join(cache, s, 'chrome-linux64/chrome')).find(s => fs.existsSync(s)) : undefined)
const ready = Boolean(executablePath && fs.existsSync(path.join(webDir, 'index.html')))

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  browser = await chromium.launch({ executablePath })
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!ready)('wheeling to the top loads older history without moving what is on screen', async () => {
  const th = await demo.kimaki.threads.create({ name: 'Long history' })
  const sent = []
  for (let i = 0; i < 120; i++) sent.push(await th.send(`history ${i}`))
  const owner = await pairedDevice(hub, 'paging')
  const ctx = await browser.newContext({ viewport: { width: 1584, height: 991 }, colorScheme: 'dark', extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  const cookie = owner.cookie!, split = cookie.indexOf('=')
  await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const page = await ctx.newPage()
  try {
    let release = () => {}
    const held = new Promise<void>(r => { release = r })
    await page.route(/\/messages\?.*before=/, async route => { await held; await route.continue() })
    await page.goto(`${owner.origin}/#/c/${th.id}`)
    await page.locator(`#m-${sent.at(-1)!.id}`).waitFor()
    const list = page.locator('.chat-history')
    const box = (await list.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 60 && await list.evaluate(el => el.scrollTop) > 0; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(30) }
    // Discord's grey skeleton rows stand above the oldest message while the page loads.
    const skeleton = page.getByRole('status', { name: 'Loading earlier messages' })
    await skeleton.waitFor()
    expect(await skeleton.locator('.skeleton-avatar').count()).toBeGreaterThan(0)
    const oldest = await page.locator('.chat-history [id^="m-"]').first().getAttribute('id')
    // Every loaded message below the oldest, where it sits on screen.
    const ids = await list.evaluate((el, oldest) => [...el.querySelectorAll('[id^="m-"]')].map(n => n.id).filter(id => id !== oldest).slice(0, 8), oldest)
    const where = () => list.evaluate((el, ids) => ids.map(id => Math.round(document.getElementById(id)!.getBoundingClientRect().top - el.getBoundingClientRect().top)), ids)
    const before = await where()
    const headed = await page.locator(`#${oldest} .message-head`).count()
    const loaded = await list.locator('[id^="m-"]').count()
    release()
    // The reader may still be near the top, so a further page can follow: either way, nothing moves.
    await expect.poll(() => list.locator('[id^="m-"]').count()).toBeGreaterThan(loaded)
    await expect.poll(() => list.evaluate(el => el.dataset.prepending ?? null)).toBeNull()
    await expect.poll(() => list.locator('.history-skeleton').count()).toBe(0)
    await page.waitForTimeout(300)
    // The oldest message did group with the page above it, so its header went.
    expect(headed).toBeGreaterThan(0)
    expect(await page.locator(`#${oldest} .message-head`).count()).toBe(0)
    expect(await where()).toEqual(before)
  } finally { await ctx.close() }
}, 120_000)
