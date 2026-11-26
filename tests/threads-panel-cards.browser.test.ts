// The built PWA in headless Chromium: the Threads panel shows each thread as a card with a
// status edge, its question or last step, inline answers, a status filter and keyboard moves.
// Screenshots go to $HUB_SCREENSHOTS. Needs `pnpm build:web` and a Playwright Chromium.
// PANEL_SHOTS=before only captures the panel as it is (for a before and after pair).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, GatewayIntentBits, type TextChannel, type ThreadChannel } from 'discord.js'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import sharp from 'sharp'
import { LOGIN, startTestHub, waitFor } from './helpers.ts'
import { Hub } from '../src/hub.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const shots = process.env['HUB_SCREENSHOTS'] ?? path.join(os.tmpdir(), 'hub-screenshots')
const stage = process.env['PANEL_SHOTS'] === 'before' ? 'before' : 'after'

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
const after = ready && stage === 'after'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const FOOTER = '-# *kimaki ⋅ main ⋅ 1m 12s ⋅ 9% ⋅ studio-large*'

let t: Awaited<ReturnType<typeof startTestHub>>
let hub: Hub
let bot: Client
let browser: Browser
let desktop: BrowserContext
let page: Page
let origin: string
let kimaki: TextChannel
let website: TextChannel
const ids: Record<'archived' | 'tidy' | 'rename' | 'cache' | 'failed' | 'question' | 'buttons' | 'working' | 'docs', string> = {} as never
const answers: string[] = []

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  await t.hub.stop()
  // A Kimaki data dir, so the working thread has a real run clock.
  const kimakiDir = path.join(t.paths.root, 'kimaki-test')
  fs.mkdirSync(path.join(kimakiDir, 'session-events'), { recursive: true })
  process.env['VOCORUM_KIMAKI_DIRS'] = kimakiDir
  process.env['VOCORUM_SYSTEMCTL'] = '/bin/false'
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  const { guildId, ownerUserId: alice } = hub.options.config
  await hub.twin.mirrorUser({ id: alice, username: 'alice', globalName: 'alice' })
  const sam = await hub.twin.createUser({ username: 'sam', globalName: 'sam' })
  await hub.twin.addGuildMember({ guildId, userId: sam })
  const minted = await hub.store.addBot('desk-pc')
  await hub.reload()
  bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], rest: { api: `${hub.localUrl}/api`, version: '10' } })
  const up = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()))
  await bot.login(`${minted.clientId}:${minted.secret}`)
  await up
  bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return
    answers.push(interaction.customId)
    await interaction.update({ content: `Using ${('label' in interaction.component ? interaction.component.label ?? '' : '').toLowerCase()} for the history.`, components: [] })
  })
  const guild = await bot.guilds.fetch(guildId)
  const deskPc = await guild.channels.create({ name: 'desk-pc', type: ChannelType.GuildCategory })
  kimaki = (await guild.channels.create({ name: 'kimaki', type: ChannelType.GuildText, parent: deskPc.id, topic: '~/code/kimaki' })) as TextChannel
  website = (await guild.channels.create({ name: 'website', type: ChannelType.GuildText, parent: deskPc.id })) as TextChannel

  // Threads are seeded oldest first with the clock set back, so ages and order are real.
  const now = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  const thread = async (channel: TextChannel, key: keyof typeof ids, age: number, userId: string, title: string, prompt: string, reply: (thread: ThreadChannel) => Promise<unknown>) => {
    vi.setSystemTime(now - age)
    const starter = await hub.twin.simulateUserMessage({ channelId: channel.id, userId, content: prompt })
    const made = await channel.threads.create({ name: title, startMessage: starter.id })
    ids[key] = made.id
    vi.setSystemTime(now - age + 40_000)
    await reply(made)
    await hub.sessions.recompute(made.id)
    return made
  }
  const old = await thread(kimaki, 'archived', 6 * DAY, alice, 'Add release notes page', 'Add a release notes page to the docs site, generated from the changelog', (th) => th.send(`Added \`docs/releases.md\` and a build step.\n${FOOTER}`))
  await old.setArchived(true)
  await thread(kimaki, 'tidy', 3 * DAY, alice, 'Tidy the README', 'Tidy the README and fix the two broken badge links at the top', (th) => th.send(`Both badges point at the new pipeline now.\n${FOOTER}`))
  await thread(kimaki, 'rename', 2 * DAY, alice, 'Rename workspace panel', 'Rename the workspace panel to Board everywhere it is shown, including the shortcut sheet and the tooltip on the header button', (th) => th.send(`Renamed in 6 files.\n${FOOTER}`))
  await thread(kimaki, 'cache', 1 * DAY, sam, 'Cache the avatar lookups so the member list stops refetching every image each time the panel opens', 'The member list refetches every avatar on open. Cache them for the session and only revalidate when the version changes.', (th) => th.send(`Avatars are cached by version; the panel opens without a single request when nothing changed.\n${FOOTER}`))
  await thread(kimaki, 'failed', 5 * HOUR, alice, 'Migrate settings store', 'Move the settings store from JSON files to the hub database, keeping a one-time import', (th) => th.send('**Error:** `pnpm test` exited with code 1. 3 tests failed in settings.test.ts after the schema change.'))
  await thread(kimaki, 'question', 2 * HOUR, alice, 'Export CSV from the reports table', 'Add an Export CSV button to the reports table', (th) => th.send('**Question:** Should the export include archived rows, or only the rows the current filter shows?'))
  await thread(kimaki, 'buttons', 25 * MIN, alice, 'Fix footer on short turns', 'Fix the footer that goes missing after short turns', (th) =>
    th.send({
      content: 'The fix is on a branch with four small commits. How should it land on main?',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('rebase').setLabel('Rebase').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('squash').setLabel('Squash').setStyle(ButtonStyle.Secondary))],
    }),
  )
  await thread(kimaki, 'working', 14 * MIN, alice, 'Speed up cold start', 'Cold start takes four seconds on the laptop. Find out where the time goes and cut it down.', async (th) => {
    // The run's start comes from the session journal, as on a real machine.
    const db = new DatabaseSync(path.join(kimakiDir, 'kimaki.db'))
    db.exec('CREATE TABLE IF NOT EXISTS thread_sessions (thread_id TEXT PRIMARY KEY, session_id TEXT)')
    db.prepare('INSERT OR REPLACE INTO thread_sessions VALUES (?,?)').run(th.id, 'session_fixture_w')
    db.close()
    const started = Date.now()
    fs.appendFileSync(path.join(kimakiDir, 'session-events', `${th.id}.jsonl`), JSON.stringify({ at: started, event: { id: 'evt_w_1', type: 'session.execution.started', created: started, durable: { aggregateID: 'session_fixture_w', seq: 1, version: 1 }, data: { sessionID: 'session_fixture_w' } } }) + '\n')
    await th.send('-# ┣ read src/startup.ts')
    vi.setSystemTime(now - 20_000)
    await th.send('-# ┣ bash pnpm vitest run tests/startup.test.ts')
  })
  // Another channel with one thread: its panel keeps its own filter.
  vi.setSystemTime(now - 3 * HOUR)
  await thread(website, 'docs', 3 * HOUR, alice, 'Refresh the docs landing page', 'Refresh the docs landing page with the new screenshots', (th) => th.send(`Swapped four screenshots.\n${FOOTER}`))
  vi.useRealTimers()
  // Read: the channels, the quiet ones, one question and the working run. The rest stay unread.
  const read = await hub.twin.prisma.channel.findMany({ where: { id: { in: [kimaki.id, website.id, ids.archived, ids.tidy, ids.rename, ids.question, ids.working, ids.docs] } }, select: { id: true, lastMessageId: true } })
  await hub.store.markRead(alice, read.flatMap((c): Array<[string, string]> => (c.lastMessageId ? [[c.id, c.lastMessageId]] : [])))

  browser = await chromium.launch({ executablePath })
  desktop = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block' })
  page = await desktop.newPage()
  const cdp = await desktop.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  origin = `http://localhost:${hub.port}`
  await page.goto(origin)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing('chromium'))
  await page.getByText('Pair this device').click()
  await page.locator('.sidebar .channel', { hasText: 'kimaki' }).first().waitFor()
}, 120_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await bot?.destroy()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

const shot = (p: Page, name: string) => p.screenshot({ path: path.join(shots, `${name}.png`) })
const panel = (p: Page) => p.locator('.side-panel', { has: p.locator('.panel-title', { hasText: 'Threads' }) })
const card = (p: Page, id: string) => panel(p).locator(`.thread-row[data-thread="${id}"]`)
const order = (p: Page) => panel(p).locator('.thread-row').evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset['thread']))
const sections = (p: Page) => panel(p).locator('.panel-section').allInnerTexts().then((all) => all.map((s) => s.replace(/\s+/g, ' ').trim()))
const fits = (p: Page) =>
  p.evaluate(() => {
    const wide = [...document.querySelectorAll('.side-panel, .side-panel .panel-search, .side-panel .thread-row')].filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 || el.scrollWidth > el.clientWidth)
    return document.documentElement.scrollWidth === document.documentElement.clientWidth && wide.length === 0 ? true : `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth} ${wide.map((el) => `${el.className} ${el.scrollWidth}/${el.clientWidth}`).join('; ')}`
  })
async function openPanel(p: Page, channel: string) {
  await p.goto(`${origin}/#/c/${channel}`)
  // A panel left open would be closed by the button: start from a fresh page.
  await p.reload()
  await p.locator('.chat-header button[aria-label="Threads"]').click()
  await panel(p).locator('.thread-row').first().waitFor()
}
async function openPanelOnPhone(p: Page, channel: string) {
  await p.goto(`${origin}/#/c/${channel}`)
  await p.locator('.chat-header .chat-title').tap()
  await p.locator('.sheet-item', { hasText: 'Threads' }).tap()
  await panel(p).locator('.thread-row').first().waitFor()
  await p.waitForTimeout(400)
}
const phone = async () => browser.newContext({ storageState: await desktop.storageState(), extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, serviceWorkers: 'block', reducedMotion: 'reduce' })

// The approved edge as painted (card-edges.css, sampled as tests/card-edges.mjs does at 2x):
// from the card's outer edge, full height, round outside, flat inside.
async function edgePixels(target: Locator) {
  const { data, info } = await sharp(await target.screenshot({ animations: 'disabled' })).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number) => [...data.subarray((Math.floor(y) * info.width + x) * 3, (Math.floor(y) * info.width + x) * 3 + 3)].join()
  const mark = at(5, info.height / 2)
  const on = (x: number, y: number) => at(x, y) === mark
  return { mark, top: on(8, 5), bottom: on(8, info.height - 6), outerEdge: on(0, info.height / 2), roundTop: !on(2, 2), roundBottom: !on(2, info.height - 3), flatInside: !on(12, 5) && !on(12, info.height - 6) && !on(12, info.height / 2), stopsAtCorner: !on(8, 0) && !on(8, info.height - 1) }
}
const painted = (colour: [number, number, number]) => ({ mark: colour.join(), top: true, bottom: true, outerEdge: true, roundTop: true, roundBottom: true, flatInside: true, stopsAtCorner: true })

test.skipIf(!ready)('screenshots: the Threads panel beside #kimaki, on desktop and on a phone', async () => {
  // Stills are taken with motion reduced, so the working edge shows its full colour.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openPanel(page, kimaki.id)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
  await shot(page, `${stage}-desktop`)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const context = await phone()
  const p = await context.newPage()
  try {
    await openPanelOnPhone(p, kimaki.id)
    await shot(p, `${stage}-phone`)
  } finally {
    await context.close()
  }
})

test.skipIf(!after)('cards: sections, order, edges, lines and the meta line', async () => {
  await openPanel(page, kimaki.id)
  await card(page, ids.cache).locator('.ov-line').waitFor()
  // Active: waiting, failed, working, then newest activity first. Archived keeps its own section.
  expect(await sections(page)).toEqual(['Active 7', 'Archived 1'])
  expect(await order(page)).toEqual([ids.buttons, ids.question, ids.failed, ids.working, ids.cache, ids.rename, ids.tidy, ids.archived])
  const marks = await panel(page).locator('.thread-row').evaluateAll((cards) => cards.map((c) => [(c as HTMLElement).dataset['edge'] ?? null, (c as HTMLElement).dataset['unread'] ?? null]))
  expect(marks).toEqual([['waiting', 'true'], ['waiting', null], ['failed', 'true'], ['busy', null], ['unread', 'true'], [null, null], [null, null], [null, null]])

  // The question, the error and the last step, without the hub's "Question:" or "Error:" lead; else the first prompt.
  const line = (id: string) => card(page, id).locator('.ov-line').innerText()
  expect(await line(ids.buttons)).toBe('The fix is on a branch with four small commits. How should it land on main?')
  expect(await line(ids.question)).toBe('Should the export include archived rows, or only the rows the current filter shows?')
  expect(await line(ids.failed)).toBe('pnpm test exited with code 1. 3 tests failed in settings.test.ts after the schema change.')
  expect(await line(ids.working)).toBe('bash pnpm vitest run tests/startup.test.ts')
  expect(await line(ids.tidy)).toBe('Tidy the README and fix the two broken badge links at the top')
  expect(await card(page, ids.cache).locator('.ov-line').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))).toBe(2)
  // Count and age; a working thread shows its run clock, not the 20 seconds since its last step.
  // A hub that keeps no run clock shows that age instead.
  const meta = (id: string) => card(page, id).locator('.result-where').innerText().then((s) => s.replace(/\s+/g, ' ').trim())
  expect(await meta(ids.working)).toMatch('activity' in hub.sessions ? /^2 1[34]m$/ : /^2 just now$/)
  expect(await meta(ids.tidy)).toBe('1 3d')
  expect(await meta(ids.archived)).toBe('1 6d')
  expect(await card(page, ids.buttons).locator('.action-row button').allInnerTexts()).toEqual(['Rebase', 'Squash'])
  expect(await card(page, ids.question).locator('.action-row').count()).toBe(0)
  expect(await panel(page).locator('.thread-row').evaluateAll((cards) => cards.filter((c) => /desk-pc|alice|sam/i.test(c.querySelector('.result-where')!.textContent!) || c.querySelector('.avatar')).length)).toBe(0)

  // Bright title only when unread.
  const title = (id: string) => card(page, id).locator('.link-title').evaluate((el) => getComputedStyle(el).color)
  expect(await title(ids.cache)).toBe('rgb(255, 255, 255)')
  expect(await title(ids.buttons)).toBe('rgb(255, 255, 255)')
  expect(await title(ids.question)).toBe('rgb(227, 227, 233)')
  expect(await title(ids.tidy)).toBe('rgb(227, 227, 233)')

  // The edge: blue waiting, red failed, pink working, white unread, none when read and quiet.
  await page.mouse.move(0, 0)
  expect(await edgePixels(card(page, ids.question))).toEqual(painted([0, 210, 255]))
  expect(await edgePixels(card(page, ids.failed))).toEqual(painted([255, 77, 94]))
  expect(await edgePixels(card(page, ids.working))).toEqual(painted([255, 46, 136]))
  expect(await edgePixels(card(page, ids.cache))).toEqual(painted([255, 255, 255]))
  expect(await card(page, ids.tidy).evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none')
  const edge = (id: string) => card(page, id).evaluate((el) => { const s = getComputedStyle(el, '::before'); return [s.left, s.top, s.bottom, s.width, s.borderTopLeftRadius, s.borderTopRightRadius, s.animationName].join(' ') })
  // Only the working edge moves, and not when motion is reduced.
  expect(await edge(ids.working)).toBe('-1px -1px -1px 5px 8px 0px thread-edge-breathe')
  for (const id of [ids.buttons, ids.question, ids.failed, ids.cache]) expect(await edge(id)).toBe('-1px -1px -1px 5px 8px 0px none')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await edge(ids.working)).toBe('-1px -1px -1px 5px 8px 0px none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  // Twelve times, nearest neighbour: the top-left and bottom-left corner of each edge colour.
  const corners: Array<{ input: Buffer; left: number; top: number }> = []
  const size = 24
  for (const [i, id] of [ids.working, ids.question, ids.failed, ids.cache].entries()) {
    const png = await card(page, id).screenshot({ animations: 'disabled' })
    const { height } = await sharp(png).metadata()
    for (const [j, top] of [0, height! - size].entries()) corners.push({ input: await sharp(png).extract({ left: 0, top, width: size, height: size }).resize(size * 12, size * 12, { kernel: 'nearest' }).png().toBuffer(), left: 12 + i * (size * 12 + 12), top: 12 + j * (size * 12 + 12) })
  }
  await sharp({ create: { width: 12 + 4 * (size * 12 + 12), height: 12 + 2 * (size * 12 + 12), channels: 3, background: '#3a3a3a' } }).composite(corners).png().toFile(path.join(shots, 'after-edge-zoom.png'))
})

test.skipIf(!after)('the status filter sits beside the search, is kept per channel and leaves the sidebar alone', async () => {
  await openPanel(page, kimaki.id)
  const sidebarRows = () => page.locator('.sidebar [data-thread-row]').count()
  const sidebarFilter = () => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('thread-filter:')).map(([k, v]) => `${k.split(':').slice(2).join(':')}=${v}`).sort())
  const rows = await sidebarRows()
  expect(await sidebarFilter()).toEqual([])
  const trigger = panel(page).getByRole('button', { name: 'Filter threads by status' })
  const [search, button] = await Promise.all([panel(page).locator('.search').boundingBox(), trigger.boundingBox()])
  expect(Math.abs(search!.y + search!.height / 2 - (button!.y + button!.height / 2))).toBeLessThanOrEqual(0.5)
  expect(button!.x).toBeGreaterThanOrEqual(search!.x + search!.width)
  await trigger.click()
  const options = panel(page).locator('.mark-options')
  expect(await options.locator('label').allInnerTexts()).toEqual(['All statuses', 'Working', 'Waiting for you', 'Failed', 'Unread', 'Quiet'])
  for (const label of ['Working', 'Unread', 'Quiet']) await options.getByLabel(label, { exact: true }).uncheck()
  expect(await order(page)).toEqual([ids.buttons, ids.question, ids.failed])
  expect(await sections(page)).toEqual(['Active 3'])
  await page.mouse.move(0, 0)
  await shot(page, 'after-filter-desktop')
  await page.keyboard.press('Escape')
  await options.waitFor({ state: 'detached' })
  expect(await trigger.getAttribute('data-filtered')).toBe('true')
  // The sidebar's own filter and its rows are as they were.
  expect(await sidebarFilter()).toEqual([`panel:${kimaki.id}=6`])
  expect(await sidebarRows()).toBe(rows)
  expect(await page.locator('.sidebar .mark-trigger').getAttribute('data-filtered')).toBeNull()

  // Kept for this channel after a reload; another channel's panel shows everything.
  await page.reload()
  await page.locator('.chat-header button[aria-label="Threads"]').click()
  await card(page, ids.buttons).waitFor()
  expect(await order(page)).toEqual([ids.buttons, ids.question, ids.failed])
  await openPanel(page, website.id)
  expect(await order(page)).toEqual([ids.docs])
  expect(await panel(page).getByRole('button', { name: 'Filter threads by status' }).getAttribute('data-filtered')).toBeNull()

  // Nothing left: the sidebar's own words, and one press restores every status.
  await openPanel(page, kimaki.id)
  await panel(page).getByRole('button', { name: 'Filter threads by status' }).click()
  for (const label of ['Waiting for you', 'Failed']) await panel(page).locator('.mark-options').getByLabel(label, { exact: true }).uncheck()
  await page.keyboard.press('Escape')
  await panel(page).getByText('No matching threads.').waitFor()
  await panel(page).getByRole('button', { name: 'Show all statuses' }).click()
  expect(await order(page)).toHaveLength(8)
  // The search field still narrows by name, with the sections' counts following.
  await panel(page).getByLabel('Search thread names').fill('re')
  expect(await order(page)).toEqual([ids.question, ids.failed, ids.cache, ids.rename, ids.tidy, ids.archived])
  expect(await sections(page)).toEqual(['Active 5', 'Archived 1'])
})

test.skipIf(!after)('phone: the panel fits at 390 and 320 and a card opens its thread', async () => {
  const context = await phone()
  const p = await context.newPage()
  try {
    await openPanelOnPhone(p, kimaki.id)
    for (const width of [390, 320]) {
      await p.setViewportSize({ width, height: 844 })
      await card(p, ids.cache).locator('.ov-line').waitFor()
      expect(await fits(p), `fits at ${width}`).toBe(true)
      expect(await card(p, ids.cache).locator('.link-title b').evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')).toBe(true)
      if (width === 320) await shot(p, 'after-phone-320')
    }
    await card(p, ids.failed).tap({ position: { x: 200, y: 14 } })
    await p.waitForURL(new RegExp(ids.failed))
    await p.locator('.chat-header .title-text', { hasText: 'Migrate settings store' }).waitFor()
  } finally {
    await context.close()
  }
})

test.skipIf(!after)('keyboard: arrows walk the cards and Enter opens the thread, as a click does', async () => {
  await openPanel(page, kimaki.id)
  await panel(page).getByLabel('Search thread names').focus()
  const focused = () => page.evaluate(() => (document.activeElement?.closest('.thread-row') as HTMLElement | null)?.dataset['thread'])
  await page.keyboard.press('ArrowDown')
  expect(await focused()).toBe(ids.buttons)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  expect(await focused()).toBe(ids.failed)
  await page.keyboard.press('ArrowUp')
  expect(await focused()).toBe(ids.question)
  expect(await card(page, ids.question).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  await page.keyboard.press('Enter')
  await page.waitForURL(new RegExp(`#/c/${ids.question}$`))
  await page.locator('.chat-header .title-text', { hasText: 'Export CSV from the reports table' }).waitFor()
  await openPanel(page, kimaki.id)
  await card(page, ids.failed).click({ position: { x: 200, y: 14 } })
  await page.waitForURL(new RegExp(`#/c/${ids.failed}$`))
})

test.skipIf(!after)('a question with buttons is answered on its card', async () => {
  await openPanel(page, kimaki.id)
  await card(page, ids.buttons).getByRole('button', { name: 'Rebase' }).click()
  await expect.poll(() => answers).toEqual(['rebase'])
  // Answered without opening: the same address, and the card has nothing left to ask.
  await expect.poll(() => card(page, ids.buttons).locator('.action-row').count()).toBe(0)
  await expect.poll(() => card(page, ids.buttons).getAttribute('data-edge')).toBe('unread')
  expect(page.url()).toBe(`${origin}/#/c/${kimaki.id}`)
  const message = await waitFor(async () => (await ((await bot.channels.fetch(ids.buttons)) as ThreadChannel).messages.fetch({ limit: 1 })).first())
  expect(message.content).toBe('Using rebase for the history.')
})

test.skipIf(!after)('Create Thread opens the channel at its message box; the body never scrolls sideways', async () => {
  await openPanel(page, kimaki.id)
  const body = panel(page).locator('.panel-body')
  expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
  // On desktop Create sits in the popout's header, after the search, as in Discord.
  const create = panel(page).locator('.panel-head').getByRole('button', { name: 'Create', exact: true })
  expect((await create.boundingBox())!.x).toBeGreaterThan((await panel(page).locator('.panel-head .search').boundingBox())!.x)
  expect(await panel(page).locator('.create-thread').count()).toBe(0)
  expect(await panel(page).locator('.panel-action').isVisible()).toBe(false)
  // From one of its threads (the panel stays open), back to the channel to write the first message.
  await page.goto(`${origin}/#/c/${ids.question}`)
  await page.locator('.chat-header .title-text', { hasText: 'Export CSV from the reports table' }).waitFor()
  await create.click()
  await page.waitForURL(new RegExp(`#/c/${kimaki.id}$`))
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.composer') !== null && (document.activeElement as HTMLTextAreaElement).placeholder)).toBe('Message #kimaki')
  await page.keyboard.press('Escape')
})

test.skipIf(!after)('phone: X, a centred Threads and a + that starts a thread', async () => {
  const context = await phone()
  const p = await context.newPage()
  try {
    await openPanelOnPhone(p, kimaki.id)
    const body = panel(p).locator('.panel-body')
    expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
    const head = (await panel(p).locator('.panel-head').boundingBox())!
    const x = (await panel(p).locator('.panel-back').boundingBox())!
    const plus = (await panel(p).locator('.panel-head .panel-action').boundingBox())!
    const title = await panel(p).locator('.panel-title').evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return b.left + b.width / 2 })
    expect(x.x).toBeLessThan(head.width / 4)
    expect(plus.x).toBeGreaterThan((head.width * 3) / 4)
    expect(Math.abs(title - head.width / 2)).toBeLessThanOrEqual(1)
    await panel(p).locator('.panel-head .panel-action').tap()
    await p.waitForURL(new RegExp(`#/c/${kimaki.id}$`))
    await panel(p).waitFor({ state: 'detached' })
  } finally {
    await context.close()
  }
})

test.skipIf(!after)('desktop: Threads, Pinned and Inbox float from their icons; the chat keeps its width; a click outside or Esc closes them', async () => {
  await page.goto(`${origin}/#/c/${kimaki.id}`)
  await page.reload()
  await page.locator('.app > .chat .message').last().waitFor()
  const chat = page.locator('.app > .chat')
  const chatWidth = (await chat.boundingBox())!.width
  const headerBottom = await page.locator('.app > .chat > .chat-header').evaluate((el) => el.getBoundingClientRect().bottom)
  const box = (l: Locator) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } })
  for (const [label, width, head] of [['Threads', 556, 48], ['Pinned messages', 422, 56]] as const) {
    const trigger = page.locator(`.app > .chat > .chat-header button[aria-label="${label}"]`)
    await trigger.click()
    const pop = page.locator('.side-panel.popout')
    await pop.waitFor()
    const [p, t] = [await box(pop), await box(trigger)]
    expect(p.width).toBe(width)
    expect(Math.abs(p.right - t.right)).toBeLessThanOrEqual(1)
    expect(Math.abs(p.y - headerBottom)).toBeLessThanOrEqual(1)
    expect((await box(pop.locator('.panel-head'))).height).toBe(head)
    expect(await pop.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
    expect((await chat.boundingBox())!.width).toBe(chatWidth)
    if (label === 'Threads') {
      // Search and Create in the 48px header; the height follows the cards, capped to the window.
      await pop.locator('.panel-head .search input').waitFor()
      await pop.locator('.panel-head').getByRole('button', { name: 'Create', exact: true }).waitFor()
      expect(p.bottom).toBeLessThanOrEqual(900)
      // A click on the trigger closes it, as a toggle.
      await trigger.click()
      await pop.waitFor({ state: 'detached' })
    } else {
      expect(p.height).toBeLessThan(400)
      // A click in the chat closes it.
      await page.mouse.click((await chat.boundingBox())!.x + chatWidth - 40, 600)
      await pop.waitFor({ state: 'detached' })
    }
  }
  // The inbox bell sits low on the left, in the user panel: its popout opens upward from there.
  await page.locator('.inbox-button').click()
  const inbox = page.locator('.side-panel.popout.inbox-panel')
  await inbox.waitFor()
  const [p, user] = [await box(inbox), await box(page.locator('.user-panel'))]
  expect(p.width).toBe(562)
  expect(Math.abs(p.x - user.x)).toBeLessThanOrEqual(1)
  expect(p.bottom).toBeLessThanOrEqual(user.y)
  expect((await chat.boundingBox())!.width).toBe(chatWidth)
  await page.keyboard.press('Escape')
  await inbox.waitFor({ state: 'detached' })
})
