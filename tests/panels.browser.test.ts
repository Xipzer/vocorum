// The built PWA in headless Chromium: message search (Ctrl+F, side panel, jump),
// pins (pin from the toolbar, the pins panel, unpin) and the mentions inbox
// (badge, list, jump). Screenshots go to $HUB_SCREENSHOTS.
// Needs `pnpm build:web` and a Playwright Chromium (PLAYWRIGHT_CHROMIUM overrides).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { LOGIN, startTestHub } from './helpers.ts'
import { readSecret } from '../src/config.ts'
import { startDemoBot } from './demo-bot.ts'
import { Hub } from '../src/hub.ts'
import { createClient } from '@libsql/client'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
// A solid-colour PNG of the given size, so tests need no image files.
function png(width: number, height: number, [r, g, b]: [number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
}

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
let page: Page
let origin: string

beforeAll(async () => {
  if (!ready) return
  fs.mkdirSync(shots, { recursive: true })
  t = await startTestHub()
  await t.hub.stop()
  // A Kimaki data dir with its thread ↔ session table, filled once the threads exist.
  process.env['VOCORUM_KIMAKI_DIRS'] = path.join(t.paths.root, 'kimaki-test')
  fs.mkdirSync(process.env['VOCORUM_KIMAKI_DIRS'], { recursive: true })
  // Services come from a stand-in systemctl with three units.
  const userDir = path.join(os.homedir(), '.config/systemd/user')
  const unit = (id: string, extra: Record<string, unknown>) => ({ Id: id, Description: '', LoadState: 'loaded', ActiveState: 'active', SubState: 'running', Result: 'success', MainPID: 0, NRestarts: 0, FragmentPath: `${userDir}/${id}`, WorkingDirectory: '', UnitFileState: 'enabled', ActiveEnterTimestamp: new Date(Date.now() - 3_600_000).toISOString(), InactiveEnterTimestamp: '', ExecMainStartTimestamp: '', Triggers: '', ...extra })
  process.env['FAKE_SYSTEMCTL_STATE'] = path.join(t.paths.root, 'systemctl.json')
  process.env['VOCORUM_SYSTEMCTL'] = path.resolve(import.meta.dirname, 'fake-systemctl.mjs')
  fs.writeFileSync(
    process.env['FAKE_SYSTEMCTL_STATE'],
    JSON.stringify({
      units: [
        unit('web-api.service', { Description: 'Web API on :8787', MainPID: 4100 }),
        unit('crashy.service', { Description: 'Price watcher', ActiveState: 'failed', SubState: 'failed', Result: 'exit-code' }),
        unit('nightly.timer', { Description: 'Nightly re-index', SubState: 'waiting', Triggers: 'nightly.service', next: (Date.now() + 2 * 3_600_000) * 1000 }),
        unit('nightly.service', { Description: 'Nightly re-index', ActiveState: 'inactive', SubState: 'dead' }),
        { ...unit('dbus.service', {}), FragmentPath: '/usr/lib/systemd/user/dbus.service' },
      ],
    }),
  )
  hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir })
  await hub.start()
  demo = await startDemoBot(hub)
  // An older message deep in the thread, so search has to page back to reach it.
  await demo.thread.send('The flamingo migration note lives in docs/flamingo.md')
  for (let i = 0; i < 60; i++) await demo.thread.send(`filler ${i}`)
  browser = await chromium.launch({ executablePath })
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  origin = `http://localhost:${hub.port}`
  await page.goto(origin)
  await page.getByLabel('Pairing code').fill(await hub.store.createPairing('chromium'))
  await page.getByText('Pair this device').click()
  await page.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).waitFor()
}, 90_000)

afterAll(async () => {
  if (!ready) return
  await browser?.close()
  await demo?.stop()
  await hub?.stop()
  fs.rmSync(t.paths.root, { recursive: true, force: true })
})

test.skipIf(!ready)('search: Ctrl+F opens the panel, filters work, a result jumps to an older message', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await page.locator('.chat-title', { hasText: 'kimaki' }).waitFor()
  await page.keyboard.press('Control+f')
  const box = page.getByPlaceholder('Search messages')
  await box.fill('flamingo in:#kimaki')
  const result = page.locator('.result', { hasText: 'flamingo' })
  await result.waitFor()
  await expect.poll(() => page.locator('.result mark').first().textContent()).toMatch(/flamingo/i)
  await page.screenshot({ path: path.join(shots, 'search-panel.png') })
  await result.click()
  const target = page.locator('.message.highlight', { hasText: 'The flamingo migration note' })
  await target.waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.side-panel').waitFor({ state: 'detached' })
})

test.skipIf(!ready)('pins: pin from the toolbar, see it in the panel, unpin', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const message = page.locator('.message', { hasText: 'Found it' }).first()
  // It's above the newest page: scroll up until it has loaded.
  for (let i = 0; i < 5 && !(await message.count()); i++) {
    await page.locator('.messages').evaluate((el: any) => { el.scrollTop = 0 })
    await page.waitForTimeout(400)
  }
  await message.hover()
  await message.getByRole('button', { name: 'Pin', exact: true }).click()
  await page.locator('.message.system', { hasText: 'pinned' }).waitFor()
  await page.getByRole('button', { name: 'Pinned messages' }).click()
  const pin = page.locator('.pin', { hasText: 'Found it' })
  await pin.waitFor()
  await page.screenshot({ path: path.join(shots, 'pins-panel.png') })
  await pin.getByRole('button', { name: 'Unpin' }).click()
  await pin.waitFor({ state: 'detached' })
  await page.getByText('No pinned messages').waitFor()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
})

test.skipIf(!ready)('mentions: a ping shows a badge, the inbox lists it, a click jumps and clears it', async () => {
  await page.goto(`${origin}/#/overview`)
  const { ownerUserId } = hub.options.config
  await demo.website.send(`<@${ownerUserId}> the deploy needs your login`)
  const badge = page.locator('.sidebar .channel', { hasText: 'website' }).locator('.badge')
  await expect.poll(() => badge.textContent()).toBe('1')
  await page.locator('.sidebar .channel', { hasText: 'Mentions' }).click()
  const row = page.locator('.mention-row', { hasText: 'the deploy needs your login' })
  await row.waitFor()
  await expect(row.getAttribute('class')).resolves.toContain('unread')
  await page.screenshot({ path: path.join(shots, 'mentions-inbox.png') })
  await row.click()
  await page.locator('.message.highlight', { hasText: 'the deploy needs your login' }).waitFor()
  await expect.poll(() => badge.count()).toBe(0)
})

test.skipIf(!ready)('linked sessions: liaisons and a spawned child show under the open thread and in the panel', async () => {
  const partner = await demo.kimaki.threads.create({ name: 'Liaison partner' })
  const db = createClient({ url: `file:${path.join(process.env['VOCORUM_KIMAKI_DIRS']!, 'kimaki.db')}` })
  await db.execute('CREATE TABLE thread_sessions (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL)')
  await db.execute({ sql: 'INSERT INTO thread_sessions VALUES (?, ?), (?, ?)', args: [demo.thread.id, 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', partner.id, 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb'] })
  db.close()
  // Each names the other: one by session ID, one by thread link.
  await demo.thread.send('Asking the partner session ses_bbbbbbbbbbbbbbbbbbbbbbbbbb about the schema')
  await partner.send(`Replying to https://discord.com/channels/${hub.options.config.guildId}/${demo.thread.id}`)
  const child = await demo.kimaki.threads.create({ name: 'Spawned helper' })
  await child.send({ content: 'Run the migration', embeds: [{ footer: { text: 'start: true\nparentSessionId: ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' } }] })

  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const linked = page.locator('.sidebar .linked-row')
  await expect.poll(() => linked.allTextContents(), { timeout: 15_000 }).toEqual(['Liaison partnerliaison', 'Spawned helperchild'])
  await page.getByRole('button', { name: 'Linked sessions: 2' }).click()
  const item = page.locator('.link-item', { hasText: 'Liaison partner' })
  await item.getByText('Liaison: you name each other').waitFor()
  await page.screenshot({ path: path.join(shots, 'linked-sessions.png') })
  await item.getByRole('button', { name: 'Show the latest reference' }).click()
  await page.locator('.message.highlight', { hasText: 'Replying to' }).waitFor()
  await page.locator('.chat-title', { hasText: 'Liaison partner' }).waitFor()
  await expect.poll(() => linked.allTextContents()).toEqual(['Fix footer on short turnsliaison'])
  await page.keyboard.press('Escape')
  await linked.click()
  await page.locator('.sidebar .linked-row', { hasText: 'Spawned helper' }).click()
  await page.locator('.chat-title', { hasText: 'Spawned helper' }).waitFor()
  await expect.poll(() => page.locator('.sidebar .linked-row').allTextContents()).toEqual(['Fix footer on short turnsparent'])
})

test.skipIf(!ready)('output view: a locked thread has no composer, a pinned panel on top and look-alike posts folded', async () => {
  const log = await demo.kimaki.threads.create({ name: 'Build log' })
  const board = await log.send('### Status\n✅ **API**: up\n⚠️ **Homelab**: asleep\n❌ **Voice notes**: down\n-# checked 20:35')
  await board.pin()
  for (const n of [707, 512, 98, 1204]) await log.send(`**Deployed build ${n}**\nFiles changed in this build: **${n}**`)
  await log.send('**Nightly run 30 finished** with 59 tests skipped')
  await log.setLocked(true)

  await page.goto(`${origin}/#/c/${log.id}`)
  await page.locator('.output-panel .status-row.bad', { hasText: 'Voice notes' }).waitFor()
  await expect(page.locator('.output-panel .status-row').count()).resolves.toBe(3)
  await expect(page.locator('.footer textarea').count()).resolves.toBe(0)
  await page.getByText('Output only.').waitFor()
  await page.locator('.day-divider', { hasText: 'Today' }).waitFor()
  const fold = page.locator('.run-fold')
  await expect(fold.textContent()).resolves.toMatch(/3 more like this/)
  await expect(page.locator('.messages .message', { hasText: 'Deployed build' }).count()).resolves.toBe(1)
  await page.screenshot({ path: path.join(shots, 'output-feed.png') })
  await fold.click()
  await expect.poll(() => page.locator('.messages .message', { hasText: 'Deployed build' }).count()).toBe(4)

  // The owner can turn it back into a conversation, and that choice is kept.
  await page.getByRole('button', { name: 'Allow replies' }).click()
  await page.locator('.footer textarea').waitFor()
  await expect(page.locator('.output-panel').count()).resolves.toBe(0)
  await page.reload()
  await page.locator('.footer textarea').waitFor()
})

test.skipIf(!ready)('services: the user panel flags a failure, the panel groups units, a restart is confirmed and recorded', async () => {
  page.setDefaultTimeout(8000)
  await demo.thread.send('Restarting it: `systemctl --user restart web-api`')
  await page.goto(`${origin}/#/overview`)
  await page.getByRole('button', { name: 'Services: 1 failed' }).click()
  const panel = page.locator('.side-panel')
  await panel.locator('.panel-section', { hasText: 'Needs attention' }).waitFor()
  await expect(panel.locator('.service-row').allTextContents()).resolves.toEqual([expect.stringContaining('crashy'), expect.stringContaining('web-api'), expect.stringContaining('nightly')])
  await expect(panel.getByText('dbus').count()).resolves.toBe(0)
  await page.screenshot({ path: path.join(shots, 'services-panel.png') })
  await panel.locator('.service-row', { hasText: 'web-api' }).click()
  await panel.getByText('4100').waitFor()
  await expect.poll(() => panel.locator('.linked-row', { hasText: 'Fix footer on short turns' }).count(), { timeout: 10_000 }).toBe(1)
  await panel.getByRole('button', { name: 'Restart' }).click()
  await page.locator('.sheet').getByRole('menuitem', { name: 'Restart' }).click()
  await panel.locator('.history li', { hasText: 'Restart requested' }).waitFor()
  await panel.locator('.history li', { hasText: 'Restarted' }).waitFor()
  await page.screenshot({ path: path.join(shots, 'service-detail.png') })
  await panel.getByRole('button', { name: 'Stop' }).click()
  await page.locator('.sheet').getByRole('menuitem', { name: 'Stop' }).click()
  await panel.getByRole('button', { name: 'Start' }).waitFor()
  await panel.locator('.history li', { hasText: /^.*Stopped/ }).waitFor()
})

test.skipIf(!ready)('links: a hub thread link and a session ID show as named chips, with a link sheet', async () => {
  const partner = await demo.kimaki.threads.create({ name: 'Chip target' })
  await new Promise((r) => setTimeout(r, 300))
  await demo.thread.send(`See https://discord.com/channels/${hub.options.config.guildId}/${partner.id} and ses_aaaaaaaaaaaaaaaaaaaaaaaaaa`)
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.reload()
  const chips = page.locator('.message', { hasText: 'See ' }).last().locator('.channel-chip')
  await expect.poll(() => chips.allTextContents()).toEqual(['Chip target', 'Fix footer on short turns'])
  await chips.first().click({ button: 'right' })
  await page.locator('.sheet').getByRole('menuitem', { name: 'Copy link' }).waitFor()
  await page.locator('.sheet').getByRole('menuitem', { name: 'Go to channel' }).click()
  await page.locator('.chat-title', { hasText: 'Chip target' }).waitFor()
})

test.skipIf(!ready)("linked sessions: links Kimaki records itself (session_links) show too, without a message to jump to", async () => {
  const other = await demo.kimaki.threads.create({ name: 'Linked in Kimaki only' })
  const db = createClient({ url: `file:${path.join(process.env['VOCORUM_KIMAKI_DIRS']!, 'kimaki.db')}` })
  await db.execute({ sql: 'INSERT INTO thread_sessions VALUES (?, ?)', args: [other.id, 'ses_cccccccccccccccccccccccccc'] })
  await db.execute('CREATE TABLE session_links (session_id TEXT, linked_session_id TEXT, source TEXT, created_at INTEGER, last_contact_at INTEGER, PRIMARY KEY (session_id, linked_session_id))')
  const now = Date.now()
  await db.execute({ sql: "INSERT INTO session_links VALUES ('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'ses_cccccccccccccccccccccccccc', 'manual', ?, ?), ('ses_cccccccccccccccccccccccccc', 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'manual', ?, ?)", args: [now, now, now, now] })
  db.close()
  await (hub.sessions.links as unknown as { loadSessions: () => Promise<void> }).loadSessions()
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.getByRole('button', { name: /Linked sessions: \d+/ }).click()
  const item = page.locator('.link-item', { hasText: 'Linked in Kimaki only' })
  await item.getByText('Liaison: you name each other').waitFor()
  await item.getByText('Linked in Kimaki', { exact: true }).waitFor()
})

test.skipIf(!ready)('servers: the rail lists every guild; switching shows its channels; mentions badge the server', async () => {
  const friends = await hub.store.addGuild('Friends')
  await hub.reload()
  const general = (await hub.twin.prisma.channel.findMany({ where: { guildId: friends.id, type: 0 } }))[0]!
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const rail = page.getByRole('navigation', { name: 'Servers' })
  await rail.waitFor()
  // Home (direct messages) and the two servers.
  await expect(rail.locator('.rail-item').count()).resolves.toBe(3)
  await expect(page.locator('.side-title').textContent()).resolves.toContain(hub.options.config.guildName)
  await rail.getByRole('button', { name: /Friends/ }).click()
  await expect.poll(() => page.locator('.side-title').textContent()).toContain('Friends')
  await expect(page.locator('.sidebar .channel', { hasText: 'kimaki' }).count()).resolves.toBe(0)
  await page.locator('.chat-title', { hasText: 'general' }).waitFor()
  await expect(rail.locator('.rail-item.active').getAttribute('aria-label')).resolves.toMatch(/^Friends/)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(shots, 'servers-rail.png') })
  // A mention in the first server shows on its rail icon while the second is open.
  await demo.website.send(`<@${hub.options.config.ownerUserId}> over here`)
  await rail.getByRole('button', { name: /1 mentions/ }).waitFor()
  expect(general.id).toBeTruthy()
})

test.skipIf(!ready)('columns: drag the channel list wider, fold it by dragging past the edge, open it again; Ctrl+B; kept on reload', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const side = page.locator('.side-main')
  const handle = page.locator('.col-handle.col-side')
  const width = async () => Math.round((await side.boundingBox())?.width ?? 0)
  const drag = async (dx: number) => {
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 300)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + 300, { steps: 4 })
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + 300, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(350)
  }
  const start = await width()
  // The user panel and the composer make one bar: their top rules line up.
  {
    // The dock: composer and user panel are the same height, tops level, 8px from their edges.
    const panelBox = (await page.locator('.user-panel').boundingBox())!
    const footerBox = (await page.locator('.footer').boundingBox())!
    const chatBox = (await page.locator('.chat').boundingBox())!
    expect(Math.round(panelBox.y)).toBe(Math.round(footerBox.y))
    expect(Math.round(panelBox.height)).toBe(Math.round(footerBox.height))
    expect(Math.round(panelBox.x)).toBe(8)
    expect(Math.round(footerBox.x - chatBox.x)).toBe(8)
    expect(Math.round(chatBox.x + chatBox.width - footerBox.x - footerBox.width)).toBe(8)
    // Inside: content starts and ends 14px from each piece's outer edge, on both sides of both.
    const inset = async (outer: string, first: string, last: string) => {
      const o = (await page.locator(outer).boundingBox())!
      const a = (await page.locator(first).first().boundingBox())!
      const b = (await page.locator(last).last().boundingBox())!
      return [Math.round(a.x - o.x), Math.round(o.x + o.width - b.x - b.width)]
    }
    expect(await inset('.user-panel', '.user-panel .avatar', '.user-panel > .services-button > *')).toEqual([14, 14])
    expect(await inset('.footer', '.composer .attach svg', '.composer .mic svg')).toEqual([14, 14])
  }
  await drag(96)
  expect(await width()).toBe(start + 96)
  await drag(-400)
  expect(await width()).toBe(0)
  const reopen = page.locator('.chat-header .menu')
  await expect(reopen.isVisible()).resolves.toBe(true)
  // Nothing of the folded list covers the chat.
  expect(await page.evaluate("document.elementFromPoint(120, 300).closest('.sidebar')")).toBeNull()
  await page.screenshot({ path: path.join(shots, 'columns-folded.png') })
  await reopen.click()
  await page.waitForTimeout(350)
  expect(await width()).toBe(start + 96)
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(350)
  expect(await width()).toBe(0)
  await page.reload()
  await page.locator('.chat-title').waitFor()
  expect(await width()).toBe(0)
  // A small pull from folded snaps open at the minimum.
  await drag(20)
  expect(await width()).toBe(200)
  await page.keyboard.press('Control+b')
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(350)
  await drag(start - 200)
  expect(await width()).toBe(start)
  // The server rail folds and opens on its own.
  if (await page.locator('.rail').count()) {
    const rail = async () => Math.round((await page.locator('.rail').boundingBox())?.width ?? 0)
    await page.keyboard.press('Control+Alt+b')
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(350)
    expect(await rail()).toBe(0)
    expect(await width()).toBe(0)
    await page.screenshot({ path: path.join(shots, 'columns-focus.png') })
    await page.keyboard.press('Control+Alt+b')
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(350)
    expect(await rail()).toBe(72)
    expect(await width()).toBe(start)
  }
})

test.skipIf(!ready)('bell and members: mute a thread from the bell; the member list shows this device here', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.locator('.chat-title').waitFor()
  // Menus drop from their button: 8px below it, right edges lined up (Discord's).
  const more = page.locator('.chat-actions').getByRole('button', { name: 'More', exact: true })
  await more.click()
  const menu = page.locator('.sheet')
  await menu.waitFor()
  const [b, m] = [(await more.boundingBox())!, (await menu.boundingBox())!]
  expect(Math.round(m.y - (b.y + b.height))).toBe(8)
  expect(Math.round(m.x + m.width)).toBe(Math.round(b.x + b.width))
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Notification settings' }).click()
  await page.getByText('Mute for 1 hour').click()
  await page.locator('.icon-button.muted-bell').waitFor()
  await page.getByRole('button', { name: 'Notification settings' }).click()
  await page.getByText('Unmute').click()
  await page.locator('.icon-button.muted-bell').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Members' }).click()
  await page.locator('.member-note', { hasText: 'chromium · here' }).waitFor()
  await page.screenshot({ path: path.join(shots, 'members-panel.png') })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
})

test.skipIf(!ready)('thread card: the message that started a thread carries its card in the channel, not inside the thread', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const card = page.locator('.thread-card', { hasText: 'Fix footer on short turns' })
  await card.waitFor()
  // Opened from its channel, the thread sits beside it (split view); the channel stays.
  await card.click()
  const split = page.locator('.split-panel')
  await split.locator('.chat-title', { hasText: 'Fix footer on short turns' }).waitFor()
  await page.locator('.chat:not(.split) .chat-title', { hasText: 'kimaki' }).waitFor()
  await expect(split.locator('.thread-card').count()).resolves.toBe(0)
  {
    // Every dock piece: same height, same bottom, and 16px between neighbours (8 + 8).
    const boxes = await Promise.all(['.user-panel', '.chat:not(.split) .footer', '.split-panel .footer'].map(async (sel) => (await page.locator(sel).boundingBox())!))
    expect(new Set(boxes.map((b) => Math.round(b.y + b.height))).size).toBe(1)
    expect(new Set(boxes.map((b) => Math.round(b.height))).size).toBe(1)
    expect(Math.round(boxes[1]!.x - boxes[0]!.x - boxes[0]!.width)).toBe(16)
    expect(Math.round(boxes[2]!.x - boxes[1]!.x - boxes[1]!.width)).toBe(16)
  }
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shots, 'split-view.png') })
  // Open in full view swaps it into the main column.
  await split.getByRole('link', { name: 'Open in full view' }).click()
  await page.locator('.chat:not(.split) .chat-title', { hasText: 'Fix footer on short turns' }).waitFor()
  await expect(page.locator('.split-panel').count()).resolves.toBe(0)
  await expect(page.locator('.messages .thread-card').count()).resolves.toBe(0)
})

test.skipIf(!ready)('message bands: every row has the same 3px inside its hover band, above and below', async () => {
  // The edge case found in review: a one-line bot reply under a reply line, shorter than its avatar.
  const last = (await demo.thread.messages.fetch({ limit: 1 })).first()!
  await demo.thread.send({ content: '× OpenCode integration.list failed', reply: { messageReference: last.id } })
  for (const id of [demo.thread.id, demo.kimaki.id]) {
    await page.goto(`${origin}/#/c/${id}`)
    await page.waitForTimeout(500)
    await page.locator('.messages').evaluate((el: any) => { el.scrollTop = 0 })
    await page.waitForTimeout(800)
    const off = await page.evaluate(`[...document.querySelectorAll('.message:not(.needs)')].map((m) => {
      const r = m.getBoundingClientRect()
      const kids = [...m.querySelectorAll('.message-body > *, :scope > *')].filter((k) => !k.classList.contains('message-actions') && getComputedStyle(k).display !== 'none' && k.getBoundingClientRect().height > 0)
      // Discord keeps some blocks a little below the row's top (a container or image 2px, a
      // code block 6px, discord-reference/blocks.md): that margin is the block's, not the band's.
      const lead = (el) => { let m = 0; for (let e = el; e; e = e.firstElementChild) m += parseFloat(getComputedStyle(e).marginTop) || 0; return m }
      const first = kids.reduce((a, k) => (k.getBoundingClientRect().top < a.getBoundingClientRect().top ? k : a), kids[0])
      const top = Math.min(...kids.map((k) => k.getBoundingClientRect().top)) - (first.classList.contains('message-head') ? 0 : lead(first))
      const bottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom))
      // The avatar counts as content too: it must sit inside the band with the same 3px below.
      const av = m.querySelector('.message-head .avatar')
      const low = Math.max(bottom, av ? av.getBoundingClientRect().bottom : bottom)
      const extra = Math.round(r.bottom - low)
      return [Math.round(top - r.top), Math.min(Math.round(r.bottom - bottom), extra), extra, (m.textContent || '').slice(0, 30)]
    }).filter(([a, b, c]) => a !== 3 || c < 3 || (b !== 3 && c !== 3))`)
    expect(off).toEqual([])
  }
})

test.skipIf(!ready)('reactions: add from the toolbar, it lights up as yours; click the chip to take it off; picker adds any emoji', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const message = page.locator('.message', { hasText: 'filler 59' }).first()
  await message.hover()
  await message.getByRole('button', { name: 'React 👍' }).click()
  const chip = message.locator('.reaction.me', { hasText: '👍' })
  await chip.waitFor()
  await chip.click()
  await chip.waitFor({ state: 'detached' })
  await message.hover()
  await message.locator('.message-actions').getByRole('button', { name: 'Add reaction' }).click()
  const picker = page.locator('.emoji-picker')
  await picker.waitFor()
  await picker.getByRole('textbox').fill('rocket')
  await picker.getByRole('button', { name: 'rocket' }).first().click()
  await message.locator('.reaction.me', { hasText: '🚀' }).waitFor()
  await page.screenshot({ path: path.join(shots, 'reactions.png') })
})

test.skipIf(!ready)('inbox bell: the user panel bell gathers mentions from every server and sessions that need you', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const { ownerUserId } = hub.options.config
  await demo.website.send(`<@${ownerUserId}> the inbox should see this`)
  const bell = page.locator('.user-panel .inbox-button')
  await bell.locator('.num').waitFor()
  await bell.click()
  const panel = page.locator('.side-panel', { hasText: 'Inbox' })
  await panel.locator('.mention-row', { hasText: 'the inbox should see this' }).waitFor()
  await page.screenshot({ path: path.join(shots, 'inbox-panel.png') })
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
})

test.skipIf(!ready)('errors: a failed turn with Retry reads red, with a red band and a solid red button', async () => {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js')
  await demo.thread.send({ content: '× OpenCode model.default failed', components: [new ActionRowBuilder<any>().addComponents(new ButtonBuilder().setCustomId('retry').setLabel('Retry').setStyle(ButtonStyle.Secondary))] })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const failed = page.locator('.message.failed.needs', { hasText: 'model.default failed' })
  await failed.waitFor()
  const bg = await failed.locator('.action-row .button').first().evaluate((el: any) => getComputedStyle(el).backgroundColor)
  expect(bg).toBe('rgb(255, 77, 94)')
  await page.screenshot({ path: path.join(shots, 'error-band.png') })
})

test.skipIf(!ready)('formatting: code is coloured, diffs and ansi render, machine tokens in prose are marked', async () => {
  await demo.thread.send([
    'Run finished in ses_1234567890abcdefFAKEid0000 after 13m 15s, 311213 tokens. Wrote `x` to web/src/styles.css at 9f4ab0c, mode=fast.',
    '```ts',
    "export async function load(id: string): Promise<number> {",
    "  // fetch it once",
    "  const res = await fetch(`/api/${id}`, { method: 'GET' })",
    '  return res.ok ? 42 : null',
    '}',
    '```',
    '```diff',
    '@@ -1,2 +1,2 @@',
    '-const a = 1',
    '+const a = 2',
    '```',
  ].join('\n'))
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const m = page.locator('.message', { hasText: 'Run finished in' }).last()
  await m.locator('.tk-kw').first().waitFor()
  await m.locator('.diff-add').waitFor()
  await m.locator('.sem-num', { hasText: '13m 15s' }).waitFor()
  await m.screenshot({ path: path.join(shots, 'formatting.png') })
  await demo.thread.send(['💭 _Checking the logs before the deploy._', '🗣️ Give me a sec, two builds are queued.', '🔧 `pnpm test` in web → 134 passed (694 ms)', '✅ build passed in 27.3s', '⚠️ cache was cold', '⛔ deploy cancelled', '✋ waiting for review'].join('\n'))
  const log = page.locator('.message', { hasText: 'Give me a sec' }).last()
  await log.locator('.status-row.tool .status-time').waitFor()
  await log.screenshot({ path: path.join(shots, 'status-gutter.png') })
})

test.skipIf(!ready)('containers: content-width cards with an accent bar, separators, compact relay lines', async () => {
  await demo.thread.send([
    '-# » **routine #5:** Weekly build report. Be concise. Read-only, change nothing.',
    '-# Background: every CI run stores its duration and cache hits. We compare this week with last week.',
    '-# Task: group the runs by pipeline (web, api, docs) and report run count, median time and the share of runs that hit the cache.',
  ].join('\n'))
  const stats = { type: 17, accent_color: null, components: [
    { type: 10, content: '**Pipeline** web\n**Runs** 212\n**Median** 4.1 min\n**Last week** 4.3 min\n**Cache hits** **81%**' },
    { type: 14, spacing: 1, divider: true },
    { type: 10, content: '**Pipeline** api\n**Runs** 148\n**Median** 6.0 min\n**Last week** 6.2 min\n**Cache hits** 74%' },
    { type: 14, spacing: 1, divider: true },
    { type: 10, content: '**Pipeline** docs\n**Runs** 37\n**Median** 1.2 min\n**Last week** 1.2 min\n**Cache hits** **95%**' },
  ] }
  await demo.thread.send({ flags: 32768, components: [stats] } as never)
  await demo.thread.send({ flags: 32768, components: [{ type: 17, accent_color: 16096779, components: [{ type: 10, content: '## Caveats\n- **Cold runners:** Monday\'s runs started without a cache.\n- **Docs:** too few runs to compare.' }] }] } as never)
  await demo.thread.send({ flags: 32768, components: [{ type: 17, accent_color: 3900150, components: [{ type: 10, content: '## My suggestion\nShip the cache change on Monday.' }] }] } as never)
  await demo.thread.send({ flags: 32768, components: [{ type: 17, accent_color: null, components: [{ type: 10, content: 'Runner\n****linux-large**** 8 cores\n****ephemeral-small**** 2 cores' }, { type: 14, spacing: 1, divider: true }, { type: 10, content: 'Queue time\n****linux-large**** **~12 s** (was 40 s)\n****ephemeral-small**** ~3 s' }] }] } as never)
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.locator('.message', { hasText: 'ephemeral' }).last().waitFor()
  await page.setViewportSize({ width: 1280, height: 1400 })
  const list = page.locator('.message', { hasText: 'routine #5' }).last()
  await list.scrollIntoViewIfNeeded()
  const box = await list.boundingBox()
  await page.screenshot({ path: path.join(shots, 'containers.png'), clip: { x: box!.x, y: box!.y, width: 900, height: 1400 - box!.y } })
})

test.skipIf(!ready)('markdown parity: headings, mentions, time chips, quotes, footer, raw callouts, jumbo emoji', async () => {
  const now = Math.floor(Date.now() / 1000)
  const guildId = demo.thread.guildId
  await demo.thread.send([
    '# Heading one',
    'Plain **bold** *italic* __underline__ ~~strike~~ ||spoiler|| `inline code` and [a masked link](https://example.com/very/long/path).',
    '## Heading two',
    `Mentions: <@123456789012345678> <@&123456789012345679> <#${demo.thread.id}> @everyone </model:123456789012345680> <id:customize>`,
    `Message link: https://discord.com/channels/${guildId}/${demo.thread.id}/123456789012345681`,
    `Times: <t:${now - 300}:R> · <t:${now}:t> · <t:${now}:D> · <t:${now}:f>`,
    '### Heading three',
    '- one',
    '  - nested',
    '1. first',
    '2. second',
    '> quoted line with `code`',
    '> 🟡 **Revoke the bot token** we have been using → `/revoke` → restart',
    '-# subtext with **bold**',
    '*example-project ⋅ master ⋅ 7m 16s ⋅ 19% ⋅ claude-opus-4-7*',
  ].join('\n'))
  await demo.thread.send(['Fixed. Why it did not show:', '', '<callout accent="#3b82f6">', '## Why % was missing', "The list endpoint only returns the **top 100**.", '</callout>', '', '-# *master ⋅ 2s ⋅ 3% ⋅ claude-opus-5-5*'].join('\n'))
  await demo.thread.send('🎉🔥')
  await page.setViewportSize({ width: 1280, height: 1400 })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const m = page.locator('.message', { hasText: 'Heading one' }).last()
  await m.locator('.meta-line').waitFor()
  expect(await m.locator('.timestamp-mention').count()).toBe(4)
  expect(await m.locator('.mention', { hasText: '@everyone' }).count()).toBe(1)
  expect(await m.locator('.command-mention', { hasText: '/model' }).count()).toBe(1)
  await page.locator('.message .markdown.jumbo').last().waitFor()
  await page.locator('.message .container.accented', { hasText: 'Why % was missing' }).waitFor()
  const box = await m.boundingBox()
  await page.screenshot({ path: path.join(shots, 'markdown-parity.png'), clip: { x: box!.x, y: box!.y, width: 900, height: Math.min(1400 - box!.y, 1100) } })
})

test.skipIf(!ready)('composer aids: @ # : suggestions, formatting bar and shortcuts, emoji button', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const box = page.locator('.composer textarea')
  await box.fill('')
  await box.pressSequentially('hi #')
  await page.locator('.palette.suggest .slash-item').first().waitFor()
  await page.screenshot({ path: path.join(shots, 'composer-suggest.png'), clip: { x: 0, y: 500, width: 1280, height: 400 } })
  await box.press('Enter')
  expect(await box.inputValue()).toMatch(/^hi <#\d+> $/)
  await box.fill('')
  await box.pressSequentially('ok :fir')
  await page.locator('.palette.suggest .slash-item').first().waitFor()
  await box.press('Tab')
  expect(await box.inputValue()).toMatch(/^ok \S+ $/u)
  await box.fill('make this bold')
  await box.press('End')
  for (let i = 0; i < 4; i++) await box.press('Shift+ArrowLeft')
  await page.locator('.format-bar').waitFor()
  await page.screenshot({ path: path.join(shots, 'composer-format.png'), clip: { x: 0, y: 600, width: 1280, height: 300 } })
  await page.locator('.format-button[aria-label="Bold"]').click()
  expect(await box.inputValue()).toBe('make this **bold**')
  await box.press('Control+i')
  expect(await box.inputValue()).toBe('make this ***bold***')
  await box.fill('')
  expect(await page.locator('.composer .emoji-button').count()).toBe(1)
})

test.skipIf(!ready)('media: embeds, attachment mosaics with a lightbox, spoilers, players, text previews, forwards, polls, system rows and jump bars', async () => {
  const zlib = await import('node:zlib')
  const { execFileSync } = await import('node:child_process')
  const { generateSnowflake } = await import('discord-digital-twin/src')
  // A small PNG: a diagonal gradient in one hue with soft stripes, so crops and fits are visible.
  const png = (w: number, h: number, [r, g, b]: [number, number, number]) => {
    const raw = Buffer.alloc((w * 3 + 1) * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const t = 0.35 + 0.65 * ((x / w + y / h) / 2) * (Math.floor((x + y) / 24) % 2 ? 1 : 0.85)
        raw.set([r * t, g * t, b * t].map(Math.round), y * (w * 3 + 1) + 1 + x * 3)
      }
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
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  }
  const dataUri = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`
  const wav = () => {
    const n = 8000
    const out = Buffer.alloc(44 + n * 2)
    out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
    out.writeUInt32LE(8000, 24); out.writeUInt32LE(16000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40)
    for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin(i / 4) * 8000), 44 + i * 2)
    return out
  }
  const save = async (filename: string, contentType: string, data: Buffer, size?: [number, number]) => {
    const s = await hub.attachments.save({ id: generateSnowflake(), filename, contentType, data, uploadedBy: 'test' })
    return { id: s.id, filename: s.filename, size: s.size, url: s.url, proxy_url: s.url, content_type: s.contentType, ...(size && { width: size[0], height: size[1] }) }
  }
  const hues: Array<[number, number, number]> = [[0, 170, 220], [230, 120, 60], [60, 190, 120], [220, 200, 70], [200, 80, 110], [90, 120, 230], [140, 140, 150]]
  const image = (i: number, w = 480, h = 320) => save(`photo-${i + 1}.png`, 'image/png', png(w, h, hues[i % hues.length]!), [w, h])

  const { ownerUserId } = hub.options.config
  const botId = demo.thread.client.user!.id
  const media = await demo.kimaki.threads.create({ name: 'Media check' })
  let clock = Date.now() - 60 * 60_000
  const post = async (m: { authorId?: string; content?: string; type?: number; attachments?: unknown[]; embeds?: unknown[]; editedTimestamp?: Date; messageReference?: unknown }, extra?: Record<string, unknown>) => {
    const id = generateSnowflake()
    clock += 20_000
    await hub.twin.mirrorMessage({ id, channelId: media.id, authorId: m.authorId ?? botId, content: m.content ?? '', timestamp: new Date(clock), type: m.type, attachments: m.attachments, embeds: m.embeds, editedTimestamp: m.editedTimestamp, messageReference: m.messageReference }, { extra })
    return id
  }

  // A rich embed: colour bar, author, title, description, inline fields (3 + 2 + full), thumbnail, image, footer.
  await post({
    content: 'Deploy report',
    embeds: [{
      type: 'rich', color: 0x00d2ff, url: 'https://example.com/deploys/42', title: 'Deploy #42 finished', description: 'Shipped **vocorum** to the hub. `pnpm build` took 41s.\nNo errors in the last 15 minutes.',
      author: { name: 'Workstation CI', url: 'https://example.com', icon_url: dataUri(png(48, 48, [0, 170, 220])) },
      thumbnail: { url: dataUri(png(160, 160, [230, 120, 60])), width: 160, height: 160 },
      fields: [{ name: 'Branch', value: 'master', inline: true }, { name: 'Commit', value: '`a28d15b`', inline: true }, { name: 'Duration', value: '41s', inline: true }, { name: 'Tests', value: '212 passed', inline: true }, { name: 'Bundle', value: '412 KB', inline: true }, { name: 'Notes', value: 'Containers render as cards; stats sit side by side; relayed prompts on one line.' }],
      image: { url: dataUri(png(800, 400, [60, 190, 120])), width: 800, height: 400 },
      footer: { text: 'vocorum ci', icon_url: dataUri(png(40, 40, [140, 140, 150])) }, timestamp: new Date().toISOString(),
    }],
  })
  // Four embeds with one URL: one card with an image grid.
  const shared = 'https://example.com/album'
  await post({ embeds: [{ type: 'rich', url: shared, title: 'Album: launch day', description: 'Four shots from the launch.', color: 0xe5a50a, image: { url: dataUri(png(400, 300, hues[0]!)) } }, ...[1, 2, 3].map((i) => ({ type: 'rich', url: shared, image: { url: dataUri(png(400, 300, hues[i]!)) } }))] })
  // A video link preview and a bare image link.
  await post({ content: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', embeds: [{ type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'A video worth watching', color: 0xff0000, provider: { name: 'YouTube', url: 'https://www.youtube.com' }, author: { name: 'Some Channel', url: 'https://www.youtube.com/@x' }, thumbnail: { url: dataUri(png(480, 270, [200, 80, 110])), width: 480, height: 270 }, video: { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', width: 1280, height: 720 } }] })
  await post({ content: 'https://example.com/cat.png', embeds: [{ type: 'image', url: 'https://example.com/cat.png', thumbnail: { url: dataUri(png(360, 240, [90, 120, 230])), width: 360, height: 240 } }] })

  // Attachments: one, three, five images; a spoiler; video, audio, a text file and a plain file.
  await post({ authorId: ownerUserId, content: 'One picture', attachments: [await image(0, 900, 600)] })
  await post({ authorId: ownerUserId, content: 'Three of them', attachments: [await image(1), await image(2), await image(3)] })
  await post({ authorId: ownerUserId, content: 'Five for the mosaic', attachments: await Promise.all([0, 1, 2, 3, 4].map((i) => image(i + 2))) })
  await post({ authorId: ownerUserId, content: 'Hidden one', attachments: [{ ...(await image(5)), filename: 'SPOILER_photo.png' }] })
  let video: unknown = null
  try {
    const out = path.join(t.paths.root, 'clip.webm')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=480x270:rate=15', '-t', '2', '-c:v', 'libvpx', '-b:v', '300k', out], { timeout: 30_000 })
    video = await save('clip.webm', 'video/webm', fs.readFileSync(out), [480, 270])
  } catch {}
  const code = Array.from({ length: 24 }, (_, i) => (i === 0 ? "import { load } from './api.ts'" : i % 5 === 0 ? `// step ${i}` : `export const value${i} = await load('item-${i}') // ${'x'.repeat(i)}`)).join('\n')
  await post({
    authorId: ownerUserId,
    content: 'Files',
    attachments: [...(video ? [video] : []), await save('voice-note.wav', 'audio/wav', wav()), await save('loader.ts', 'text/plain', Buffer.from(code)), await save('release-build.zip', 'application/zip', Buffer.alloc(48_213, 7))],
  })
  // An edited message, a reply and system rows.
  const editedId = await post({ authorId: ownerUserId, content: 'Fixed the typo in that last note', editedTimestamp: new Date() })
  await post({ authorId: botId, content: 'Thanks, noted.', type: 19, messageReference: { message_id: editedId, channel_id: media.id } })
  await post({ authorId: ownerUserId, type: 7 })
  await post({ authorId: ownerUserId, type: 8 })
  await post({ authorId: ownerUserId, type: 2 })

  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block' })
  const p = await context.newPage()
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(origin)
  await p.getByLabel('Pairing code').fill(await hub.store.createPairing('media'))
  await p.getByText('Pair this device').click()
  await p.goto(`${origin}/#/c/${media.id}`)
  await p.locator('.message', { hasText: 'Thanks, noted.' }).waitFor()
  // The socket's first resync reloads the page from REST; live events go after it.
  await p.waitForTimeout(1500)

  // Live-only fields (the hub's REST copy drops them): forward, poll, sticker, command line.
  await post({ authorId: ownerUserId, messageReference: { type: 1, message_id: '1', channel_id: demo.kimaki.id } }, { message_reference: { type: 1, message_id: '1', channel_id: demo.kimaki.id }, message_snapshots: [{ message: { content: 'The flamingo migration note lives in **docs/flamingo.md**', timestamp: new Date(Date.now() - 3_600_000).toISOString(), attachments: [], embeds: [] } }] })
  await post({ authorId: ownerUserId }, { poll: { question: { text: 'Which model for the nightly run?' }, answers: [{ answer_id: 1, poll_media: { text: 'claude-opus-5-5' } }, { answer_id: 2, poll_media: { text: 'local llama' } }, { answer_id: 3, poll_media: { text: 'skip tonight' } }], expiry: new Date(Date.now() + 5 * 3_600_000).toISOString(), allow_multiselect: false, results: { is_finalized: false, answer_counts: [{ id: 1, count: 7, me_voted: true }, { id: 2, count: 3, me_voted: false }, { id: 3, count: 1, me_voted: false }] } } })
  await post({ authorId: botId, content: 'Model set to **claude-opus-5-5** for this session.' }, { interaction_metadata: { id: '1', type: 2, name: 'model', user: { id: ownerUserId, username: 'owner', global_name: 'Owner' } } })
  await post({ authorId: ownerUserId }, { sticker_items: [{ id: '749054660769218631', name: 'Wave', format_type: 3 }] })
  await p.locator('.poll').waitFor()

  const shot = async (text: string, name: string, sel = '.message') => {
    const el = p.locator(sel, { hasText: text }).last()
    await el.scrollIntoViewIfNeeded()
    await p.waitForTimeout(250)
    await el.screenshot({ path: path.join(shots, name) })
  }
  const card = p.locator('.embed-card', { hasText: 'Deploy #42' })
  await card.locator('.embed-thumb').waitFor({ state: 'attached' })
  await expect(card.locator('.embed-field').count()).resolves.toBe(6)
  // Beside a thumbnail two inline fields share a row (three without one); the last spans the card.
  const column = (i: number) => card.locator('.embed-field').nth(i).evaluate((el) => getComputedStyle(el).gridColumn)
  await expect(column(1)).resolves.toBe('7 / 13')
  await expect(column(2)).resolves.toBe('1 / 7')
  await expect(column(5)).resolves.toBe('1 / 13')
  await shot('Deploy report', 'media-embed-rich.png')
  await expect(p.locator('.embed-card', { hasText: 'Album' }).locator('.mosaic .media-cell').count()).resolves.toBe(4)
  await shot('Four shots', 'media-embed-album.png')
  await shot('A video worth watching', 'media-embed-video.png')
  // A bare image link hides its URL text, as Discord does.
  const bare = p.locator('.message', { has: p.locator('img[alt="cat.png"]') })
  await expect(bare.locator('.markdown').count()).resolves.toBe(0)
  await shot('One picture', 'media-one.png')
  await shot('Three of them', 'media-three.png')
  await shot('Five for the mosaic', 'media-five.png')
  const spoiler = p.locator('.message', { hasText: 'Hidden one' }).locator('.media-cell')
  await expect(spoiler.getAttribute('class')).resolves.toMatch(/spoiler/)
  await shot('Hidden one', 'media-spoiler.png')
  await spoiler.locator('button').click()
  await expect(spoiler.getAttribute('class')).resolves.not.toMatch(/spoiler/)
  const files = p.locator('.message', { hasText: 'Files' })
  await files.locator('.text-file code').filter({ hasText: 'import' }).waitFor()
  await shot('Files', 'media-files.png')
  await files.locator('.text-file-toggle').click()
  await expect(files.locator('.text-file code').textContent()).resolves.toMatch(/value23/)
  await shot('Fixed the typo', 'media-edited.png', '.message.you')
  await shot('Thanks, noted.', 'media-reply.png')
  await shot('Model set to', 'media-command.png')
  await shot('Forwarded', 'media-forward.png')
  await shot('Which model', 'media-poll.png')
  await p.locator('.message.system').last().scrollIntoViewIfNeeded()
  await p.screenshot({ path: path.join(shots, 'media-system.png'), clip: { x: 300, y: 0, width: 980, height: 900 } })

  // Lightbox: open the second of five, step with the arrows, zoom, Esc closes.
  const five = p.locator('.message', { hasText: 'Five for the mosaic' })
  await five.scrollIntoViewIfNeeded()
  await five.locator('.media-open').nth(1).click()
  const box = p.locator('.lightbox')
  await box.waitFor()
  await expect(box.locator('.lightbox-meta').textContent()).resolves.toMatch(/2 of 5/)
  await p.keyboard.press('ArrowRight')
  await expect(box.locator('.lightbox-meta').textContent()).resolves.toMatch(/3 of 5/)
  await p.waitForTimeout(300)
  await p.screenshot({ path: path.join(shots, 'media-lightbox.png') })
  await box.locator('.lightbox-stage img').click()
  await expect(box.locator('.lightbox-stage.zoomed').count()).resolves.toBe(1)
  await p.keyboard.press('Escape')
  await box.waitFor({ state: 'detached' })

  // Scrolled up: the jump-to-present bar takes you back down.
  await p.locator('.messages').evaluate((el) => (el.scrollTop = 0))
  const present = p.locator('.present-bar')
  await present.waitFor()
  await p.screenshot({ path: path.join(shots, 'media-jump-present.png'), clip: { x: 300, y: 500, width: 980, height: 400 } })
  await present.getByRole('button', { name: 'Jump to present' }).click()
  await present.waitFor({ state: 'detached' })

  // Unread messages above the fold: the top bar counts them and jumps to the first.
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p.locator('.chat-title', { hasText: 'kimaki' }).waitFor()
  for (let i = 0; i < 30; i++) await post({ authorId: botId, content: `catch-up line ${i}` })
  await p.goto(`${origin}/#/c/${media.id}`)
  const bar = p.locator('.new-bar')
  await bar.waitFor()
  await expect(bar.textContent()).resolves.toMatch(/30 new messages since/)
  await p.screenshot({ path: path.join(shots, 'media-new-bar.png'), clip: { x: 300, y: 0, width: 980, height: 300 } })
  await bar.locator('.new-bar-jump').click()
  await p.locator('.message.highlight', { hasText: 'catch-up line 0' }).waitFor()
  await context.close()
}, 180_000)

test.skipIf(!ready)('older threads: hovering the older row previews them, See all opens the Threads panel', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const older = page.locator('.channel.older').first()
  await older.hover()
  await page.locator('.threads-popout .threads-popout-row').first().waitFor()
  await page.screenshot({ path: path.join(shots, 'older-popout.png'), clip: { x: 0, y: 150, width: 700, height: 300 } })
  await page.locator('.threads-popout-all').click()
  await page.locator('.side-panel', { hasText: 'Threads' }).first().waitFor()
})

test.skipIf(!ready)('relays and tool lines: Kimaki-injected prompt stays quiet, opens to subtext lists', async () => {
  await demo.thread.send(['┣ shell _Build the docs site_', '┣ general **Tidy the changelog** (background)'].join('\n'))
  await demo.thread.send(['Now the composer tools.', '-# » **CLI:** Progress from the other thread:', '-# - **Search is live** (commit `abc1234`, tests in `tests/search.test.ts`). Results keep their ids.', '-# - Messages carry `origin: \'remote\'` in live `MESSAGE_CREATE`.', '-# - **Sync is running now** for two servers.'].join('\n'))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  const m = page.locator('.message', { hasText: 'Now the composer tools.' }).last()
  await m.locator('.relay').waitFor()
  const tools = page.locator('.message', { hasText: 'Build the docs site' }).last()
  await page.locator('.relay-toggle').last().click()
  await m.locator('.relay.open li').first().waitFor()
  const a = await tools.boundingBox()
  const b = await m.boundingBox()
  await page.screenshot({ path: path.join(shots, 'relay-tools.png'), clip: { x: a!.x, y: a!.y, width: 900, height: b!.y + b!.height - a!.y + 8 } })
})

test.skipIf(!ready)('workspace: a thread\'s outputs, waiting items and versions in one panel; Look opens docs, tables and compares', async () => {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = await import('discord.js')
  const file = (name: string, data: Buffer | string) => new AttachmentBuilder(Buffer.from(data), { name })
  const notes = '# Weekly build report\n\nBuild times are **stable**: 4.1 min against 4.3 min last week.\n\n## Pipelines\n| Pipeline | Runs | Median |\n|---|---|---|\n| web | 212 | 4.1 min |\n| api | 148 | 6.0 min |\n'
  const data = 'pipeline,runs,median_min,cache_hits\nweb,212,4.1,81%\napi,148,6.0,74%\ndocs,37,1.2,95%\n'
  const log = '09:12:01 INFO  build started pipeline=web\n09:16:07 INFO  build finished in 4.1 min\n09:16:08 WARN  cache upload slow (1.8 s)\n'
  const pin = await demo.thread.send('Weekly build report: build times are stable (4.1 min vs 4.3 min). Next check Monday 09:00.')
  await pin.pin()
  await demo.thread.send({ content: 'First pass of the chart.', files: [file('chart.png', png(480, 300, [88, 101, 242]))] })
  await demo.thread.send({ content: 'Raw data and the build log.', files: [file('data.csv', data), file('build.log', log)] })
  await demo.thread.send({ content: 'Chart after the fix.', files: [file('chart-2.png', png(480, 300, [35, 165, 90])), file('timeline.png', png(640, 360, [250, 166, 26])), file('notes.md', notes)] })
  await demo.thread.send({ content: 'Ship the cache change on Monday?', components: [new ActionRowBuilder<any>().addComponents(new ButtonBuilder().setCustomId('ship-yes').setLabel('Ship on Monday').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('ship-no').setLabel('Wait a week').setStyle(ButtonStyle.Secondary))] })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.locator('.chat-header [aria-label="Workspace"]').click()
  const ws = page.locator('.side-panel.workspace')
  await ws.locator('.ws-shot').first().waitFor()
  await ws.locator('.ws-waiting').first().waitFor()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(shots, 'workspace-board.png') })
  await ws.locator('.ws-row', { hasText: 'notes.md' }).click()
  await page.locator('.look-doc h1').waitFor()
  await page.screenshot({ path: path.join(shots, 'workspace-look-md.png') })
  await page.locator('.look-back').click()
  await ws.locator('.ws-row', { hasText: 'data.csv' }).click()
  await page.locator('.ws-table td').first().waitFor()
  await page.screenshot({ path: path.join(shots, 'workspace-look-csv.png') })
  await page.locator('.look-back').click()
  await ws.locator('.ws-shot').filter({ has: page.locator('.ws-badge') }).first().click()
  await page.locator('[aria-label="Compare with the previous version"]').click()
  await page.locator('.look-compare img').nth(1).waitFor()
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shots, 'workspace-compare.png') })
}, 120_000)

// Discord's block spacing, measured from the desktop app in CSS px.
// gap = block's visible top minus the bottom of the 22px name line; after = between blocks.
test.skipIf(!ready)('spacing: every block kind sits where Discord puts it', async () => {
  const cases: Array<{ name: string; send: unknown; block: string }> = [
    { name: 'text', send: 'zz-text plain line', block: '.paragraph' },
    { name: 'code', send: '```\nzz-code service inactive\n```', block: '.codeblock pre' },
    { name: 'heading', send: '## zz-heading Housekeeping\n- item', block: 'h2' },
    { name: 'list', send: '- zz-list first item\n- second', block: 'ul' },
    { name: 'quote', send: '> zz-quote 458 KB', block: 'blockquote' },
    { name: 'subtext', send: '-# zz-subtext note', block: '.subtext' },
    { name: 'container', send: { flags: 32768, components: [{ type: 17, components: [{ type: 10, content: 'zz-container body' }, { type: 14, divider: true }, { type: 10, content: 'second' }] }] }, block: '.container' },
    { name: 'image', send: { files: [{ attachment: png(400, 240, [88, 101, 242]), name: 'zz-image.png' }] }, block: '.attachments' },
  ]
  // Discord's numbers: gap from the 22px name line to the block's visible top.
  const discord: Record<string, number> = { text: 0, code: 6, heading: 8, list: 4, quote: 4, subtext: 0, container: 2, image: 2 }
  // A reply always starts a group, so each case gets its own name line.
  const anchor = await demo.thread.send('zz-anchor')
  for (const c of cases) await demo.thread.send({ ...(typeof c.send === 'string' ? { content: c.send } : (c.send as object)), reply: { messageReference: anchor.id } } as never)
  await demo.thread.send('zz-end')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.locator('.message', { hasText: 'zz-end' }).waitFor()
  const out: Record<string, number> = {}
  for (const c of cases) {
    const m = c.name === 'container' ? page.locator('.message', { has: page.locator('.container', { hasText: 'zz-container' }) }).last() : c.name === 'image' ? page.locator('.message', { has: page.locator('.attachments') }).last() : page.locator('.message', { hasText: `zz-${c.name}` }).last()
    out[c.name] = await m.evaluate((el, sel) => {
      const head = el.querySelector('.message-head') as HTMLElement | null
      const block = el.querySelector(sel) as HTMLElement
      const h = head ? head.getBoundingClientRect() : null
      // The name line box: Discord's is 22px tall, centred on the name.
      const name = (el.querySelector('.author') as HTMLElement).getBoundingClientRect()
      const lineBottom = name.top + name.height / 2 + 11
      return Math.round((block.getBoundingClientRect().top - lineBottom) * 10) / 10 + (h ? 0 : 0)
    }, c.block)
  }
  console.log('SPACING', JSON.stringify(out))
  for (const c of cases) expect.soft(out[c.name], c.name).toBeCloseTo(discord[c.name]!, 0)
  // Insides: list pitch 26, quote text at +16, code text inset 8, container text inset 17, separator 8 each side.
  const inside = await page.evaluate(() => {
    const r = (el: Element | null | undefined) => el!.getBoundingClientRect()
    const lis = [...document.querySelectorAll('.message .markdown > ul')].at(-1)!.querySelectorAll(':scope > li')
    const quote = [...document.querySelectorAll('.message blockquote')].at(-1)!
    const pre = [...document.querySelectorAll('.message .codeblock pre')].at(-1)!
    const box = [...document.querySelectorAll('.message .container')].at(-1)!
    const sep = box.querySelector(':scope > .separator')!
    const range = document.createRange()
    range.selectNodeContents(quote)
    const firstText = box.querySelector('.markdown')!
    return {
      listPitch: Math.round(r(lis[1]).top - r(lis[0]).top),
      quoteText: Math.round(range.getBoundingClientRect().left - r(quote).left),
      codeInset: Math.round(r(pre.querySelector('code')).left - r(pre).left),
      containerInset: Math.round(r(firstText).left - r(box).left),
      sepAbove: Math.round(r(sep).top - r(sep.previousElementSibling).bottom),
      sepBelow: Math.round(r(sep.nextElementSibling).top - r(sep).bottom),
    }
  })
  console.log('INSIDE', JSON.stringify(inside))
  expect.soft(inside).toEqual({ listPitch: 26, quoteText: 16, codeInset: 8, containerInset: 17, sepAbove: 8, sepBelow: 8 })
  // Discord's tones (#abacb2 for quotes and -# lines): our --text-muted, not the body colour.
  const tones = await page.evaluate(() => {
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim()
    const probe = document.createElement('span')
    probe.style.color = muted
    document.body.append(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    const color = (sel: string) => getComputedStyle([...document.querySelectorAll(sel)].at(-1)!).color
    return { quote: color('.message blockquote') === want, subtext: color('.message .subtext') === want }
  })
  expect.soft(tones).toEqual({ quote: true, subtext: true })
})

test.skipIf(!ready)('lightbox: a tall phone screenshot fits the screen, top to bottom', async () => {
  const { AttachmentBuilder } = await import('discord.js')
  await demo.thread.send({ content: 'zz-tall', files: [new AttachmentBuilder(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/tall-phone.png')), { name: 'IMG_0001.png' })] })
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size)
    await page.goto(`${origin}/#/c/${demo.thread.id}`)
    // Close any side panel an earlier test left open (it covers the chat on a phone).
    while (await page.locator('.side-panel').count()) await page.locator('.side-panel .panel-close').first().click()
    const m = page.locator('.message', { hasText: 'zz-tall' }).last()
    await m.locator('.attachments img').first().click()
    const img = page.locator('.lightbox-stage img')
    await img.waitFor()
    await page.waitForFunction(() => (document.querySelector('.lightbox-stage img') as HTMLImageElement)?.complete)
    const r = await img.boundingBox()
    expect(r!.y).toBeGreaterThanOrEqual(0)
    expect(r!.y + r!.height).toBeLessThanOrEqual(size.height)
    expect(r!.x).toBeGreaterThanOrEqual(0)
    expect(r!.x + r!.width).toBeLessThanOrEqual(size.width)
    await page.screenshot({ path: path.join(shots, `lightbox-${size.width}.png`) })
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 1280, height: 800 })
})

test.skipIf(!ready)('upload tiles: previews in the composer, spoiler, rename and remove before sending', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block' })
  const p = await context.newPage()
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(origin)
  await p.getByLabel('Pairing code').fill(await hub.store.createPairing('uploads'))
  await p.getByText('Pair this device').click()
  await p.goto(`${origin}/#/c/${demo.thread.id}`)
  await p.locator('.composer textarea').waitFor()
  const input = p.locator('.composer input[type=file]')
  await input.setInputFiles([
    { name: 'tide-chart.png', mimeType: 'image/png', buffer: png(320, 180, [0, 160, 200]) },
    { name: 'pier.png', mimeType: 'image/png', buffer: png(120, 240, [200, 120, 40]) },
  ])
  const tiles = p.locator('.upload-tile')
  await expect.poll(() => tiles.count()).toBe(2)
  await expect.poll(() => p.locator('.upload-tile:not(.busy)').count()).toBe(2)
  for (const img of await p.locator('.upload-preview img').all()) expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)

  // Spoiler the first: the button presses and the preview blurs.
  await tiles.nth(0).getByRole('button', { name: 'Spoiler attachment' }).click()
  expect(await tiles.nth(0).getAttribute('class')).toMatch(/spoilered/)
  expect(await tiles.nth(0).getByRole('button', { name: 'Remove spoiler' }).getAttribute('aria-pressed')).toBe('true')

  // Rename the second in the dialog.
  await tiles.nth(1).getByRole('button', { name: 'Modify attachment' }).click()
  const dialog = p.locator('form.upload-editor')
  await dialog.waitFor()
  await p.screenshot({ path: path.join(shots, 'upload-editor.png'), animations: 'disabled' })
  await dialog.getByLabel('File name').fill('harbour-map.png')
  await dialog.getByLabel('Description').fill('A map of the harbour')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => tiles.nth(1).locator('.upload-tile-name').textContent()).toBe('harbour-map.png')

  // A third, non-image file shows its type; then remove it.
  await input.setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('tide notes\n') }])
  await expect.poll(() => tiles.count()).toBe(3)
  expect(await tiles.nth(2).locator('.upload-file').textContent()).toBe('TXT')
  await expect.poll(() => p.locator('.upload-tile:not(.busy)').count()).toBe(3)
  await p.screenshot({ path: path.join(shots, 'upload-tiles.png'), clip: { x: 0, y: 560, width: 1280, height: 340 } })

  // Padding: the tile's content sits the same distance from every edge, and so does the bar's.
  const geometry = await tiles.nth(0).evaluate((tile) => {
    const r = tile.getBoundingClientRect()
    const preview = tile.querySelector('.upload-preview')!.getBoundingClientRect()
    const name = tile.querySelector('.upload-tile-name')!.getBoundingClientRect()
    const bar = tile.querySelector('.upload-actions')!.getBoundingClientRect()
    const buttons = [...tile.querySelectorAll('.upload-actions .icon-button')].map((b) => b.getBoundingClientRect())
    const footer = tile.closest('.footer')!.getBoundingClientRect()
    return {
      size: [r.width, r.height],
      tile: [preview.left - r.left, preview.top - r.top, r.right - preview.right, r.bottom - name.bottom],
      bar: [preview.right - bar.right, bar.top - preview.top],
      barPad: [buttons[0]!.left - bar.left, buttons[0]!.top - bar.top, bar.right - buttons.at(-1)!.right, bar.bottom - buttons[0]!.bottom],
      box: [r.left - footer.left, r.top - footer.top],
    }
  })
  expect(geometry.size).toEqual([216, 216])
  expect(geometry.tile).toEqual([9, 9, 9, 9])
  expect(geometry.bar[0]).toBe(geometry.bar[1])
  expect(new Set(geometry.barPad).size).toBe(1)
  expect(geometry.box[0]).toBe(geometry.box[1])

  await tiles.nth(2).getByRole('button', { name: 'Remove attachment' }).click()
  await expect.poll(() => tiles.count()).toBe(2)

  await p.locator('.composer textarea').fill('zz-tiles')
  await p.locator('.composer textarea').press('Enter')
  const sent = p.locator('.message', { hasText: 'zz-tiles' }).last()
  await sent.waitFor()
  await expect.poll(() => tiles.count()).toBe(0)
  const names = await p.evaluate(async (id) => {
    const r = await fetch(`/client/channels/${id}/messages?limit=5`)
    const { messages } = (await r.json()) as { messages: Array<{ content: string; attachments: Array<{ filename: string; description?: string }> }> }
    return messages.find((m) => m.content === 'zz-tiles')?.attachments.map((a) => [a.filename, a.description ?? null])
  }, demo.thread.id)
  expect(names).toEqual([['SPOILER_tide-chart.png', null], ['harbour-map.png', 'A map of the harbour']])
  await expect(sent.locator('.media-cell.spoiler').count()).resolves.toBe(1)
  await context.close()
})

test.skipIf(!ready)('jump to present: a floating pill centred over the chat, as in Discord', async () => {
  for (let i = 0; i < 40; i++) await demo.thread.send(`zz-older ${i}`)
  const ctx2 = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', storageState: await page.context().storageState(), deviceScaleFactor: 2, viewport: { width: 1280, height: 700 } })
  const p2 = await ctx2.newPage()
  await p2.goto(`${origin}/#/c/${demo.thread.id}`)
  await p2.locator('.message', { hasText: 'zz-older 39' }).waitFor()
  await p2.locator('.messages').evaluate((el) => { el.scrollTop = 0 })
  await p2.locator('.present-bar').waitFor()
  await p2.mouse.move(1, 1)
  await p2.waitForTimeout(400)
  const bar = await p2.locator('.present-bar').boundingBox()
  const chat = await p2.locator('.messages').boundingBox()
  expect(Math.abs(bar!.x + bar!.width / 2 - (chat!.x + chat!.width / 2))).toBeLessThan(2)
  await p2.screenshot({ path: path.join(shots, 'jump-present.png'), clip: { x: bar!.x - 40, y: bar!.y - 30, width: bar!.width + 80, height: bar!.height + 60 } })
  await ctx2.close()
}, 90_000)

test.skipIf(!ready)('list pills: a row below the fold shows a pill 26px tall, 6px above the user panel', async () => {
  const ctx2 = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', storageState: await page.context().storageState(), deviceScaleFactor: 2, viewport: { width: 1280, height: 360 } })
  const p2 = await ctx2.newPage()
  await p2.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p2.locator('.channel-list').waitFor()
  await p2.locator('.channel-list').evaluate((el) => { el.scrollTop = 0 })
  await demo.thread.send('zz-unread ping')
  await p2.waitForTimeout(1200)
  const info = await p2.evaluate(() => ({ unread: document.querySelectorAll('.channel-list .channel.unread').length, pills: [...document.querySelectorAll('.list-pill')].map((p) => p.textContent), h: document.querySelector('.channel-list')!.scrollHeight, ch: document.querySelector('.channel-list')!.clientHeight }))
  // Unread, or a mention if an earlier test left one below the fold: either way one pill.
  expect(info.pills.length).toBe(1)
  // Discord: 26px tall, 6px above the user panel.
  const pill = await p2.locator('.list-pill').boundingBox()
  const panel = await p2.locator('.user-panel').boundingBox()
  expect(Math.round(pill!.height)).toBe(26)
  expect(Math.round(panel!.y - (pill!.y + pill!.height))).toBe(6)
  expect(Math.round(pill!.x + pill!.width)).toBe(Math.round(panel!.x + panel!.width))
  const side = await p2.locator('.sidebar').boundingBox()
  await p2.screenshot({ path: path.join(shots, 'list-pills.png'), clip: { x: side!.x, y: 0, width: side!.width, height: 360 } })
  await ctx2.close()
}, 60_000)

test.skipIf(!ready)('pairing link: #pair=CODE opens on Create passkey, signs the device in and clears the fragment', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const p = await context.newPage()
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  const code = await hub.store.createPairing('tablet')
  await p.goto(`${origin}/#pair=${code}`)
  await p.getByRole('button', { name: 'Create passkey' }).waitFor()
  expect(await p.evaluate(() => location.hash)).toBe('')
  await expect(p.getByLabel('Pairing code').inputValue()).resolves.toBe(code)
  await expect(p.getByText('Sign in with passkey').count()).resolves.toBe(0)
  await p.getByRole('button', { name: 'Create passkey' }).click()
  await p.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' }).waitFor()
  await context.close()
}, 60_000)

test.skipIf(!ready)('requests: an agent asks, the bell counts it, the owner approves with a passkey or denies', async () => {
  const token = readSecret(t.paths.adminToken)
  const ask = async (username: string, reason: string) => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/admin/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { username }, reason, origin: 'agent session docs' }) })
    expect(res.status).toBeLessThan(300)
  }
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const bell = page.locator('.inbox-button')
  await bell.waitFor()
  const before = Number((await bell.locator('.num').textContent().catch(() => '0')) ?? 0)
  await ask('robin', 'Robin reviews the release notes')
  await ask('kit', 'Kit tests the installer')
  await expect.poll(() => bell.locator('.num').textContent()).toBe(String(before + 2))
  await bell.click()
  const cards = page.locator('.request-card')
  await expect.poll(() => cards.count()).toBe(2)
  const robin = cards.filter({ hasText: 'Robin reviews' })
  await expect(robin.locator('.request-meta').textContent()).resolves.toMatch(/^from agent session docs · expires (at|tomorrow) \d\d:\d\d$/)
  const shot = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', storageState: await page.context().storageState(), deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } })
  const p2 = await shot.newPage()
  await p2.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p2.locator('.inbox-button').click()
  await p2.locator('.request-card').first().waitFor()
  await p2.mouse.move(1, 1)
  await p2.waitForTimeout(300)
  await p2.locator('.side-panel').last().screenshot({ path: path.join(shots, 'inbox-requests.png') })
  await shot.close()
  await robin.getByRole('button', { name: 'Approve' }).click()
  await expect.poll(() => robin.getAttribute('class')).toContain('approved')
  // An approved change can be undone: the reversal is a new pending request.
  await robin.getByRole('button', { name: 'Undo' }).click()
  const reversal = cards.filter({ hasText: /^Undo: / })
  await expect.poll(() => reversal.count()).toBe(1)
  await expect(reversal.getAttribute('class')).resolves.toContain('pending')
  await reversal.getByRole('button', { name: 'Deny' }).click()
  await expect.poll(() => reversal.getAttribute('class')).toContain('denied')
  const kit = cards.filter({ hasText: 'Kit tests' })
  await kit.getByRole('button', { name: 'Deny' }).click()
  await expect.poll(() => kit.getAttribute('class')).toContain('denied')
  await expect.poll(() => bell.locator('.num').count().then(async (n) => (n ? Number(await bell.locator('.num').textContent()) : 0))).toBe(before)
  await page.keyboard.press('Escape')
}, 60_000)

test.skipIf(!ready)('one chat at a time: switching channels with a thread\'s Services panel open leaves no stale chat behind', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const rows = page.locator('.sidebar .channel')
  await rows.filter({ hasText: 'Fix footer on short turns' }).click()
  await page.locator('.chat-title', { hasText: 'Fix footer' }).waitFor()
  await page.locator('.chat-header button[aria-label^="Services"]').click()
  await page.locator('.side-panel').first().waitFor()
  await rows.filter({ hasText: '#general' }).click()
  await page.locator('.chat-title', { hasText: 'general' }).waitFor()
  await rows.filter({ hasText: '#kimaki' }).click()
  await page.locator('.chat-title', { hasText: 'kimaki' }).waitFor()
  await expect.poll(() => page.locator('section.chat').count()).toBe(1)
  await page.keyboard.press('Escape')
}, 60_000)

test.skipIf(!ready)('server rail: a server with its own icon gets no accent fill when open or hovered', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const guild = page.locator('.rail-item.active .rail-guild')
  await guild.waitFor()
  const fill = () => guild.evaluate((e) => getComputedStyle(e).backgroundColor)
  expect(await fill()).not.toBe('rgba(0, 0, 0, 0)')
  await guild.evaluate((e) => e.classList.add('has-icon'))
  await expect.poll(fill).toBe('rgba(0, 0, 0, 0)')
  await guild.hover()
  await expect.poll(fill).toBe('rgba(0, 0, 0, 0)')
  await guild.evaluate((e) => e.classList.remove('has-icon'))
}, 30_000)

test.skipIf(!ready)('phone: a channel opened from outside the list (a link, a notification) shows the channel', async () => {
  const phone = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const m = await phone.newPage()
  await m.goto(`${origin}/`)
  await m.locator('.sidebar .channel').first().waitFor()
  await m.evaluate((id) => (location.hash = `#/c/${id}`), demo.thread.id)
  await m.locator('.chat-title', { hasText: 'Fix footer' }).waitFor()
  await expect.poll(() => m.locator('.sidebar.open').count()).toBe(0)
  await phone.close()
}, 60_000)

test.skipIf(!ready)('long press: holding a message on a phone opens its sheet, and lifting the finger picks nothing', async () => {
  const phone = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', storageState: await page.context().storageState(), deviceScaleFactor: 3, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const m = await phone.newPage()
  await m.goto(`${origin}/#/c/${demo.thread.id}`)
  const msg = m.locator('.message').last()
  await msg.waitFor()
  const text = await msg.textContent()
  const b = (await msg.boundingBox())!
  const cdp = await phone.newCDPSession(m)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 150, y: b.y + b.height / 2 }] })
  await m.locator('.sheet-layer').waitFor()
  await m.waitForTimeout(200)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await m.waitForTimeout(600)
  // Still open, nothing chosen: the message is still there.
  await expect(m.locator('.sheet-layer').count()).resolves.toBe(1)
  await expect(m.locator('.message').last().textContent()).resolves.toBe(text)
  await m.screenshot({ path: path.join(shots, 'longpress-sheet.png') })
  // A real tap afterwards still works.
  await m.getByRole('menuitem', { name: 'Reply' }).or(m.locator('.sheet-item', { hasText: 'Reply' })).first().tap()
  await m.locator('.sheet-layer').waitFor({ state: 'detached' })
  await phone.close()
}, 60_000)

test.skipIf(!ready)('deleting a message asks first, as in Discord', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.evaluate((id) => fetch(`/client/channels/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'zz-delete-me' }) }), demo.thread.id)
  // Exact text: the demo bot answers with "Got it: zz-delete-me".
  const msg = page.locator('.message').filter({ has: page.getByText('zz-delete-me', { exact: true }) })
  await msg.waitFor()
  const del = async () => {
    await msg.click({ button: 'right' })
    await page.locator('.sheet-item', { hasText: 'Delete' }).click()
    await page.locator('.sheet-title', { hasText: 'Delete message?' }).waitFor()
  }
  await del()
  await page.keyboard.press('Escape')
  await page.locator('.sheet-layer').waitFor({ state: 'detached' })
  await expect(msg.count()).resolves.toBe(1)
  await del()
  await page.locator('.sheet').screenshot({ path: path.join(shots, 'delete-confirm.png') })
  await page.locator('.sheet-item', { hasText: 'Delete' }).click()
  await msg.waitFor({ state: 'detached' })
}, 60_000)

test.skipIf(!ready)('thread cards: the meta line starts under the name, in the channel and in the Threads panel', async () => {
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  // Where an element's first piece of text starts on screen.
  const textLeft = (l: import('playwright-core').Locator) =>
    l.evaluate((e) => {
      const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) })
      const r = document.createRange()
      r.selectNodeContents(walk.nextNode()!)
      return Math.round(r.getBoundingClientRect().left)
    })
  const card = page.locator('.thread-card').first()
  await card.waitFor()
  expect(await textLeft(card.locator('.thread-card-meta'))).toBe(await textLeft(card.locator('.thread-card-name')))
  await page.locator('.chat-header button[aria-label="Threads"]').click()
  const row = page.locator('.side-panel .thread-row').first()
  await row.waitFor()
  expect(await textLeft(row.locator('.result-where'))).toBe(await textLeft(row.locator('.link-title')))
  await page.keyboard.press('Escape')
}, 30_000)

test.skipIf(!ready)('overview on a phone: the always-visible dismiss button never covers the age', async () => {
  const { ownerUserId } = hub.options.config
  const ask = await demo.kimaki.threads.create({ name: 'Pick the release train' })
  await ask.send(`<@${ownerUserId}> **Question:** Beta first, or straight to stable?`)
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(`${origin}/#/overview`)
  const item = p.locator('.ov-item', { hasText: 'Pick the release train' })
  await item.waitFor()
  const age = (await item.locator('.ov-age').boundingBox())!
  const dismiss = (await item.locator('.ov-dismiss').boundingBox())!
  expect(await item.locator('.ov-dismiss').evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
  expect(dismiss.x - (age.x + age.width)).toBeGreaterThanOrEqual(4)
  await ctx.close()
}, 60_000)

test.skipIf(!ready)('thread card on a phone: a long name gives way, the message count stays whole', async () => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const card = p.locator('.thread-card').first()
  await card.waitFor()
  const fits = await card.evaluate((c) => {
    const box = c.getBoundingClientRect()
    const count = c.querySelector('.thread-card-count')!.getBoundingClientRect()
    return count.right <= box.right - 8 && c.querySelector('.thread-card-count svg') !== null
  })
  expect(fits).toBe(true)
  await ctx.close()
}, 60_000)

test.skipIf(!ready)('sign-in: a bad pairing code shows in the field label, in plain words', async () => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })
  const p = await ctx.newPage()
  await p.goto(`${origin}/`)
  await p.getByLabel('Pairing code').fill('ZZZZZZZZZZ')
  await p.getByRole('button', { name: 'Pair this device' }).click()
  const label = p.locator('.login-label.bad')
  await label.waitFor()
  expect(await label.textContent()).toBe('Pairing code · Expired, used or not found. Ask for a new one.')
  await ctx.close()
}, 60_000)

test.skipIf(!ready)("can't reach the hub: a plain card with Try again, and it recovers by itself", async () => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': LOGIN }, serviceWorkers: 'block', deviceScaleFactor: 2, viewport: { width: 1000, height: 700 } })
  await ctx.route('**/client/auth/status', (r) => r.abort())
  const p = await ctx.newPage()
  await p.goto(`${origin}/`)
  await p.getByRole('heading', { name: "Can't reach the hub" }).waitFor()
  await p.screenshot({ path: path.join(shots, 'cant-reach.png') })
  await ctx.unroute('**/client/auth/status')
  await p.getByText('Sign in with passkey').waitFor({ timeout: 8000 })
  await ctx.close()
}, 60_000)

test.skipIf(!ready)('a server with no channels welcomes the owner with first steps', async () => {
  const p = await page.context().newPage()
  await p.route('**/client/state', async (r) => {
    const j = await (await r.fetch()).json()
    j.channels = []
    j.threads = []
    await r.fulfill({ json: j })
  })
  // An earlier test may have left Overview as the last view; ask for a channel that isn't there.
  await p.goto(`${origin}/#/c/1`)
  await p.getByRole('heading', { name: /Welcome to/ }).waitFor()
  for (const step of ['Connect a machine', 'Move from Discord', 'Pair another device', 'Invite people']) await p.locator('.welcome-step', { hasText: step }).waitFor()
  await p.locator('.welcome-step', { hasText: 'Pair another device' }).click()
  await p.locator('.settings-layer').getByText('Devices').first().waitFor()
  await p.close()
}, 60_000)

test.skipIf(!ready)('keyboard: Ctrl+K switcher, Enter on empty goes back, Alt+arrows walk the list, Up edits, Ctrl+/ lists shortcuts, message links jump', async () => {
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await page.locator('.chat-header', { hasText: 'Fix footer on short turns' }).waitFor()
  const general = await page.evaluate(() => fetch('/client/state').then((r) => r.json()).then((s) => s.channels.find((c: { name: string }) => c.name === 'general').id))

  await page.keyboard.press('Control+k')
  await page.locator('.switcher').waitFor()
  await page.keyboard.type('genera')
  await page.locator('.switcher-item.picked', { hasText: 'general' }).waitFor()
  await page.locator('.switcher').screenshot({ path: path.join(shots, 'quick-switcher.png') })
  await page.keyboard.press('Enter')
  await page.waitForFunction((id) => location.hash === `#/c/${id}`, general)
  await page.keyboard.press('Control+k')
  await page.locator('.switcher input:focus').waitFor()
  await page.keyboard.press('Enter')
  await page.locator('.switcher').waitFor({ state: 'detached' })
  await page.waitForFunction((id) => location.hash === `#/c/${id}`, demo.thread.id)

  // Alt+Down from the thread moves to the next row in the list.
  const rows = await page.locator('.sidebar [data-nav]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['nav']))
  const next = rows[rows.indexOf(demo.thread.id) + 1]
  if (next) {
    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForFunction((id) => location.hash === `#/c/${id}`, next)
    await page.keyboard.press('Alt+ArrowUp')
    await page.waitForFunction((id) => location.hash === `#/c/${id}`, demo.thread.id)
  }

  // Up in the empty box edits the owner's last message.
  const box = page.locator('.composer textarea').first()
  await page.evaluate((id) => fetch(`/client/channels/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'zz-edit-me' }) }), demo.thread.id)
  await page.locator('.message', { has: page.getByText('zz-edit-me', { exact: true }) }).waitFor()
  await box.click()
  await box.press('ArrowUp')
  const editor = page.locator('.edit-box textarea, .message textarea').filter({ hasText: 'zz-edit-me' })
  await editor.waitFor()
  await editor.press('Escape')

  // Copy message link gives a link that jumps to the message.
  const id = await page.locator('.message', { has: page.getByText('zz-edit-me', { exact: true }) }).getAttribute('id')
  await page.goto(`${origin}/#/c/${demo.thread.id}/${id!.slice(2)}`)
  await page.waitForFunction((tid) => location.hash === `#/c/${tid}`, demo.thread.id)
  await page.locator(`#${id}.highlight`).waitFor()

  await page.keyboard.press('Control+/')
  await page.locator('.shortcuts .shortcut-row').first().waitFor()
  await page.locator('.shortcuts').screenshot({ path: path.join(shots, 'shortcuts.png') })
  await page.keyboard.press('Escape')
  await page.locator('.shortcuts').waitFor({ state: 'detached' })
}, 60_000)

test.skipIf(!ready)('mark unread: from the menu or Alt+click, the line moves there, and other tabs follow', async () => {
  const other = await page.context().newPage()
  await other.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const otherRow = other.locator('.sidebar .channel', { hasText: 'Fix footer on short turns' })
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  // Messages sent before the event socket is up only show after a resync.
  await page.getByText('filler 59', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  await demo.thread.send('zz-unread-one')
  await demo.thread.send('zz-unread-two')
  const one = page.locator('.message').filter({ has: page.getByText('zz-unread-one', { exact: true }) })
  await page.locator('.message').filter({ has: page.getByText('zz-unread-two', { exact: true }) }).waitFor()
  const id = (await one.getAttribute('id'))!.slice(2)
  await one.click({ button: 'right' })
  await page.locator('.sheet-item', { hasText: 'Mark unread' }).click()
  // The line sits right above the message, the hub moved back, and the other tab shows it unread.
  await expect.poll(() => page.evaluate((mid) => document.getElementById(`m-${mid}`)?.previousElementSibling?.classList.contains('new-divider') ?? false, id)).toBe(true)
  await expect.poll(async () => (await hub.store.readState(hub.options.config.ownerUserId))[demo.thread.id]).toBe(String(BigInt(id) - 1n))
  await expect.poll(() => otherRow.evaluate((e) => e.classList.contains('unread'))).toBe(true)
  // Still unread while open: reading it again needs leaving or Mark as read.
  await page.waitForTimeout(800)
  expect((await hub.store.readState(hub.options.config.ownerUserId))[demo.thread.id]).toBe(String(BigInt(id) - 1n))
  // Alt+click moves it to another message.
  const two = page.locator('.message').filter({ has: page.getByText('zz-unread-two', { exact: true }) })
  const id2 = (await two.getAttribute('id'))!.slice(2)
  await two.locator('.message-body, .content').first().click({ modifiers: ['Alt'] }).catch(() => two.click({ modifiers: ['Alt'], position: { x: 300, y: 10 } }))
  await expect.poll(async () => (await hub.store.readState(hub.options.config.ownerUserId))[demo.thread.id]).toBe(String(BigInt(id2) - 1n))
  // Leaving and coming back reads it.
  await page.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await page.getByPlaceholder('Message #kimaki').waitFor()
  await page.goto(`${origin}/#/c/${demo.thread.id}`)
  await expect.poll(() => otherRow.evaluate((e) => e.classList.contains('unread'))).toBe(false)
  await other.close()
}, 90_000)

test.skipIf(!ready)('direct messages: Home in the rail, the DM list, and New message offers people', async () => {
  const p = await page.context().newPage()
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p.getByRole('button', { name: 'Direct messages' }).click()
  await p.locator('.side-title', { hasText: 'Direct messages' }).waitFor()
  await p.getByRole('button', { name: 'New message' }).first().click()
  // People to write to, or (when no one else is on the hub) Invite people; never a machine.
  await p.locator('.sheet-item').first().waitFor()
  await expect(p.locator('.sheet-item', { hasText: 'Workstation' }).count()).resolves.toBe(0)
  await p.close()
}, 60_000)

test.skipIf(!ready)('reminders: Remind me on a message; when it fires the Inbox shows it with Later and Done', async () => {
  const p = await page.context().newPage()
  await p.goto(`${origin}/#/c/${demo.thread.id}`)
  await p.locator('.message').last().waitFor()
  await p.waitForTimeout(500)
  await demo.thread.send('zz-remind-me')
  const msg = p.locator('.message').filter({ has: p.getByText('zz-remind-me', { exact: true }) })
  await msg.click({ button: 'right' })
  await p.locator('.sheet-item', { hasText: 'Remind me' }).click()
  await p.locator('.sheet-item', { hasText: 'In 1 hour' }).click()
  await p.getByText(/^Reminder set for /).waitFor()
  await p.evaluate(() => (document.querySelector('.inbox-button') as HTMLElement).click())
  await p.locator('.reminder-row:not(.due)', { hasText: 'zz-remind-me' }).waitFor()
  await hub.schedules.runDue(Date.now() + 2 * 3600_000)
  const due = p.locator('.reminder-row.due', { hasText: 'zz-remind-me' })
  await due.waitFor()
  await due.getByRole('button', { name: 'Done' }).click()
  await due.waitFor({ state: 'detached' })
  await p.close()
}, 60_000)

test.skipIf(!ready)('scheduled messages: right-click Send to schedule, the channel says so, the panel lists and cancels', async () => {
  const p = await page.context().newPage()
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const box = p.getByPlaceholder('Message #kimaki')
  await box.fill('zz-later-please')
  await p.getByRole('button', { name: 'Send', exact: true }).click({ button: 'right' })
  await p.locator('.sheet-item', { hasText: 'Pick a time' }).click()
  const dialog = p.getByRole('dialog', { name: 'Schedule message' })
  await dialog.waitFor()
  await dialog.getByLabel('Repeat').selectOption('weekdays')
  await dialog.getByRole('button', { name: 'Schedule' }).click()
  await p.getByText(/^Scheduled: Weekdays at /).waitFor()
  await expect(box.inputValue()).resolves.toBe('')
  const rows = await hub.schedules.handleClient({ method: 'GET' } as never, '/client/schedules', { userId: hub.options.config.ownerUserId } as never) as { schedules: Array<{ content: string; cron: string | null }> }
  expect(rows.schedules.find((s) => s.content === 'zz-later-please')?.cron).toMatch(/^\d+ \d+ \* \* [\d,]+$/)
  await p.getByRole('button', { name: '1 scheduled message' }).click()
  const row = p.locator('.reminder-row.scheduled', { hasText: 'zz-later-please' })
  await row.waitFor()
  await row.getByRole('button', { name: 'Cancel scheduled message' }).click()
  await row.waitFor({ state: 'detached' })
  await p.close()
}, 60_000)

test.skipIf(!ready)('members: a machine in the member list has a menu, without Message', async () => {
  const p = await page.context().newPage()
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p.getByRole('button', { name: 'Members' }).click()
  await p.locator('button.member', { hasText: 'Workstation' }).first().click()
  // Agents work in project channels: a machine's menu has no Message.
  await p.locator('.sheet-item', { hasText: 'Copy machine name' }).waitFor()
  await expect(p.locator('.sheet-item', { hasText: 'Message' }).count()).resolves.toBe(0)
  await p.close()
}, 60_000)

test.skipIf(!ready)("a DM with a machine shows the hub's note instead of the message box", async () => {
  const p = await page.context().newPage()
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p.getByPlaceholder('Message #kimaki').waitFor()
  const dm = await p.evaluate(() => fetch('/client/dms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machine: 'workstation' }) }).then((r) => r.json()))
  await p.goto(`${origin}/#/c/${dm.id}`)
  await p.locator('.output-bar', { hasText: 'work in its project channels' }).waitFor()
  await expect(p.locator('.footer textarea').count()).resolves.toBe(0)
  await p.close()
}, 60_000)

test.skipIf(!ready)('Kimaki routines show in Scheduled, read-only, under their machine', async () => {
  const p = await page.context().newPage()
  await p.route('**/client/routines', (r) => r.fulfill({ json: { machines: [{ machine: 'workstation', updated_at: Date.now(), routines: [
    { id: 'k1', prompt: 'Run the weekly test suite and summarise failures', schedule: '0 9 * * 1 (UTC)', channel_id: demo.kimaki.id, thread_id: null, agent: 'build', model: null, next_run: new Date(Date.now() + 86_400_000).toISOString(), status: 'active' },
  ] }] } }))
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p.locator('.channel.overview-row', { hasText: 'Scheduled' }).click()
  await p.locator('.panel-section', { hasText: 'Routines on Workstation' }).waitFor()
  const row = p.locator('.reminder-row.routine', { hasText: 'weekly test suite' })
  await row.waitFor()
  await expect(row.locator('.reminder-cancel').count()).resolves.toBe(0)
  await p.getByText('Routines are edited in Kimaki.').waitFor()
  await p.close()
}, 60_000)

test.skipIf(!ready)("an agent's permission prompt is an approval card: the ask, the command, Accept, Always and Deny", async () => {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js')
  const p = await page.context().newPage()
  await p.goto(`${origin}/#/c/${demo.thread.id}`)
  await p.locator('.message').last().waitFor()
  await p.waitForTimeout(500)
  await demo.thread.send({ content: '⚠️ **Permission Required**\n**Type:** `bash`\n**Pattern:** `vocorum devices revoke laptop`', components: [new ActionRowBuilder<any>().addComponents(new ButtonBuilder().setCustomId('permission_once:x').setLabel('Accept').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('permission_always:x').setLabel('Accept Always').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('permission_reject:x').setLabel('Deny').setStyle(ButtonStyle.Secondary))] })
  const card = p.locator('.approval.open', { hasText: 'vocorum devices revoke laptop' })
  await card.waitFor()
  await card.getByText('Run this command?').waitFor()
  for (const name of ['Accept', 'Always', 'Deny']) await card.getByRole('button', { name, exact: true }).waitFor()
  await demo.thread.send('⚠️ **Permission Required**\n**Type:** `bash`\n**Pattern:** `vocorum people remove sam`\n❌ Permission **rejected**')
  const done = p.locator('.approval', { hasText: 'vocorum people remove sam' })
  await done.getByText('Denied', { exact: true }).waitFor()
  await expect(done.getByRole('button', { name: 'Accept' }).count()).resolves.toBe(0)
  await p.close()
}, 60_000)

test.skipIf(!ready)("a request link in an agent's message carries the request's card, decided right there", async () => {
  const token = readSecret(t.paths.adminToken)
  const res = await fetch(`http://127.0.0.1:${hub.port}/admin/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'POST', route: `/client/guilds/${t.config.guildId}/invites`, body: { username: 'jules' }, reason: 'Jules joins for the launch', origin: 'admin' }) })
  const { id } = (await res.json()) as { id: string }
  const p = await page.context().newPage()
  await p.goto(`${origin}/#/c/${demo.thread.id}`)
  await p.locator('.message').last().waitFor()
  await p.waitForTimeout(500)
  await demo.thread.send(`I asked to invite jules. Approve it here: ${origin}/#/requests/${id}`)
  const card = p.locator('.inline-requests .request-card', { hasText: 'Jules joins for the launch' })
  await card.waitFor()
  await card.getByRole('button', { name: 'Deny' }).click()
  await expect.poll(() => card.getAttribute('class')).toContain('denied')
  await p.close()
}, 60_000)

test.skipIf(!ready)('the Admin server is marked apart: last in the rail, a shield and a note, an amber rule, its own prompt', async () => {
  const adminGuild = await hub.store.addGuild('Admin')
  await hub.reload()
  const p = await page.context().newPage()
  await p.route('**/client/state', async (r) => {
    const j = await (await r.fetch()).json()
    j.admin_guild_id = adminGuild.id
    await r.fulfill({ json: j })
  })
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  const rail = p.getByRole('navigation', { name: 'Servers' })
  await rail.locator('.rail-item.admin').waitFor()
  await expect(rail.locator('.rail-item').last().getAttribute('class')).resolves.toContain('admin')
  await rail.locator('.rail-item.admin').click()
  await p.getByText('Only you and your admin agent.').waitFor()
  await p.locator('section.chat.admin').waitFor()
  await p.getByPlaceholder('Ask your admin agent').waitFor()
  await p.close()
}, 60_000)

test.skipIf(!ready)('a friend (no manage rights): Devices opens, panels close, channel settings have no Permissions page', async () => {
  const token = readSecret(t.paths.adminToken)
  const res = await fetch(`http://127.0.0.1:${hub.port}/admin/people`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'robin2', guilds: [t.config.guildId], tailscale_login: 'robin2@example.org' }) })
  const { code } = (await res.json()) as { code: string }
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': 'robin2@example.org' }, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const p = await ctx.newPage()
  const cdp = await ctx.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(origin)
  await p.getByLabel('Pairing code').fill(code)
  await p.getByRole('button', { name: 'Pair this device' }).click()
  await p.goto(`${origin}/#/c/${demo.kimaki.id}`)
  await p.getByPlaceholder('Message #kimaki').waitFor()
  await p.getByRole('button', { name: 'Settings', exact: true }).click()
  await p.getByRole('button', { name: 'User settings' }).click()
  await p.getByRole('button', { name: 'Devices', exact: true }).click({ timeout: 5000 })
  await p.getByRole('heading', { name: 'Devices' }).waitFor({ timeout: 5000 })
  await p.keyboard.press('Escape')
  await p.getByRole('button', { name: 'Members' }).click({ timeout: 5000 })
  await p.locator('.side-panel').waitFor()
  await p.locator('.side-panel').getByRole('button', { name: 'Close', exact: true }).click({ timeout: 5000 })
  await p.locator('.side-panel').waitFor({ state: 'detached', timeout: 5000 })
  await p.locator('.chat-header button[aria-label="More"]').click()
  await p.locator('.sheet-item', { hasText: 'Edit channel' }).click()
  const dialog = p.getByRole('dialog', { name: 'Channel settings' })
  await dialog.getByRole('button', { name: 'Notifications', exact: true }).waitFor()
  await expect(dialog.getByRole('button', { name: 'Permissions', exact: true }).count()).resolves.toBe(0)
  await ctx.close()
}, 90_000)
