// The built PWA in headless Chromium with its service worker: another app shares text, a link
// and files to Vocorum (Web Share Target). The worker keeps them on the device, the app opens
// on "Share to…", nothing is uploaded until Send, and Cancel drops the share. Without the
// worker the hub keeps nothing and the app asks to share again.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { startTestHub } from './helpers.ts'
import { initHub } from '../src/config.ts'
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
let origin: string
const uploads: string[] = []

// Open access on this computer: the worker's own requests carry no proxy identity header.
beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub({ tailscaleLogin: null })
  await t.hub.stop()
  t.config = initHub(t.paths, { localAccess: 'open' })
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  browser = await chromium.launch({ executablePath })
  context = await browser.newContext({ viewport: { width: 1584, height: 991 }, deviceScaleFactor: 1 })
  context.on('request', (r) => r.url().includes('/client/uploads') && uploads.push(r.url()))
  const page = await context.newPage()
  origin = `http://localhost:${hub.port}`
  await page.goto(origin)
  await page.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).waitFor()
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  // The app is closed when the share arrives.
  await page.close()
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

// What the share sheet does: a multipart POST navigation to the manifest's share_target action.
async function share(page: Page, fields: Record<string, string>) {
  await page.goto('about:blank')
  await page.setContent(`<form method="post" enctype="multipart/form-data" action="${origin}/share">${Object.keys(fields).map((k) => `<input name="${k}">`).join('')}<input type="file" name="files" multiple></form>`)
  for (const [k, v] of Object.entries(fields)) await page.locator(`input[name="${k}"]`).fill(v)
  await page.locator('input[type=file]').setInputFiles([
    { name: 'shot.png', mimeType: 'image/png', buffer: fs.readFileSync(path.resolve(import.meta.dirname, '../web/public/icon-192.png')) },
    { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
  ])
  await Promise.all([page.waitForURL(`${origin}/**`), page.locator('form').evaluate((f: HTMLFormElement) => f.submit())])
  await page.getByRole('dialog', { name: 'Share to' }).waitFor()
}

test.skipIf(!ready)('a share opens "Share to…" with the text and files, and Send posts them to the picked thread', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'manifest.webmanifest'), 'utf8'))
  expect(manifest.share_target).toMatchObject({ action: '/share', method: 'POST', enctype: 'multipart/form-data' })

  const page = await context.newPage()
  await share(page, { title: 'A page', text: 'Look at this', url: 'https://example.com/x' })
  const dialog = page.getByRole('dialog', { name: 'Share to' })
  await expect.poll(() => dialog.getByLabel('Message').inputValue()).toBe('Look at this\nhttps://example.com/x')
  await dialog.getByRole('listitem', { name: 'shot.png' }).waitFor()
  await dialog.getByRole('listitem', { name: 'notes.pdf' }).waitFor()
  await dialog.getByRole('option', { name: /Fix footer on short turns/ }).waitFor()
  expect(await dialog.getByRole('button', { name: 'Send' }).isDisabled()).toBe(true)
  await page.screenshot({ path: path.join(shots, 'share-desktop.png') })

  await dialog.getByLabel('Search channels and DMs').fill('fix foot')
  await dialog.getByRole('option', { name: /Fix footer on short turns/ }).click()
  await dialog.getByRole('listitem', { name: 'notes.pdf' }).getByRole('button').click()
  // Nothing has left the device yet.
  expect(uploads).toEqual([])
  await dialog.getByRole('button', { name: 'Send' }).click()

  await dialog.waitFor({ state: 'detached' })
  expect(page.url()).toContain(`#/c/${demo.thread.id}`)
  const sent = page.locator('.messages .message', { hasText: 'Look at this' }).filter({ has: page.locator('.attachments img') }).first()
  await sent.waitFor()
  expect(uploads).toHaveLength(1)
  const last = (await demo.thread.messages.fetch({ limit: 10 })).find((m) => m.content.startsWith('Look at this'))!
  expect(last.content).toBe('Look at this\nhttps://example.com/x')
  expect([...last.attachments.values()].map((a) => a.name)).toEqual(['shot.png'])
  expect(await page.evaluate(() => caches.has('vocorum-share'))).toBe(false)
  await page.close()
}, 120_000)

test.skipIf(!ready)('Cancel drops the shared files on a phone', async () => {
  const page = await context.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  uploads.length = 0
  await share(page, { title: 'Only a title', url: 'https://example.com/y' })
  const dialog = page.getByRole('dialog', { name: 'Share to' })
  await expect.poll(() => dialog.getByLabel('Message').inputValue()).toBe('Only a title\nhttps://example.com/y')
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shots, 'share-phone.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.waitFor({ state: 'detached' })
  await expect.poll(() => page.evaluate(() => caches.has('vocorum-share'))).toBe(false)
  expect(uploads).toEqual([])
  await page.close()
}, 120_000)

test.skipIf(!ready)('without the service worker the hub keeps nothing and the app asks to share again', async () => {
  const bare = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  const sent: string[] = []
  bare.on('request', (r) => (r.url().includes('/client/uploads') || (r.method() === 'POST' && r.url().includes('/messages'))) && sent.push(r.url()))
  const page = await bare.newPage()
  await page.setContent(`<form method="post" enctype="multipart/form-data" action="${origin}/share"><input name="text" value="Look again"><input type="file" name="files"></form>`)
  await page.locator('input[type=file]').setInputFiles([{ name: 'shot.png', mimeType: 'image/png', buffer: fs.readFileSync(path.resolve(import.meta.dirname, '../web/public/icon-192.png')) }])
  await Promise.all([page.waitForURL(`${origin}/**`), page.locator('form').evaluate((f: HTMLFormElement) => f.submit())])
  const note = page.getByRole('status').filter({ hasText: 'share it again' })
  await note.waitFor()
  await page.screenshot({ path: path.join(shots, 'share-again-phone.png') })
  expect(page.url()).toBe(`${origin}/`)
  expect(await page.getByRole('dialog', { name: 'Share to' }).count()).toBe(0)
  expect(sent).toEqual([])
  await bare.close()
}, 60_000)
