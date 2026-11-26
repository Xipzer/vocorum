// Getting back to the newest message. Touch screens get Discord iOS's square button over the
// composer's right edge; a fine pointer keeps the "You're viewing older messages" bar.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
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
let owner: Awaited<ReturnType<typeof pairedDevice>>
let browser: Browser
let thread: string
let channel = 0

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  owner = await pairedDevice(hub, 'jump')
  const long = await demo.kimaki.threads.create({ name: 'A long thread to scroll back through' })
  for (let i = 0; i < 40; i++) await long.send(`Entry ${i}\nThe second line of entry ${i}.\nAnd a third line, so the thread runs several screens.`)
  thread = long.id
  browser = await chromium.launch({ executablePath })
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

async function open(viewport: { width: number; height: number }, touch: boolean, channelId: string) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, colorScheme: 'dark', reducedMotion: 'reduce', extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  const cookie = owner.cookie!, split = cookie.indexOf('=')
  await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const page = await ctx.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(`${owner.origin}/#/c/${channelId}`)
  await page.locator('.chat-history .message').first().waitFor()
  return page
}
// A channel read up to its third message, then 26 more: "26 new messages since <the fourth's time>".
async function unreadChannel() {
  const ch = await demo.kimaki.guild.channels.create({ name: `catch-up-${channel++}`, parent: demo.kimaki.parentId })
  const sent = []
  for (let i = 0; i < 29; i++) sent.push(await ch.send(`Reading ${i}\nA second line for reading ${i}.\nA third line, so the new ones run past a screen.`))
  await owner.json('/client/read', { method: 'PUT', json: { read: { [ch.id]: sent[2]!.id } } })
  return { id: ch.id, first: sent[3]!, last: sent.at(-1)! }
}
const readTo = async (id: string) => (await hub.store.readState(t.config.ownerUserId))[id]
const scrollDown = (page: Page) => page.locator('.messages').evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
const scrollUp = (page: Page) => page.locator('.messages').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
const fromBottom = (page: Page) => page.locator('.messages').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)

test.skipIf(!ready)('touch: a square button over the composer\'s right edge takes you back to the newest message', async () => {
  const page = await open({ width: 390, height: 844 }, true, thread)
  await expect.poll(() => fromBottom(page)).toBeLessThan(4)
  await expect.poll(() => page.locator('.present-button').count()).toBe(0)
  await scrollUp(page)
  const button = page.getByRole('button', { name: 'Jump to present' })
  await button.waitFor()
  await expect.poll(() => button.count()).toBe(1)
  expect(await page.locator('.present-bar').isVisible()).toBe(false)
  const box = (await button.boundingBox())!
  const composer = (await page.locator('.composer').boundingBox())!
  const footer = (await page.locator('.footer').boundingBox())!
  const look = await button.evaluate(el => {
    const s = getComputedStyle(el), f = getComputedStyle(document.querySelector('.footer')!)
    return { radius: s.borderTopLeftRadius, border: s.borderTopWidth, fill: s.backgroundColor, footerFill: f.backgroundColor, text: (el as HTMLElement).innerText }
  })
  expect([box.width, box.height]).toEqual([36, 36])
  expect(look).toMatchObject({ radius: '7px', border: '1px', text: '' })
  expect(look.fill).toBe(look.footerFill)
  expect(box.x + box.width).toBe(composer.x + composer.width)
  // 8px above the footer, so it never sits over the composer or the typing line inside it.
  expect(footer.y - (box.y + box.height)).toBe(8)

  await button.tap()
  await expect.poll(() => fromBottom(page)).toBeLessThan(4)
  await expect.poll(() => page.locator('.present-button').count()).toBe(0)
  await page.context().close()
})

test.skipIf(!ready)('desktop: the older-messages bar stays', async () => {
  const page = await open({ width: 1584, height: 991 }, false, thread)
  await scrollUp(page)
  await page.locator('.present-bar').waitFor()
  expect(await page.locator('.present-button').isVisible()).toBe(false)
  await expect.poll(() => page.getByRole('button', { name: 'Jump to present' }).count()).toBe(1)
  await page.locator('.present-bar').getByRole('button', { name: 'Jump to present' }).click()
  await expect.poll(() => fromBottom(page)).toBeLessThan(4)
  await expect.poll(() => page.locator('.present-bar').count()).toBe(0)
  await page.context().close()
})

async function newBar(page: Page, first: { id: string; createdAt: Date }) {
  const bar = page.locator('.new-bar')
  await bar.waitFor()
  const time = await page.evaluate(iso => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }), first.createdAt.toISOString())
  expect(await page.locator('.new-bar-jump').innerText()).toBe(`26 new messages since ${time}`)
  const box = (await bar.boundingBox())!, header = (await page.locator('.chat-header').boundingBox())!, list = (await page.locator('.messages').boundingBox())!
  expect(box.y).toBe(header.y + header.height)
  // Fill and text from the accent tokens, readable at 4.5:1 or better.
  const contrast = await bar.evaluate(el => {
    const s = getComputedStyle(el)
    const lum = (c: string) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! }
    const [a, b] = [lum(s.backgroundColor), lum(s.color)].sort((x, y) => y - x)
    return (a! + 0.05) / (b! + 0.05)
  })
  expect(contrast).toBeGreaterThanOrEqual(4.5)
  return { bar, box, list }
}

test.skipIf(!ready)('touch: the new-messages bar spans the chat under the header, jumps to the first new message, and its X reads the channel', async () => {
  const { id, first } = await unreadChannel()
  const page = await open({ width: 390, height: 844 }, true, id)
  await scrollDown(page)
  const { bar, box, list } = await newBar(page, first)
  expect([box.x, box.width, box.height]).toEqual([list.x, list.width, 58])
  expect(await page.locator('.new-bar-read').isVisible()).toBe(false)

  await page.locator('.new-bar-jump').tap()
  await expect.poll(() => page.locator(`#m-${first.id}`).evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })).toBe(true)

  await page.context().close()

  // Dismissing: the X marks the channel read and the bar does not come back.
  const again = await unreadChannel()
  const next = await open({ width: 390, height: 844 }, true, again.id)
  await scrollDown(next)
  await newBar(next, again.first)
  expect(await readTo(again.id)).not.toBe(again.last.id)
  await next.getByRole('button', { name: 'Mark as read' }).tap()
  await expect.poll(() => next.locator('.new-bar').count()).toBe(0)
  await expect.poll(() => readTo(again.id)).toBe(again.last.id)
  await scrollUp(next)
  await next.waitForTimeout(300)
  expect(await next.locator('.new-bar').count()).toBe(0)
  await next.context().close()
})

test.skipIf(!ready)('desktop: the new-messages bar reads "Mark as read" at its right', async () => {
  const { id, first } = await unreadChannel()
  const page = await open({ width: 1584, height: 991 }, false, id)
  await scrollDown(page)
  const { bar, box } = await newBar(page, first)
  expect(box.height).toBe(34)
  expect(await page.locator('.new-bar-close').isVisible()).toBe(false)
  await page.locator('.new-bar-jump').click()
  await expect.poll(() => page.locator(`#m-${first.id}`).evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })).toBe(true)
  await page.context().close()

  const again = await unreadChannel()
  const next = await open({ width: 1584, height: 991 }, false, again.id)
  await scrollDown(next)
  await newBar(next, again.first)
  expect(await readTo(again.id)).not.toBe(again.last.id)
  await next.getByRole('button', { name: 'Mark as read' }).click()
  await expect.poll(() => next.locator('.new-bar').count()).toBe(0)
  await expect.poll(() => readTo(again.id)).toBe(again.last.id)
  await next.context().close()
})
