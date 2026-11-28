// The reply bar's "@ ON / @ OFF" toggle and the "@" on a reply header that pinged, as on Discord.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { expect, test } from 'vitest'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const chrome = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse().map((d) => path.join(cache, d, 'chrome-linux64/chrome')).find((f) => fs.existsSync(f)) : undefined)

const hoverReply = async (page: Page, id: string, modifiers: Array<'Shift'> = []) => {
  await page.locator(`#m-${id}`).hover()
  await page.locator(`#m-${id}`).getByRole('button', { name: 'Reply', exact: true }).click({ modifiers })
}

test.skipIf(!chrome || !fs.existsSync(path.join(webDir, 'index.html')))('the reply bar toggles the ping; shift-click starts it off; a pinged reply header shows the @', async () => {
  const t = await startTestHub({ extensions: [] }); await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  const owner = await pairedDevice(t.hub), demo = await startDemoBot(t.hub), browser = await chromium.launch({ executablePath: chrome })
  try {
    const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'replier' } }), login = 'replier@example.test'
    await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: login }); await t.hub.refreshLogins()
    const member = new TestDevice(t.hub, { 'tailscale-user-login': login }); await member.pair(invite.code)
    const channel = demo.website.id, post = (device: TestDevice, json: object) => device.json(`/client/channels/${channel}/messages`, { method: 'POST', json })
    const question = await demo.website.send('Which logo should we use?')
    const mine = await post(owner, { content: 'The round one, I think.' })
    const pinged = await post(member, { content: 'Agreed.', message_reference: { message_id: mine.id }, allowed_mentions: { replied_user: true } })
    const quiet = await post(member, { content: 'Or the square.', message_reference: { message_id: mine.id }, allowed_mentions: { replied_user: false } })

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
    const k = owner.cookie!.indexOf('='); await ctx.addCookies([{ name: owner.cookie!.slice(0, k), value: owner.cookie!.slice(k + 1), url: owner.origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
    const page = await ctx.newPage(); page.setDefaultTimeout(10_000)
    await page.goto(`${owner.origin}/#/c/${channel}`)
    await page.locator(`#m-${quiet.id}`).waitFor()
    expect(await page.locator(`#m-${pinged.id} .reply-preview strong`).textContent()).toMatch(/^@/)
    expect(await page.locator(`#m-${quiet.id} .reply-preview strong`).textContent()).not.toMatch(/^@/)

    const toggle = page.locator('.footer-line .reply-ping')
    await hoverReply(page, question.id)
    await expect.poll(() => toggle.textContent()).toBe('@ ON')
    expect(await toggle.getAttribute('aria-pressed')).toBe('true')
    await toggle.click()
    await expect.poll(() => toggle.textContent()).toBe('@ OFF')
    const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/client/channels/${channel}/messages`))
    await page.locator('.composer textarea').fill('The round one.')
    await page.locator('.composer textarea').press('Enter')
    expect((await sent).postDataJSON()).toMatchObject({ content: 'The round one.', message_reference: { message_id: question.id }, allowed_mentions: { replied_user: false } })
    await expect.poll(() => toggle.count()).toBe(0)

    await hoverReply(page, question.id, ['Shift'])
    await expect.poll(() => toggle.textContent()).toBe('@ OFF')
    await page.getByRole('button', { name: 'Cancel reply' }).click()
    await hoverReply(page, question.id)
    await expect.poll(() => toggle.textContent()).toBe('@ ON')
    await hoverReply(page, mine.id)
    await page.locator('.footer-line', { hasText: 'Replying to' }).waitFor()
    expect(await toggle.count()).toBe(0)
  } finally { await browser.close(); await demo.stop(); await t.cleanup() }
}, 60_000)
