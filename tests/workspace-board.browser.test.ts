// Private, disposable hub; its registered bot publishes and edits a real
// attachment. The browser uses the normal paired-device session and event bus.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'
import { expect, test } from 'vitest'
import { Hub } from '../src/hub.ts'
import { startDemoBot } from './demo-bot.ts'
import { LOGIN, pairedDevice, startTestHub, waitFor } from './helpers.ts'
import type { BoardPage } from '../web/src/board-document.ts'

const dist = process.env['VOCORUM_BOARD_WEB'] || path.resolve(import.meta.dirname, '../web/dist')
function chromiumPath() {
  const cache = path.join(os.homedir(), '.cache/ms-playwright')
  return process.env['PLAYWRIGHT_CHROMIUM'] || (fs.existsSync(cache) && fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a,b) => Number(b.slice(9))-Number(a.slice(9))).map(d => path.join(cache, d, 'chrome-linux64/chrome')).find(p => fs.existsSync(p))) || undefined
}

test.skipIf(!chromiumPath() || !fs.existsSync(path.join(dist, 'index.html')))('a published board survives edits, navigation and device-scoped visits without paging chat or sending corrections', async () => {
  const t = await startTestHub()
  await t.hub.stop()
  const hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir: dist }); await hub.start()
  const demo = await startDemoBot(hub), id = demo.thread.id
  const browser = await chromium.launch({ executablePath: chromiumPath() })
  try {
    const origin = `http://localhost:${hub.port}`, device = await pairedDevice(hub, 'Board desktop'), phone = await pairedDevice(hub, 'Board phone')
    const paired = async (c: BrowserContext, cookie: string) => { const i = cookie.indexOf('='); await c.addCookies([{ name: cookie.slice(0,i), value: cookie.slice(i+1), url: origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }]) }
    const route = `/client/threads/${id}/panels`, data = () => device.json<BoardPage>(route)
    const utc = Date.now() - 3_600_000
    const count = 1759 // size of the existing design thread at the time of this walk
    const rows = Array.from({length: count}, (_,i) => ({ id: ((BigInt(utc+i)-1420070400000n)<<22n).toString(), channelId: id, authorId: t.config.ownerUserId, timestamp: new Date(utc+i), content: `Archived design note ${i}` }))
    for (let i=0;i<count;i+=200) await hub.twin.prisma.message.createMany({ data: rows.slice(i,i+200) })
    const referenced = await demo.thread.send('Agreed on the width in the original brief.')
    const source = `https://discord.com/channels/${t.config.guildId}/${id}/${referenced.id}`
    const body = (v: number, phase: string) => Buffer.from(`---\npanel: board\ntitle: Design brief\nv: ${v}\n---\n## Now\n${phase}\n\n## Facts\nKeep the document at 400px.\n\n| Surface | Width |\n| --- | ---: |\n| Board | 400 |\n\n## Steps\n- [x] Measure the drawer\n- [>] Test the correction\n\n## Sources\n[Original decision](${source})\n`)
    const file = (v: number, phase: string) => ({ name: 'board.panel.md', attachment: body(v,phase) })
    const m = await demo.thread.send({ content: 'Board updated', files:[file(1,'First brief.')] })
    await waitFor(async () => (await data()).board?.versions.at(-1)?.v === 1)
    const c = await browser.newContext({ viewport:{width:1440,height:900}, serviceWorkers:'block', reducedMotion:'reduce', extraHTTPHeaders:{ 'tailscale-user-login': LOGIN } })
    await paired(c,device.cookie!); const p=await c.newPage(); p.setDefaultTimeout(7000)
    const pathTo=`${origin}/#/c/${id}`, reg=p.getByRole('region',{name:'Agent board'}), draft=p.locator('.composer textarea')
    let olderReads=0, sent=0, boardReads=0
    p.on('request',r=>{ const u=new URL(r.url());if(u.pathname===route && r.method()==='GET') boardReads++; if(u.pathname===`/client/channels/${id}/messages`){if(u.searchParams.has('before')) olderReads++; if(r.method()==='POST') sent++} })
    await p.goto(pathTo); await draft.waitFor(); await draft.fill('Keep this unsent draft.')
    await p.getByRole('button',{name:'Workspace',exact:true}).click(); await reg.getByText('First brief.').waitFor()
    await waitFor(async () => (await data()).seen_version === 1)
    await p.goBack(); await reg.waitFor({state:'detached'}); await p.goForward(); await reg.getByText('First brief.').waitFor()
    await m.edit({content:'Board updated',attachments:[],files:[file(2,'Ready to review.')]})
    await reg.getByText('Ready to review.').waitFor(); await reg.getByText('Since v1: 1 line added, 1 removed.').waitFor()
    expect(await reg.locator('[data-changed]').count()).toBe(1); expect(await reg.getByRole('cell',{name:'400',exact:true}).count()).toBe(1)
    await waitFor(async () => (await data()).seen_version === 2)
    await reg.getByRole('button',{name:'Older board version'}).click(); await reg.getByText('First brief.').waitFor(); expect(await reg.getByRole('button',{name:/^Correct /}).count()).toBe(0)
    await reg.getByRole('button',{name:'Newer board version'}).click(); await reg.getByRole('button',{name:'Correct Now line 1'}).click()
    expect(await draft.inputValue()).toBe('Keep this unsent draft.\n\nBoard v2:\n> Ready to review.\n\nCorrection: ')
    expect(sent).toBe(0); expect(olderReads).toBe(0)
    await reg.locator(`a[href="#/c/${id}/${referenced.id}"]`).click(); await p.locator(`#m-${referenced.id}.highlight`).waitFor()
    await p.goto(`${pathTo}?p=board`); await p.reload(); await reg.getByText('Ready to review.').waitFor(); expect(await reg.locator('[data-changed]').count()).toBe(0)
    await p.locator(`[data-nav="${demo.website.id}"]`).click(); await reg.waitFor({state:'detached'})
    const readsWhileClosed=boardReads
    await m.edit({content:'Board updated',attachments:[],files:[file(3,'Published while away.')]}); await waitFor(async () => (await data()).board?.versions.at(-1)?.v===3)
    expect(boardReads).toBe(readsWhileClosed)
    await p.locator(`[data-nav="${id}"]`).click(); await reg.getByText('Published while away.').waitFor(); await reg.getByText('Since v2: 1 line added, 1 removed.').waitFor()
    if(process.env['HUB_SCREENSHOTS']) await p.screenshot({path:path.join(process.env['HUB_SCREENSHOTS'],'board-desktop.png')})
    const mobile=await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, serviceWorkers:'block', extraHTTPHeaders:{ 'tailscale-user-login': LOGIN } }); await paired(mobile,phone.cookie!)
    const mp=await mobile.newPage(); mp.setDefaultTimeout(7000); await mp.goto(pathTo); await mp.locator('.composer textarea').waitFor()
    expect(await mp.getByRole('region',{name:'Agent board'}).count()).toBe(0); expect((await phone.json<BoardPage>(route)).seen_version).toBeNull()
    await mp.locator('.chat-title').first().click(); await mp.getByText('Workspace',{exact:true}).filter({visible:true}).click()
    const mr=mp.getByRole('region',{name:'Agent board'}); await mr.getByText('Published while away.').waitFor()
    expect(await mr.locator('[data-changed]').count()).toBe(0); expect(await mp.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
    if(process.env['HUB_SCREENSHOTS']) await mp.screenshot({path:path.join(process.env['HUB_SCREENSHOTS'],'board-phone.png')})
    await mr.getByRole('button',{name:'Correct Now line 1'}).click(); await mr.waitFor({state:'detached'}); expect(await mp.locator('.composer textarea').inputValue()).toContain('Board v3:')
    await demo.thread.setLocked(true); await demo.thread.setArchived(true); await mp.goto(`${pathTo}?p=board`); await mp.reload(); await mr.getByText('Published while away.').waitFor(); expect(await mr.locator('.board-correct').count()).toBe(0)
    expect((await data()).board?.versions.map(v=>v.v)).toEqual([1,2,3])
  } finally { await browser.close(); await demo.stop(); await hub.stop(); fs.rmSync(t.paths.root,{recursive:true,force:true}) }
},90_000)

test.skipIf(!chromiumPath() || !fs.existsSync(path.join(dist, 'index.html')))('evicted versions, a same-version clear and a missed socket update resolve from the authoritative board', async () => {
  const t = await startTestHub(); await t.hub.stop()
  const hub = new Hub({ paths: t.paths, config: t.config, port: 0, webDir: dist }); await hub.start()
  const demo = await startDemoBot(hub), id = demo.thread.id, route = `/client/threads/${id}/panels`
  const browser = await chromium.launch({ executablePath: chromiumPath() })
  let resume: (() => void) | undefined
  try {
    const origin = `http://localhost:${hub.port}`, desktop = await pairedDevice(hub, 'History desktop'), other = await pairedDevice(hub, 'Second reader')
    const state = () => desktop.json<BoardPage>(route)
    const file = (v: number, text: string) => ({ name: 'board.panel.md', attachment: Buffer.from(`---\npanel: board\ntitle: Release notes\nv: ${v}\n---\n## Now\n${text}\n`) })
    const first = await demo.thread.send({ content: 'Current brief', files: [file(1, 'First delivery.')] })
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'tailscale-user-login': LOGIN } })
    const split = desktop.cookie!.indexOf('=')
    await c.addCookies([{ name: desktop.cookie!.slice(0, split), value: desktop.cookie!.slice(split + 1), url: origin.replace('http:', 'https:') + '/', secure: true, httpOnly: true }])
    const p = await c.newPage(); p.setDefaultTimeout(8000)
    let cut: (() => Promise<void>) | undefined, gate = Promise.resolve(), connects = 0, reads = 0, sends = 0
    const updates: number[] = [], seenReplies: number[] = []
    // Transparent relay of the real fixture socket. Hold a single reconnect
    // below, so a publish genuinely occurs while its event cannot arrive.
    await p.routeWebSocket('**/client/events', async client => {
      await gate
      const server = client.connectToServer()
      cut = async () => { await Promise.all([client.close({ code: 1000 }), server.close({ code: 1000 })]) }
      server.onMessage(raw => {
        const frame = JSON.parse(String(raw))
        if (frame.t === 'HELLO') connects++
        if (frame.t === 'PANEL_UPDATE' && frame.d.thread_id === id && frame.d.slot === 'board') updates.push(frame.d.v)
        client.send(raw)
      })
    })
    p.on('response', r => {
      const path = new URL(r.url()).pathname
      if (path === route && r.ok()) reads++
      if (path === `${route}/board/seen`) seenReplies.push(r.status())
      if (path === `/client/channels/${id}/messages` && r.request().method() === 'POST') sends++
    })
    const board = p.getByRole('region', { name: 'Agent board' }), panel = p.getByRole('complementary', { name: 'Workspace' })
    await p.goto(`${origin}/#/c/${id}?p=board`); await board.getByText('First delivery.').waitFor()
    await waitFor(async () => connects > 0 && (await state()).seen_version === 1)
    await panel.getByRole('button', { name: 'Close', exact: true }).click(); await panel.waitFor({ state: 'detached' })
    const closedReads = reads
    for (let v = 2; v <= 23; v++) await first.edit({ attachments: [], files: [file(v, `Delivery ${v}.`)] })
    await waitFor(() => updates.includes(23))
    expect(reads).toBe(closedReads); expect((await state()).seen_version).toBe(1)
    await p.getByRole('button', { name: 'Workspace', exact: true }).click(); await board.getByText('Delivery 23.').waitFor()
    await board.getByText('Your last viewed version (v1) is no longer in history.').waitFor()
    expect((await state()).board?.versions.map(v => v.v)).toEqual(Array.from({length:20}, (_, i) => i+4))
    await waitFor(async () => (await state()).seen_version === 23)
    expect((await other.json<BoardPage>(route)).seen_version).toBeNull()
    for (let v = 22; v >= 4; v--) { await board.getByRole('button', {name: 'Older board version'}).click(); await board.getByText(`Delivery ${v}.`).waitFor() }
    expect(await board.getByRole('button', {name:'Older board version'}).isDisabled()).toBe(true)
    expect(await board.locator('.board-correct').count()).toBe(0)
    const draft = p.locator('.composer textarea'); await draft.fill('Unsent note.')
    const reread = p.waitForResponse(r => new URL(r.url()).pathname === route && r.ok())
    await first.delete()
    expect(await (await reread).json()).toEqual({ board: null, seen_version: null })
    await board.waitFor({ state: 'detached' }); await panel.getByRole('heading',{ name: 'Now', exact:true }).waitFor()
    expect(updates.slice(-2)).toEqual([23,23]); expect(await panel.getByText('Delivery 4.').count()).toBe(0)
    expect(await draft.inputValue()).toBe('Unsent note.')
    const replacement = await demo.thread.send({ content: 'Revised brief', files: [file(1,'Replacement document.')] })
    expect(replacement.id).not.toBe(first.id); await board.getByText('Replacement document.').waitFor()
    await waitFor(async () => (await state()).seen_version === 1)
    const n = connects
    gate = new Promise<void>(resolve => { resume = resolve }); await cut!()
    await waitFor(() => !hub.events.connections().some(d => d.name === 'History desktop'))
    const delivered = updates.length
    await replacement.edit({ attachments: [], files: [file(2,'Updated during disconnect.')] })
    expect(updates.length).toBe(delivered)
    const reconnectRead = p.waitForResponse(r => connects > n && new URL(r.url()).pathname === route && r.ok())
    resume!(); const caughtUp = await (await reconnectRead).json() as BoardPage
    expect(caughtUp.board?.message_id).toBe(replacement.id); expect(caughtUp.board?.versions.at(-1)?.v).toBe(2)
    expect(updates.length).toBe(delivered); await board.getByText('Updated during disconnect.').waitFor()
    await waitFor(async () => (await state()).seen_version === 2)
    expect(seenReplies.length).toBeGreaterThan(0); expect([...new Set(seenReplies)]).toEqual([204])
    expect(await draft.inputValue()).toBe('Unsent note.'); expect(sends).toBe(0)
  } finally { resume?.(); await browser.close(); await demo.stop(); await hub.stop(); fs.rmSync(t.paths.root,{recursive:true,force:true}) }
}, 90_000)
