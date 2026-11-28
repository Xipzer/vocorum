// A bot's modal with Discord's Label components (string and user selects, a radio group,
// a checkbox group and a checkbox beside a required text input) is filled in the browser,
// and the bot receives each component's answer in Discord's modal-submit shape.
// Screenshots go to $HUB_SCREENSHOTS. Needs `pnpm build:web` and a Playwright Chromium.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { LOGIN, pairedDevice, startTestHub, type TestDevice } from './helpers.ts'
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
let bot: Client
let browser: Browser
let owner: TestDevice
let channel: TextChannel
const submits: Array<Record<string, unknown>> = []

const MODAL = {
  custom_id: 'order',
  title: 'Place an order',
  components: [
    { type: 18, id: 10, label: 'Flavours', description: 'Pick one or two.', component: { type: 3, id: 11, custom_id: 'flavours', placeholder: 'Choose flavours', min_values: 1, max_values: 2, options: [{ label: 'Apple', value: 'apple' }, { label: 'Banana', value: 'banana' }, { label: 'Cherry', value: 'cherry', description: 'Seasonal' }] } },
    { type: 18, label: 'Name', component: { type: 4, custom_id: 'name', style: 1, min_length: 2, required: true } },
    { type: 18, label: 'Deliver to', component: { type: 5, custom_id: 'who', required: false } },
    { type: 18, label: 'Size', component: { type: 21, custom_id: 'size', options: [{ label: 'Small', value: 'small' }, { label: 'Large', value: 'large', description: 'Feeds two' }] } },
    { type: 18, label: 'Extras', component: { type: 22, custom_id: 'extras', required: false, options: [{ label: 'Sprinkles', value: 'sprinkles' }, { label: 'Cream', value: 'cream' }] } },
    { type: 18, label: 'Gift wrap', component: { type: 23, custom_id: 'gift' } },
  ],
}

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  const { guildId, ownerUserId } = hub.options.config
  await hub.twin.mirrorUser({ id: ownerUserId, username: 'alice', globalName: 'Alice' })
  const minted = await hub.store.addBot('desk-pc')
  await hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], rest: { api: `${hub.localUrl}/api`, version: '10' } })
  bot.on('raw', (packet: { t?: string; d?: { type?: number; data?: Record<string, unknown> } }) => {
    if (packet.t === 'INTERACTION_CREATE' && packet.d?.type === 5) submits.push(packet.d.data!)
  })
  bot.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) await interaction.showModal(MODAL as never)
    if (interaction.isModalSubmit()) await interaction.reply({ content: `order for ${interaction.fields.getTextInputValue('name')}: ${interaction.fields.getStringSelectValues('flavours').join(', ')}` })
  })
  const up = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await up
  const guild = await bot.guilds.fetch(guildId)
  channel = (await guild.channels.create({ name: 'orders', type: ChannelType.GuildText })) as TextChannel
  await channel.send({ content: 'Ready to order?', components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('open').setLabel('Order').setStyle(ButtonStyle.Primary))] })
  owner = await pairedDevice(hub, 'modal')
  browser = await chromium.launch({ executablePath })
  fs.mkdirSync(shots, { recursive: true })
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await bot?.destroy()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

async function open(viewport: { width: number; height: number }, touch: boolean) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, colorScheme: 'dark', reducedMotion: 'reduce', extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  const cookie = owner.cookie!, split = cookie.indexOf('=')
  await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
  const page = await ctx.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(`${owner.origin}/#/c/${channel.id}`)
  await page.locator('.message').getByRole('button', { name: 'Order', exact: true }).click()
  await page.locator('.modal', { hasText: 'Place an order' }).waitFor()
  return page
}

const submit = (page: Page) => page.locator('.modal').getByRole('button', { name: 'Submit' })

test.skipIf(!ready)('a modal select, radio group and checkboxes reach the bot as Discord sends them', async () => {
  const page = await open({ width: 1584, height: 991 }, false)
  const modal = page.locator('.modal')
  // Required: the flavours select and a name of at least two characters.
  expect(await submit(page).isDisabled()).toBe(true)
  await modal.getByRole('textbox').fill('B')
  await modal.getByRole('button', { name: /^Flavours/ }).click()
  const list = page.getByRole('listbox', { name: 'Choose flavours' })
  await list.getByRole('option', { name: 'Apple' }).click()
  await list.getByRole('option', { name: /Cherry/ }).click()
  expect(await list.getByRole('option', { name: 'Banana' }).isDisabled()).toBe(true)
  await page.screenshot({ path: path.join(shots, 'modal-fields-select-desktop.png') })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => modal.getByRole('button', { name: /^Flavours/ }).textContent()).toBe('Apple, Cherry')
  expect(await submit(page).isDisabled()).toBe(true)
  await modal.getByRole('textbox').fill('Bea')
  // The radio group is required too.
  expect(await submit(page).isDisabled()).toBe(true)
  await modal.getByText('Large').click()
  expect(await submit(page).isDisabled()).toBe(false)
  await modal.getByRole('button', { name: /^Deliver to/ }).click()
  await page.getByRole('option', { name: /Alice/ }).click()
  await modal.getByText('Sprinkles').click()
  await modal.getByText('Gift wrap').click()
  await page.screenshot({ path: path.join(shots, 'modal-fields-desktop.png') })
  await submit(page).click()
  await page.locator('.message', { hasText: 'order for Bea: apple, cherry' }).waitFor()

  // Discord's shape: each answer in its Label, in the modal's order, ids echoed (and the
  // missing ones numbered in order, skipping the bot's own 10 and 11).
  const { ownerUserId } = hub.options.config
  const data = submits.at(-1)!
  expect(data['components']).toEqual([
    { type: 18, id: 10, component: { type: 3, id: 11, custom_id: 'flavours', values: ['apple', 'cherry'] } },
    { type: 18, id: 1, component: { type: 4, id: 2, custom_id: 'name', value: 'Bea' } },
    { type: 18, id: 3, component: { type: 5, id: 4, custom_id: 'who', values: [ownerUserId] } },
    { type: 18, id: 5, component: { type: 21, id: 6, custom_id: 'size', value: 'large' } },
    { type: 18, id: 7, component: { type: 22, id: 8, custom_id: 'extras', values: ['sprinkles'] } },
    { type: 18, id: 9, component: { type: 23, id: 12, custom_id: 'gift', value: true } },
  ])
  expect(data['resolved']).toMatchObject({ users: { [ownerUserId]: { id: ownerUserId, username: 'alice' } }, members: { [ownerUserId]: {} } })
  await page.context().close()
})

test.skipIf(!ready)('phone: the modal select opens as a sheet', async () => {
  const page = await open({ width: 390, height: 844 }, true)
  await page.screenshot({ path: path.join(shots, 'modal-fields-phone.png') })
  await page.locator('.modal').getByRole('button', { name: /^Flavours/ }).click()
  await page.getByRole('listbox', { name: 'Choose flavours' }).getByRole('option', { name: 'Banana' }).click()
  await page.screenshot({ path: path.join(shots, 'modal-fields-select-phone.png') })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => page.locator('.modal').getByRole('button', { name: /^Flavours/ }).textContent()).toBe('Banana')
  await page.context().close()
})
