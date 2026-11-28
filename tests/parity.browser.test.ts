// Discord parity in the built PWA: muted rows in the sidebar, silent messages, the app icon badge.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { MessageFlags } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, type TestDevice } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const shots = process.env['HUB_SCREENSHOTS'] ?? path.join(os.tmpdir(), 'hub-screenshots')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const chrome = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse().map((d) => path.join(cache, d, 'chrome-linux64/chrome')).find((f) => fs.existsSync(f)) : undefined)
const ready = Boolean(chrome && fs.existsSync(path.join(webDir, 'index.html')))

let t: Awaited<ReturnType<typeof startTestHub>>
let demo: Awaited<ReturnType<typeof startDemoBot>>
let owner: TestDevice
let browser: Browser

async function open(hash: string, width = 1584, height = 991, init?: () => void): Promise<Page> {
  const c = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  const k = owner.cookie!.indexOf('=')
  await c.addCookies([{ name: owner.cookie!.slice(0, k), value: owner.cookie!.slice(k + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const p = await c.newPage()
  if (init) await p.addInitScript(init)
  await p.goto(`${owner.origin}/${hash}`)
  await p.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).waitFor()
  return p
}

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
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

test.skipIf(!ready)('a muted channel is greyed with no unread mark, and its mentions still count', async () => {
  await owner.json(`/client/notifications/${demo.website.id}`, { method: 'PUT', json: { muted_until: Date.now() + 3_600_000 } })
  const p = await open(`#/c/${demo.thread.id}`)
  const website = p.locator('.sidebar .channel', { has: p.locator('.channel-name', { hasText: /^website$/ }) })
  const kimaki = p.locator('.sidebar .channel', { has: p.locator('.channel-name', { hasText: /^kimaki$/ }) })
  await demo.kimaki.send('Build passed.')
  // The page waits for each message to arrive (expect.poll alone gives up after a second).
  await p.locator('.sidebar .channel.unread', { has: p.locator('.channel-name', { hasText: /^kimaki$/ }) }).waitFor()
  expect(await kimaki.getAttribute('class')).toContain('unread')
  await demo.website.send('Deploy finished.')
  await demo.website.send(`<@${t.config.ownerUserId}> the preview is up.`)
  await website.locator('.badge', { hasText: /^1$/ }).waitFor()
  expect(await website.getAttribute('class')).toContain('muted')
  expect(await website.getAttribute('class')).not.toContain('unread')
  expect(await website.locator('.badge').textContent()).toBe('1')
  expect(await website.evaluate((el) => getComputedStyle(el).color)).toMatch(/0\.55\)$/)
  await p.screenshot({ path: path.join(shots, 'muted-desktop.png'), animations: 'disabled' })
  await p.context().close()
}, 45_000)

test.skipIf(!ready)('a silent message shows the crossed bell, and "@silent " sends one', async () => {
  await demo.kimaki.send({ content: 'Nightly backup done.', flags: MessageFlags.SuppressNotifications })
  await demo.kimaki.send('Loud news.')
  const p = await open(`#/c/${demo.kimaki.id}`)
  // A follow-on row: the bell sits by the time in the gutter, shown on hover.
  const quiet = p.locator('.message', { hasText: 'Nightly backup done.' })
  await quiet.hover()
  await quiet.locator('.row-time .silent-mark').hover()
  await p.getByRole('tooltip').filter({ hasText: /^Silent message$/ }).waitFor()
  expect(await p.locator('.message', { hasText: 'Loud news.' }).locator('.silent-mark').count()).toBe(0)
  await p.locator('.composer textarea').fill('@silent Ship it quietly.')
  await p.locator('.composer textarea').press('Enter')
  const mine = p.locator('.message', { hasText: 'Ship it quietly.' })
  await mine.locator('.message-head .silent-mark').waitFor()
  expect(await mine.textContent()).not.toContain('@silent')
  await expect.poll(async () => (await owner.json(`/client/channels/${demo.kimaki.id}/messages?limit=5`)).messages.find((m: { content: string }) => m.content === 'Ship it quietly.')?.flags, { timeout: 15_000 }).toBe(MessageFlags.SuppressNotifications)
  await p.screenshot({ path: path.join(shots, 'silent-desktop.png'), animations: 'disabled' })
  await p.context().close()
}, 45_000)

test.skipIf(!ready)('the app icon badge shows the inbox count and clears with it', async () => {
  const p = await open(`#/c/${demo.website.id}`, 1584, 991, () => {
    const w = window as unknown as { badges: Array<number | null> }
    w.badges = []
    Object.assign(navigator, { setAppBadge: async (n: number) => void w.badges.push(n), clearAppBadge: async () => void w.badges.push(null) })
  })
  const last = () => p.evaluate(() => (window as unknown as { badges: Array<number | null> }).badges.at(-1))
  const inbox = async () => Number((await p.locator('.inbox-button .num').textContent({ timeout: 1000 }).catch(() => '0')) ?? 0)
  // The inbox count can still be arriving after the first badge; wait until the badge and the count agree.
  await expect.poll(async () => (await last()) !== undefined && (await last()) === ((await inbox()) || null), { timeout: 15_000 }).toBe(true)
  const before = await inbox()
  await demo.kimaki.send(`<@${t.config.ownerUserId}> one more thing.`)
  await expect.poll(last, { timeout: 15_000 }).toBe(before + 1)
  expect(await inbox()).toBe(before + 1)
  await p.context().close()
}, 45_000)

test.skipIf(!ready)('a message that lands while the state reloads keeps its unread mark and mention', async () => {
  const guild = await demo.bot.guilds.fetch(t.config.guildId)
  const news = (await guild.channels.create({ name: 'late-news', parent: demo.kimaki.parentId })) as import('discord.js').TextChannel
  const p = await open(`#/c/${demo.thread.id}`)
  const row = p.locator('.sidebar .channel', { has: p.locator('.channel-name', { hasText: /^late-news$/ }) })
  await row.waitFor()
  expect(await row.getAttribute('class')).not.toContain('unread')
  // Hold the next state load with a snapshot taken before the message.
  let taken!: () => void, release!: () => void
  const snapshot = new Promise<void>((resolve) => (taken = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  await p.route('**/client/state', async (route) => {
    const response = await route.fetch()
    taken()
    await released
    await route.fulfill({ response })
  })
  t.hub.events.send('ACCESS_CHANGED', { guild_id: t.config.guildId }, { guildId: t.config.guildId })
  await snapshot
  await news.send(`<@${t.config.ownerUserId}> arrived during the reload.`)
  await p.locator('.sidebar .channel.unread', { has: p.locator('.channel-name', { hasText: /^late-news$/ }) }).waitFor()
  const loaded = p.waitForResponse((r) => r.url().endsWith('/client/state'))
  release()
  await loaded
  await p.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await row.getAttribute('class')).toContain('unread')
  expect(await row.locator('.badge').textContent()).toBe('1')
  await p.context().close()
}, 45_000)
