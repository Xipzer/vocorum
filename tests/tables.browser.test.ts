// Markdown pipe tables in the built PWA: on phones the header words stay whole and the table
// scrolls sideways inside its block instead of squeezing letters or widening the page.
// Needs `pnpm build:web` and a Playwright Chromium.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import type { ThreadChannel } from 'discord.js'
import { LOGIN, pairedDevice, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache)
  .filter(s => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .map(s => path.join(cache, s, 'chrome-linux64/chrome')).find(s => fs.existsSync(s)) : undefined)
const ready = Boolean(executablePath) && fs.existsSync(path.join(webDir, 'index.html'))

const TABLE = [
  'Release readiness by service:',
  '',
  '| Service | Environment | Throughput | Availability | Regression | Owner notes |',
  '| --- | --- | ---: | ---: | --- | --- |',
  '| gateway | production | 1,240 | 99.98% | none | Rolled out behind the canary flag on Tuesday morning |',
  '| uploads | staging | 310 | 99.10% | flaky retries | Waiting on the storage migration before promoting |',
  '| search | production | 880 | 99.95% | none | Index rebuild finished overnight without errors |',
].join('\n')

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser
let origin: string
let cookie: string
let thread: ThreadChannel

const open = async (width: number, height: number) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width, height }, serviceWorkers: 'block', reducedMotion: 'reduce' })
  const i = cookie.indexOf('=')
  await ctx.addCookies([{ name: cookie.slice(0, i), value: cookie.slice(i + 1), url: origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const p = await ctx.newPage()
  p.setDefaultTimeout(8000)
  return p
}

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  origin = `http://localhost:${hub.port}`
  cookie = (await pairedDevice(hub, 'Table phone')).cookie!
  thread = await demo.kimaki.threads.create({ name: 'Release readiness' })
  await thread.send(TABLE)
  browser = await chromium.launch({ executablePath })
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

for (const [width, height] of [[390, 844], [320, 640], [1584, 991]] as const) {
  test.skipIf(!ready)(`at ${width}px table headers keep whole words and the table scrolls inside its block`, async () => {
    const p = await open(width, height)
    try {
      await p.goto(`${origin}/#/c/${thread.id}`)
      const wrap = p.locator('.md-table-wrap').first()
      await wrap.waitFor()
      if (process.env['HUB_SCREENSHOTS']) await p.screenshot({ path: path.join(process.env['HUB_SCREENSHOTS'], `md-table-${width}.png`) })
      const m = await wrap.evaluate((el) => {
        const range = document.createRange()
        const words = [...el.querySelectorAll('thead th')].map((th) => {
          // The widest single word in the header, measured with the cell's own font.
          const canvas = document.createElement('canvas').getContext('2d')!
          const cs = getComputedStyle(th)
          canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
          const word = Math.max(...th.textContent!.split(/\s+/).map((w) => canvas.measureText(w).width))
          range.selectNodeContents(th)
          return { text: th.textContent, word, lines: Math.round(th.getBoundingClientRect().height / parseFloat(cs.lineHeight)), content: range.getBoundingClientRect().width }
        })
        const body = el.closest('.message-body') ?? el.parentElement!
        return {
          words,
          wrap: el.getBoundingClientRect(),
          body: body.getBoundingClientRect(),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowX: getComputedStyle(el).overflowX,
          page: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
        }
      })
      for (const h of m.words) {
        if (!/\s/.test(h.text!.trim())) expect(h.lines, `${h.text} breaks inside the word`).toBe(1)
        expect(h.content + 0.5, `${h.text} squeezed`).toBeGreaterThanOrEqual(h.word)
      }
      expect(m.page).toBeLessThanOrEqual(m.viewport)
      expect(m.wrap.right).toBeLessThanOrEqual(m.body.right + 0.5)
      if (width < 768) {
        expect(m.scrollWidth).toBeGreaterThan(m.clientWidth)
        expect(m.overflowX).toBe('auto')
        await wrap.evaluate((el) => { el.scrollLeft = 120 })
        expect(await wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
        expect(await p.evaluate(() => document.scrollingElement!.scrollLeft)).toBe(0)
        if (process.env['HUB_SCREENSHOTS']) {
          await wrap.evaluate((el) => { el.scrollLeft = el.scrollWidth })
          await p.screenshot({ path: path.join(process.env['HUB_SCREENSHOTS'], `md-table-${width}-scrolled.png`) })
        }
      }
    } finally {
      await p.context().close()
    }
  })
}
