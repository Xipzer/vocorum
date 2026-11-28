// The channel list as Discord's: favourites in a Favorites category on every device of the
// person, and drag to reorder channels for people who can manage them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice } from './helpers.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).filter((s) => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))).map((s) => path.join(cache, s, 'chrome-linux64/chrome')).find((p) => fs.existsSync(p)) : undefined)
const check = test.skipIf(!executablePath || !fs.existsSync(path.join(webDir, 'index.html')))
const shots = process.env['HUB_SCREENSHOTS']
const memberLogin = 'reorder-reader@example.test'
let t: Awaited<ReturnType<typeof startTestHub>>
let browser: Browser
let owner: TestDevice
let reader: TestDevice
let readerId: string
const contexts: BrowserContext[] = []
const ids: Record<string, string> = {}

async function view(login: string, code: string, size = { width: 1584, height: 991 }): Promise<Page> {
  const phone = size.width < 768
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': login }, serviceWorkers: 'block', reducedMotion: 'reduce', viewport: size, isMobile: phone, hasTouch: phone })
  contexts.push(context)
  const p = await context.newPage()
  p.setDefaultTimeout(6000)
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(owner.origin)
  await p.getByLabel('Pairing code').fill(code)
  await p.getByText('Pair this device', { exact: true }).click()
  await p.locator('.sidebar .channel', { hasText: 'alpha' }).first().waitFor({ state: 'attached' })
  return p
}

const group = (p: Page, name: string) => p.locator('.sidebar .category', { has: p.locator('.category-name', { hasText: name }) })
const order = (p: Page) => group(p, 'Projects').locator('.channel .channel-name').allTextContents()

beforeAll(async () => {
  if (!executablePath || !fs.existsSync(path.join(webDir, 'index.html'))) return
  t = await startTestHub({ extensions: [] })
  await t.hub.stop()
  t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] })
  await t.hub.start()
  owner = await pairedDevice(t.hub, 'desktop')
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'reader' } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: memberLogin })
  await t.hub.refreshLogins()
  reader = new TestDevice(t.hub, { 'tailscale-user-login': memberLogin })
  await reader.pair(invite.code)
  readerId = invite.user.id
  ids['Projects'] = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'Projects', type: 4 } })).id
  for (const name of ['alpha', 'beta', 'gamma']) ids[name] = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name, parent_id: ids['Projects'] } })).id
  browser = await chromium.launch({ executablePath })
}, 90_000)
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()))
})
afterAll(async () => {
  await browser?.close()
  await t?.cleanup()
})

check('a favourite shows in Favorites on the person\'s other device at once and after a reload', async () => {
  const desk = await view(LOGIN, await t.hub.store.createPairing('desk'))
  const laptop = await view(LOGIN, await t.hub.store.createPairing('laptop'))
  await group(desk, 'Projects').locator('.channel', { hasText: 'beta' }).click({ button: 'right' })
  await desk.getByRole('menuitem', { name: 'Add to Favorites' }).click()
  await group(desk, 'Favorites').locator('.channel', { hasText: 'beta' }).waitFor()
  await group(laptop, 'Favorites').locator('.channel', { hasText: 'beta' }).waitFor()
  // Unread marks come along: a new message in beta bolds its favourite row too.
  await owner.json(`/client/channels/${ids['beta']}/messages`, { method: 'POST', json: { content: 'ship it' } })
  await group(laptop, 'Favorites').locator('.channel.unread', { hasText: 'beta' }).waitFor()
  if (shots) await desk.screenshot({ path: path.join(shots, 'favorites-1584.png') })
  await laptop.reload()
  await group(laptop, 'Favorites').locator('.channel', { hasText: 'beta' }).waitFor()
  await group(laptop, 'Favorites').locator('.channel', { hasText: 'beta' }).click({ button: 'right' })
  await laptop.getByRole('menuitem', { name: 'Remove from Favorites' }).click()
  await expect.poll(() => group(desk, 'Favorites').count()).toBe(0)
  expect((await owner.json('/client/state')).favourites).toEqual([])
}, 60_000)

check('a drag puts a channel where the line shows, for good; a person without Manage Channels cannot drag', async () => {
  const p = await view(LOGIN, await t.hub.store.createPairing('drag'))
  expect(await order(p)).toEqual(['alpha', 'beta', 'gamma'])
  const projects = group(p, 'Projects')
  await projects.locator('.channel', { hasText: 'gamma' }).dragTo(projects.locator('.channel', { hasText: 'alpha' }), { targetPosition: { x: 40, y: 4 } })
  await expect.poll(() => order(p)).toEqual(['gamma', 'alpha', 'beta'])
  const positions = (await owner.json<{ channels: Array<{ id: string; position: number }> }>('/client/state')).channels
  const at = (name: string) => positions.find((c) => c.id === ids[name])!.position
  expect(at('gamma') < at('alpha') && at('alpha') < at('beta')).toBe(true)
  await p.reload()
  await p.locator('.sidebar .channel', { hasText: 'alpha' }).first().waitFor()
  expect(await order(p)).toEqual(['gamma', 'alpha', 'beta'])
  expect(await projects.locator('.category-name').getAttribute('draggable')).toBe('true')

  const member = await view(memberLogin, await t.hub.store.createPairing('reader browser', { userId: readerId }))
  expect(await member.locator('.sidebar [draggable="true"]').count()).toBe(0)
  expect((await reader.fetch(`/client/guilds/${t.config.guildId}/channels`, { method: 'PATCH', json: [{ id: ids['beta'], position: 0 }] })).status).toBe(403)
}, 60_000)
