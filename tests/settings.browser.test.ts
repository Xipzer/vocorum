// Settings in the built PWA (headless Chromium): open from the user panel, set the
// server's notification default, rename yourself, create a channel, edit its topic
// and delete it, close with Esc. Screenshots of every section (1440x900 at 2x and a
// phone) go to $HUB_SCREENSHOTS.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { LOGIN, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const shots = process.env['HUB_SCREENSHOTS'] ?? path.join(os.tmpdir(), 'hub-screenshots')

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
let demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser
let context: BrowserContext
let page: Page
let origin: string

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  browser = await chromium.launch({ executablePath })
  context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  page = await context.newPage()
  // Reloads of the state land late, as on a busy machine: changes made meanwhile must stay.
  let loads = 0
  await page.route('**/client/state', async (r) => {
    const res = await r.fetch()
    if (++loads > 1) await new Promise((ok) => setTimeout(ok, 800))
    await r.fulfill({ response: res })
  })
  page.setDefaultTimeout(8_000)
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  origin = `http://localhost:${hub.port}`
  await page.goto(origin)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing('chromium'))
  await page.getByText('Pair this device').click()
  await page.locator('.sidebar .channel', { hasText: 'kimaki' }).first().waitFor()
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

const dialog = (p: Page, name = 'Settings') => p.getByRole('dialog', { name })
const openSettings = async (p: Page) => {
  await p.getByRole('button', { name: 'Settings', exact: true }).click()
  await p.getByRole('button', { name: 'User settings' }).click()
  await dialog(p).waitFor()
}
// Server settings are their own full-screen layer, opened from the server menu.
const openServerSettings = async (p: Page) => {
  if (await dialog(p).count()) {
    await p.keyboard.press('Escape')
    await dialog(p).waitFor({ state: 'detached' })
  }
  await p.locator('.side-title').click()
  await p.locator('.sheet-item', { hasText: 'Server settings' }).click()
  await dialog(p, 'Server settings').waitFor()
}
const notificationsState = (p: Page) => p.evaluate(() => fetch('/client/notifications').then((r) => r.json()))

test.skipIf(!ready)('settings: server notification default, Esc closes', async () => {
  await openSettings(page)
  // Focus moves into the layer, on the current section.
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('My account')
  await dialog(page).getByRole('button', { name: 'Notifications', exact: true }).click()
  await dialog(page).getByRole('heading', { name: 'Notifications' }).waitFor()
  await dialog(page).getByRole('radiogroup', { name: 'Server default' }).getByText('All messages').click()
  await expect.poll(async () => (await notificationsState(page)).settings[t.config.guildId]?.level).toBe('all')
  await expect.poll(() => dialog(page).getByRole('radio', { name: /All messages/ }).isChecked()).toBe(true)
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
  // The app behind is usable again.
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(false)
})

test.skipIf(!ready)('settings: the OG theme gives the chat Discord’s colour, survives a reload, and Vocorum comes back', async () => {
  await page.locator('.sidebar .channel', { hasText: 'kimaki' }).first().click()
  await page.locator('section.chat .chat-header').waitFor()
  const chat = () => page.locator('section.chat:has(.chat-header)').first().evaluate((e) => getComputedStyle(e).backgroundColor)
  const vocorum = 'rgb(13, 13, 16)'
  await expect.poll(chat).toBe(vocorum)
  await openSettings(page)
  await dialog(page).getByRole('button', { name: 'Appearance', exact: true }).click()
  const themes = dialog(page).getByRole('radiogroup', { name: 'Theme' })
  await expect.poll(() => themes.getByRole('radio', { name: 'Vocorum' }).isChecked()).toBe(true)
  await themes.getByText('OG', { exact: true }).click()
  await expect.poll(() => themes.getByRole('radio', { name: 'OG' }).isChecked()).toBe(true)
  // The accent choice belongs to the Vocorum theme.
  await expect(dialog(page).getByRole('radiogroup', { name: 'Accent colour' }).count()).resolves.toBe(0)
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
  await expect.poll(chat).toBe('rgb(26, 26, 30)')

  await page.reload()
  await page.locator('section.chat .chat-header').waitFor()
  expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('og')
  await expect.poll(chat).toBe('rgb(26, 26, 30)')
  // Applied before any app script runs: with the bundle blocked, the page is already OG.
  const bare = await context.newPage()
  await bare.route('**/assets/*.js', (r) => r.abort())
  await bare.goto(origin)
  expect(await bare.evaluate(() => [document.documentElement.dataset['theme'], getComputedStyle(document.getElementById('root')!).backgroundColor])).toEqual(['og', 'rgb(18, 18, 20)'])
  await bare.close()

  await openSettings(page)
  await dialog(page).getByRole('button', { name: 'Appearance', exact: true }).click()
  await dialog(page).getByRole('radiogroup', { name: 'Theme' }).getByText('Vocorum', { exact: true }).click()
  await dialog(page).getByRole('radiogroup', { name: 'Accent colour' }).waitFor()
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
  expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBeUndefined()
  await expect.poll(chat).toBe(vocorum)
  await page.reload()
  await page.locator('section.chat .chat-header').waitFor()
  await expect.poll(chat).toBe(vocorum)
})

test.skipIf(!ready)('settings: display name, then a channel created, edited and deleted', async () => {
  await openSettings(page)
  await dialog(page).getByRole('textbox', { name: 'Display name' }).fill('Captain')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await page.locator('.user-panel-name', { hasText: 'Captain' }).waitFor()
  await dialog(page).locator('.settings-profile-name', { hasText: 'Captain' }).waitFor()

  await openServerSettings(page)
  await dialog(page).getByRole('button', { name: 'Channels', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Create channel' }).click()
  await dialog(page).getByRole('textbox', { name: 'Channel name' }).fill('Release Notes')
  await dialog(page).getByRole('combobox', { name: 'Category' }).selectOption({ label: 'workstation' })
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await page.locator('.sidebar .channel', { hasText: 'release-notes' }).waitFor()

  // Edit opens the channel's own settings.
  await dialog(page).getByRole('button', { name: 'Edit release-notes' }).click()
  const channel = dialog(page, 'Channel settings')
  await channel.waitFor()
  await channel.getByRole('textbox', { name: 'Topic' }).fill('What shipped, per version')
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith('/settings'))
  await channel.getByRole('button', { name: 'Save' }).click()
  expect((await saved).ok()).toBe(true)
  expect((await state(page)).channels.find((c: { name: string }) => c.name === 'release-notes')?.topic).toBe('What shipped, per version')

  await channel.getByRole('button', { name: 'Delete channel' }).click()
  const remove = channel.getByRole('button', { name: 'Delete channel' }).last()
  expect(await remove.isDisabled()).toBe(true)
  await channel.getByRole('textbox', { name: 'Type the channel name to confirm' }).fill('release-notes')
  await remove.click()
  await channel.waitFor({ state: 'detached' })
  await page.locator('.sidebar .channel', { hasText: 'release-notes' }).waitFor({ state: 'detached' })
  expect((await state(page)).channels.some((c: { name: string }) => c.name === 'release-notes')).toBe(false)
})

test.skipIf(!ready)('settings: user settings are a centred dialog, server settings stay full-screen', async () => {
  const box = (sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round) })
  await openSettings(page)
  const user = dialog(page, 'User settings')
  await user.waitFor()
  // 40px clear of the window at 1280x800, a 252px nav and a 48px header naming the page.
  await expect.poll(() => box('.settings-layer')).toEqual([40, 40, 1200, 720])
  expect(await box('.settings-side')).toEqual([41, 41, 252, 718])
  expect(await box('.settings-head')).toEqual([293, 41, 946, 49])
  await user.locator('.settings-head').getByRole('heading', { name: 'My account' }).waitFor()
  // Only the user's sections; the server's live in their own layer.
  await expect(user.getByRole('button', { name: 'Channels', exact: true }).count()).resolves.toBe(0)
  await user.getByRole('button', { name: 'Appearance', exact: true }).click()
  await user.locator('.settings-head').getByRole('heading', { name: 'Appearance' }).waitFor()
  // A click on the dimmed app closes it, after its closing fade.
  await page.evaluate(() => {
    const scrim = document.querySelector('.settings-scrim')!
    new MutationObserver(() => { if (scrim.hasAttribute('data-leaving')) (window as unknown as { faded: boolean }).faded = true }).observe(scrim, { attributes: true })
  })
  await page.mouse.click(10, 400)
  await expect.poll(() => page.evaluate(() => (window as unknown as { faded?: boolean }).faded === true)).toBe(true)
  await user.waitFor({ state: 'detached' })
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(false)

  await openServerSettings(page)
  await expect.poll(() => box('.settings-layer')).toEqual([0, 0, 1280, 800])
  await expect(page.locator('.settings-scrim').count()).resolves.toBe(0)
  await expect(dialog(page, 'Server settings').getByRole('button', { name: 'My account', exact: true }).count()).resolves.toBe(0)
  await page.keyboard.press('Escape')
  await dialog(page, 'Server settings').waitFor({ state: 'detached' })
})

test.skipIf(!ready)('settings: search keeps the sections whose name or settings match, Enter opens the first', async () => {
  await openSettings(page)
  const user = dialog(page, 'User settings')
  const sections = () => user.locator('.settings-nav-item').allTextContents()
  const search = user.getByRole('searchbox', { name: 'Search settings' })
  await search.fill('colour')
  await expect.poll(sections).toEqual(['My account', 'Appearance'])
  await search.fill('reduced motion')
  await expect.poll(sections).toEqual(['Appearance'])
  await search.press('Enter')
  await user.locator('.settings-head').getByRole('heading', { name: 'Appearance' }).waitFor()
  await search.fill('qqq')
  await expect.poll(sections).toEqual([])
  await user.getByText('No settings match.').waitFor()
  await search.fill('')
  await expect.poll(async () => (await sections()).length).toBeGreaterThan(4)
  await page.keyboard.press('Escape')
  await user.waitFor({ state: 'detached' })
})

test.skipIf(!ready)('settings: compact message display puts the name on the text line without an avatar, the group space applies, both kept on this device', async () => {
  await page.locator('.sidebar .channel', { hasText: 'kimaki' }).first().click()
  const head = page.locator('section.chat .message:has(.message-head)').first()
  await head.waitFor()
  const layout = () =>
    head.evaluate((m) => {
      const box = (s: string) => m.querySelector(s)!.getBoundingClientRect()
      return {
        inline: Math.abs(box('.author').top - box('.markdown').top) < 2,
        avatar: getComputedStyle(m.querySelector('.author-avatar')!).display !== 'none',
        gap: parseFloat(getComputedStyle(m).marginTop),
      }
    })
  await expect.poll(layout).toEqual({ inline: false, avatar: true, gap: 17 })

  await openSettings(page)
  await dialog(page).getByRole('button', { name: 'Accessibility', exact: true }).click()
  await dialog(page).getByRole('radiogroup', { name: 'Chat message display' }).getByText('Compact').click()
  const space = dialog(page).getByRole('slider', { name: 'Space between message groups' })
  await space.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => space.getAttribute('aria-valuetext')).toBe('8px')
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
  await expect.poll(layout).toEqual({ inline: true, avatar: false, gap: 8 })

  await page.reload()
  await head.waitFor()
  await expect.poll(layout).toEqual({ inline: true, avatar: false, gap: 8 })

  await openSettings(page)
  await dialog(page).getByRole('button', { name: 'Accessibility', exact: true }).click()
  await dialog(page).getByRole('radiogroup', { name: 'Chat message display' }).getByText('Default').click()
  await space.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
  await expect.poll(layout).toEqual({ inline: false, avatar: true, gap: 17 })
})

test.skipIf(!ready)('settings: text size in chat scales message text and its line height, kept on this device', async () => {
  await page.locator('.sidebar .channel', { hasText: 'kimaki' }).first().click()
  const text = page.locator('section.chat .message .markdown').first()
  await text.waitFor()
  const size = () => text.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight])
  await expect.poll(size).toEqual(['16px', '22px'])

  await openSettings(page)
  await dialog(page).getByRole('button', { name: 'Accessibility', exact: true }).click()
  const font = dialog(page).getByRole('slider', { name: 'Text size in chat' })
  await font.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => font.getAttribute('aria-valuetext')).toBe('20px')
  // The preview follows at once.
  expect(await dialog(page).locator('.settings-preview .markdown').first().evaluate((e) => getComputedStyle(e).fontSize)).toBe('20px')
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
  await expect.poll(size).toEqual(['20px', '27.5px'])
  // The rest of the app keeps its size.
  expect(await page.locator('.sidebar .channel').first().evaluate((e) => getComputedStyle(e).fontSize)).not.toBe('20px')

  await page.reload()
  await text.waitFor()
  await expect.poll(size).toEqual(['20px', '27.5px'])

  await openSettings(page)
  await dialog(page).getByRole('button', { name: 'Accessibility', exact: true }).click()
  await font.focus()
  await page.keyboard.press('Home')
  await expect.poll(() => font.getAttribute('aria-valuetext')).toBe('12px')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
  await expect.poll(size).toEqual(['16px', '22px'])
})

// Verify persisted state in the same signed-in context. Only the application's reloads
// should pass through the 800 ms delay above; test assertions should not create stale reloads.
const state = async (p: Page) => {
  const response = await p.request.get(`${origin}/client/state`)
  expect(response.ok()).toBe(true)
  return response.json()
}

test.skipIf(!ready)('people: a role with a permission, a private channel, an invite with a code', async () => {
  await openServerSettings(page)
  const guildId = t.config.guildId

  // A role, then one of its permissions switched on.
  await dialog(page).getByRole('button', { name: 'Roles', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Create role' }).click()
  await dialog(page).getByRole('heading', { name: 'new role' }).waitFor()
  await dialog(page).getByRole('switch', { name: 'Manage messages' }).click()
  await expect.poll(async () => {
    const role = (await state(page)).roles[guildId].find((r: { name: string }) => r.name === 'new role')
    return role ? (BigInt(role.permissions) & (1n << 13n)) !== 0n : false
  }).toBe(true)
  expect(await dialog(page).getByRole('switch', { name: 'Manage messages' }).getAttribute('aria-checked')).toBe('true')

  // A private channel: @everyone can't view it, the creator can.
  await dialog(page).getByRole('button', { name: 'Channels', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Create channel' }).click()
  await dialog(page).getByRole('textbox', { name: 'Channel name' }).fill('secret-plans')
  await dialog(page).getByRole('switch', { name: 'Private channel' }).click()
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await page.locator('.sidebar .channel', { hasText: 'secret-plans' }).waitFor()
  const secret = (await state(page)).channels.find((c: { name: string }) => c.name === 'secret-plans')
  const everyone = secret.permission_overwrites.find((o: { id: string }) => o.id === guildId)
  expect((BigInt(everyone.deny) & (1n << 10n)) !== 0n).toBe(true)
  // Its Permissions page shows it as private.
  await dialog(page).getByRole('button', { name: 'Edit secret-plans' }).click()
  const channel = dialog(page, 'Channel settings')
  await channel.getByRole('button', { name: 'Permissions', exact: true }).click()
  expect(await channel.getByRole('switch', { name: 'Private channel' }).getAttribute('aria-checked')).toBe('true')
  await page.keyboard.press('Escape')
  await channel.waitFor({ state: 'detached' })

  // An invite: a new person with a pairing code.
  await openServerSettings(page)
  await dialog(page).getByRole('button', { name: 'Members', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Invite a person' }).click()
  await dialog(page).getByRole('textbox', { name: 'Username' }).fill('sam')
  await dialog(page).getByRole('button', { name: 'Create invite' }).click()
  const code = dialog(page).getByLabel('Pairing code')
  await code.waitFor()
  expect((await code.textContent())?.trim().length).toBeGreaterThanOrEqual(6)
  await dialog(page).locator('.settings-member', { hasText: 'sam' }).waitFor()
  await page.keyboard.press('Escape')
  await dialog(page).waitFor({ state: 'detached' })
})

test.skipIf(!ready)('settings: screenshots of every section, desktop 2x and phone', async () => {
  const desktop = await browser.newContext({ storageState: await context.storageState(), extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block' })
  const p = await desktop.newPage()
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await openSettings(p)
  const sections = ['My account', 'Devices', 'Notifications', 'Appearance', 'Privacy', 'Overview', 'Channels', 'Notification settings', 'Privacy settings', 'Roles', 'Members', 'Permissions']
  for (const [i, name] of sections.entries()) {
    if (name === 'Overview') await openServerSettings(p)
    await dialog(p).getByRole('button', { name, exact: true }).click()
    if (name === 'Devices') await dialog(p).getByText('This device', { exact: true }).waitFor()
    await p.waitForTimeout(250)
    await p.screenshot({ path: path.join(shots, `settings-${String(i + 1).padStart(2, '0')}-${name.toLowerCase().replace(/\s+/g, '-')}.png`) })
  }
  // A role's editor and a pairing code for another device.
  await dialog(p).getByRole('button', { name: 'Roles', exact: true }).click()
  await dialog(p).getByRole('button', { name: 'Edit new role' }).click()
  await p.waitForTimeout(250)
  await p.screenshot({ path: path.join(shots, 'settings-role-editor.png') })
  await p.keyboard.press('Escape')
  await dialog(p).waitFor({ state: 'detached' })
  await openSettings(p)
  await dialog(p).getByRole('button', { name: 'Devices', exact: true }).click()
  await dialog(p).getByRole('button', { name: 'Pair another device' }).click()
  await dialog(p).getByRole('button', { name: 'Get a code' }).click()
  await dialog(p).getByLabel('Pairing code').waitFor()
  await expect(dialog(p).getByRole('img', { name: 'Pairing QR code' }).isVisible()).resolves.toBe(true)
  await p.screenshot({ path: path.join(shots, 'settings-devices-pair.png') })
  // A project channel's own settings, from Channels.
  await openServerSettings(p)
  await dialog(p).getByRole('button', { name: 'Channels', exact: true }).click()
  await dialog(p).getByRole('button', { name: 'Edit kimaki' }).click()
  const channel = dialog(p, 'Channel settings')
  for (const name of ['Overview', 'Notifications', 'Output view', 'Permissions', 'Delete channel']) {
    await channel.getByRole('button', { name, exact: true }).click()
    await p.waitForTimeout(250)
    await p.screenshot({ path: path.join(shots, `channel-settings-${name.toLowerCase().replace(/\s+/g, '-')}.png`) })
  }
  await p.keyboard.press('Escape')
  await channel.waitFor({ state: 'detached' })
  await desktop.close()

  const phone = await browser.newContext({ storageState: await context.storageState(), extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const q = await phone.newPage()
  await q.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await q.locator('.chat-title').first().waitFor()
  await q.getByRole('button', { name: 'Channels' }).first().click().catch(() => {})
  await openSettings(q)
  await q.waitForTimeout(400)
  await q.screenshot({ path: path.join(shots, 'settings-phone-list.png') })
  await dialog(q).getByRole('button', { name: /Notifications/ }).first().click()
  await dialog(q).getByRole('radiogroup', { name: 'Server default' }).waitFor()
  await q.waitForTimeout(250)
  await q.screenshot({ path: path.join(shots, 'settings-phone-notifications.png') })
  await phone.close()
}, 60_000)
