// Phone swipes, as Discord's app: left in a chat pulls the member list in from the right and
// right on it puts it away; right still goes back, and nothing fights a sideways scroller.
// In the image viewer a vertical swipe throws the picture away.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { LOGIN, pairedDevice, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const shots = process.env['HUB_SCREENSHOTS'] ?? path.join(os.tmpdir(), 'hub-screenshots')
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
let chat: string
// Where a swipe starts: on a plain message, not in a scroller.
let Y = 420

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  owner = await pairedDevice(hub, 'swipes')
  const ch = await demo.kimaki.guild.channels.create({ name: 'swipes', parent: demo.kimaki.parentId })
  for (let i = 0; i < 12; i++) await ch.send(`Note ${i}\nA second line, so the chat fills the screen.`)
  await ch.send('```\n' + 'const wide = ' + 'x'.repeat(240) + '\n```')
  await ch.send(`| ${Array.from({ length: 10 }, (_, i) => `column number ${i}`).join(' | ')} |\n|${' --- |'.repeat(10)}\n| ${Array.from({ length: 10 }, (_, i) => `value ${i}`).join(' | ')} |`)
  await ch.send({ content: 'A picture', files: [{ attachment: png(240, 160), name: 'picture.png' }] })
  await ch.send('The last note, a plain place to start a swipe.')
  chat = ch.id
  browser = await chromium.launch({ executablePath })
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

async function phone(reduced = false) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'dark', reducedMotion: reduced ? 'reduce' : 'no-preference', extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  const cookie = owner.cookie!, split = cookie.indexOf('=')
  await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const page = await ctx.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(`${owner.origin}/#/c/${chat}`)
  await page.locator('.chat-history .message').first().waitFor()
  await page.locator('.md-table-wrap').waitFor()
  const last = (await page.locator('.message', { hasText: 'The last note' }).boundingBox())!
  Y = Math.round(last.y + last.height / 2)
  return page
}

// One finger, as touch events dispatched where it lands; `ms` paces the moves (a fling is fast).
async function finger(page: Page, from: [number, number]) {
  const send = (type: string, x: number, y: number) =>
    page.evaluate(([type, x, y]) => {
      const w = window as unknown as { finger?: Element }
      if (type === 'touchstart') w.finger = document.elementFromPoint(x as number, y as number)!
      const touch = new Touch({ identifier: 1, target: w.finger!, clientX: x as number, clientY: y as number })
      const down = type === 'touchend' ? [] : [touch]
      w.finger!.dispatchEvent(new TouchEvent(type as string, { bubbles: true, cancelable: true, composed: true, touches: down, targetTouches: down, changedTouches: [touch] }))
    }, [type, x, y] as const)
  let at = from
  await send('touchstart', ...at)
  return {
    async to(next: [number, number], { steps = 12, ms = 600 } = {}) {
      const [x0, y0] = at
      for (let i = 1; i <= steps; i++) {
        await page.waitForTimeout(ms / steps)
        await send('touchmove', x0 + ((next[0] - x0) * i) / steps, y0 + ((next[1] - y0) * i) / steps)
      }
      at = next
    },
    lift: () => send('touchend', ...at),
  }
}
async function drag(page: Page, from: [number, number], to: [number, number], pace?: { steps?: number; ms?: number }) {
  const f = await finger(page, from)
  await f.to(to, pace)
  await f.lift()
}
const box = (page: Page, sel: string) => page.locator(sel).boundingBox()
const members = '.app > .members-panel'
const settled = (page: Page) => page.waitForFunction(() => document.documentElement.dataset['pull'] === undefined)

test.skipIf(!ready)('swipe left: the member list follows the finger in from the right and settles open past half its width', async () => {
  const page = await phone()
  expect(await page.locator(members).count()).toBe(0)
  const f = await finger(page, [320, Y])
  await f.to([120, Y])
  await expect.poll(async () => Math.round((await box(page, members))?.x ?? -1)).toBe(190)
  // The chat gives way beneath it, dimmed.
  expect((await box(page, '.app > .chat'))!.x).toBeLessThan(0)
  await page.screenshot({ path: path.join(shots, 'swipe-members-mid.png') })
  await f.to([40, Y], { steps: 4, ms: 400 })
  await f.lift()
  await settled(page)
  expect((await box(page, members))!.x).toBe(0)
  await page.screenshot({ path: path.join(shots, 'swipe-members-open.png') })
  // Swipe right on the list puts it away again.
  const back = await finger(page, [60, Y])
  await back.to([260, Y])
  await expect.poll(async () => Math.round((await box(page, members))?.x ?? -1)).toBe(200)
  await page.screenshot({ path: path.join(shots, 'swipe-members-closing.png') })
  await back.lift()
  await page.locator(members).waitFor({ state: 'detached' })
  expect((await box(page, '.app > .chat'))!.x).toBe(0)
  await page.context().close()
})

test.skipIf(!ready)('a short slow swipe springs back; a fast fling opens it', async () => {
  const page = await phone()
  await drag(page, [320, Y], [200, Y])
  await page.locator(members).waitFor({ state: 'detached' })
  await drag(page, [320, Y], [220, Y], { steps: 3, ms: 30 })
  await settled(page)
  expect((await box(page, members))!.x).toBe(0)
  // A slow swipe right less than half way leaves it open.
  await drag(page, [60, Y], [160, Y])
  await settled(page)
  expect((await box(page, members))!.x).toBe(0)
  await page.context().close()
})

test.skipIf(!ready)('swipe right still goes back to the list, and neither swipe fights a sideways scroller', async () => {
  const page = await phone()
  const code = (await box(page, '.codeblock pre'))!
  const table = (await box(page, '.md-table-wrap'))!
  for (const r of [code, table]) {
    const y = r.y + r.height / 2
    await drag(page, [r.x + r.width - 20, y], [r.x + r.width - 240, y])
    await drag(page, [r.x + 20, y], [r.x + 240, y])
  }
  await page.waitForTimeout(300)
  expect(await page.locator(members).count()).toBe(0)
  expect(await page.locator('.sidebar.open').count()).toBe(0)
  await drag(page, [40, Y], [300, Y])
  await page.locator('.sidebar.open').waitFor()
  expect(await page.locator(members).count()).toBe(0)
  await page.context().close()
})

test.skipIf(!ready)('reduced motion: nothing follows the finger, the list just opens and closes', async () => {
  const page = await phone(true)
  const f = await finger(page, [320, Y])
  await f.to([80, Y])
  await page.screenshot({ path: path.join(shots, 'swipe-members-reduced-mid.png') })
  expect(await page.evaluate(() => [document.querySelectorAll('.app > .members-panel').length, getComputedStyle(document.querySelector('.app > .chat')!).transform])).toEqual([0, 'none'])
  await f.lift()
  await page.locator(members).waitFor()
  expect((await box(page, members))!.x).toBe(0)
  await drag(page, [40, Y], [300, Y])
  await page.locator(members).waitFor({ state: 'detached' })
  await page.context().close()
})

// A solid PNG, so the test needs no image files.
function png(w: number, h: number) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

async function viewer(reduced = false) {
  const page = await phone(reduced)
  await page.locator('.message', { hasText: 'A picture' }).locator('.media-open').click()
  await page.locator('.lightbox-stage img').waitFor()
  await page.waitForTimeout(200)
  return page
}
// Where the picture sits, the backdrop's and the bar's opacity.
const look = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.lightbox')
    if (!box) return null
    const img = document.querySelector('.lightbox-stage img')!.getBoundingClientRect()
    return { y: Math.round(img.top + img.height / 2 - innerHeight / 2), backdrop: Number(getComputedStyle(box, '::before').opacity), bar: Number(getComputedStyle(document.querySelector('.lightbox-bar')!).opacity) }
  })
const gone = (page: Page) => page.locator('.lightbox').waitFor({ state: 'detached' })

test.skipIf(!ready)('viewer: the picture follows a vertical swipe, the backdrop fades, and past a quarter of the height it closes', async () => {
  const page = await viewer()
  const at = await look(page)
  const f = await finger(page, [195, 420])
  await f.to([195, 620])
  const mid = (await look(page))!
  expect(mid.y - at!.y).toBe(200)
  expect(mid.backdrop).toBeGreaterThan(0.2)
  expect(mid.backdrop).toBeLessThan(0.8)
  expect(mid.bar).toBeLessThan(mid.backdrop)
  await page.screenshot({ path: path.join(shots, 'swipe-viewer-mid.png') })
  await f.to([195, 660], { steps: 4, ms: 400 })
  await f.lift()
  await gone(page)
  await page.context().close()
})

test.skipIf(!ready)('viewer: a short slow swipe springs back; a fast fling up closes it', async () => {
  const page = await viewer()
  const at = (await look(page))!
  await drag(page, [195, 420], [195, 520])
  await expect.poll(() => look(page)).toEqual(at)
  await drag(page, [195, 420], [195, 340], { steps: 3, ms: 30 })
  await gone(page)
  await page.context().close()
})

test.skipIf(!ready)('viewer: a zoomed picture pans instead of closing', async () => {
  const page = await viewer()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.locator('.lightbox-stage.zoomed').waitFor()
  await drag(page, [195, 420], [195, 760])
  await page.waitForTimeout(300)
  expect(await page.locator('.lightbox').count()).toBe(1)
  expect(await page.locator('.lightbox-stage').evaluate((el) => getComputedStyle(el).translate)).toBe('none')
  await page.context().close()
})

test.skipIf(!ready)('viewer, reduced motion: the picture stays put while dragged and the viewer just closes', async () => {
  const page = await viewer(true)
  const at = await look(page)
  const f = await finger(page, [195, 420])
  await f.to([195, 700])
  expect(await look(page)).toEqual(at)
  await f.lift()
  await gone(page)
  await page.context().close()
})
