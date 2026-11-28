// The voice room in the built PWA: the channel's own chat beside the call (a pane on
// desktop, a full-height panel on phones), typing into it, reading it without joining,
// the call time, and the phone's call pill on other screens. The hub's voice socket is
// mocked; the microphone is Chromium's fake device.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core'
import { LOGIN, startTestHub } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'
import { STEPS, seedVoiceRoom } from './voice-room-seed.ts'
import { Hub } from '../src/hub.ts'

const webDir = process.env['VOICE_TEST_WEB'] ?? path.resolve(import.meta.dirname, '../web/dist')

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
let room: { id: string }

// On the loopback test hub a person is named by a request header, which a worklet's
// module request does not carry: load the capture worklet through fetch instead, so the
// call has its microphone (the context drops the page's script policy for the blob).
function workletThroughFetch() {
  const add = AudioWorklet.prototype.addModule
  AudioWorklet.prototype.addModule = async function (url: string | URL, options?: WorkletOptions) {
    const text = await (await fetch(url)).text()
    return add.call(this, URL.createObjectURL(new Blob([text], { type: 'text/javascript' })), options)
  }
}

async function device(options: BrowserContextOptions) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', bypassCSP: true, ...options })
  await context.addInitScript(workletThroughFetch)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  // The client's screens and states are under test, not the audio path.
  await page.routeWebSocket(/\/client\/voice/, () => {})
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await page.goto(origin)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing(`desk-pc-${Math.random()}`))
  await page.getByText('Pair this device').click()
  await page.locator('.channel').first().waitFor()
  return page
}

// Nothing wider than the window: the page, the message list, the dock and the pill.
const overflow = (p: Page) =>
  p.evaluate(() => {
    const width = window.innerWidth
    const out = [...document.querySelectorAll<HTMLElement>('.voice-button, .voice-join, .voice-controls, .voice-chip, .voice-tile, .call-pill, .call-pill *, .voice-chat, .voice-chat .footer')]
      .filter((el) => el.getBoundingClientRect().width > 0 && (el.getBoundingClientRect().left < -0.5 || el.getBoundingClientRect().right > width + 0.5))
      .map((el) => el.className)
    const list = document.querySelector<HTMLElement>('.voice-chat .messages')
    return { page: document.documentElement.scrollWidth - width, list: list ? list.scrollWidth - list.clientWidth : 0, out }
  })

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  room = await seedVoiceRoom(hub, demo)
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

test.skipIf(!ready)('desktop: the chat sits beside the call under one header, reads before joining, takes a typed message and remembers being closed', async () => {
  const p = await device({ viewport: { width: 1280, height: 800 } })
  try {
    await p.goto(`${origin}/#/c/${room.id}`)
    const view = p.locator('.voice-view'), chat = view.locator('.voice-chat')
    // A room with messages opens with them, and nobody has joined by opening it.
    await chat.locator('.message', { hasText: 'keep the call timer across reconnects' }).waitFor()
    await view.getByRole('button', { name: 'Join voice' }).waitFor()
    expect(await p.locator('.voice-strip').count()).toBe(0)
    expect(hub.twin.voiceStates().map((s) => s.user_id)).toEqual([hub.options.config.botUserId])
    // The same messages as anywhere: spoken lines keep their label and transcript, the
    // agent's tool lines fold into steps, its card keeps its accent.
    expect(await chat.locator('.voice-note-label').count()).toBe(2)
    await expect(chat.locator('.voice-transcript').first().textContent()).resolves.toBe('Open the voice code and tell me why the call timer starts again after a reconnect.')
    const steps = chat.locator('button.steps')
    await expect(steps.textContent()).resolves.toContain(`${STEPS.length} steps`)
    await steps.click()
    expect(await chat.locator('.steps-list .step-line').count()).toBe(STEPS.length)
    await steps.click()
    expect(await chat.locator('.container.accented').count()).toBe(1)
    // One header for the call and its chat; the pane is 400px and the stage keeps the rest.
    expect(await view.locator('.chat-header').count()).toBe(1)
    expect(await chat.locator('.panel-head').isVisible()).toBe(false)
    const [pane, stage] = [(await chat.boundingBox())!, (await view.locator('.voice-main').boundingBox())!]
    expect(pane.width).toBe(400)
    expect(Math.round(stage.x + stage.width)).toBe(Math.round(pane.x))
    expect(Math.round(pane.x + pane.width)).toBe(1280)

    // The header's button closes and opens it, and this device remembers.
    await view.getByRole('button', { name: 'Hide chat' }).click()
    await chat.waitFor({ state: 'detached' })
    await expect(view.getByRole('button', { name: 'Show chat' }).getAttribute('aria-pressed')).resolves.toBe('false')
    await p.reload()
    await view.getByRole('button', { name: 'Show chat' }).waitFor()
    expect(await chat.count()).toBe(0)
    await view.getByRole('button', { name: 'Show chat' }).click()
    await chat.locator('.message').last().waitFor()
    await p.reload()
    await view.getByRole('button', { name: 'Hide chat' }).waitFor()
    await chat.locator('.message').last().waitFor()

    // Typed into the call: it appears, and the agent in the room gets it.
    await chat.getByPlaceholder('Message #pairing').fill('Is the timer right on phones too?')
    await p.keyboard.press('Enter')
    await chat.locator('.message', { hasText: 'Is the timer right on phones too?' }).first().waitFor()
    await chat.locator('.message', { hasText: 'Got it: Is the timer right on phones too?' }).waitFor()

    // Joined: a tile each, the agent's status on its tile, and the call time in the strip.
    await view.getByRole('button', { name: 'Join voice' }).click()
    await view.locator('.voice-tile').nth(1).waitFor()
    await expect(view.locator('.voice-activity.tile').textContent()).resolves.toBe('Running the browser test')
    const time = p.locator('.voice-strip [role=timer]')
    await time.waitFor()
    const first = await time.textContent()
    expect(first).toMatch(/^0:0\d$/)
    await expect.poll(() => time.textContent(), { timeout: 5000 }).not.toBe(first)
    expect(await p.locator('.call-pill').count()).toBe(0)

    // A narrow window: the chat is a side panel over the call, opened when asked.
    await p.setViewportSize({ width: 1000, height: 800 })
    await chat.waitFor({ state: 'detached' })
    await view.getByRole('button', { name: 'Show chat' }).click()
    await chat.locator('.panel-head').waitFor()
    expect((await chat.boundingBox())!.height).toBe(800)
    await chat.getByRole('button', { name: 'Close', exact: true }).click()
    await chat.waitFor({ state: 'detached' })
    // The choice made beside the call is kept.
    await p.setViewportSize({ width: 1280, height: 800 })
    await chat.locator('.message').last().waitFor()
  } finally {
    await p.context().close()
  }
}, 90_000)

test.skipIf(!ready)('phone: the dock opens the chat as a full-height panel, and a pill under the header keeps the call in reach on other screens', async () => {
  const p = await device({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  try {
    // A fresh load on the room: on phones the channel list covers it otherwise.
    await p.goto(`${origin}/#/c/${room.id}`)
    await p.reload()
    const view = p.locator('.voice-view'), chat = view.locator('.voice-chat'), pill = p.locator('.call-pill')
    // The call keeps the screen; the chat is one tap away, before joining too.
    await view.getByRole('button', { name: 'Join voice' }).waitFor()
    expect(await chat.count()).toBe(0)
    expect(await view.locator('.chat-header').getByRole('button', { name: 'Show chat' }).isVisible()).toBe(false)
    await view.locator('.voice-controls').getByRole('button', { name: 'Show chat' }).tap()
    await chat.locator('.message', { hasText: 'keep the call timer across reconnects' }).waitFor()
    expect(await chat.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
    expect(await overflow(p)).toEqual({ page: 0, list: 0, out: [] })
    await chat.getByRole('button', { name: 'Close panel' }).tap()
    await chat.waitFor({ state: 'detached' })
    expect(await p.locator('.voice-strip').count()).toBe(0)

    await view.getByRole('button', { name: 'Join voice' }).tap()
    await view.locator('.voice-tile').nth(1).waitFor()
    await view.getByRole('button', { name: 'Leave voice' }).waitFor()
    // In the room its own dock has the controls: no pill.
    expect(await pill.count()).toBe(0)
    expect(await overflow(p)).toEqual({ page: 0, list: 0, out: [] })

    // Elsewhere: the room, the call time, mute and leave, under the header and above the page.
    await p.goto(`${origin}/#/c/${demo.thread.id}`)
    await pill.waitFor()
    await expect(pill.locator('.voice-strip-status').textContent()).resolves.toBe('pairing')
    await expect(pill.locator('[role=timer]').textContent()).resolves.toMatch(/^\d+:\d\d$/)
    const [bar, head, list] = [(await pill.boundingBox())!, (await p.locator('.chat > .chat-header').boundingBox())!, (await p.locator('.messages').boundingBox())!]
    expect(bar.y).toBeGreaterThanOrEqual(head.y + head.height)
    expect(list.y).toBeGreaterThanOrEqual(bar.y + bar.height)
    expect(await overflow(p)).toEqual({ page: 0, list: 0, out: [] })
    await pill.getByRole('button', { name: 'Mute' }).tap()
    await pill.getByRole('button', { name: 'Unmute' }).tap()
    await pill.getByRole('button', { name: 'Mute' }).waitFor()
    // On the overview too.
    await p.goto(`${origin}/#/overview`)
    await p.locator('.chat.overview').waitFor()
    expect(await pill.isVisible()).toBe(true)

    // A tap on it returns to the room.
    await pill.getByRole('button', { name: 'Return to pairing' }).tap()
    await view.locator('.voice-tile').nth(1).waitFor()
    await p.waitForURL(new RegExp(room.id))
    expect(await pill.count()).toBe(0)

    // The narrowest phones: nothing leaves the screen, in the room, its chat or under the pill.
    await p.setViewportSize({ width: 320, height: 640 })
    expect(await overflow(p)).toEqual({ page: 0, list: 0, out: [] })
    // In the call the chat is a chip in the header, not in the dock.
    expect(await view.locator('.voice-controls').getByRole('button', { name: 'Show chat' }).count()).toBe(0)
    await view.locator('.chat-header').getByRole('button', { name: 'Show chat' }).tap()
    await chat.locator('.message').last().waitFor()
    expect(await overflow(p)).toEqual({ page: 0, list: 0, out: [] })
    await chat.getByRole('button', { name: 'Close panel' }).tap()
    await p.goto(`${origin}/#/c/${demo.thread.id}`)
    await pill.waitFor()
    expect(await overflow(p)).toEqual({ page: 0, list: 0, out: [] })

    // Leaving from the pill ends the call and removes it.
    await pill.getByRole('button', { name: 'Leave voice' }).tap()
    await pill.waitFor({ state: 'detached' })
  } finally {
    await p.context().close()
  }
}, 90_000)
