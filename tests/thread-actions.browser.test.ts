// A thread's menu as Discord's: Mute thread for a while, its notification level, and Join or
// Leave thread (a twin thread member; a thread you left leaves your sidebar unless it is open).

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
  await p.locator('.sidebar .channel', { hasText: 'kimaki' }).first().waitFor()
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

test.skipIf(!ready)('the thread menu mutes for a while, sets the level, and joins and leaves the thread', async () => {
  const id = demo.thread.id
  const member = () => t.hub.twin.prisma.threadMember.findUnique({ where: { channelId_userId: { channelId: id, userId: t.config.ownerUserId } } })
  const p = await open(`#/c/${demo.kimaki.id}`)
  const row = p.locator(`.sidebar [data-nav="${id}"]`)
  const menu = async () => {
    await row.click({ button: 'right' })
    await p.getByRole('menuitem', { name: 'Notification settings' }).waitFor()
  }

  await menu()
  await p.getByRole('menuitem', { name: 'Mute thread' }).click()
  expect(await p.locator('.sheet-item').allInnerTexts()).toEqual(['For 15 minutes', 'For 1 hour', 'For 3 hours', 'For 8 hours', 'For 24 hours', 'Until I turn it back on'])
  const before = Date.now()
  await p.getByRole('menuitem', { name: 'For 15 minutes' }).click()
  await expect.poll(async () => (await owner.json('/client/notifications')).settings[id]?.muted_until ?? 0).toBeGreaterThan(0)
  const until = (await owner.json('/client/notifications')).settings[id].muted_until
  expect(until).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000)
  expect(until).toBeLessThanOrEqual(Date.now() + 15 * 60_000)
  await expect.poll(() => row.getAttribute('class')).toContain('muted')

  await menu()
  await p.getByRole('menuitem', { name: /Unmute thread/ }).click()
  await expect.poll(async () => (await owner.json('/client/notifications')).settings[id]?.muted_until ?? null).toBeNull()

  await menu()
  await p.getByRole('menuitem', { name: 'Notification settings' }).click()
  expect(await p.locator('.sheet-item').allInnerTexts()).toEqual(['All messages', 'Only @mentions', 'Nothing'])
  await p.getByRole('menuitemradio', { name: 'All messages' }).click()
  await expect.poll(async () => (await owner.json('/client/notifications')).settings[id]?.level).toBe('all')

  // The bot started the thread: the owner is not a member yet.
  expect(await member()).toBeNull()
  await menu()
  await p.getByRole('menuitem', { name: 'Join thread' }).click()
  await expect.poll(member).not.toBeNull()
  expect((await owner.json('/client/state')).thread_members).toContain(id)

  await menu()
  await p.getByRole('menuitem', { name: 'Leave thread' }).click()
  await row.waitFor({ state: 'detached' })
  expect(await member()).toBeNull()
  const state = await owner.json('/client/state')
  expect(state.left_threads).toEqual([id])
  expect(state.thread_members).not.toContain(id)

  // Open, a left thread shows; its More menu joins it again and it stays after you move on.
  await p.goto(`${owner.origin}/#/c/${id}`)
  await row.waitFor()
  await p.getByRole('button', { name: 'More', exact: true }).click()
  await p.getByRole('menuitem', { name: 'Join thread' }).click()
  await expect.poll(member).not.toBeNull()
  await p.goto(`${owner.origin}/#/c/${demo.kimaki.id}`)
  await p.locator('.sidebar .channel.active', { hasText: 'kimaki' }).waitFor()
  await row.waitFor()
  expect((await owner.json('/client/state')).left_threads).toEqual([])
  expect((await owner.fetch(`/client/channels/${demo.kimaki.id}/thread-members/@me`, { method: 'PUT' })).status).toBe(400)
}, 60_000)
