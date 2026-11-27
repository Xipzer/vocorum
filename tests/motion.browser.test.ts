// The built PWA in headless Chromium: scrolling, arrivals and the owner's own actions move as
// Discord's desktop app does (measured from 60 fps captures of it). Page Up and Page Down in
// the message box page the messages with Discord's 580 ms glide; new messages, the owner's
// own sends (from the bottom or scrolled up), reactions, Mark unread and Mark as read land on
// one frame; the delete confirmation opens and leaves as Discord's confirm dialog; the image
// viewer opens centred and closes as Discord's does; starting a reply shows its bar and
// highlights the message on one frame.
// Needs `pnpm build:web` and a Playwright Chromium.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { ChannelType, Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { LOGIN, startTestHub } from './helpers.ts'
import { Hub } from '../src/hub.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')

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
let page: Page
let channel: TextChannel

beforeAll(async () => {
  if (!ready) return
  t = await startTestHub()
  await t.hub.stop()
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  const { guildId, ownerUserId: alice } = hub.options.config
  await hub.twin.mirrorUser({ id: alice, username: 'alice', globalName: 'alice' })
  const minted = await hub.store.addBot('desk-pc')
  await hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], rest: { api: `${hub.localUrl}/api`, version: '10' } })
  const up = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await up
  const guild = await bot.guilds.fetch(guildId)
  channel = (await guild.channels.create({ name: 'kimaki', type: ChannelType.GuildText })) as TextChannel
  for (let i = 1; i <= 60; i++) await channel.send(`Line ${i}: a reply long enough to wrap onto a second line in a narrow window, so the history is several pages tall.`)

  browser = await chromium.launch({ executablePath })
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  // A window in front, as the owner's is when they send: the app eases only for a focused window.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await page.goto(`http://localhost:${hub.port}`)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing('chromium'))
  await page.getByText('Pair this device').click()
  await page.goto(`http://localhost:${hub.port}/#/c/${channel.id}`)
  await page.locator('.message', { hasText: 'Line 60:' }).waitFor()
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await bot?.destroy()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

const list = (p: Page) => p.locator('.chat:not(.split) .messages').first()
const gap = (p: Page) => list(p).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

// Recordings run in the page, one sample per animation frame, stamped with the frame's own
// time, so they hold however late frames come on a busy machine. Each is armed (its first
// frame sampled) before the input that starts what it watches, and stops on that thing's end
// state plus a few frames, or after a generous bound. Per frame: the list's scroll position,
// height and distance from the bottom; for each probe selector, how many match, how many
// animations and transitions run on or under them, and the first match's height. Every CSS
// animation seen on or under a probe is kept as "name duration pseudo", including ones too
// short to span a frame.
type Probe = [number, number, number]
type Frame = { t: number; top: number; tall: number; gap: number } & Record<string, Probe>
type Recording = { frames: Frame[]; seen: Record<string, string[]>; reached: boolean }
// The end state: each probe's match count, or 'still' for the list at rest after moving.
type Until = Record<string, number> | 'still'
const AFTER = 10
const record = async (p: Page, probes: Record<string, string>, until: Until) => {
  await list(p).evaluate(
    (el, { probes, until, after }) =>
      new Promise<void>((armed) => {
        ;(window as { recorded?: Promise<Recording> }).recorded = new Promise((resolve) => {
          const frames: Frame[] = []
          const seen: Record<string, Set<string>> = Object.fromEntries(Object.keys(probes).map((k) => [k, new Set()]))
          const under = (target: Element) => Object.entries(probes).filter(([, sel]) => [...document.querySelectorAll(sel)].some((f) => f.contains(target))).map(([k]) => k)
          const ms = (s: string) => parseFloat(s) * (s.endsWith('ms') ? 1 : 1000)
          const started = (e: AnimationEvent) => {
            const style = getComputedStyle(e.target as Element, e.pseudoElement || null)
            const duration = ms(style.animationDuration.split(', ')[style.animationName.split(', ').indexOf(e.animationName)] ?? '0s')
            for (const k of under(e.target as Element)) seen[k]!.add(`${e.animationName} ${duration} ${e.pseudoElement}`)
          }
          document.addEventListener('animationstart', started, true)
          let left = -1, still = 0, moved = false
          const finish = (reached: boolean) => {
            document.removeEventListener('animationstart', started, true)
            resolve({ frames, seen: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v].sort()])), reached })
          }
          const tick = (now: number) => {
            const row = { t: now, top: el.scrollTop, tall: el.scrollHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop } as Frame
            for (const [name, sel] of Object.entries(probes)) {
              const found = [...document.querySelectorAll<HTMLElement>(sel)]
              const running = found.flatMap((f) => f.getAnimations({ subtree: true }))
              for (const a of running) if (a instanceof CSSAnimation) seen[name]!.add(`${a.animationName} ${a.effect?.getTiming().duration} ${(a.effect as KeyframeEffect).pseudoElement ?? ''}`)
              row[name] = [found.length, running.length, found[0]?.offsetHeight ?? 0]
            }
            const prev = frames.at(-1)
            frames.push(row)
            if (left < 0) {
              if (until === 'still') {
                moved ||= !!prev && row.top !== prev.top
                still = moved && prev && row.top === prev.top ? still + 1 : 0
                if (still >= after && now - frames[frames.length - 1 - still]!.t >= 250) left = 0
              } else if (Object.entries(until).every(([k, n]) => row[k]![0] === n)) left = after
            } else left--
            if (frames.length === 1) armed()
            if (left === 0) finish(true)
            else if (now - frames[0]!.t > 10_000) finish(false)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      }),
    { probes, until, after: AFTER },
  )
  return async () => {
    const out = await p.evaluate(() => (window as { recorded?: Promise<Recording> }).recorded!)
    expect(out.reached, 'the recording saw its end state').toBe(true)
    return out
  }
}
// The first frame a probe's count changes.
const flip = (frames: Frame[], name: string) => frames.findIndex((f) => f[name]![0] !== frames[0]![name]![0])
// Discord's paging glide, as the app eases it.
const GLIDE_MS = 580
const curve = (s: number, a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3
const ease = (t: number) => {
  let lo = 0, hi = 1
  for (let i = 0; i < 20; i++) { const s = (lo + hi) / 2; if (curve(s, 0.23, 0.23) < t) lo = s; else hi = s }
  return curve((lo + hi) / 2, 0.04, 1)
}

test.skipIf(!ready)('Page Up and Page Down in the message box page the messages with a glide', async () => {
  // The whole history in first: a page of it arriving mid-glide (as it may when the machine is
  // busy) moves the content under the glide, and this measures the glide alone.
  const earlier = list(page).getByLabel('Load earlier messages')
  await expect.poll(async () => { await earlier.click({ timeout: 1000 }).catch(() => {}); return earlier.count() }, { timeout: 20_000 }).toBe(0)
  await list(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  const box = page.locator('.composer textarea')
  await box.click()
  const height = await list(page).evaluate((el) => el.clientHeight)
  const stop = await record(page, {}, 'still')
  await box.press('PageUp')
  const { frames } = await stop()
  // Should anything still land above, the list keeps it out of the way: follow where the
  // content is, not the raw scroll position.
  const at = frames.map((f) => f.top - (f.tall - frames[0]!.tall))
  const from = at[0]!, to = at.at(-1)!
  expect(from - to).toBeGreaterThan(height * 0.8)
  expect(from - to).toBeLessThan(height)
  // Discord's 580 ms glide on the page's clock, not a jump or a 150 ms native step: the key
  // came after the first frame and before the first frame that moved, so each frame's progress
  // lies on the curve between those two starts. A frame may show the glide's step from the
  // frame before (whichever animation-frame callback runs first), hence the earlier bound.
  const go = at.findIndex((x) => x !== from)
  expect(go).toBeGreaterThan(0)
  const between = frames.slice(go).map((f, i) => [(from - at[go + i]!) / (from - to), ease(Math.min(1, Math.max(0, frames[go + i - 1]!.t - frames[go]!.t) / GLIDE_MS)), ease(Math.min(1, (f.t - frames[0]!.t) / GLIDE_MS))])
  for (const [done, least, most] of between) {
    expect(done).toBeGreaterThanOrEqual(least! - 0.02)
    expect(done).toBeLessThanOrEqual(most! + 0.02)
  }
  expect(between.some(([done]) => done! > 0.02 && done! < 0.98)).toBe(true)
  expect(await box.evaluate((el) => el === document.activeElement)).toBe(true)
  await box.press('PageDown')
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
})

test.skipIf(!ready)('a new message from someone else is placed at once, as on Discord', async () => {
  await list(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  // Record the gap on each frame from the first frame the new message is on screen.
  const watching = list(page).evaluate(
    (el) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = []
        const tick = () => {
          if (el.querySelector('.message:last-child, .message') && [...el.querySelectorAll('.message')].some((m) => m.textContent?.includes('Arrived'))) out.push(el.scrollHeight - el.clientHeight - el.scrollTop)
          if (out.length < 10) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
  )
  await channel.send('Arrived: a reply from the agent while the owner reads the bottom of the thread.')
  const gaps = await watching
  expect(gaps.every((g) => g <= 1)).toBe(true)
})

const toBottom = async () => {
  await list(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
}
// The list's distance from the bottom on each of the first ten frames a message with this text is shown.
const gapsOnceShown = (p: Page, text: string) =>
  list(p).evaluate(
    (el, text) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = []
        const tick = () => {
          if ([...el.querySelectorAll('.message')].some((m) => m.textContent?.includes(text))) out.push(el.scrollHeight - el.clientHeight - el.scrollTop)
          if (out.length < 10) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
    text,
  )

test.skipIf(!ready)('the owner\'s own send lands on one frame at the bottom, with no glide', async () => {
  await toBottom()
  const box = page.locator('.composer textarea')
  await box.fill('Own at the bottom: a note from the owner')
  const watching = gapsOnceShown(page, 'Own at the bottom')
  await box.press('Enter')
  expect((await watching).every((g) => g <= 1)).toBe(true)
  await list(page).locator('.message:not(.sending)', { hasText: 'Own at the bottom' }).waitFor()
})

test.skipIf(!ready)('sending while scrolled up jumps straight to the bottom on one frame', async () => {
  await toBottom()
  await list(page).evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight * 3))
  await expect.poll(() => gap(page)).toBeGreaterThan(1000)
  const box = page.locator('.composer textarea')
  await box.fill('Own while scrolled up: a note from the owner')
  const watching = gapsOnceShown(page, 'Own while scrolled up')
  await box.press('Enter')
  expect((await watching).every((g) => g <= 1)).toBe(true)
  await list(page).locator('.message:not(.sending)', { hasText: 'Own while scrolled up' }).waitFor()
})

test.skipIf(!ready)('the owner\'s message shows the moment it is sent, and the hub\'s copy replaces it', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let fail = false
  await page.route('**/client/channels/*/messages', async (r) => {
    if (r.request().method() !== 'POST') return r.continue()
    await gate
    if (fail) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'The hub is unreachable' }) })
    await r.continue()
  })
  try {
    const box = page.locator('.composer textarea')
    await box.fill('Sent at once: a note from the owner')
    await box.press('Enter')
    // Before the hub has answered: dimmed in the list, and the box is clear for the next one.
    const sending = list(page).locator('.message.sending', { hasText: 'Sent at once: a note from the owner' })
    await sending.waitFor()
    expect(await box.inputValue()).toBe('')
    release()
    const copies = list(page).locator('.message', { hasText: 'Sent at once: a note from the owner' })
    await expect.poll(() => sending.count()).toBe(0)
    await expect.poll(() => copies.count()).toBe(1)

    // A send the hub refuses goes away again and gives the text back.
    fail = true
    await box.fill('Never arrives: the hub refuses this one')
    await box.press('Enter')
    await expect.poll(() => list(page).locator('.message.sending').count()).toBe(0)
    await expect.poll(() => box.inputValue()).toBe('Never arrives: the hub refuses this one')
    expect(await list(page).locator('.message', { hasText: 'Never arrives' }).count()).toBe(0)
    await box.fill('')
  } finally {
    release()
    await page.unroute('**/client/channels/*/messages')
  }
})

test.skipIf(!ready)('a reaction appears and goes on one frame, the row resizing with it, as on Discord', async () => {
  await toBottom()
  const message = list(page).locator('.message', { hasText: 'Line 60:' })
  const id = await message.getAttribute('id')
  const probes = { pill: `#${id} .reaction.me`, row: `#${id}` }
  await message.hover()
  let stop = await record(page, probes, { pill: 1 })
  await message.getByRole('button', { name: 'React 👍' }).click()
  let { frames } = await stop()
  let at = flip(frames, 'pill')
  expect(at).toBeGreaterThan(0)
  // Full size and opaque on its first frame: no pop, and the row is already its new height.
  expect(frames.slice(at).every((f) => f.pill![0] === 1 && f.pill![1] === 0 && f.row![2] === frames.at(-1)!.row![2])).toBe(true)
  expect(await list(page).locator(probes.pill).evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  const tall = frames.at(-1)!.row![2]
  stop = await record(page, probes, { pill: 0 })
  await list(page).locator(probes.pill).click()
  ;({ frames } = await stop())
  at = flip(frames, 'pill')
  expect(at).toBeGreaterThan(0)
  expect(frames.slice(at).every((f) => f.pill![0] === 0 && f.row![2] < tall && f.row![2] === frames.at(-1)!.row![2])).toBe(true)
})

test.skipIf(!ready)('the delete confirmation opens and leaves as Discord\'s; the message goes on one frame', async () => {
  await toBottom()
  const message = list(page).locator('.message', { hasText: 'Own at the bottom' })
  const id = await message.getAttribute('id')
  await message.click({ button: 'right' })
  const opening = await record(page, { open: '.sheet.confirm' }, { open: 1 })
  await page.locator('.sheet-item', { hasText: 'Delete' }).click()
  // In as Discord's modal card: 120 ms, growing from 0.9 as it fades in.
  expect((await opening()).seen.open).toEqual(['card-in 120 '])
  const confirm = page.locator('.sheet.confirm')
  const stop = await record(page, { layer: '.sheet-layer', leaving: '.sheet-layer[data-leaving]', card: '.sheet-layer[data-leaving] .sheet.confirm', row: `#${id}` }, { layer: 0, row: 0 })
  await confirm.locator('.sheet-item', { hasText: 'Delete' }).click()
  const { frames, seen } = await stop()
  // Out over 120 ms on the page's clock, shrinking to 0.9: from the last frame before it began
  // leaving to the first frame without it.
  expect(seen.card).toEqual(['confirm-out 120 '])
  const leaving = flip(frames, 'leaving')
  expect(leaving).toBeGreaterThan(0)
  expect(frames[flip(frames, 'layer')]!.t - frames[leaving - 1]!.t).toBeGreaterThanOrEqual(120)
  const gone = flip(frames, 'row')
  expect(gone).toBeGreaterThan(0)
  // No collapse: the row is there at full height or not at all, and the bottom stays in place.
  expect(frames.slice(0, gone).every((f) => f.row![1] === 0 && f.row![2] === frames[0]!.row![2])).toBe(true)
  expect(frames.slice(gone).every((f) => f.row![0] === 0 && f.gap <= 1)).toBe(true)
})

test.skipIf(!ready)('Mark unread shows the line and the bar on one frame; Mark as read takes both away on one', async () => {
  const message = list(page).locator('.message', { hasText: 'Line 40:' })
  await message.scrollIntoViewIfNeeded()
  await message.click({ button: 'right' })
  let stop = await record(page, { line: '.new-divider', bar: '.new-bar' }, { line: 1 })
  await page.locator('.sheet-item', { hasText: 'Mark unread' }).click()
  let { frames, seen } = await stop()
  const at = flip(frames, 'line')
  expect(at).toBeGreaterThan(0)
  expect(frames.slice(at).every((f) => f.line![0] === 1 && f.line![1] === 0)).toBe(true)
  // Read down past it: the bar above, whole from its first frame.
  const before = { frames, seen }
  stop = await record(page, { bar: '.new-bar' }, { bar: 1 })
  await toBottom()
  ;({ frames, seen } = await stop())
  expect([...before.seen.bar!, ...seen.bar!]).toEqual([])
  expect([...before.frames, ...frames].every((f) => f.bar![0] === 0 || f.bar![1] === 0)).toBe(true)
  stop = await record(page, { line: '.new-divider', bar: '.new-bar' }, { line: 0, bar: 0 })
  await page.locator('.new-bar-read').click()
  ;({ frames } = await stop())
  const off = flip(frames, 'bar')
  expect(off).toBeGreaterThan(0)
  expect(frames.slice(off).every((f) => f.bar![0] === 0 && f.line![0] === 0)).toBe(true)
})

// A solid PNG, so the test needs no image files.
function png(w: number, h: number) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

// Animations running under a selector now, pseudo-elements included, as a recording keeps them.
const animations = (p: Page, sel: string) =>
  p.locator(sel).evaluate((el) => el.getAnimations({ subtree: true }).map((a) => [(a as CSSAnimation).animationName, a.effect?.getTiming().duration, (a.effect as KeyframeEffect).pseudoElement ?? ''].join(' ')).sort())

test.skipIf(!ready)('the image viewer opens centred and closes as Discord\'s does', async () => {
  await channel.send({ content: 'A picture to open', files: [{ attachment: png(240, 160), name: 'picture.png' }] })
  await toBottom()
  const open = list(page).locator('.message', { hasText: 'A picture to open' }).locator('.media-open')
  await open.waitFor()
  // On the first frame it shows, the picture sits in the middle of the window, not on the thumbnail.
  const first = page.evaluate(
    () =>
      new Promise<{ x: number; y: number; w: number; h: number }>((resolve) => {
        const tick = () => {
          const img = document.querySelector('.lightbox-stage img')
          if (!img) return requestAnimationFrame(tick)
          const r = img.getBoundingClientRect()
          resolve({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight })
        }
        requestAnimationFrame(tick)
      }),
  )
  const opening = await record(page, { open: '.lightbox' }, { open: 1 })
  await open.click()
  const at = await first
  expect(Math.abs(at.x - at.w / 2)).toBeLessThan(40)
  expect(Math.abs(at.y - at.h / 2)).toBeLessThan(40)
  // The backdrop darkens in two frames; the picture (from 0.95) and its bar fade in together.
  expect((await opening()).seen.open).toEqual(['fade 130 ', 'fade 50 ::before', 'lightbox-in 130 '])
  await expect.poll(() => animations(page, '.lightbox')).toEqual([])
  const stop = await record(page, { open: '.lightbox', leaving: '.lightbox[data-leaving]' }, { open: 0 })
  await page.keyboard.press('Escape')
  const { frames, seen } = await stop()
  // Out: the backdrop lifts in 80 ms, the picture and bar fade by 130 ms, and it stays over
  // those 130 ms of the page's clock, from the last frame before it began leaving.
  expect(seen.leaving).toEqual(['fade-out 130 ', 'fade-out 80 ::before', 'lightbox-out 130 '])
  const leaving = flip(frames, 'leaving')
  const gone = flip(frames, 'open')
  expect(leaving).toBeGreaterThan(0)
  expect(gone).toBeGreaterThan(leaving)
  expect(frames[gone]!.t - frames[leaving - 1]!.t).toBeGreaterThanOrEqual(130)
  await page.locator('.lightbox').waitFor({ state: 'detached' })
})

test.skipIf(!ready)('starting a reply shows its bar and highlights the message on one frame; Esc takes both away on one', async () => {
  await toBottom()
  const message = list(page).locator('.message', { hasText: 'Line 59:' })
  const id = await message.getAttribute('id')
  const probes = { bar: '.composer-box .footer-line:has([aria-label="Cancel reply"])', target: `#${id}.replying` }
  await message.click({ button: 'right' })
  let stop = await record(page, probes, { bar: 1, target: 1 })
  await page.locator('.sheet-item', { hasText: 'Reply' }).first().click()
  let { frames } = await stop()
  const at = flip(frames, 'bar')
  expect(at).toBeGreaterThan(0)
  expect(flip(frames, 'target')).toBe(at)
  // No slide or fade: both whole from their first frame.
  expect(frames.slice(at).every((f) => f.bar![0] === 1 && f.bar![1] === 0 && f.target![0] === 1 && f.target![1] === 0 && f.bar![2] === frames.at(-1)!.bar![2])).toBe(true)
  // The highlight is Vocorum's own highlight colour, and stays under the pointer.
  const colours = await message.evaluate((el) => {
    const probe = document.createElement('div')
    probe.className = 'message highlight'
    el.parentElement!.append(probe)
    const want = getComputedStyle(probe).backgroundColor
    probe.remove()
    return [getComputedStyle(el).backgroundColor, want]
  })
  expect(colours[0]).toBe(colours[1])
  expect(colours[0]).not.toBe('rgba(0, 0, 0, 0)')
  await message.hover()
  expect(await message.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(colours[1])
  const box = page.locator('.composer textarea')
  await box.focus()
  stop = await record(page, probes, { bar: 0, target: 0 })
  await box.press('Escape')
  ;({ frames } = await stop())
  const off = flip(frames, 'bar')
  expect(off).toBeGreaterThan(0)
  expect(flip(frames, 'target')).toBe(off)
  expect(frames.slice(off).every((f) => f.bar![0] === 0 && f.target![0] === 0)).toBe(true)
})
