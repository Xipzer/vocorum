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

// Where, from the Page Up that starts a glide, the older page already on its way is handed
// over: with the key, with the glide's first scroll event (the reader still within a few px
// of the bottom), after so many frames, so far into the 580 ms, and after it ended.
type Landing = { on: 'key' | 'scroll' } | { frames: number } | { ms: number }
const LANDINGS: Landing[] = [{ on: 'key' }, { on: 'scroll' }, { frames: 1 }, { frames: 2 }, { frames: 3 }, { ms: 100 }, { ms: 290 }, { ms: 560 }, { ms: 800 }]

test.skipIf(!ready)('a page landing at any point of a Page Up glide moves the glide with it, and Page Down lands pinned at the bottom', async () => {
  const th = await demo.kimaki.threads.create({ name: 'Paging under load' })
  const sent = []
  for (let i = 0; i < 120; i++) sent.push(await th.send(`paging ${i}`))
  const owner = await pairedDevice(hub, 'glide')
  const ctx = await browser.newContext({ viewport: { width: 1584, height: 991 }, colorScheme: 'dark', extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  const cookie = owner.cookie!, split = cookie.indexOf('=')
  await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const page = await ctx.newPage()
  // The older page is fetched, then held in the page until the landing point after the next Page Up.
  await page.addInitScript(() => {
    const w = window as unknown as { landing?: Landing; fetched?: boolean; landed?: number }
    let release = () => {}
    const real = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const res = await real(input, init)
      // Only the first older page is held; any after it come as they are.
      if (!String(input instanceof Request ? input.url : input).includes('before=') || w.fetched) return res
      const body = await res.arrayBuffer()
      w.fetched = true
      await new Promise<void>(r => { release = () => { w.landed = performance.now() - key; r() } })
      return new Response(body, { status: res.status, headers: res.headers })
    }
    let key = 0
    window.addEventListener('keydown', e => {
      const l = w.landing
      if (e.key !== 'PageUp' || !l) return
      key = performance.now()
      if ('on' in l && l.on === 'key') return release()
      if ('on' in l) return document.addEventListener('scroll', () => release(), { capture: true, once: true })
      let n = 0
      const tick = (now: number) => ('frames' in l ? ++n >= l.frames : now - key >= l.ms) ? release() : requestAnimationFrame(tick)
      requestAnimationFrame(tick)
    }, true)
  })
  const list = page.locator('.chat-history')
  const gap = () => list.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
  const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const still = () => list.evaluate(el => new Promise<void>(r => {
    let last = el.scrollTop, n = 0
    const tick = () => { n = el.scrollTop === last ? n + 1 : 0; last = el.scrollTop; if (n > 20) r(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }))
  const mark = `m-${sent.at(-1)!.id}`
  const at = () => list.evaluate((el, id) => document.getElementById(id)!.getBoundingClientRect().top - el.getBoundingClientRect().top, mark)
  const box = page.locator('.composer textarea')
  try {
    for (const landing of LANDINGS) {
      const where = JSON.stringify(landing)
      await page.goto(`${owner.origin}/#/c/${th.id}`)
      await page.reload()
      await page.locator(`#${mark}`).waitFor()
      await expect.poll(gap).toBeLessThanOrEqual(1)
      await page.evaluate(l => { (window as { landing?: Landing }).landing = l }, landing)
      // Asked for from the bottom (a click would scroll the button into view first), then back
      // at the bottom, following it, while the page is still on its way.
      await list.getByLabel('Load earlier messages').evaluate(b => (b as HTMLButtonElement).click())
      await expect.poll(() => page.evaluate(() => (window as { fetched?: boolean }).fetched ?? false)).toBe(true)
      await list.evaluate(el => { el.scrollTop -= 40 })
      await frame()
      await list.evaluate(el => { el.scrollTop = el.scrollHeight })
      await frame()
      expect(await gap(), where).toBeLessThanOrEqual(1)
      await box.focus()
      const before = await at()
      const step = await list.evaluate(el => el.clientHeight * 0.875)
      const tall = await list.evaluate(el => el.scrollHeight)
      await box.press('PageUp')
      await expect.poll(() => list.evaluate(el => el.dataset.prepending ?? null), { message: where }).toBeNull()
      expect(await list.evaluate(el => el.scrollHeight), where).toBeGreaterThan(tall)
      await still()
      const landed = await page.evaluate(() => (window as { landed?: number }).landed)
      expect(landed, where).toBeGreaterThanOrEqual('ms' in landing ? landing.ms : 0)
      // One page up, measured in the content: the page above moved the scroll position, not the reader.
      expect(Math.abs((await at()) - before - step), where).toBeLessThanOrEqual(1)
      await box.press('PageDown')
      await still()
      expect(await gap(), where).toBeLessThanOrEqual(1)
      expect(Math.abs((await at()) - before), where).toBeLessThanOrEqual(1)
      // Pinned again: a new message keeps the bottom.
      const text = `paging after ${where}`
      await th.send(text)
      await page.locator('.message', { hasText: text }).waitFor()
      await expect.poll(gap, { message: where }).toBeLessThanOrEqual(1)
    }
  } finally { await ctx.close() }
}, 300_000)
