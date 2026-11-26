// The channel list's NEW UNREADS / NEW MENTIONS pill floats above whatever covers the
// list's foot. During a call that is the voice strip, not the user panel under it: the
// pill must clear the strip so mute, deafen and leave stay in reach.
import { createHash, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { expect, test } from 'vitest'
import { initHub } from '../src/config.ts'
import { Hub } from '../src/hub.ts'
import { pairedDevice, startTestHub } from './helpers.ts'

const webDir = process.env['VOCORUM_REVIEW_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache)
  .filter(s => /^chromium-\d+$/.test(s)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .map(s => path.join(cache, s, 'chrome-linux64/chrome')).find(s => fs.existsSync(s)) : undefined)

const box = async (p: Page, selector: string) => (await p.locator(selector).boundingBox())!
// Pixels between the pill's foot and the top of what it floats above.
const gap = async (p: Page, under: string) => {
  const pill = await box(p, '.list-pill'), floor = await box(p, under)
  return Math.round(floor.y - (pill.y + pill.height))
}

test.skipIf(!executablePath || !fs.existsSync(path.join(webDir, 'index.html')))('the list pill clears the voice strip during a call and returns to the user panel after it', async () => {
  const t = await startTestHub({ extensions: [] })
  let browser: Browser | undefined
  try {
    await t.hub.stop()
    // Voice needs a secure origin: the paired private listener on loopback, its fresh certificate pinned.
    const host = 'hub.home.arpa', config = initHub(t.paths, { privateListener: { address: '127.0.0.1', names: [host], port: 0, httpPort: null, allowedCidrs: ['127.0.0.0/8'] } })
    t.hub = new Hub({ paths: t.paths, config, port: 0, webDir, extensions: [] }); await t.hub.start()
    const listener = t.hub.privateListener!, origin = `https://${host}:${listener.port}`
    const cert = new X509Certificate(fs.readFileSync(listener.files.cert)), pin = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    const owner = await pairedDevice(t.hub, 'Test desk')
    const invite = await owner.json(`/client/guilds/${config.guildId}/invites`, { method: 'POST', json: { username: 'writer' } })
    const room = await t.hub.twin.simulateChannelCreate({ guildId: config.guildId, type: 2, name: 'Test call' })
    // Enough channels that the last one sits below the fold.
    let last = room
    for (let i = 0; i < 40; i++) last = await t.hub.twin.simulateChannelCreate({ guildId: config.guildId, type: 0, name: `room-${String(i).padStart(2, '0')}` })

    browser = await chromium.launch({ executablePath, args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${pin}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'], serviceWorkers: 'block' }), cookie = owner.cookie!, i = cookie.indexOf('=')
    await ctx.addCookies([{ name: cookie.slice(0, i), value: cookie.slice(i + 1), secure: true, httpOnly: true, url: origin }])
    const p = await ctx.newPage(); p.setDefaultTimeout(8000)
    await p.goto(`${origin}/#/c/${room.id}`)
    await p.locator('.channel-list .channel', { hasText: 'room-00' }).waitFor()
    await p.locator('.channel-list').evaluate(el => { el.scrollTop = 0 })

    // Someone else writes in the last channel: unread, out of view, so the pill shows.
    await t.hub.twin.simulateUserMessage({ channelId: last.id, userId: invite.user.id, content: 'a note below the fold' })
    await p.locator('.list-pill').waitFor()
    await expect.poll(() => gap(p, '.user-panel')).toBe(6)

    await p.getByRole('button', { name: 'Join voice' }).click()
    await p.locator('.voice-strip-status').filter({ hasText: 'Voice connected' }).waitFor()
    // 6px above the strip, as it is above the panel; never over the strip.
    await expect.poll(() => gap(p, '.voice-strip')).toBe(6)
    for (const name of ['Mute', 'Deafen', 'Leave voice']) {
      const button = p.locator('.voice-strip').getByRole('button', { name, exact: true })
      const hit = await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })
      expect(hit, `${name} is not covered`).toBe(true)
    }
    if (process.env['HUB_SCREENSHOTS']) await p.screenshot({ path: path.join(process.env['HUB_SCREENSHOTS'], 'voice-strip-pill.png'), clip: { x: 0, y: 560, width: 360, height: 240 } })

    // The strip's own button ends the call; the pill drops back to the panel.
    await p.locator('.voice-strip').getByRole('button', { name: 'Leave voice' }).click()
    await p.locator('.voice-strip').waitFor({ state: 'detached' })
    await expect.poll(() => gap(p, '.user-panel')).toBe(6)
  } finally {
    await browser?.close()
    await t.cleanup()
  }
}, 60_000)
