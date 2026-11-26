// Waking a device that was showing a thread which moved on, as Discord does: the reader's view
// stays, only the newest page is fetched, and if it does not reach what was loaded a
// "Load more messages" bar marks the gap, loaded only on request. Opening a thread never gaps.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { LOGIN, pairedDevice, startTestHub, waitFor } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache)
  .filter(s => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .map(s => path.join(cache, s, 'chrome-linux64/chrome')).find(s => fs.existsSync(s)) : undefined)
const ready = Boolean(executablePath && fs.existsSync(path.join(webDir, 'index.html')))
// Evidence: GAP_SHOTS=<dir> GAP_SHOTS_PREFIX=before|after saves the woken view.
const shots = process.env['GAP_SHOTS']

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser
let n = 0

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

const DESKTOP = { width: 1584, height: 991 }
const PHONE = { width: 390, height: 844 }
const line = (label: string) => `${label}\nThe second line of ${label}.\nAnd a third line, so the thread runs several screens.`

async function thread(count: number) {
  const th = await demo.kimaki.threads.create({ name: `Woken thread ${++n}` })
  const sent = []
  for (let i = 0; i < count; i++) sent.push(await th.send(line(`Before ${i}`)))
  return { th, sent }
}
async function post(th: Awaited<ReturnType<typeof thread>>['th'], count: number, label: string) {
  const sent = []
  for (let i = 0; i < count; i++) sent.push(await th.send(line(`${label} ${i}`)))
  return sent
}

// A device whose event socket can be cut and held closed: the sleep.
async function device(viewport: { width: number; height: number }, channelId: string) {
  const name = `gap-${++n}`, owner = await pairedDevice(hub, name)
  const touch = viewport.width < 600
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, colorScheme: 'dark', reducedMotion: 'reduce', extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  const cookie = owner.cookie!, split = cookie.indexOf('=')
  await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const page = await ctx.newPage()
  page.setDefaultTimeout(10_000)
  let gate = Promise.resolve(), resume = () => {}, cut = async () => {}, connects = 0
  await page.routeWebSocket('**/client/events', async client => {
    await gate
    const server = client.connectToServer()
    cut = async () => { await Promise.all([client.close({ code: 1000 }), server.close({ code: 1000 })]) }
    server.onMessage(raw => {
      if (JSON.parse(String(raw)).t === 'HELLO') connects++
      client.send(raw)
    })
  })
  await page.goto(`${owner.origin}/#/c/${channelId}`)
  await page.locator('.chat-history .message').first().waitFor()
  await waitFor(() => connects > 0)
  await expect.poll(() => fromBottom(page)).toBeLessThan(4)
  const sleep = async () => {
    gate = new Promise<void>(r => { resume = r })
    await cut()
    await waitFor(() => !hub.events.connections().some(d => d.name === name))
  }
  const wake = async (newest: string) => {
    const before = connects
    resume()
    await waitFor(() => connects > before)
    await page.locator(`#m-${newest}`).waitFor({ state: 'attached' })
    await page.waitForTimeout(300)
  }
  return { page, sleep, wake, close: () => ctx.close() }
}

const fromBottom = (page: Page) => page.locator('.messages').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
const top = (page: Page, id: string) => page.locator(`#m-${id}`).evaluate(el => Math.round(el.getBoundingClientRect().top))
const scrollTo = (page: Page, id: string, block: ScrollLogicalPosition) => page.locator(`#m-${id}`).evaluate((el, block) => el.scrollIntoView({ block }), block)
const shot = async (page: Page, what: string) => {
  if (!shots) return
  const { width, height } = page.viewportSize()!
  await page.screenshot({ path: path.join(shots, `${process.env['GAP_SHOTS_PREFIX'] ?? 'after'}-${what}-${width}x${height}.png`) })
}

for (const viewport of [DESKTOP, PHONE]) {
  test.skipIf(!ready)(`${viewport.width}px: scrolled up, more than a page arrives while asleep: the view holds and a gap bar loads the rest`, async () => {
    const { th, sent } = await thread(60)
    const d = await device(viewport, th.id)
    const { page } = d
    try {
      // Read to the end, then back a little: the reader is somewhere in the middle.
      await scrollTo(page, sent[40]!.id, 'start')
      await expect.poll(() => fromBottom(page)).toBeGreaterThan(200)
      const held = await top(page, sent[40]!.id)
      await d.sleep()
      const away = await post(th, 70, 'Away')
      await d.wake(away.at(-1)!.id)
      await shot(page, 'scrolled')
      expect(Math.abs(await top(page, sent[40]!.id) - held)).toBeLessThanOrEqual(2)
      // Everything that was loaded is still there, then the gap, then the newest page.
      expect(await page.locator(`#m-${sent[10]!.id}`).count()).toBe(1)
      const bar = page.locator('.gap-bar')
      await expect.poll(() => bar.count()).toBe(1)
      expect(await bar.innerText()).toBe('Load more messages')
      expect(await page.locator(`#m-${away[0]!.id}`).count()).toBe(0)
      expect(await page.locator(`#m-${away[20]!.id}`).count()).toBe(1)
      expect(await bar.evaluate((el, id) => el.previousElementSibling?.querySelector(`#m-${id}`) !== null || el.previousElementSibling?.id === `m-${id}`, sent.at(-1)!.id)).toBe(true)
      // Unread across the gap: the count says there are more than are loaded.
      await scrollTo(page, away[30]!.id, 'start')
      await expect.poll(() => page.locator('.new-bar-jump').innerText()).toMatch(/^50\+ new messages since/)
      // Loading the gap keeps the bar's place: the message above it does not move.
      await bar.evaluate(el => el.scrollIntoView({ block: 'center' }))
      await page.waitForTimeout(100)
      await shot(page, 'bar')
      const above = await top(page, sent.at(-1)!.id)
      await bar.getByRole('button', { name: 'Load more messages' }).click()
      await expect.poll(() => bar.count()).toBe(0)
      expect(Math.abs(await top(page, sent.at(-1)!.id) - above)).toBeLessThanOrEqual(2)
      for (const m of away) expect(await page.locator(`#m-${m.id}`).count()).toBe(1)
      await scrollTo(page, away[30]!.id, 'start')
      await expect.poll(() => page.locator('.new-bar-jump').innerText()).toMatch(/^70 new messages since/)
    } finally { await d.close() }
  }, 120_000)

  test.skipIf(!ready)(`${viewport.width}px: at the bottom when it slept, the reader stays put and the jump control shows; opening the thread again has no gap`, async () => {
    const { th, sent } = await thread(55)
    const other = await thread(3)
    const d = await device(viewport, th.id)
    const { page } = d
    try {
      const held = await top(page, sent.at(-1)!.id)
      await d.sleep()
      const away = await post(th, 70, 'Away')
      await d.wake(away.at(-1)!.id)
      await shot(page, 'bottom')
      expect(Math.abs(await top(page, sent.at(-1)!.id) - held)).toBeLessThanOrEqual(2)
      await expect.poll(() => page.locator('.gap-bar').count()).toBe(1)
      expect(await fromBottom(page)).toBeGreaterThan(200)
      const jump = viewport === PHONE ? page.locator('.present-button') : page.locator('.present-bar')
      await expect.poll(() => jump.isVisible()).toBe(true)
      // Switching away and back: a fresh load from the newest, no gap.
      await page.evaluate(id => { location.hash = `#/c/${id}` }, other.th.id)
      await page.locator(`#m-${other.sent.at(-1)!.id}`).waitFor()
      await page.evaluate(id => { location.hash = `#/c/${id}` }, th.id)
      await page.locator(`#m-${away.at(-1)!.id}`).waitFor()
      await page.waitForTimeout(300)
      expect(await page.locator('.gap-bar').count()).toBe(0)
      // A hidden thread that moved on during a sleep opens fresh too.
      await page.evaluate(id => { location.hash = `#/c/${id}` }, other.th.id)
      await page.locator(`#m-${other.sent.at(-1)!.id}`).waitFor()
      await d.sleep()
      const later = await post(th, 70, 'Later')
      await d.wake(other.sent.at(-1)!.id)
      await page.evaluate(id => { location.hash = `#/c/${id}` }, th.id)
      await page.locator(`#m-${later.at(-1)!.id}`).waitFor()
      await page.waitForTimeout(300)
      expect(await page.locator('.gap-bar').count()).toBe(0)
    } finally { await d.close() }
  }, 120_000)
}

test.skipIf(!ready)('a page or less arrives while asleep: it joins the loaded messages with no gap, at the bottom or scrolled up', async () => {
  const { th, sent } = await thread(55)
  const d = await device(DESKTOP, th.id)
  const { page } = d
  try {
    await d.sleep()
    const few = await post(th, 5, 'Few')
    await d.wake(few.at(-1)!.id)
    expect(await page.locator('.gap-bar').count()).toBe(0)
    await expect.poll(() => fromBottom(page)).toBeLessThan(4)
    await scrollTo(page, sent[30]!.id, 'start')
    await expect.poll(() => fromBottom(page)).toBeGreaterThan(200)
    const held = await top(page, sent[30]!.id)
    await d.sleep()
    const more = await post(th, 20, 'More')
    await d.wake(more.at(-1)!.id)
    expect(await page.locator('.gap-bar').count()).toBe(0)
    expect(Math.abs(await top(page, sent[30]!.id) - held)).toBeLessThanOrEqual(2)
    // What was loaded before the newest page is kept.
    expect(await page.locator(`#m-${sent[10]!.id}`).count()).toBe(1)
  } finally { await d.close() }
}, 120_000)
