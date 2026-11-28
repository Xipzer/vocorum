// Hide Muted Channels in the server menu, as Discord's: saved per person on the hub, followed by
// their other windows, and a muted channel still shows while it mentions you or is open.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, type TestDevice } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const chrome = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse().map((d) => path.join(cache, d, 'chrome-linux64/chrome')).find((f) => fs.existsSync(f)) : undefined)
const ready = Boolean(chrome && fs.existsSync(path.join(webDir, 'index.html')))

let t: Awaited<ReturnType<typeof startTestHub>>
let demo: Awaited<ReturnType<typeof startDemoBot>>
let owner: TestDevice
let browser: Browser

async function open(hash: string): Promise<Page> {
  const c = await browser.newContext({ viewport: { width: 1584, height: 991 }, extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', reducedMotion: 'reduce' })
  const k = owner.cookie!.indexOf('=')
  await c.addCookies([{ name: owner.cookie!.slice(0, k), value: owner.cookie!.slice(k + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const p = await c.newPage()
  p.setDefaultTimeout(8000)
  await p.goto(`${owner.origin}/${hash}`)
  await p.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).waitFor()
  return p
}

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub({ extensions: [] })
  await t.hub.stop()
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] })
  await t.hub.start()
  owner = await pairedDevice(t.hub)
  demo = await startDemoBot(t.hub)
  browser = await chromium.launch({ executablePath: chrome })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await demo?.stop()
  await t?.cleanup()
})

test.skipIf(!ready)('Hide muted channels hides a muted channel until it mentions you, and follows to other windows', async () => {
  const guild = t.config.guildId
  await owner.json(`/client/notifications/${demo.website.id}`, { method: 'PUT', json: { muted_until: Date.now() + 3_600_000 } })
  const p = await open(`#/c/${demo.thread.id}`)
  const other = await open(`#/c/${demo.thread.id}`)
  const website = (page: Page) => page.locator('.sidebar .channel', { has: page.locator('.channel-name', { hasText: /^website$/ }) })
  const kimaki = p.locator('.sidebar .channel', { has: p.locator('.channel-name', { hasText: /^kimaki$/ }) })
  await website(p).waitFor()

  await p.locator('.side-title').click()
  const box = p.getByRole('menuitemcheckbox', { name: 'Hide muted channels' })
  expect(await box.getAttribute('aria-checked')).toBe('false')
  await box.click()
  await website(p).waitFor({ state: 'detached' })
  await kimaki.waitFor()
  await website(other).waitFor({ state: 'detached' })
  expect((await owner.json('/client/notifications')).hide_muted).toEqual([guild])
  expect((await owner.json('/client/state')).notifications.hide_muted).toEqual([guild])

  await demo.website.send(`<@${t.config.ownerUserId}> the deploy needs you`)
  await website(p).locator('.badge').waitFor()

  await p.locator('.side-title').click()
  expect(await p.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }).getAttribute('aria-checked')).toBe('true')
  await p.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }).click()
  await expect.poll(async () => (await owner.json('/client/notifications')).hide_muted).toEqual([])
  expect((await owner.fetch(`/client/guilds/${guild}/settings`, { method: 'PATCH', json: { hide_muted_channels: 'yes' } })).status).toBe(400)
  expect((await owner.fetch('/client/guilds/123/settings', { method: 'PATCH', json: { hide_muted_channels: true } })).status).toBe(404)
}, 60_000)
