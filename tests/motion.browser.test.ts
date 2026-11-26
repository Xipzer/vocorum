// The built PWA in headless Chromium: scrolling and arrivals move as Discord's desktop app
// does (measured from 60 fps captures of it). Page Up and Page
// Down in the message box page the messages with Discord's 580 ms glide; a new message from
// someone else is placed at once, without an eased scroll.
// Needs `pnpm build:web` and a Playwright Chromium.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChannelType, Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { LOGIN, startTestHub } from './helpers.ts'
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
let bot: Client
let browser: Browser
let page: Page
let channel: TextChannel

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  const { guildId, ownerUserId: alice } = hub.options.config
  await hub.twin.mirrorUser({ id: alice, username: 'alice', globalName: 'alice' })
  const minted = await hub.store.addBot('desk-pc')
  await hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], rest: { api: `${hub.localUrl}/api`, version: '10' } })
  const up = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await up
  const guild = await bot.guilds.fetch(guildId)
  channel = (await guild.channels.create({ name: 'kimaki', type: ChannelType.GuildText })) as TextChannel
  for (let i = 1; i <= 60; i++) await channel.send(`Line ${i}: a reply long enough to wrap onto a second line in a narrow window, so the history is several pages tall.`)

  browser = await chromium.launch({ executablePath })
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await page.goto(`http://localhost:${hub.port}`)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing('chromium'))
  await page.getByText('Pair this device').click()
  await page.goto(`http://localhost:${hub.port}/#/c/${channel.id}`)
  await page.locator('.message', { hasText: 'Line 60:' }).waitFor()
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await bot?.destroy()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

const list = (p: Page) => p.locator('.chat:not(.split) .messages').first()
const gap = (p: Page) => list(p).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

// scrollTop on every frame for a while, starting now.
const frames = (p: Page, ms: number) =>
  list(p).evaluate(
    (el, ms) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = []
        const start = performance.now()
        const tick = (now: number) => {
          out.push(el.scrollTop)
          if (now - start < ms) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
    ms,
  )

test.skipIf(!ready)('Page Up and Page Down in the message box page the messages with a glide', async () => {
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  const box = page.locator('.composer textarea')
  await box.click()
  const { top, height, tall } = await list(page).evaluate((el) => ({ top: el.scrollTop, height: el.clientHeight, tall: el.scrollHeight }))
  const watching = frames(page, 900)
  await box.press('PageUp')
  const seen = await watching
  // Paging up near the top also brings in older history above, which the list keeps out of
  // the way: measure how far the content moved, not the raw scroll position.
  const grown = (await list(page).evaluate((el) => el.scrollHeight)) - tall
  const moved = top + grown - seen.at(-1)!
  expect(moved).toBeGreaterThan(height * 0.8)
  expect(moved).toBeLessThan(height)
  // Discord's ~580 ms glide: many distinct positions on the way, not a jump or a 150 ms native step.
  expect(new Set(seen).size).toBeGreaterThan(15)
  expect(await box.evaluate((el) => el === document.activeElement)).toBe(true)
  await box.press('PageDown')
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
})

test.skipIf(!ready)('a new message from someone else is placed at once, as on Discord', async () => {
  await list(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  // Record the gap on each frame from the first frame the new message is on screen.
  const watching = list(page).evaluate(
    (el) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = []
        const tick = () => {
          if (el.querySelector('.message:last-child, .message') && [...el.querySelectorAll('.message')].some((m) => m.textContent?.includes('Arrived'))) out.push(el.scrollHeight - el.clientHeight - el.scrollTop)
          if (out.length < 10) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
  )
  await channel.send('Arrived: a reply from the agent while the owner reads the bottom of the thread.')
  const gaps = await watching
  expect(gaps.every((g) => g <= 1)).toBe(true)
})

test.skipIf(!ready)('the owner\'s message shows the moment it is sent, and the hub\'s copy replaces it', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let fail = false
  await page.route('**/client/channels/*/messages', async (r) => {
    if (r.request().method() !== 'POST') return r.continue()
    await gate
    if (fail) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'The hub is unreachable' }) })
    await r.continue()
  })
  try {
    const box = page.locator('.composer textarea')
    await box.fill('Sent at once: a note from the owner')
    await box.press('Enter')
    // Before the hub has answered: dimmed in the list, and the box is clear for the next one.
    const sending = list(page).locator('.message.sending', { hasText: 'Sent at once: a note from the owner' })
    await sending.waitFor()
    expect(await box.inputValue()).toBe('')
    release()
    const copies = list(page).locator('.message', { hasText: 'Sent at once: a note from the owner' })
    await expect.poll(() => sending.count()).toBe(0)
    await expect.poll(() => copies.count()).toBe(1)

    // A send the hub refuses goes away again and gives the text back.
    fail = true
    await box.fill('Never arrives: the hub refuses this one')
    await box.press('Enter')
    await expect.poll(() => list(page).locator('.message.sending').count()).toBe(0)
    await expect.poll(() => box.inputValue()).toBe('Never arrives: the hub refuses this one')
    expect(await list(page).locator('.message', { hasText: 'Never arrives' }).count()).toBe(0)
    await box.fill('')
  } finally {
    release()
    await page.unroute('**/client/channels/*/messages')
  }
})
