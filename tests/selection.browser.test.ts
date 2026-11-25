// All actions in this suite, including the real confirm click, go to a new
// loopback hub. There is no option to supply another origin or device.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { Hub } from '../src/hub.ts'
import { LOGIN, pairedDevice, startTestHub, TestDevice } from './helpers.ts'
import { startDemoBot } from './demo-bot.ts'

const webDir = path.resolve(import.meta.dirname, '../web/dist')
const cache = path.join(os.homedir(), '.cache/ms-playwright')
const executablePath = process.env['PLAYWRIGHT_CHROMIUM'] ?? (fs.existsSync(cache) ? fs.readdirSync(cache).filter((s) => /^chromium-\d+$/.test(s)).sort((a,b) => Number(b.slice(9)) - Number(a.slice(9))).map((s) => path.join(cache, s, 'chrome-linux64/chrome')).find((p) => fs.existsSync(p)) : undefined)
const check = test.skipIf(!executablePath || !fs.existsSync(path.join(webDir, 'index.html')))
const memberLogin = 'reader@example.test'
let t: Awaited<ReturnType<typeof startTestHub>>, demo: Awaited<ReturnType<typeof startDemoBot>>
let browser: Browser, owner: TestDevice, reader: TestDevice, readerId: string
const contexts: BrowserContext[] = []
const chat = async (name: string): Promise<string> => (await owner.json(`/client/guilds/${t.config.guildId}/channels`, { method: 'POST', json: { name } })).id
const post = async (by: TestDevice, channel: string, content: string): Promise<string> => (await by.json(`/client/channels/${channel}/messages`, { method: 'POST', json: { content } })).id
const history = async (channel: string): Promise<string[]> => (await owner.json(`/client/channels/${channel}/messages`)).messages.map((m: { id: string }) => m.id)
const row = (p: Page, id: string) => p.locator(`#m-${id}`)
const pick = (p: Page, id: string) => p.locator(`button[data-pick-id="${id}"]`)
const dock = (p: Page) => p.getByRole('region', { name: 'Message selection' })
const count = async (p: Page, n: number) => { await expect.poll(() => dock(p).getByRole('status').innerText()).toBe(`${n} selected`) }
const enter = async (p: Page, id: string) => {
  await row(p,id).hover()
  await row(p,id).getByRole('button', { name: 'More', exact: true }).click()
  await p.getByRole('menuitem', { name: 'Select messages', exact: true }).click()
  await count(p, 1)
}
const review = async (p: Page, n: number) => {
  await dock(p).getByRole('button', { name: 'Delete', exact: true }).click()
  const dialog = p.getByRole('dialog', { name: `Delete ${n} ${n === 1 ? 'message' : 'messages'}?`, exact: true })
  await dialog.waitFor()
  return dialog
}
async function view(by: TestDevice, channel: string, touch = false) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'tailscale-user-login': by === reader ? memberLogin : LOGIN }, serviceWorkers: 'block', reducedMotion: 'reduce', deviceScaleFactor: 2, viewport: { width: touch ? 320 : 1280, height: 800 }, isMobile: touch, hasTouch: touch })
  contexts.push(context)
  const p = await context.newPage()
  p.setDefaultTimeout(6000)
  const cdp = await context.newCDPSession(p)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await p.goto(by.origin)
  await p.getByLabel('Pairing code').fill(await t.hub.store.createPairing('selection browser', by === reader ? { userId: readerId } : {}))
  await p.getByText('Pair this device', { exact: true }).click()
  await p.locator('.sidebar .channel').first().waitFor({ state: 'attached' })
  await p.goto(`${by.origin}/#/c/${channel}`)
  await p.locator('.chat-history').waitFor()
  return p
}

beforeAll(async () => {
  if (!executablePath || !fs.existsSync(path.join(webDir,'index.html'))) return
  t = await startTestHub({ extensions: [] })
  await t.hub.stop(); t.hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir, extensions: [] }); await t.hub.start()
  owner = await pairedDevice(t.hub, 'desktop')
  const invite = await owner.json(`/client/guilds/${t.config.guildId}/invites`, { method: 'POST', json: { username: 'reader' } })
  readerId = invite.user.id
  await t.hub.store.setProfile(invite.user.id, { tailscaleLogin: memberLogin }); await t.hub.refreshLogins()
  reader = new TestDevice(t.hub, { 'tailscale-user-login': memberLogin }); await reader.pair(invite.code)
  demo = await startDemoBot(t.hub)
  browser = await chromium.launch({ executablePath })
}, 90_000)
afterEach(async () => { await Promise.all(contexts.splice(0).map((c) => c.close())) })
afterAll(async () => { await browser?.close(); await demo?.stop(); await t?.cleanup() })

check('a drag copies ordinary text; a range skips the other author and sends only after confirmation', async () => {
  const channel = await chat('proofreading'), elsewhere = await chat('another-draft')
  const text = 'Check the margins on the printed draft.'
  const a = await post(reader,channel,text), other = await post(owner,channel,'Keep this note.'), b = await post(reader,channel,'Second draft.'), c = await post(reader,channel,'Third draft.')
  const foreign = await post(reader,elsewhere,'Other chat.')
  const p = await view(reader,channel)
  const sent: Array<{ url: string; body: unknown }> = []
  p.on('request', (r) => { if (r.method() === 'DELETE' || r.url().endsWith('/bulk-delete')) sent.push({ url: r.url(), body: r.postDataJSON() }) })
  const line = row(p,a).getByText(text, { exact: true })
  await line.waitFor()
  const box = await line.evaluate((el) => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return { x:r.left, end:r.right, y:r.top + r.height/2 } })
  await p.mouse.move(box.x+0.2,box.y); await p.mouse.down(); await p.mouse.move(box.end+1,box.y,{ steps: 12 }); await p.mouse.up()
  expect(await p.evaluate(() => getSelection()?.toString().trim())).toBe(text)
  expect(await dock(p).count()).toBe(0)
  await enter(p,a)
  expect(await pick(p,other).count()).toBe(0)
  await pick(p,c).click({ modifiers:['Shift'] }); await count(p,3)
  await pick(p,b).click(); await count(p,2); await pick(p,b).click(); await count(p,3)
  await (await review(p,3)).getByRole('button',{name:'Cancel'}).click(); await count(p,3)
  expect(sent).toEqual([])
  const confirm = await review(p,3)
  const arrival = await post(reader,channel,'Arrived after the question opened.')
  // Two activations before a paint exercise the submit guard, not Playwright's click delay.
  await confirm.getByRole('button',{name:'Delete',exact:true}).evaluate((el: HTMLButtonElement) => { el.click(); el.click() })
  await dock(p).waitFor({state:'detached'})
  expect(sent).toHaveLength(1); expect(sent[0]!.url).toBe(`${reader.origin}/client/channels/${channel}/messages/bulk-delete`)
  expect([...(sent[0]!.body as { message_ids: string[] }).message_ids].sort()).toEqual([a,b,c].sort())
  expect(await history(channel)).toEqual([other,arrival]); expect(await history(elsewhere)).toEqual([foreign])
}, 45_000)

check('a rejection keeps the draft; a disappearing row invalidates confirmation; Escape and navigation discard it', async () => {
  const channel = await chat('weather-notes'), other = await chat('map-notes')
  const a = await post(owner,channel,'Cloud cover.'), b = await post(owner,channel,'Cloud height.')
  await post(owner,other,'Map key.')
  const p = await view(owner,channel)
  let submissions = 0
  await p.route('**/messages/bulk-delete', async (route) => { submissions++; await route.fulfill({ status:409, contentType:'application/json', body:JSON.stringify({ error:'Review this chat again.' }) }) })
  await enter(p,a); await pick(p,b).click(); await count(p,2)
  await (await review(p,2)).getByRole('button',{ name:'Delete',exact:true }).click()
  await dock(p).getByRole('alert').filter({hasText:'Review this chat again'}).waitFor()
  expect(await history(channel)).toEqual([a,b]); await count(p,2)
  await review(p,2)
  await owner.json(`/client/channels/${channel}/messages/${b}`, { method:'DELETE' })
  await p.getByRole('dialog').waitFor({state:'detached'}); await count(p,1)
  await dock(p).getByRole('button',{name:'Cancel'}).click(); await dock(p).waitFor({ state:'detached' })
  await enter(p,a); await review(p,1); await p.keyboard.press('Escape')
  await p.getByRole('dialog').waitFor({state:'detached'}); await p.keyboard.press('Escape'); await dock(p).waitFor({state:'detached'})
  await enter(p,a); await p.evaluate((id) => { location.hash = `#/c/${id}` }, other); await p.getByText('Map key.',{exact:true}).waitFor()
  expect(await dock(p).count()).toBe(0); expect(submissions).toBe(1)
}, 45_000)

check('a phone hold opens Select messages; the release chooses nothing and later taps toggle whole rows', async () => {
  const channel = await chat('garden-notes')
  const a = await post(owner,channel,'First planting.'), b = await post(owner,channel,'Keep a note of the newly planted seedlings. '.repeat(5))
  const p = await view(owner,channel,true)
  let writes = 0
  p.on('request',r => { if (r.url().endsWith('/bulk-delete') || r.method() === 'DELETE') writes++ })
  const line = row(p,a).getByText('First planting.', { exact: true })
  // Let the phone drawer finish closing before starting the raw touch gesture.
  await line.tap({ trial: true })
  const r = (await line.boundingBox())!
  const touch = { x: r.x + Math.min(r.width / 2, 22), y: r.y + r.height / 2 }
  expect(await p.evaluate(({ x,y }) => document.elementFromPoint(x,y)?.closest('.message')?.id, touch)).toBe(`m-${a}`)
  const cdp = await p.context().newCDPSession(p)
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchStart', touchPoints:[touch] })
  const option = p.getByRole('menuitem',{ name:'Select messages' }); await option.waitFor()
  await cdp.send('Input.dispatchTouchEvent',{ type:'touchEnd',touchPoints:[] }); await p.waitForTimeout(450)
  expect(await option.isVisible()).toBe(true); expect(await dock(p).count()).toBe(0)
  await option.tap(); await count(p,1)
  await row(p,b).scrollIntoViewIfNeeded(); const long = (await row(p,b).boundingBox())!
  await p.touchscreen.tap(long.x+100,long.y+long.height-5); await count(p,2)
  await pick(p,a).tap(); await count(p,1)
  await dock(p).getByRole('button',{name:'Cancel'}).tap(); await dock(p).waitFor({state:'detached'})
  expect(writes).toBe(0); expect(await history(channel)).toEqual([a,b])
}, 45_000)

check('a split thread cannot pick its parent starter, private reply or closed steps', async () => {
  const source = await demo.thread.fetchStarterMessage()
  const first = await demo.thread.send('Before the folded work.')
  const hidden = await demo.thread.send('-# ┣ read _garden notes_')
  const last = await demo.thread.send('After the folded work.')
  await owner.json('/client/commands',{ method:'POST',json:{ channelId:demo.thread.id,name:'accounts' } })
  const p = await view(owner,demo.kimaki.id)
  await p.locator('.thread-card',{hasText:'Fix footer on short turns'}).first().click()
  const split = p.locator('.chat.split'); await split.locator('.private-reply').waitFor()
  await enter(p,first.id); await pick(p,last.id).click({modifiers:['Shift']}); await count(p,2)
  expect(await split.locator(`button[data-pick-id="${source!.id}"], button[data-pick-id="${hidden.id}"]`).count()).toBe(0)
  expect(await split.locator('.pick-row:has(.private-reply) [role=checkbox]').count()).toBe(0)
  expect(await p.locator('.chat:not(.split) .pick-row').count()).toBe(0)
  await split.locator('.steps').click(); await pick(p,hidden.id).click(); await count(p,3)
  expect(await split.locator('.steps').isDisabled()).toBe(true)
  await dock(p).getByRole('button',{name:'Cancel'}).click()
}, 45_000)
