// Slash command options of type user and attachment, filled in the browser, reach the bot
// as Discord sends them: snowflake values with the objects in data.resolved. A channel
// option offers only channels the person can see.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { test, expect } from 'vitest'
import { Client, GatewayDispatchEvents, GatewayIntentBits } from 'discord.js'
import { Hub } from '../src/hub.ts'
import { LOGIN, TestDevice, pairedDevice, startTestHub } from './helpers.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const chrome = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse().map((d) => path.join(cache, d, 'chrome-linux64/chrome')).find((f) => fs.existsSync(f)) : undefined)
const shots = process.env['HUB_SCREENSHOTS']

test.skipIf(!chrome || !fs.existsSync(path.join(webDir, 'index.html')))('a user and an attachment option are picked in the browser and reach the bot resolved', async () => {
  const t = await startTestHub({ extensions: [] }); await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  const owner = await pairedDevice(t.hub), browser = await chromium.launch({ executablePath: chrome })
  const minted = await t.hub.store.addBot('desktop'); await t.hub.reload()
  const bot = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`); await ready
  try {
    const general = (await owner.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general')
    await bot.application!.commands.create({ name: 'share', description: 'share a file', options: [
      { type: 6, name: 'who', description: 'who gets it', required: true },
      { type: 11, name: 'file', description: 'the file', required: true },
    ] }, t.config.guildId)
    const raw: Array<{ data: { options: Array<{ name: string; type: number; value: string }>; resolved: Record<string, Record<string, Record<string, unknown>>> } }> = []
    bot.on('raw', (packet: { t: string; d: never }) => { if (packet.t === GatewayDispatchEvents.InteractionCreate) raw.push(packet.d) })
    const got: { user?: string; member?: boolean; name?: string; body?: string } = {}
    bot.on('interactionCreate', async (i) => {
      if (!i.isChatInputCommand() || i.commandName !== 'share') return
      const file = i.options.getAttachment('file', true)
      Object.assign(got, { user: i.options.getUser('who', true).id, member: Boolean(i.options.getMember('who')), name: file.name, body: await (await fetch(file.url)).text() })
      await i.reply(`shared ${file.name}`)
    })
    const me = (await owner.json('/client/state')).users.find((u: { id: string }) => u.id === t.config.ownerUserId)

    const c = await browser.newContext({ viewport: { width: 1584, height: 991 }, extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
    const k = owner.cookie!.indexOf('='); await c.addCookies([{ name: owner.cookie!.slice(0, k), value: owner.cookie!.slice(k + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
    const p = await c.newPage(); await p.goto(`${owner.origin}/#/c/${general.id}`)
    const box = p.getByPlaceholder('Message #general')
    await box.fill('/share')
    await p.locator('.slash-item', { hasText: 'share' }).first().waitFor()
    await box.press('Enter')
    const run = p.getByRole('button', { name: 'Run command' })
    await expect.poll(() => run.isDisabled()).toBe(true)
    await p.locator('.slash-arg input[data-option="who"]').fill((me.global_name ?? me.username).slice(0, 3))
    if (shots) await p.screenshot({ path: path.join(shots, 'slash-user-picker.png') })
    await p.locator('.palette .slash-item', { hasText: me.username }).first().click()
    expect(await run.isDisabled()).toBe(true)
    await p.locator('.slash-arg input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from the browser') })
    await p.getByRole('button', { name: 'file: notes.txt' }).waitFor()
    await expect.poll(() => run.isDisabled()).toBe(false)
    if (shots) await p.screenshot({ path: path.join(shots, 'slash-filled.png') })
    await run.click()
    await p.getByText('shared notes.txt').waitFor()

    expect(got).toEqual({ user: t.config.ownerUserId, member: true, name: 'notes.txt', body: 'hello from the browser' })
    const { data } = raw.find((d) => (d as { data: { name?: string } }).data.name === 'share')!
    const who = data.options.find((o) => o.name === 'who')!, file = data.options.find((o) => o.name === 'file')!
    expect(who).toEqual({ name: 'who', type: 6, value: t.config.ownerUserId })
    expect(file.type).toBe(11)
    expect(file.value).toMatch(/^\d{17,20}$/)
    expect(data.resolved.users![t.config.ownerUserId]).toMatchObject({ id: t.config.ownerUserId, username: me.username })
    expect(data.resolved.members![t.config.ownerUserId]).toHaveProperty('roles')
    expect(data.resolved.members![t.config.ownerUserId]).not.toHaveProperty('user')
    expect(data.resolved.attachments![file.value]).toMatchObject({ id: file.value, filename: 'notes.txt', content_type: 'text/plain', size: 22 })
  } finally { await browser.close(); await bot.destroy(); await t.cleanup() }
}, 60_000)

test.skipIf(!chrome || !fs.existsSync(path.join(webDir, 'index.html')))('a channel option offers only the channels the person can see', async () => {
  const t = await startTestHub({ extensions: [] }); await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  const owner = await pairedDevice(t.hub), browser = await chromium.launch({ executablePath: chrome })
  const minted = await t.hub.store.addBot('desktop'); await t.hub.reload()
  const bot = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${t.hub.localUrl}/api`, version: '10' } })
  const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`); await ready
  try {
    const general = (await owner.json('/client/state')).channels.find((c: { name: string }) => c.name === 'general')
    await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name: 'owners-only', permission_overwrites: [{ id: t.config.guildId, type: 0, allow: '0', deny: String(1n << 10n) }] } })
    await bot.application!.commands.create({ name: 'goto', description: 'go to a channel', options: [{ type: 7, name: 'where', description: 'where', required: true }] }, t.config.guildId)
    const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'robin' } })
    await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: 'robin@example.test' })
    await t.hub.reload()
    const member = new TestDevice(t.hub, { 'tailscale-user-login': 'robin@example.test' })
    await member.pair(invite.code)

    const offered = async (device: TestDevice, login: string) => {
      const c = await browser.newContext({ viewport: { width: 1584, height: 991 }, extraHTTPHeaders: { 'tailscale-user-login': login }, serviceWorkers: 'block' })
      const k = device.cookie!.indexOf('='); await c.addCookies([{ name: device.cookie!.slice(0, k), value: device.cookie!.slice(k + 1), url: device.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
      const p = await c.newPage(); await p.goto(`${device.origin}/#/c/${general.id}`)
      const box = p.getByPlaceholder('Message #general')
      await box.fill('/goto')
      await p.locator('.slash-item', { hasText: 'goto' }).first().waitFor()
      await box.press('Enter')
      await p.locator('.slash-arg input[data-option="where"]').fill('#')
      await p.locator('.palette .slash-item', { hasText: '#general' }).first().waitFor()
      if (shots) await p.screenshot({ path: path.join(shots, `slash-channel-picker-${login.split('@')[0]}.png`) })
      const names = await p.locator('.palette .slash-item').allTextContents()
      await c.close()
      return names
    }
    const forMember = await offered(member, 'robin@example.test')
    expect(forMember.some((n) => n.includes('#general'))).toBe(true)
    expect(forMember.some((n) => n.includes('owners-only'))).toBe(false)
    expect((await offered(owner, LOGIN)).some((n) => n.includes('owners-only'))).toBe(true)
  } finally { await browser.close(); await bot.destroy(); await t.cleanup() }
}, 60_000)
