// The built PWA in headless Chromium: defects seen on the owner's hub. A sidebar
// tooltip, a doubled voice channel, a machine shown by its bot's name, a person
// with no server, and the sign-out on an open hub. Screenshots go to $HUB_SCREENSHOTS.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { ChannelType, type TextChannel } from 'discord.js'
import { LOGIN, pairedDevice, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const shots = process.env['HUB_SCREENSHOTS'] ?? path.join(os.tmpdir(), 'hub-screenshots')
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(shots, name), animations: 'disabled' })

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

const LONG = 'what research fellowships are available at the moment - AI research labs are open to'
const ALEX_LOGIN = 'alex@example.com'
let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser
let page: Page
let origin: string
let queueNotes: TextChannel

const owner = async (width: number, height: number) => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width, height }, serviceWorkers: 'block' })
  const p = await context.newPage()
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(origin)
  await p.getByLabel('Pairing code').fill(await hub.store.createPairing('chromium'))
  await p.getByText('Pair this device').click()
  await p.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).waitFor()
  return p
}

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  const guild = await demo.bot.guilds.fetch(t.config.guildId)
  // A machine whose Discord bot is "Desk PC", in a category named after that bot,
  // as a mirrored Discord server has it ("Kimaki Desk PC").
  await hub.mirror.machineBot('workstation', { discord_user_id: '960000000000000001', name: 'Desk PC' })
  const category = await guild.channels.create({ name: 'Kimaki Desk PC', type: ChannelType.GuildCategory })
  queueNotes = (await guild.channels.create({ name: 'queue-notes', type: ChannelType.GuildText, parent: category.id })) as TextChannel
  await queueNotes.send('Queued message sent')
  // Kimaki made its own voice channel on the hub, then the Discord import brought Discord's.
  await guild.channels.create({ name: 'Kimaki voice laptop', type: ChannelType.GuildVoice })
  await guild.channels.create({ name: 'Kimaki voice laptop', type: ChannelType.GuildVoice })
  const long = await demo.kimaki.threads.create({ name: LONG })
  await long.send('Looking into it.')
  browser = await chromium.launch({ executablePath })
  origin = `http://localhost:${hub.port}`
  page = await owner(1584, 991)
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!ready)('a sidebar thread tooltip opens beside the row, not over the rows above it', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const row = page.locator('.sidebar .channel', { hasText: LONG.slice(0, 30) })
  await row.hover()
  const tip = page.locator('.tip')
  await page.waitForTimeout(1_000)
  await shot(page, 'defect1-tooltip-1584.png')
  await tip.waitFor()
  // The app's tooltip, not the browser's: a native one sits wherever the pointer was.
  expect(await row.getAttribute('title')).toBeNull()
  expect(await tip.textContent()).toContain(LONG)
  const [r, b, overview] = await Promise.all([row.boundingBox(), tip.boundingBox(), page.locator('.sidebar .overview-row').first().boundingBox()])
  expect(b!.x).toBeGreaterThanOrEqual(r!.x + r!.width - 1)
  expect(Math.abs(b!.y + b!.height / 2 - (r!.y + r!.height / 2))).toBeLessThan(2)
  expect(b!.y > overview!.y + overview!.height || b!.y + b!.height < overview!.y).toBe(true)
  await page.mouse.move(800, 500)
  await tip.waitFor({ state: 'detached' })
})

test.skipIf(!ready)('two voice channels with one name show once in the sidebar', async () => {
  await page.goto(`${origin}/#/overview`)
  const voice = page.locator('.sidebar .channel[data-voice-channel]', { hasText: 'Kimaki voice laptop' })
  await voice.first().waitFor()
  await page.locator('.sidebar').screenshot({ path: path.join(shots, 'defect2-voice-1584.png'), animations: 'disabled' })
  expect(await voice.count()).toBe(1)
})

test.skipIf(!ready)("a machine's messages carry the machine's name and picture, not the agents' bot's", async () => {
  const botName = demo.bot.user!.username
  await page.goto(`${origin}/#/c/${queueNotes.id}`)
  const message = page.locator('.messages .message', { hasText: 'Queued message sent' })
  await message.waitFor()
  await shot(page, 'defect3-machine-1584.png')
  expect(await message.locator('.author').textContent()).toBe('Desk PC')
  expect(botName).not.toBe('Desk PC')
  // The machine's own category, named after the machine, shows the same name.
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.locator('.messages .message .author', { hasText: 'Desk PC' }).first().waitFor()
})

test.skipIf(!ready)('a person in no server sees where they are and what to do, with no retry loop', async () => {
  const api = await pairedDevice(hub, 'api')
  const invite = await api.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'alex', global_name: 'Alex' } })
  await hub.store.setProfile(invite.user.id, { tailscaleLogin: ALEX_LOGIN })
  await hub.reload()
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': ALEX_LOGIN }, viewport: { width: 1584, height: 991 }, serviceWorkers: 'block' })
  const p = await context.newPage()
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(origin)
  await p.getByLabel('Pairing code').fill(invite.code)
  await p.getByText('Pair this device').click()
  await p.locator('.sidebar .channel', { hasText: 'general' }).waitFor()
  await api.json(`/client/guilds/${t.config.guildId}/members/${invite.user.id}`, { method: 'DELETE' })
  let states = 0
  p.on('request', (r) => void (r.url().endsWith('/client/state') && states++))
  for (const [width, height] of [[1584, 991], [390, 844]] as const) {
    await p.setViewportSize({ width, height })
    states = 0
    await p.reload()
    await p.waitForTimeout(8_000)
    await shot(p, `defect4-no-server-${width}.png`)
    expect(await p.getByRole('heading', { name: 'No servers yet' }).count()).toBe(1)
    expect(await p.getByText("Can't reach the hub").count()).toBe(0)
    expect(states).toBeLessThanOrEqual(1)
  }
  await context.close()
}, 60_000)

test.skipIf(!ready)('on an open hub this computer has no sign-out and its device row says what it is', async () => {
  const open = await startTestHub({ tailscaleLogin: null })
  await open.hub.stop()
  open.config = initHub(open.paths, { localAccess: 'open' })
  open.hub = new Hub({ paths: open.paths, config: open.config, port: 0, webDir })
  await open.hub.start()
  try {
    const context = await browser.newContext({ viewport: { width: 1584, height: 991 }, serviceWorkers: 'block' })
    const p = await context.newPage()
    await p.goto(`http://localhost:${open.hub.port}`)
    await p.locator('.sidebar .channel', { hasText: 'general' }).waitFor()
    await p.locator('.user-panel-me').click()
    await p.locator('.menu-pop').waitFor()
    await shot(p, 'defect5-open-menu-1584.png')
    expect(await p.locator('.menu-pop').getByText('Sign out').count()).toBe(0)
    await p.locator('.menu-pop').getByText('User settings').click()
    await p.getByRole('button', { name: 'Devices' }).first().click()
    const row = p.locator('.settings-list-row', { hasText: 'This computer' })
    await row.waitFor()
    await shot(p, 'defect5-open-devices-1584.png')
    expect(await row.textContent()).toContain('No sign-in needed')
    expect(await row.getByRole('button', { name: 'Sign out' }).count()).toBe(0)
    expect(await p.getByRole('button', { name: 'Sign out' }).count()).toBe(0)
    expect(await p.evaluate(() => fetch('/client/auth/status').then((r) => r.json()))).toMatchObject({ signedIn: true, local: true })
    // A paired browser the owner named "This computer" is still a paired device: it keeps
    // Rename and Sign out, and open access never signs in as it.
    const laptop = await open.hub.store.createDevice('laptop', open.config.ownerUserId)
    await open.hub.store.addCredential({ id: 'laptop-passkey', deviceId: laptop.id, publicKey: new Uint8Array([1]), counter: 0, transports: [] })
    await open.hub.store.renameDevice(laptop.id, 'This computer')
    await p.reload()
    await p.locator('.sidebar .channel', { hasText: 'general' }).waitFor()
    await p.locator('.user-panel-me').click()
    await p.locator('.menu-pop').getByText('User settings').click()
    await p.getByRole('button', { name: 'Devices' }).first().click()
    await expect.poll(() => row.count()).toBe(2)
    await shot(p, 'local-device-renamed-1584.png')
    const renamed = row.filter({ hasNotText: 'No sign-in needed' })
    expect(await renamed.getByRole('button', { name: 'Rename' }).count()).toBe(1)
    expect(await renamed.getByRole('button', { name: 'Sign out' }).count()).toBe(1)
    expect(await row.filter({ hasText: 'No sign-in needed' }).getByRole('button').count()).toBe(0)
    await context.close()
    // A paired device still has a session to end.
    expect((await (await pairedDevice(hub, 'laptop')).json('/client/auth/status')).local).toBeUndefined()
  } finally {
    await open.cleanup()
  }
}, 60_000)
