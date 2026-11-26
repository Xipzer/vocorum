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

// Phones record as Discord does on iPhone: hold the mic, release to send, slide up
// onto the lock to keep recording hands-free, the bin to drop it.
async function phone() {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  const cdp = await pair(page)
  page.setDefaultTimeout(8000)
  // A fresh load on the thread: on phones the session list covers it otherwise.
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.reload()
  await page.locator('.message').last().waitFor()
  await page.waitForTimeout(600)
  const box = (await page.getByRole('button', { name: 'Record a voice message' }).boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p = at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [p] })
  // Slide in small steps, as a finger does.
  const slide = async (to: { x: number; y: number }) => {
    for (let i = 1; i <= 8; i++) {
      await touch('touchMove', { x: at.x + ((to.x - at.x) * i) / 8, y: at.y + ((to.y - at.y) * i) / 8 })
      await page.waitForTimeout(20)
    }
  }
  return { context, page, at, touch, slide }
}

test.skipIf(!ready)('phone: hold the mic to record, release to send', async () => {
  const { context, page, touch } = await phone()
  try {
    const before = await voiceNotes(page).count()
    await touch('touchStart')
    await page.locator('.recording-label').waitFor()
    await page.getByText('Release to Send', { exact: true }).waitFor()
    // Discord's bar: the bin where the + was, the timer, the waveform and a 36pt accent Send square under the finger.
    expect(await page.getByRole('button', { name: 'Add to message' }).count()).toBe(0)
    await page.getByRole('button', { name: 'Discard voice message' }).waitFor()
    const send = page.getByRole('button', { name: 'Send voice message' })
    const [box, bg, accent] = [(await send.boundingBox())!, await send.evaluate((e) => getComputedStyle(e).backgroundColor), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())]
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([36, 36])
    expect(box.x + box.width).toBeLessThanOrEqual(393)
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
    expect(accent).not.toBe('')
    // The bar sits inside the floating message box, 16pt in from each side.
    const inside = await page.evaluate(() => {
      const pill = document.querySelector('.composer-box')!.getBoundingClientRect()
      return ['.rec-trash', '.recording-label', '.composer .send'].map((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return r.left >= pill.left && r.right <= pill.right && r.top >= pill.top && r.bottom <= pill.bottom })
        .concat([pill.left === 16, innerWidth - pill.right === 16, pill.height === 58])
    })
    expect(inside).toEqual([true, true, true, true, true, true])
    // Send and the shut lock are the theme's accent with a white glyph, in cyan and in pink.
    for (const tone of ['cyan', 'pink']) {
      const look = () => page.evaluate((tone) => {
        if (tone === 'pink') document.documentElement.dataset['accent'] = 'pink'
        else delete document.documentElement.dataset['accent']
        const probe = document.createElement('i')
        probe.style.cssText = 'background: var(--accent); color: #fff'
        document.body.append(probe)
        const want = [getComputedStyle(probe).backgroundColor, getComputedStyle(probe).color]
        probe.remove()
        const send = getComputedStyle(document.querySelector('.composer .send')!)
        const lum = (c: string) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! }
        const [a, b] = [lum(send.backgroundColor), lum(send.color)].sort((x, y) => y - x)
        return { want, got: [send.backgroundColor, send.color], contrast: (a! + 0.05) / (b! + 0.05) }
      }, tone)
      // Polled: the fill eases between tones.
      await expect.poll(async () => { const l = await look(); return l.got.join() === l.want.join() }).toBe(true)
    }
    await page.evaluate(() => { delete document.documentElement.dataset['accent'] })
    await page.locator('.rec-lock').waitFor()
    const [lock, sendNow] = [(await page.locator('.rec-lock').boundingBox())!, (await send.boundingBox())!]
    expect(lock.x + lock.width).toBe(sendNow.x + sendNow.width)
    await page.waitForTimeout(1500)
    await expect(page.locator('.recording-label .num').textContent()).resolves.toMatch(/^0:0[1-2]$/)
    expect(await page.locator('.rec-wave i').count()).toBeGreaterThan(5)
    await page.screenshot({ path: path.join(shots, 'voice-phone-recording.png') })
    await touch('touchEnd')
    await expect.poll(() => voiceNotes(page).count(), { timeout: 10_000 }).toBe(before + 1)
    await page.locator('.recording-label').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Record a voice message' }).waitFor()
  } finally { await context.close() }
})

test.skipIf(!ready)('phone: slide up onto the lock, recording carries on after release, Send sends', async () => {
  const { context, page, at, touch, slide } = await phone()
  try {
    const before = await voiceNotes(page).count()
    await touch('touchStart')
    await page.locator('.recording-label').waitFor()
    await slide({ x: at.x, y: at.y - 100 })
    await page.getByText('Release to Lock', { exact: true }).waitFor()
    await page.locator('.rec-lock.on').waitFor()
    // The shut lock: the accent square with its ink, centred over Send.
    const [on, send] = await Promise.all(['.rec-lock.on', '.composer .send'].map((s) => page.locator(s).evaluate((el) => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return { mid: r.left + r.width / 2, bg: c.backgroundColor, ink: c.color } })))
    expect(on!.mid).toBe(send!.mid)
    expect(on!.bg).toBe(await page.evaluate(() => { const i = document.createElement('i'); i.style.background = 'var(--accent)'; document.body.append(i); const c = getComputedStyle(i).backgroundColor; i.remove(); return c }))
    await page.screenshot({ path: path.join(shots, 'voice-phone-lock.png') })
    await touch('touchEnd', { x: at.x, y: at.y - 100 })
    // Locked: the hint and the lock go, the timer keeps counting, nothing is sent yet.
    await page.locator('.rec-lock').waitFor({ state: 'detached' })
    expect(await page.locator('.rec-tip').count()).toBe(0)
    await page.waitForTimeout(1600)
    await expect(page.locator('.recording-label .num').textContent()).resolves.toMatch(/^0:0[1-3]$/)
    expect(await voiceNotes(page).count()).toBe(before)
    await page.screenshot({ path: path.join(shots, 'voice-phone-locked.png') })
    await page.getByRole('button', { name: 'Send voice message' }).tap()
    await expect.poll(() => voiceNotes(page).count(), { timeout: 10_000 }).toBe(before + 1)
    await page.locator('.recording-label').waitFor({ state: 'detached' })
  } finally { await context.close() }
})

test.skipIf(!ready)('phone: the bin drops a recording, locked or held; a quick tap only says how', async () => {
  const { context, page, at, touch, slide } = await phone()
  try {
    const before = await voiceNotes(page).count()
    // Locked, then the bin.
    await touch('touchStart')
    await page.locator('.recording-label').waitFor()
    await slide({ x: at.x, y: at.y - 100 })
    await touch('touchEnd', { x: at.x, y: at.y - 100 })
    await page.locator('.rec-lock').waitFor({ state: 'detached' })
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: 'Discard voice message' }).tap()
    await page.locator('.recording-label').waitFor({ state: 'detached' })
    // Held, slid onto the bin, released.
    await touch('touchStart')
    await page.locator('.recording-label').waitFor()
    await page.waitForTimeout(600)
    const bin = (await page.getByRole('button', { name: 'Discard voice message' }).boundingBox())!
    const over = { x: bin.x + bin.width / 2, y: bin.y + bin.height / 2 }
    await slide(over)
    await page.getByText('Release to Discard', { exact: true }).waitFor()
    await touch('touchEnd', over)
    await page.locator('.recording-label').waitFor({ state: 'detached' })
    // A tap records nothing and shows the hint.
    await touch('touchStart')
    await page.waitForTimeout(60)
    await touch('touchEnd')
    await page.getByText('Hold to record, release to send', { exact: true }).waitFor()
    await page.waitForTimeout(1500)
    expect(await page.locator('.recording-label').count()).toBe(0)
    expect(await voiceNotes(page).count()).toBe(before)
  } finally { await context.close() }
})

test.skipIf(!ready)('phone: typed text shows the Send square in place of the mic', async () => {
  const { context, page } = await phone()
  try {
    const mic = page.getByRole('button', { name: 'Record a voice message' })
    await mic.waitFor()
    expect(await page.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0)
    await page.locator('.composer textarea').fill('On my way')
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await send.waitFor()
    expect(await mic.count()).toBe(0)
    const box = (await send.boundingBox())!
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([36, 36])
    await page.locator('.composer textarea').fill('')
    await mic.waitFor()
  } finally { await context.close() }
})
