// Voice notes in the built PWA, with Chromium's fake microphone: click to
// record on desktop (Enter sends, Esc cancels) and hold to record on a touch
// phone. The demo bot answers voice notes. Screenshots go to $HUB_SCREENSHOTS.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { LOGIN, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'

const webDir = process.env['VOICE_TEST_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')
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
let origin: string

async function pair(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await page.goto(origin)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing(`chromium-${Math.random()}`))
  await page.getByText('Pair this device').click()
  await page.locator('.channel').first().waitFor()
  return cdp
}

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  browser = await chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  origin = `http://localhost:${hub.port}`
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

const voiceNotes = (page: Page) => page.locator('.message .voice-message')

test.skipIf(!ready)('a rejected voice upload survives a reload and retries the original audio', async () => {
  const context = await browser.newContext({extraHTTPHeaders:{'tailscale-user-login':LOGIN},serviceWorkers:'block'})
  try {
    const p = await context.newPage(); await pair(p); await p.goto(`${origin}/#/c/${demo.website.id}`)
    await p.route('**/client/uploads', r => r.fulfill({status:400,body:'Bad multipart body'}))
    await p.getByRole('button',{name:'Record a voice message'}).click(); await p.locator('.recording-label').waitFor(); await p.waitForTimeout(1500); await p.keyboard.press('Enter')
    await p.getByText('Unsent voice note',{exact:true}).waitFor(); await p.reload()
    const local = p.getByRole('link',{name:'Save audio'}); await local.waitFor()
    const download = p.waitForEvent('download'); await local.click()
    expect(fs.statSync((await (await download).path())!).size).toBeGreaterThan(1024)
    await p.unroute('**/client/uploads'); await p.getByRole('button',{name:'Retry',exact:true}).click()
    await voiceNotes(p).last().waitFor(); await local.waitFor({state:'detached'}); await p.reload(); await voiceNotes(p).last().waitFor(); expect(await local.count()).toBe(0)
  } finally { await context.close() }
})

test.skipIf(!ready)('identical words stay typed or spoken on both paths; only local recordings play', async () => {
  const words = 'Meet beside the blue gate.'
  const rows: Array<{ id: string }> = []
  for (let i = 0; i < 6; i++) rows.push(await demo.website.send(words))
  const bytes = fs.readFileSync(path.resolve(import.meta.dirname, '../vendor/discord-digital-twin/tests/fixtures/voice-hello.ogg'))
  const saved = await hub.attachments.save({ id: rows[1]!.id, filename: 'clip.ogg', contentType: 'audio/ogg', data: bytes, uploadedBy: 'fixture' })
  const u = new URL(saved.url), clip = { id: saved.id, filename: 'clip.ogg', size: bytes.length, url: u.pathname + u.search, content_type: 'audio/ogg' }
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', deviceScaleFactor: 2 })
  try {
    const p = await context.newPage(); await pair(p)
    await p.route(`**/client/channels/${demo.website.id}/messages?*`, async route => {
      const response = await route.fetch(), body = await response.json()
      for (const [i,r] of rows.entries()) {
        const m = body.messages.find((x: {id:string}) => x.id === r.id)
        Object.assign(m, { flags: i % 3 === 0 ? 0 : 8192, origin: i >= 3 ? 'discord' : undefined, voice_note: i === 4 ? { attachment_id: clip.id } : i === 5 ? {} : undefined, attachments: i % 3 === 1 ? [clip] : [] })
      }
      await route.fulfill({response,json:body})
    })
    await p.goto(`${origin}/#/c/${demo.website.id}`)
    for (const width of [1280,390,320]) {
      await p.setViewportSize({width,height:800})
      for (const [i,r] of rows.entries()) {
        const row = p.locator(`#m-${r.id}`); await row.getByText(words,{exact:true}).waitFor()
        expect(await row.getByText('Voice note',{exact:true}).count()).toBe(i % 3 === 0 ? 0 : 1)
        expect(await row.locator('.voice-transcript').count()).toBe(i % 3 === 0 ? 0 : 1)
        const play = row.getByRole('button',{name:'Play voice note'})
        expect(await row.locator('audio').count()).toBe(i % 3 === 1 ? 1 : 0)
        if (width === 1280 && i % 3 === 1) { await play.click(); await expect.poll(() => row.locator('audio').evaluate((a:HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0) }
      }
    }
  } finally { await context.close() }
})

test.skipIf(!ready)('a mirrored voice message plays its own local bytes after reload; identical typed text stays plain', async () => {
  const words = 'The pocket guide is ready.'
  const ids = Array.from({length: 4}, (_, i) => String(((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt(8000 + i)))
  const [typed, spoken, silent, file] = ids as [string,string,string,string]
  const bytes = fs.readFileSync(path.resolve(import.meta.dirname, '../vendor/discord-digital-twin/tests/fixtures/voice-hello.ogg'))
  const msg = { channel_id: demo.website.id, author: { id: '4005551234', username: 'reader' }, content: words }
  // All inputs and bytes are local; there is no CDN URL to fetch.
  await hub.mirror.message(null, { ...msg, id: typed })
  await hub.mirror.message(null, { ...msg, id: spoken, flags: 8192, attachments: [{ id: file, filename: 'field.ogg', content_type: 'audio/ogg', size: bytes.length }] }, { files: new Map([[file, bytes]]) })
  await hub.mirror.message(null, { ...msg, id: silent, flags: 8192 })
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block' })
  try {
    const p = await context.newPage(); await pair(p); await p.goto(`${origin}/#/c/${msg.channel_id}`); await p.reload()
    for (const id of [typed, spoken, silent]) {
      const row = p.locator(`#m-${id}`); await row.getByText(words, { exact: true }).waitFor()
      expect(await row.locator('.voice-note-label').count()).toBe(id === typed ? 0 : 1)
      expect(await row.locator('audio').count()).toBe(id === spoken ? 1 : 0)
    }
    const row = p.locator(`#m-${spoken}`), url = new URL((await row.locator('audio').getAttribute('src'))!, origin)
    expect(url.origin).toBe(origin)
    expect(await (await context.request.get(url.href)).body()).toEqual(bytes)
    await row.getByRole('button', { name: 'Play voice note' }).click()
    await expect.poll(() => row.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0)
  } finally { await context.close() }
})

test.skipIf(!ready)('desktop: click the mic, see the timer and level, Enter sends; Esc cancels', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  await pair(page)
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const before = await voiceNotes(page).count()
  await page.getByRole('button', { name: 'Record a voice message' }).click()
  await page.locator('.recording-label').waitFor()
  await page.waitForTimeout(1500)
  await expect(page.locator('.recording-label .num').textContent()).resolves.toMatch(/^0:0[1-2]$/)
  await page.screenshot({ path: path.join(shots, 'voice-desktop-recording.png') })
  await page.keyboard.press('Enter')
  await expect.poll(() => voiceNotes(page).count(), { timeout: 10_000 }).toBe(before + 1)
  await page.getByRole('button', { name: 'Play voice note' }).last().click()
  await expect.poll(() => voiceNotes(page).last().locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0)
  await page.locator('.message', { hasText: 'Got it: your voice message' }).last().waitFor()

  // Cancel: nothing is sent.
  await page.getByRole('button', { name: 'Record a voice message' }).click()
  await page.locator('.recording-label').waitFor()
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.locator('.recording-label').waitFor({ state: 'detached' })
  await page.waitForTimeout(800)
  await expect(voiceNotes(page).count()).resolves.toBe(before + 1)
  await context.close()
})

test.skipIf(!ready)('desktop: + opens a menu to upload, schedule or record; keys open, move and close it', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  await pair(page)
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const plus = page.getByRole('button', { name: 'Add to message' })
  const menu = page.getByRole('menu')
  await plus.focus()
  await page.keyboard.press('Enter')
  await expect(menu.getByRole('menuitem').allTextContents()).resolves.toEqual(['Upload a file', 'Schedule message', 'Record voice message'])
  // Above the button, its left edge on the button's.
  const [b, m] = [(await plus.boundingBox())!, (await menu.boundingBox())!]
  expect(m.y + m.height).toBeLessThanOrEqual(b.y)
  expect(Math.round(m.x)).toBe(Math.round(b.x))
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('Upload a file')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('Schedule message')
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Add to message')

  await page.keyboard.press(' ')
  const chooser = page.waitForEvent('filechooser')
  await menu.getByRole('menuitem', { name: 'Upload a file' }).click()
  await chooser

  await page.locator('.composer textarea').fill('Later, please')
  await plus.click()
  await menu.getByRole('menuitem', { name: 'Schedule message' }).click()
  await page.getByRole('menuitem', { name: /In 1 hour/ }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'detached' })

  // Recording from the menu keeps the typed text and sends only the voice note.
  const before = await voiceNotes(page).count()
  await plus.click()
  await menu.getByRole('menuitem', { name: 'Record voice message' }).click()
  await page.locator('.recording-label').waitFor()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Send voice message' }).click()
  await expect.poll(() => voiceNotes(page).count(), { timeout: 10_000 }).toBe(before + 1)
  await expect(page.locator('.composer textarea').inputValue()).resolves.toBe('Later, please')
  await context.close()
})

test.skipIf(!ready)('phone: hold the mic to record, release to send', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  const cdp = await pair(page)
  page.setDefaultTimeout(8000)
  // A fresh load on the thread: on phones the session list covers it otherwise.
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.reload()
  await page.locator('.message').last().waitFor()
  await page.waitForTimeout(600)
  const before = await voiceNotes(page).count()
  const box = (await page.getByRole('button', { name: 'Record a voice message' }).boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
  await page.locator('.recording-label').waitFor()
  await page.waitForTimeout(1500)
  // The mic stays on screen under the finger while recording.
  const held = (await page.getByRole('button', { name: 'Record a voice message' }).boundingBox())!
  expect(held.x + held.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: path.join(shots, 'voice-phone-recording.png') })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect.poll(() => voiceNotes(page).count(), { timeout: 10_000 }).toBe(before + 1)
  await context.close()
})
