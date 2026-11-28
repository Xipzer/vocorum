// A deferred command reply shows Discord's "<bot> is thinking…" message, which the
// bot's edit then replaces in the same row; one never answered says so after 15 minutes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { Client, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice, waitFor } from './helpers.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).filter((s) => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))).map((s) => path.join(cache, s, 'chrome-linux64/chrome')).find((p) => fs.existsSync(p)) : undefined)
const check = test.skipIf(!executablePath || !fs.existsSync(path.join(webDir, 'index.html')))
let t: Awaited<ReturnType<typeof startTestHub>>
let browser: Browser, owner: TestDevice, bot: Client, channel: string
const pending: ChatInputCommandInteraction[] = []

async function view(): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })
  const p = await context.newPage()
  p.setDefaultTimeout(8000)
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(owner.origin)
  await p.getByLabel('Pairing code').fill(await t.hub.store.createPairing('thinking browser'))
  await p.getByText('Pair this device', { exact: true }).click()
  await p.locator('.sidebar .channel').first().waitFor({ state: 'attached' })
  await p.goto(`${owner.origin}/#/c/${channel}`)
  await p.locator('.chat-history').waitFor()
  return p
}

const run = async (p: Page, name: string) => {
  const box = p.locator('.composer textarea')
  await box.fill(`/${name}`)
  await p.locator('.slash-item', { hasText: `/${name}` }).click()
  await p.locator('.slash-line').press('Enter')
  return waitFor(async () => pending.find((i) => i.commandName === name))
}

beforeAll(async () => {
  if (!executablePath || !fs.existsSync(path.join(webDir, 'index.html'))) return
  t = await startTestHub({ extensions: [] })
  await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  owner = await pairedDevice(t.hub, 'desktop')
  const minted = await t.hub.store.addBot('desktop')
  await t.hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await ready
  channel = (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'reports' } })).id
  for (const name of ['report', 'secret', 'stall']) await bot.application!.commands.create({ name, description: 'deferred' }, t.config.guildId)
  bot.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return
    await i.deferReply(i.commandName === 'secret' ? { flags: MessageFlags.Ephemeral } : {})
    pending.push(i)
  })
  browser = await chromium.launch({ executablePath })
}, 90_000)
afterAll(async () => { await browser?.close(); await bot?.destroy(); await t?.cleanup() })

check('the bot defers, the thinking message shows, and the edit lands in the same row', async () => {
  const p = await view()
  const interaction = await run(p, 'report')
  const thinking = p.locator('.message', { has: p.locator('.thinking') })
  await thinking.getByText(/is thinking…$/).waitFor()
  await expect.poll(() => thinking.locator('.used-command').innerText()).toBe('/report')
  const id = await thinking.getAttribute('id')
  // The thinking message is the status; the composer's command receipt goes.
  expect(await p.locator('.command-receipt').count()).toBe(0)
  await interaction.editReply('Weekly report ready')
  const row = p.locator(`#${id}`)
  await row.getByText('Weekly report ready', { exact: true }).waitFor()
  expect(await row.locator('.thinking').count()).toBe(0)
  expect(await row.locator('.edited-tail').count()).toBe(0)
  expect(await p.locator('.thinking').count()).toBe(0)
  await p.context().close()
}, 45_000)

check('a private deferral shows only to the caller, and the first follow-up replaces it', async () => {
  const p = await view()
  const interaction = await run(p, 'secret')
  const thinking = p.locator('.message.private-reply', { has: p.locator('.thinking') })
  await thinking.getByText('Only you can see this').waitFor()
  const id = await thinking.getAttribute('id')
  const shared = (await owner.json<{ messages: Array<{ flags?: number }> }>(`/client/channels/${channel}/messages`)).messages
  expect(shared.some((m) => (m.flags ?? 0) & MessageFlags.Loading)).toBe(false)
  await interaction.followUp('The code is 4471')
  await p.locator(`#${id}`).getByText('The code is 4471', { exact: true }).waitFor()
  expect(await p.locator(`#${id} .edited-tail`).count()).toBe(0)
  expect(await p.locator('.thinking').count()).toBe(0)
  await p.context().close()
}, 45_000)

check('a deferral never answered reads as Discord\'s timeout', async () => {
  const p = await view()
  await run(p, 'stall')
  await p.locator('.thinking').waitFor()
  const id = (await p.locator('.message', { has: p.locator('.thinking') }).getAttribute('id'))!.slice(2)
  await t.hub.twin.prisma.message.update({ where: { id }, data: { timestamp: new Date(Date.now() - 16 * 60_000) } })
  await p.reload()
  await p.locator(`#m-${id}`).getByText('The application did not respond', { exact: true }).waitFor()
  await p.context().close()
}, 45_000)
