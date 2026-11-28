// Wide screens in the built PWA: the Activity column beside a conversation from 2400px, a
// session's Workspace beside it from 3200px until closed, and the Overview as a grid with a
// rail once the page itself is 2400px wide. Narrower windows keep the plain layout. Needs `pnpm build:web` and a Playwright Chromium.

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

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser
let origin: string
let cookie: string
let ask: ThreadChannel

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
  cookie = (await pairedDevice(hub, 'Wide desk')).cookie!
  ask = await demo.kimaki.threads.create({ name: 'Pick the release train' })
  await ask.send(`<@${t.config.ownerUserId}> **Question:** Beta first, or straight to stable?`)
  browser = await chromium.launch({ executablePath })
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!ready)('from 2400px an Activity column sits beside the conversation, and the Overview is a grid', async () => {
  const p = await open(2560, 1440)
  try {
    await p.goto(`${origin}/#/c/${ask.id}`)
    await p.locator('.composer textarea').waitFor()
    const pane = p.getByRole('complementary', { name: 'Activity' })
    await pane.locator('.ov-item', { hasText: 'Pick the release train' }).waitFor()
    // Below 3200px the Workspace stays closed until asked for.
    expect(await p.getByRole('complementary', { name: 'Workspace' }).count()).toBe(0)
    // Side columns grow with the screen (22vw here) and message text keeps a reading measure.
    expect(Math.round((await pane.boundingBox())!.width)).toBe(Math.round(2560 * 0.22))
    expect(await p.locator('.message > .message-body').first().evaluate((el) => getComputedStyle(el).maxWidth)).toBe('960px')
    if (process.env['HUB_SCREENSHOTS']) await p.screenshot({ path: path.join(process.env['HUB_SCREENSHOTS'], 'wide-activity-2560.png') })

    // The column's title opens the Overview, which then has no Activity column of its own.
    await pane.getByRole('button', { name: 'Activity' }).click()
    await p.waitForURL(/#\/overview$/)
    // The page beside the sidebar is under 2400px here: cards and machines, no rail yet.
    await p.locator('.ovg').waitFor()
    expect(await p.locator('.ovg.with-rail').count()).toBe(0)
    expect(await p.locator('.activity-pane').count()).toBe(0)
    const needs = p.locator('.ovg-band', { has: p.getByRole('heading', { name: /^Needs you/ }) })
    await needs.locator('.ovg-cards > .ov-item', { hasText: 'Pick the release train' }).waitFor()
    await p.locator('.ovg-band', { has: p.getByRole('heading', { name: 'Agents by machine' }) }).locator('.ovg-machine').first().waitFor()
    if (process.env['HUB_SCREENSHOTS']) await p.screenshot({ path: path.join(process.env['HUB_SCREENSHOTS'], 'wide-overview-2560.png') })
  } finally {
    await p.context().close()
  }
}, 60_000)

test.skipIf(!ready)('from 3200px a session opens its Workspace beside the Activity column until it is closed, and the Overview gains its rail', async () => {
  const p = await open(3440, 1440)
  try {
    await p.goto(`${origin}/#/c/${ask.id}`)
    const workspace = p.getByRole('complementary', { name: 'Workspace' })
    await workspace.waitFor()
    await p.getByRole('complementary', { name: 'Activity' }).waitFor()
    // A channel with no session gets the Activity column alone.
    await p.goto(`${origin}/#/c/${demo.website.id}`)
    await p.getByRole('complementary', { name: 'Activity' }).waitFor()
    expect(await workspace.count()).toBe(0)

    // Closed once, it stays closed, across a reload too; the Activity column remains.
    await p.goto(`${origin}/#/c/${ask.id}`)
    await workspace.getByRole('button', { name: 'Close', exact: true }).click()
    await workspace.waitFor({ state: 'detached' })
    await p.reload()
    await p.getByRole('complementary', { name: 'Activity' }).waitFor()
    expect(await workspace.count()).toBe(0)

    // An Overview page 2400px wide and more moves what finished and extensions' footers to a rail.
    await p.goto(`${origin}/#/overview`)
    await p.locator('.ovg.with-rail > .ovg-rail').waitFor()
    if (process.env['HUB_SCREENSHOTS']) await p.screenshot({ path: path.join(process.env['HUB_SCREENSHOTS'], 'wide-overview-3440.png') })
  } finally {
    await p.context().close()
  }
}, 60_000)

test.skipIf(!ready)('below 2400px there is no Activity column, and a narrow Overview keeps its rows', async () => {
  const p = await open(1280, 800)
  try {
    await p.goto(`${origin}/#/c/${ask.id}`)
    await p.locator('.composer textarea').waitFor()
    expect(await p.locator('.activity-pane').count()).toBe(0)
    await p.goto(`${origin}/#/overview`)
    await p.locator('.ov .ov-item', { hasText: 'Pick the release train' }).waitFor()
    expect(await p.locator('.ovg').count()).toBe(0)
  } finally {
    await p.context().close()
  }
}, 60_000)
