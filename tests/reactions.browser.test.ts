// Who reacted, in the built PWA: the reaction's tooltip names the people, the message menu's
// Reactions dialog lists them under each emoji, and a long press on a phone opens that list.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice } from './helpers.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const shots = process.env['HUB_SCREENSHOTS'] ?? path.join(os.tmpdir(), 'hub-screenshots')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).filter((s) => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))).map((s) => path.join(cache, s, 'chrome-linux64/chrome')).find((p) => fs.existsSync(p)) : undefined)
const check = test.skipIf(!executablePath || !fs.existsSync(path.join(webDir, 'index.html')))
const memberLogin = 'reader@example.test'
let t: Awaited<ReturnType<typeof startTestHub>>
let browser: Browser, owner: TestDevice, reader: TestDevice, channel: string, message: string
const contexts: BrowserContext[] = []

async function view(phone = false): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', reducedMotion: 'reduce', viewport: phone ? { width: 390, height: 844 } : { width: 1584, height: 991 }, isMobile: phone, hasTouch: phone })
  contexts.push(context)
  const p = await context.newPage()
  p.setDefaultTimeout(6000)
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(owner.origin)
  await p.getByLabel('Pairing code').fill(await t.hub.store.createPairing('reactions browser'))
  await p.getByText('Pair this device', { exact: true }).click()
  await p.locator('.sidebar .channel').first().waitFor({ state: 'attached' })
  await p.goto(`${owner.origin}/#/c/${channel}`)
  await p.locator(`#m-${message} .reaction`).first().waitFor()
  return p
}

beforeAll(async () => {
  if (!executablePath || !fs.existsSync(path.join(webDir, 'index.html'))) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub({ extensions: [] })
  await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  owner = await pairedDevice(t.hub, 'desktop')
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'reader' } })
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: memberLogin }); await t.hub.refreshLogins()
  reader = new TestDevice(t.hub, { 'tailscale-user-login': memberLogin }); await reader.pair(invite.code)
  const bot = await t.hub.store.addBot('builder')
  await t.hub.reload()
  channel = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'release' } })).id
  message = (await owner.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content: 'Release notes are ready for review.' } })).id
  const react = (emoji: string) => `/client/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}`
  await owner.json(react('👍'), { method: 'PUT' })
  await reader.json(react('👍'), { method: 'PUT' })
  await fetch(`${t.hub.localUrl}/api/v10/channels/${channel}/messages/${message}/reactions/${encodeURIComponent('👍')}/@me`, { method: 'PUT', headers: { authorization: `Bot ${bot.clientId}:${bot.secret}` } })
  await owner.json(react('🎉'), { method: 'PUT' })
  browser = await chromium.launch({ executablePath })
}, 90_000)
afterEach(async () => { await Promise.all(contexts.splice(0).map((c) => c.close())) })
afterAll(async () => { await browser?.close(); await t?.cleanup() })

check('hovering a reaction names who reacted; the message menu lists them under each emoji', async () => {
  const p = await view()
  const pill = p.locator(`#m-${message} .reaction`, { has: p.locator('img[alt="👍"]') })
  await pill.hover()
  const tip = p.locator('.reaction-tip')
  await expect.poll(() => tip.innerText()).toMatch(/^(?=.*owner)(?=.*reader).+, .+ and .+ reacted with :thumbs_up:$/)
  await p.screenshot({ path: path.join(shots, 'reactions-tooltip-desktop.png') })

  await p.mouse.move(0, 0)
  await p.locator(`#m-${message} .markdown, #m-${message} .message-body`).first().click({ button: 'right' })
  await p.getByRole('menuitem', { name: 'Reactions', exact: true }).click()
  const dialog = p.getByRole('dialog', { name: 'Reactions' })
  const names = async () => (await dialog.locator('.reactions-name').allInnerTexts()).sort()
  await dialog.getByRole('tab', { name: /👍/ }).click()
  await expect.poll(names).toEqual(['Kimaki', 'owner', 'reader'])
  expect(await dialog.locator('.reactions-user', { hasText: 'Kimaki' }).locator('.bot-tag').innerText()).toBe('BOT')
  await p.screenshot({ path: path.join(shots, 'reactions-dialog-desktop.png') })
  await dialog.getByRole('tab', { name: /🎉/ }).click()
  await expect.poll(names).toEqual(['owner'])
  await p.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
})

check('a long press on a reaction opens the list as a sheet on a phone', async () => {
  const p = await view(true)
  const pill = p.locator(`#m-${message} .reaction`, { has: p.locator('img[alt="👍"]') })
  const box = (await pill.boundingBox())!
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: 'touch', isPrimary: true, bubbles: true }
  await pill.dispatchEvent('pointerdown', at)
  const sheet = p.getByRole('dialog', { name: 'Reactions' })
  await sheet.waitFor()
  await pill.dispatchEvent('pointerup', at)
  await expect.poll(async () => (await sheet.locator('.reactions-name').allInnerTexts()).sort()).toEqual(['Kimaki', 'owner', 'reader'])
  expect(await sheet.getByRole('tab', { selected: true }).innerText()).toContain('3')
  await p.waitForTimeout(400)
  await p.screenshot({ path: path.join(shots, 'reactions-sheet-phone.png') })
})
