// Create Thread and Forward from the message menu: right click on desktop, long press on phones.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { LOGIN, pairedDevice, startTestHub } from './helpers.ts'
import { Hub } from '../src/hub.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache)
  .filter(s => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .map(s => path.join(cache, s, 'chrome-linux64/chrome')).find(s => fs.existsSync(s)) : undefined)
const ready = Boolean(executablePath && fs.existsSync(path.join(webDir, 'index.html')))
const shots = process.env['HUB_SCREENSHOTS']

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let owner: Awaited<ReturnType<typeof pairedDevice>>
let browser: Browser

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub({ extensions: [] })
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] })
  await hub.start()
  owner = await pairedDevice(hub, 'message-actions')
  browser = await chromium.launch({ executablePath })
}, 60_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

const chat = async (name: string): Promise<string> => (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name } })).id
const post = async (channel: string, content: string): Promise<string> => (await owner.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content } })).id

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

test.skipIf(!ready)('desktop: Create Thread names the thread from the message and opens it', async () => {
  const channel = await chat('plans')
  const message = await post(channel, 'Plan the spring launch\nwith a second line')
  const page = await open({ width: 1584, height: 991 }, false, channel)
  await page.locator(`#m-${message}`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create Thread' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create Thread' })
  const name = dialog.getByRole('textbox', { name: 'Thread Name' })
  expect(await name.inputValue()).toBe('Plan the spring launch')
  if (shots) await page.screenshot({ path: path.join(shots, 'create-thread-desktop.png') })
  await name.fill('Spring launch')
  await dialog.getByRole('button', { name: 'Create Thread' }).click()
  await expect.poll(() => dialog.count()).toBe(0)
  // The thread opens beside the channel, named as typed, and the message carries its card.
  await page.locator('.chat.split').getByText('Spring launch').first().waitFor()
  const thread = (await owner.json('/client/state')).threads.find((c: { id: string }) => c.id === message)
  expect(thread?.name).toBe('Spring launch')
  await page.locator(`#m-${message}`).getByText('Spring launch').first().waitFor()
  // One thread per message: the menu no longer offers another.
  await page.locator(`#m-${message}`).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reply' }).waitFor()
  expect(await page.getByRole('menuitem', { name: 'Create Thread' }).count()).toBe(0)
  await page.context().close()
})

test.skipIf(!ready)('desktop: Forward sends the message and an optional note to the picked channel', async () => {
  const from = await chat('design-notes')
  const to = await chat('weekly-digest')
  const message = await post(from, 'The new palette is ready for review')
  const page = await open({ width: 1584, height: 991 }, false, from)
  await page.locator(`#m-${message}`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Forward' }).click()
  const dialog = page.getByRole('dialog', { name: 'Forward To' })
  await dialog.getByRole('textbox', { name: 'Search' }).fill('weekly')
  await dialog.getByRole('option', { name: /weekly-digest/ }).click()
  await dialog.getByRole('textbox', { name: 'Add an optional message' }).fill('For the digest')
  if (shots) await page.screenshot({ path: path.join(shots, 'forward-desktop.png') })
  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => dialog.count()).toBe(0)
  const sent = (await owner.json(`/client/channels/${to}/messages`)).messages
  expect(sent.map((m: { content: string; message_reference?: { type?: number }; message_snapshots?: Array<{ message: { content: string } }> }) => [m.message_reference?.type ?? null, m.message_snapshots?.[0]?.message.content ?? m.content]))
    .toEqual([[1, 'The new palette is ready for review'], [null, 'For the digest']])
  // The target shows it as a forward.
  await page.goto(`${owner.origin}/#/c/${to}`)
  await page.locator('.forwarded').getByText('The new palette is ready for review').waitFor()
  await page.context().close()
})

test.skipIf(!ready)('phone: the long-press sheet offers Forward and Create Thread', async () => {
  const channel = await chat('phone-chat')
  const message = await post(channel, 'Long press me')
  const page = await open({ width: 390, height: 844 }, true, channel)
  const row = page.locator(`#m-${message}`)
  const box = (await row.boundingBox())!
  const client = await page.context().newCDPSession(page)
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(700)
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  // The lifted finger's click is swallowed for a moment, as on a real phone.
  await page.waitForTimeout(450)
  await page.getByRole('menuitem', { name: 'Forward' }).waitFor()
  await page.getByRole('menuitem', { name: 'Create Thread' }).waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, 'message-sheet-phone.png') })
  const item = (await page.getByRole('menuitem', { name: 'Create Thread' }).boundingBox())!
  await page.touchscreen.tap(item.x + item.width / 2, item.y + item.height / 2)
  const dialog = page.getByRole('dialog', { name: 'Create Thread' })
  if (shots) {
    await dialog.waitFor()
    await page.screenshot({ path: path.join(shots, 'create-thread-phone.png') })
  }
  expect(await dialog.getByRole('textbox', { name: 'Thread Name' }).inputValue()).toBe('Long press me')
  await dialog.getByRole('button', { name: 'Create Thread' }).click()
  // Phones open the thread in place of the channel.
  await page.waitForURL(new RegExp(`#/c/${message}`))
  await page.context().close()
})
